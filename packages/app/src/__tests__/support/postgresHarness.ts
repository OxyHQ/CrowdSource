import { and, asc, count, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { createModerationIntegration } from '../../integration.js';
import { createOutboxService, type OutboxService } from '../../outbox/service.js';
import { postgresModerationStore } from '../../postgres/store/index.js';
import type { ModerationPgHandle } from '../../postgres/store/transaction.js';
import type { ModerationStore } from '../../store/types.js';
import type {
  EnforcementEffect,
  ModerationEnforcementConfig,
  ModerationSubjectProvider,
} from '../../types.js';
import {
  TEST_ACTIONS,
  doodadSubjectProvider,
  legacyStatusFor,
  recordingLogger,
  testTaxonomy,
  type Harness,
  type HarnessEnforcement,
  type HarnessEnforcementRow,
  type HarnessEvents,
  type HarnessOptions,
  type HarnessOutbox,
  type HarnessOutboxRow,
  type ModerationBackend,
  type TestAction,
  type TestReport,
} from './backend.js';
import {
  createPostgresTestDatabase,
  STATEMENT_TIMEOUT_MS,
  type PostgresTestDatabase,
} from './postgres/database.js';
import { moderation, reports, reviewOnlyReports, widgets } from './postgres/schema.js';
import {
  REVIEW_ONLY,
  REVIEW_ONLY_WEBHOOK_SECRET,
  reviewOnlyIntegration,
  type ReviewOnlyHarness,
  type ReviewOnlyReport,
} from './reviewOnlyApplication.js';

/**
 * The same fictional application, second implementation.
 *
 * Every member of the `Harness` façade is implemented here over drizzle, and
 * nothing in a test body changes. What differs is only what has to: a widget is a
 * row in a drizzle table rather than a Mongoose document, an absent id is a uuid
 * v7 rather than an ObjectId hex, and a detached handle is the POOL rather than a
 * session nobody opened a transaction on.
 *
 * Two things the Mongo harness needs and this one does not, both because a `text`
 * id has nothing to parse: the `isValidObjectId` guards in the subject provider
 * and in `apply` are gone. Their absence is the same property `findById` relies
 * on — a malformed id matches no rows rather than throwing.
 */

/** The application's own noun, read and written through the handle. */
function postgresWidgetSubjectProvider(db: ModerationPgHandle): ModerationSubjectProvider {
  return {
    reportedType: 'widget',
    subjectType: 'custom.test.widget',
    async snapshot(reportedId) {
      const rows = await db
        .select({ body: widgets.body, ownerId: widgets.ownerId })
        .from(widgets)
        .where(eq(widgets.id, reportedId))
        .limit(1);
      const [widget] = rows;
      if (widget === undefined) return null;
      return {
        subject: {
          externalId: reportedId,
          type: 'custom.test.widget',
          author: { oxyUserId: String(widget.ownerId) },
        },
        content: { type: 'text', data: { text: String(widget.body) } },
      };
    },
  };
}

/** The same enforcement table as the Mongo harness, with drizzle effects. */
function postgresTestEnforcement(
  db: ModerationPgHandle,
): ModerationEnforcementConfig<TestAction> {
  const readWidget = async (
    id: string,
  ): Promise<{ status: string; flagged: boolean } | undefined> => {
    const rows = await db
      .select({ status: widgets.status, flagged: widgets.flagged })
      .from(widgets)
      .where(eq(widgets.id, id))
      .limit(1);
    const [row] = rows;
    return row === undefined
      ? undefined
      : { status: String(row.status), flagged: row.flagged === true };
  };

  return {
    actions: TEST_ACTIONS,
    noneAction: 'none',
    reviewAction: 'review',
    restoreAction: ['restore', 'unflag'],
    recommendationToAction: {
      remove: 'restrict',
      remove_or_restrict: 'restrict',
      hide: 'restrict',
      label: 'flag',
      allow_with_label: 'flag',
      age_gate: 'flag',
      reduce_distribution: 'flag',
      allow: 'none',
      no_action: 'none',
      no_global_effect: 'none',
      restore: 'restore',
      suspend_user: 'review',
      escalate: 'review',
      legal_queue: 'review',
    },
    severityFallback: {
      critical: 'review',
      high: 'restrict',
      medium: 'flag',
      low: 'review',
    },
    absorb: { restrict: ['flag', 'none', 'restore'] },
    precedence: ['restrict', 'restore', 'flag', 'unflag', 'review', 'none'],
    reversibleActions: ['restore', 'unflag'],
    reverses: { restore: ['restrict', 'flag'], unflag: 'flag' },

    async apply({ action, subject, previousState }): Promise<EnforcementEffect<TestAction>> {
      if (action === 'none' || action === 'review') {
        return { changed: false, reason: `Action '${action}' has no effect by definition` };
      }
      if (subject.type !== 'widget') {
        return {
          changed: false,
          reason: `No '${action}' effect for a ${subject.type}`,
          recordedAs: 'none',
        };
      }
      const widget = await readWidget(subject.id);
      if (widget === undefined) {
        return { changed: false, reason: 'The reported widget no longer exists' };
      }

      switch (action) {
        case 'restrict': {
          if (widget.status === 'restricted') {
            return { changed: false, reason: 'The widget was already restricted' };
          }
          await db
            .update(widgets)
            .set({ status: 'restricted' })
            .where(eq(widgets.id, subject.id));
          return { changed: true, previousState: { status: widget.status } };
        }
        case 'restore': {
          if (widget.status !== 'restricted') {
            return { changed: false, reason: 'The widget was not restricted' };
          }
          const restoreTo = previousState?.status;
          await db
            .update(widgets)
            .set({ status: typeof restoreTo === 'string' ? restoreTo : 'published' })
            .where(eq(widgets.id, subject.id));
          return { changed: true, previousState: { status: 'restricted' } };
        }
        case 'flag': {
          if (widget.flagged) return { changed: false, reason: 'Already flagged' };
          await db.update(widgets).set({ flagged: true }).where(eq(widgets.id, subject.id));
          return { changed: true, previousState: { flagged: false } };
        }
        case 'unflag': {
          if (previousState === undefined) {
            return { changed: false, reason: 'The flag was not set by moderation' };
          }
          if (!widget.flagged) return { changed: false, reason: 'Not flagged' };
          await db.update(widgets).set({ flagged: false }).where(eq(widgets.id, subject.id));
          return { changed: true, previousState: { flagged: true } };
        }
      }
    },
  };
}

function postgresOutboxFacade(input: {
  db: ModerationPgHandle;
  url: string;
  store: ModerationStore<TestReport, ModerationPgHandle>;
  service: OutboxService<ModerationPgHandle>;
}): HarnessOutbox {
  const { db, store, service } = input;
  const outbox = moderation.outbox;

  return {
    async count(filter = {}) {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(outbox)
        .where(
          and(
            ...(filter.kind === undefined ? [] : [eq(outbox.kind, filter.kind)]),
            ...(filter.status === undefined ? [] : [eq(outbox.status, filter.status)]),
          ),
        );
      return rows[0]?.total ?? 0;
    },

    async read(eventId) {
      const rows = await db.select().from(outbox).where(eq(outbox.id, eventId)).limit(1);
      const [row] = rows;
      if (row === undefined) return null;
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        attempts: row.attempts,
        availableAt: row.availableAt,
        leaseOwner: row.leaseOwner,
        leaseUntil: row.leaseUntil,
        lastError: row.lastError,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } satisfies HarnessOutboxRow;
    },

    async stealLease(eventId, leaseOwner) {
      /**
       * The bound the façade's contract requires, and Postgres's own spelling of
       * it. This write is made while a transaction on the same row may be open,
       * so it can BLOCK — and the pool's `statement_timeout` turns that into a
       * named `57014` in two seconds rather than a hang with no verdict. That
       * bound is set on the connection rather than per statement, which is why
       * nothing is passed here; `maxTimeMS` is Mongo's equivalent.
       */
      await db.update(outbox).set({ leaseOwner }).where(eq(outbox.id, eventId));
    },

    async claim(options) {
      return await service.claim({ leaseOwner: options.leaseOwner });
    },

    async complete(eventId, leaseOwner) {
      return await service.complete(eventId, leaseOwner);
    },

    breakEnqueue(message) {
      const original = store.outbox.enqueue;
      store.outbox.enqueue = async () => {
        throw new Error(message);
      };
      return {
        restore() {
          store.outbox.enqueue = original;
        },
      };
    },
  };
}

function postgresEventsFacade(db: ModerationPgHandle): HarnessEvents {
  return {
    async count(filter = {}) {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(moderation.events)
        .where(filter.state === undefined ? undefined : eq(moderation.events.state, filter.state));
      return rows[0]?.total ?? 0;
    },
  };
}

function postgresEnforcementFacade(db: ModerationPgHandle): HarnessEnforcement {
  return {
    async rows() {
      const found = await db
        .select()
        .from(moderation.enforcements)
        /**
         * `created_at` then `decision_revision`, ascending. The tie-breaker is the
         * same one the Mongo façade carries and for the same reason: both backends
         * stamp `created_at` at millisecond precision, so two rows written inside
         * one millisecond order arbitrarily and a test identifying a row by
         * position would fail once in a while with nothing to reproduce.
         */
        .orderBy(
          asc(moderation.enforcements.createdAt),
          asc(moderation.enforcements.decisionRevision),
        );

      return found.map(
        (row): HarnessEnforcementRow => ({
          decisionId: row.decisionId,
          decisionRevision: row.decisionRevision,
          action: row.action,
          recordedAs: row.recordedAs,
          applied: row.applied,
          appliedAt: row.appliedAt,
          skippedReason: row.skippedReason,
          previousState: row.previousState,
          mode: row.mode,
          createdAt: row.createdAt,
        }),
      );
    },
  };
}

async function createPostgresHarness(options: HarnessOptions = {}): Promise<Harness> {
  const database = await createPostgresTestDatabase();
  const db: ModerationPgHandle = database.db;

  const logs: Harness['logs'] = [];
  const store = postgresModerationStore<TestReport>({
    db,
    reportTable: reports,
    tables: moderation,
  });

  const moderationIntegration = createModerationIntegration({
    store,
    crowdSource: {
      enabled: options.enabled ?? true,
      ...(options.serviceKey === undefined ? {} : { serviceKey: options.serviceKey }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.webhookSecret === undefined
        ? {}
        : { webhookSecret: options.webhookSecret }),
      enforcementMode: options.enforcementMode ?? 'automatic',
      outboxPollIntervalMs: 50,
    },
    subjects:
      options.subjects ?? [postgresWidgetSubjectProvider(db), doodadSubjectProvider()],
    taxonomy: testTaxonomy(),
    enforcement: options.enforcement ?? postgresTestEnforcement(db),
    logger: recordingLogger(logs),
    reportDecisionExtraFields: legacyStatusFor,
  });

  /**
   * Asserts the four tables the pipeline queries exist. It creates nothing — the
   * throwaway database's migration did that, from the same definitions an adopter
   * would generate from.
   */
  await store.ensureSchema();

  const service = createOutboxService({ store: store.outbox, logger: recordingLogger(logs) });

  return {
    moderation: moderationIntegration,
    logs,

    app: {
      async createWidget(input) {
        const rows = await db
          .insert(widgets)
          .values({
            body: input.body,
            ownerId: input.ownerId,
            ...(input.status === undefined ? {} : { status: input.status }),
          })
          .returning({ id: widgets.id });
        const [row] = rows;
        if (row === undefined) throw new Error('the widget insert returned no row');
        return row.id;
      },

      async readWidget(id) {
        const rows = await db
          .select({ status: widgets.status, flagged: widgets.flagged })
          .from(widgets)
          .where(eq(widgets.id, id))
          .limit(1);
        const [row] = rows;
        return row === undefined ? null : { status: row.status, flagged: row.flagged };
      },

      async readReport(id) {
        return await store.reports.findById(id);
      },

      async countReports() {
        const rows = await db.select({ total: count() }).from(reports);
        return Number(rows[0]?.total ?? 0);
      },

      /**
       * A uuid v7, which is what `generatedId()` mints — so it is WELL-FORMED and
       * simply absent. On a `text` id column a malformed string would also match
       * no rows, but then the test would be exercising the parser rather than the
       * absence, and on Mongo the same string throws.
       */
      absentId() {
        return uuidv7();
      },
    },

    outbox: postgresOutboxFacade({ db, url: database.url, store, service }),
    events: postgresEventsFacade(db),
    enforcement: postgresEnforcementFacade(db),

    transaction: {
      async run(operation) {
        await store.transaction.run(async (tx) => {
          await operation(async (input) => {
            await service.enqueue(input, tx);
          });
        });
      },
    },

    async detachedEnqueue() {
      /**
       * The POOL handle, which is the mistake worth catching here: it satisfies
       * the parameter, it type-checks perfectly, and the row it writes commits on
       * its own connection — independently of the domain write it was supposed to
       * be atomic with. `dispose` is a no-op because nothing was opened.
       */
      return {
        enqueue: async (input) => {
          await service.enqueue(input, db);
        },
        async dispose() {
          // Nothing to release: the pool outlives this and is closed by `close()`.
        },
      };
    },

    async close() {
      await moderationIntegration.dispatcher.stop();
      moderationIntegration.reconciliationJob.stop();
      await database.close();
    },
  };
}

/** The second fictional application, over Postgres. */
async function createPostgresReviewOnlyHarness(): Promise<ReviewOnlyHarness> {
  const database = await createPostgresTestDatabase();
  const db: ModerationPgHandle = database.db;

  const store = postgresModerationStore<ReviewOnlyReport>({
    db,
    reportTable: reviewOnlyReports,
    tables: moderation,
  });
  await store.ensureSchema();

  const wired = reviewOnlyIntegration({ store });

  return {
    sandbox: wired.sandbox,
    moderation: wired.moderation,
    async readReport(id) {
      return await store.reports.findById(id);
    },
    events: postgresEventsFacade(db),
    enforcement: postgresEnforcementFacade(db),
    async close() {
      await wired.moderation.dispatcher.stop();
      wired.moderation.reconciliationJob.stop();
      await database.close();
    },
  };
}

export const postgresBackend: ModerationBackend = {
  name: 'postgres',
  createHarness: createPostgresHarness,
  createReviewOnlyHarness: createPostgresReviewOnlyHarness,
};

export { REVIEW_ONLY, REVIEW_ONLY_WEBHOOK_SECRET, STATEMENT_TIMEOUT_MS };
export type { PostgresTestDatabase };
