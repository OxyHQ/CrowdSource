import mongoose, { Schema, type ClientSession, type Model } from 'mongoose';
import type { Decision, TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import {
  applyModerationReportIndexes,
  moderationReportSchemaFields,
} from '../../mongoose/report.js';
import {
  registerModerationModels,
  type ModerationEnforcementDocument,
  type ModerationEventDocument,
  type ModerationOutboxDocument,
} from '../../mongoose/models.js';
import { mongooseModerationStore } from '../../mongoose/store/index.js';
import { createModerationIntegration } from '../../integration.js';
import { createOutboxService, type OutboxService } from '../../outbox/service.js';
import type { ModerationStore } from '../../store/types.js';
import type {
  EnforcementEffect,
  ModerationEnforcementConfig,
  ModerationLogger,
  ModerationSubjectProvider,
} from '../../types.js';
import { TEST_ACTIONS, type TestAction, type TestReport } from './backend.js';
import type {
  Harness,
  HarnessEnforcement,
  HarnessEnforcementRow,
  HarnessEvents,
  HarnessOptions,
  HarnessOutbox,
  HarnessOutboxRow,
  ModerationBackend,
} from './backend.js';

/**
 * A fictional application, wired the way an adopter wires one.
 *
 * Deliberately not a mock of this package's own pieces: the connection is a real
 * replica set, the report model is a real Mongoose model composed from the
 * exported schema fields, and the enforcement effects are real writes to a real
 * collection. What is fictional is only the application's domain — a `widget`
 * with a body and a status — because that is the part every adopter replaces.
 */

/* ------------------------------------------------------------------------- */
/* The façade, over Mongo                                                     */
/* ------------------------------------------------------------------------- */

/**
 * These three builders are exported because `reviewOnlyApplication.test.ts`
 * wires its own integration — a different application, with no enforcement
 * primitive — and must reach its rows through the same façade rather than a
 * second dialect of assertions.
 */

export function mongooseOutboxFacade(input: {
  model: Model<ModerationOutboxDocument>;
  store: ModerationStore<TestReport, ClientSession>;
  service: OutboxService<ClientSession>;
}): HarnessOutbox {
  const { model, store, service } = input;
  const nullable = <T>(value: T | undefined): T | null => value ?? null;

  return {
    async count(filter = {}) {
      return await model.countDocuments({
        ...(filter.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
      });
    },

    async read(eventId) {
      const row = await model.findById(eventId).lean();
      if (row === null) return null;
      return {
        id: String(row._id),
        kind: row.kind,
        status: row.status,
        attempts: row.attempts,
        availableAt: row.availableAt,
        leaseOwner: nullable(row.leaseOwner),
        leaseUntil: nullable(row.leaseUntil),
        lastError: nullable(row.lastError),
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } satisfies HarnessOutboxRow;
    },

    async stealLease(eventId, leaseOwner) {
      /**
       * `maxTimeMS` is the bound the façade's contract requires. This write is
       * made while a transaction on the same row may be open, so it can block —
       * and an unbounded block is a test that hangs until the runner gives up,
       * which distinguishes nothing. Two seconds turns that into a named server
       * error in about two seconds.
       */
      await model
        .updateOne({ _id: eventId }, { $set: { leaseOwner } })
        .maxTimeMS(2_000);
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

export function mongooseEventsFacade(
  model: Model<ModerationEventDocument>,
): HarnessEvents {
  return {
    async count(filter = {}) {
      return await model.countDocuments(
        filter.state === undefined ? {} : { state: filter.state },
      );
    },
  };
}

export function mongooseEnforcementFacade(
  model: Model<ModerationEnforcementDocument>,
): HarnessEnforcement {
  return {
    async rows() {
      /**
       * `decisionRevision` breaks a tie, and the tie is real: `createdAt` has
       * millisecond precision on both backends, so two rows written inside one
       * millisecond order arbitrarily and a test identifying a row by position
       * fails once in a while for no reason anybody can reproduce. Every fixture
       * that depends on the order distinguishes its rows by revision.
       */
      const found = await model
        .find({})
        .sort({ createdAt: 1, decisionRevision: 1 })
        .lean();
      return found.map(
        (row): HarnessEnforcementRow => ({
          decisionId: row.decisionId,
          decisionRevision: row.decisionRevision,
          action: row.action,
          recordedAs: row.recordedAs ?? null,
          applied: row.applied,
          appliedAt: row.appliedAt ?? null,
          skippedReason: row.skippedReason ?? null,
          previousState: row.previousState ?? null,
          mode: row.mode,
          createdAt: row.createdAt,
        }),
      );
    },
  };
}

/** The application's own noun, as THIS backend stores it. */
export interface TestWidget {
  _id: mongoose.Types.ObjectId;
  body: string;
  ownerId: string;
  status: 'draft' | 'published' | 'restricted';
  flagged: boolean;
}

export const recordingLogger = (
  sink: Harness['logs'],
): ModerationLogger => ({
  info: (message, context) => void sink.push({ level: 'info', message, ...(context ? { context } : {}) }),
  warn: (message, context) => void sink.push({ level: 'warn', message, ...(context ? { context } : {}) }),
  error: (message, context) => void sink.push({ level: 'error', message, ...(context ? { context } : {}) }),
});

const CATEGORY_TO_ALLEGATION: Readonly<Record<string, TaxonomyCode>> = Object.freeze({
  spam: 'integrity.spam',
  harassment: 'harassment.targeted_abuse',
  other: 'other.unclassifiable',
});

export function testTaxonomy(): {
  version: string;
  allegationsFor(categories: readonly string[]): readonly TaxonomyCode[];
} {
  return {
    version: '2026.07',
    allegationsFor(categories) {
      const codes = new Set<TaxonomyCode>();
      for (const category of categories) {
        codes.add(CATEGORY_TO_ALLEGATION[category] ?? 'other.unclassifiable');
      }
      return Array.from(codes).sort();
    },
  };
}

export function widgetSubjectProvider(
  widgets: Model<TestWidget>,
): ModerationSubjectProvider {
  return {
    reportedType: 'widget',
    subjectType: 'custom.test.widget',
    async snapshot(reportedId) {
      if (!mongoose.isValidObjectId(reportedId)) return null;
      const widget = await widgets.findById(reportedId).lean<TestWidget | null>();
      if (!widget) return null;
      return {
        subject: {
          externalId: String(widget._id),
          type: 'custom.test.widget',
          author: { oxyUserId: widget.ownerId },
        },
        content: { type: 'text', data: { text: widget.body } },
      };
    },
  };
}

/**
 * A second deliverable noun with no enforcement lever, mirroring Moovo's
 * customer/delivery types. It is DELIVERABLE — a jury can review it — but no
 * action in the table can act on it, which is exactly the case `recordedAs`
 * exists for.
 */
export function doodadSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: 'doodad',
    subjectType: 'custom.test.doodad',
    async snapshot(reportedId) {
      return {
        subject: { externalId: reportedId, type: 'custom.test.doodad' },
        content: { type: 'text', data: { text: 'a reported doodad' } },
      };
    },
  };
}

export function testEnforcement(
  widgets: Model<TestWidget>,
): ModerationEnforcementConfig<TestAction> {
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
        /**
         * A subject type with no lever of its own. `recordedAs` corrects the
         * label so the report does not read "decided: restore" about an object
         * that was never restricted — the plan could not know, and this is the
         * only place that does.
         */
        return {
          changed: false,
          reason: `No '${action}' effect for a ${subject.type}`,
          recordedAs: 'none',
        };
      }
      if (!mongoose.isValidObjectId(subject.id)) {
        return { changed: false, reason: 'The reported widget no longer exists' };
      }
      const widget = await widgets.findById(subject.id).lean<TestWidget | null>();
      if (!widget) return { changed: false, reason: 'The reported widget no longer exists' };

      switch (action) {
        case 'restrict': {
          if (widget.status === 'restricted') {
            return { changed: false, reason: 'The widget was already restricted' };
          }
          await widgets.updateOne({ _id: subject.id }, { $set: { status: 'restricted' } });
          return { changed: true, previousState: { status: widget.status } };
        }
        case 'restore': {
          if (widget.status !== 'restricted') {
            return { changed: false, reason: 'The widget was not restricted' };
          }
          const restoreTo = previousState?.status;
          await widgets.updateOne(
            { _id: subject.id },
            { $set: { status: typeof restoreTo === 'string' ? restoreTo : 'published' } },
          );
          return { changed: true, previousState: { status: 'restricted' } };
        }
        case 'flag': {
          if (widget.flagged) return { changed: false, reason: 'Already flagged' };
          await widgets.updateOne({ _id: subject.id }, { $set: { flagged: true } });
          return { changed: true, previousState: { flagged: false } };
        }
        case 'unflag': {
          if (previousState === undefined) {
            return { changed: false, reason: 'The flag was not set by moderation' };
          }
          if (!widget.flagged) return { changed: false, reason: 'Not flagged' };
          await widgets.updateOne({ _id: subject.id }, { $set: { flagged: false } });
          return { changed: true, previousState: { flagged: true } };
        }
      }
    },
  };
}

function legacyStatusFor(decision: Decision): { legacyStatus: string } {
  switch (decision.outcome) {
    case 'violation':
      return { legacyStatus: 'resolved' };
    case 'no_violation':
      return { legacyStatus: 'dismissed' };
    default:
      return { legacyStatus: 'reviewed' };
  }
}

let databaseCounter = 0;

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const uri = process.env.CROWDSOURCE_APP_TEST_MONGODB_URI;
  if (uri === undefined) {
    throw new Error(
      'CROWDSOURCE_APP_TEST_MONGODB_URI is unset: vitest.globalSetup.ts did not run.',
    );
  }

  databaseCounter += 1;
  const connection = mongoose.createConnection(uri, {
    dbName: `crowdsource_app_test_${process.pid}_${databaseCounter}`,
  });
  await connection.asPromise();

  const WidgetSchema = new Schema<TestWidget>({
    body: { type: String, required: true },
    ownerId: { type: String, required: true },
    status: { type: String, required: true, default: 'published' },
    flagged: { type: Boolean, required: true, default: false },
  });
  const widgets = connection.model<TestWidget>('Widget', WidgetSchema);

  const ReportSchema = new Schema<TestReport>(
    {
      ...moderationReportSchemaFields({
        reportedTypes: ['widget', 'gizmo', 'doodad'],
        categories: ['spam', 'harassment', 'other'],
      }),
      legacyStatus: { type: String, required: true, default: 'pending' },
    },
    { timestamps: true },
  );
  applyModerationReportIndexes(ReportSchema);
  const reports = connection.model<TestReport>('Report', ReportSchema);
  await widgets.init();

  const logs: Harness['logs'] = [];
  const store = mongooseModerationStore<TestReport>({
    connection,
    reportModel: reports,
    enforcementActions: TEST_ACTIONS,
  });
  const moderation = createModerationIntegration({
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
    subjects: options.subjects ?? [widgetSubjectProvider(widgets), doodadSubjectProvider()],
    taxonomy: testTaxonomy(),
    enforcement: options.enforcement ?? testEnforcement(widgets),
    logger: recordingLogger(logs),
    reportDecisionExtraFields: legacyStatusFor,
  });

  /**
   * The unique indexes are the mechanism under test in several files, so they
   * must exist before the first write rather than whenever mongoose gets round
   * to it. One call now covers the three collections this package owns AND the
   * application's own report model.
   */
  await store.ensureSchema();

  /**
   * The same three models the store registered — `registerModerationModels`
   * reuses whatever is already on the connection — so the façade reads exactly
   * the rows the pipeline wrote.
   */
  const models = registerModerationModels({ connection, enforcementActions: TEST_ACTIONS });
  /**
   * A second instance of a stateless wrapper over the SAME store, not a second
   * outbox. It is what gives the façade a policy-level `claim`/`complete`
   * without a test restating the lease and backoff arithmetic.
   */
  const service = createOutboxService({ store: store.outbox, logger: recordingLogger(logs) });

  return {
    moderation,
    logs,

    app: {
      async createWidget(input) {
        const created = await widgets.create({
          body: input.body,
          ownerId: input.ownerId,
          ...(input.status === undefined ? {} : { status: input.status }),
        });
        return String(created._id);
      },
      async readWidget(id) {
        if (!mongoose.isValidObjectId(id)) return null;
        const row = await widgets.findById(id).lean<TestWidget | null>();
        return row === null ? null : { status: row.status, flagged: row.flagged };
      },
      async readReport(id) {
        if (!mongoose.isValidObjectId(id)) return null;
        const row = await reports.findById(id).lean<(TestReport & { _id: unknown }) | null>();
        return row === null ? null : Object.assign(row, { id: String(row._id) });
      },
      async countReports() {
        return await reports.countDocuments({});
      },
      /** A syntactically valid ObjectId that was never stored. */
      absentId() {
        return String(new mongoose.Types.ObjectId());
      },
    },

    outbox: mongooseOutboxFacade({ model: models.outbox, store, service }),
    events: mongooseEventsFacade(models.event),
    enforcement: mongooseEnforcementFacade(models.enforcement),

    transaction: {
      async run(operation) {
        await store.transaction.run(async (session) => {
          await operation(async (input) => {
            await service.enqueue(input, session);
          });
        });
      },
    },

    async detachedEnqueue() {
      /**
       * A bare `startSession()`: it satisfies the required parameter, it
       * type-checks perfectly, and the row it writes would commit on its own.
       * That is the mistake the guard exists for, so the fixture has to be able
       * to make it.
       */
      const session = await connection.startSession();
      return {
        enqueue: async (input) => {
          await service.enqueue(input, session);
        },
        async dispose() {
          await session.endSession();
        },
      };
    },

    async close() {
      await moderation.dispatcher.stop();
      moderation.reconciliationJob.stop();
      await connection.dropDatabase();
      await connection.close();
    },
  };
}

/**
 * This backend, as the suite sees it.
 *
 * One entry today. Task 11 adds the Postgres one and the five storage files run
 * `describe.each` over both — which is the reason nothing above returns a
 * connection, a model or a transaction handle.
 */
export const mongooseBackend: ModerationBackend = {
  name: 'mongoose',
  createHarness,
};
