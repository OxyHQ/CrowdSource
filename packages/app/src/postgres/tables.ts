import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, timestamptz, updatedAt } from '@oxyhq/db';
import type {
  EnforcementPreviousState,
  ModerationEnforcementMode,
  ModerationOutboxKind,
  ModerationOutboxPayload,
  ModerationOutboxStatus,
} from '../types.js';

/**
 * The three tables this package owns, in Postgres.
 *
 * A direct port of `src/mongoose/models.ts`, table for table, index for index —
 * the same names, so a deployment can be read side by side with a Mongo one, and
 * the same design arguments, because those are about moderation rather than
 * about a driver. Where a Mongo comment explains WHY a field exists, it is
 * repeated on the column: the reasoning is what a future reader needs, and it is
 * not carried by the DDL.
 *
 * Three things differ, and each is a property of Postgres rather than a choice:
 *
 * 1. **A closed value set is `text` plus a CHECK built from the same tuple that
 *    types it**, never a Postgres `enum` type. Adding an enforcement action
 *    becomes a migration where Mongo only needed a restart, which is the correct
 *    trade: a stored action outside the declared set is exactly what the
 *    constraint exists to refuse.
 * 2. **The TTL indexes have no counterpart.** Postgres does not reap. Each
 *    `expires_at` keeps its index — the sweep's predicate needs it — and the
 *    reaping itself becomes an entry in the adopter's expiry registry; see
 *    `moderationExpirySweepTargets` in `registries.ts`. A table ported without
 *    one grows forever, with no error and no failing test.
 * 3. **The enforcement unique index IS the primary key.** Mongo needed a
 *    surrogate `_id` plus a unique index on the idempotency triple; here the
 *    triple is the primary key, so there is no second object to keep in step.
 *
 * Every column is named EXPLICITLY. Drizzle can derive a snake_case name from
 * the property, and its derivation mangles digit- and capital-adjacent names
 * (`cacheS3Key` becomes `cache_s_3_key` — a working column with a name nobody
 * chose). The SQL name has to match what the adopter's migration created, so it
 * is written down here rather than computed.
 */

/**
 * `timestamptz()` from `@oxyhq/db` takes NO name argument, so these column names
 * are DERIVED from the property by `DATABASE_CASING` rather than written out.
 *
 * That is the one exception to naming every column explicitly, and it is the
 * package's decision rather than this one's: the builder's whole point is that
 * "timestamps are `timestamptz`" is decided once, and re-implementing it here
 * with `timestamp(name, { withTimezone: true })` would be a second copy of the
 * rule that could drift. Every derived name in this file is a plain two-word
 * property (`availableAt`, `expiresAt`, …) with no digit and no adjacent capital,
 * so the derivation has nothing to mangle — and `postgresSchema.test.ts` asserts
 * the EXACT column-name set of every table against the real catalogue, which is
 * what would catch a derivation surprise rather than this comment.
 */

/**
 * The three table names, spelled out rather than imported from the Mongo half.
 *
 * They are deliberately the SAME strings as the `MODERATION_*_COLLECTION`
 * constants, so one deployment can be read beside the other — but importing them
 * from `src/mongoose/models.js` would pull `mongoose` into the Postgres path and
 * undo the whole point of an optional peer: a Postgres-only deployment would
 * have to install a driver it never uses. `postgresSchema.test.ts` asserts the
 * two sets of names agree, which is the only place both halves may be imported
 * at once.
 */
const OUTBOX_TABLE = 'moderation_outbox';
const EVENT_TABLE = 'moderation_events';
const ENFORCEMENT_TABLE = 'moderation_enforcements';

/** The two kinds of work this package enqueues. Types the column and its CHECK. */
const OUTBOX_KINDS = ['report.submit', 'decision.apply'] as const;
const OUTBOX_STATUSES = ['pending', 'processing', 'processed', 'dead_letter'] as const;
const EVENT_STATES = ['claimed', 'queued', 'ignored'] as const;
const ENFORCEMENT_MODES = [
  'observe',
  'manual',
  'automatic',
] as const satisfies readonly ModerationEnforcementMode[];

/**
 * Build the three tables.
 *
 * Call this ONCE and export the result. Two calls produce two distinct sets of
 * drizzle table objects for the same SQL names, and drizzle-kit would then see
 * the schema twice.
 *
 * `enforcementActions` is the adopter's own action union. It types the CHECK on
 * `action` and `recorded_as`, which is why the tables are a function rather than
 * module-level constants.
 */
export function moderationTables(options: { enforcementActions: readonly string[] }) {
  const actions = inList(options.enforcementActions);

  /**
   * The durable record of moderation work that has to happen but has not
   * happened yet.
   *
   * This table is what makes the intake guarantee true. A 201 from an
   * application's report route means the report and its outbox row committed in
   * ONE transaction — not that a call to CrowdSource succeeded. Delivery is a
   * separate, retried step, and the user is never made to wait for a third party
   * to be reachable.
   *
   * The same shape carries work in the other direction. A decision arriving over
   * a webhook is answered 2xx as soon as it is recorded here, and applied
   * afterwards. Nothing is enqueued that is not already written down: if the
   * dispatcher, the process or the whole task disappears, every pending piece of
   * moderation work is re-derivable by reading this table.
   */
  const outbox = pgTable(
    OUTBOX_TABLE,
    {
      /**
       * The deterministic event id — `moderation:report.submit:<reportId>` or
       * `moderation:decision.apply:<eventId>`.
       *
       * The primary key, and that is the mechanism rather than a convention: it
       * is what makes a repeated enqueue a no-op instead of a second delivery.
       * `text` rather than a generated id, because the WRITER computes it from
       * the report or the inbound event.
       */
      id: text('id').primaryKey(),
      /**
       * `$type` on the closed sets, so a row read back is typed as the union the
       * CHECK already enforces rather than as a bare `string` the store would
       * have to assert. TypeScript-only: it changes no DDL.
       */
      kind: text('kind').$type<ModerationOutboxKind>().notNull(),
      /**
       * The payload, stored whole and opaque.
       *
       * `jsonb` rather than columns: a decision document is deliberately loose,
       * and a projection would silently drop whatever a newer CrowdSource added.
       * It is validated against the published contract when it is READ, so an
       * event is never lost to a schema this deployment has not caught up with.
       */
      payload: jsonb('payload').$type<ModerationOutboxPayload>().notNull(),
      status: text('status').$type<ModerationOutboxStatus>().notNull().default('pending'),
      /** Counted by the claim; the retry ceiling reads it. */
      attempts: integer('attempts').notNull().default(0),
      availableAt: timestamptz().notNull(),
      leaseOwner: text('lease_owner'),
      leaseUntil: timestamptz(),
      /**
       * The last delivery error, bounded.
       *
       * `varchar(2000)` matches the Mongoose `maxlength`, and the application
       * slices to the same 2000 before writing. Both halves are needed: a
       * Mongoose validator THROWS on overflow and Postgres errors `22001`, so
       * the slice is what makes the two dialects agree rather than one of them
       * failing a delivery over an error message.
       */
      lastError: varchar('last_error', { length: 2_000 }),
      processedAt: timestamptz(),
      /** The retention deadline. Swept, not reaped — see the registry. */
      expiresAt: timestamptz().notNull(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (t) => [
      check(
        'moderation_outbox_kind_check',
        sql`${t.kind} in (${sql.raw(inList(OUTBOX_KINDS))})`,
      ),
      check(
        'moderation_outbox_status_check',
        sql`${t.status} in (${sql.raw(inList(OUTBOX_STATUSES))})`,
      ),
      // Due work and expired claims are separate bounded scans.
      index('moderation_outbox_due_idx').on(t.status, t.availableAt, t.createdAt),
      index('moderation_outbox_lease_idx').on(t.status, t.leaseUntil, t.createdAt),
      // The sweep's predicate is `expires_at <= now()`; without this it is a
      // full scan on every run — the cost Mongo's TTL index hid.
      index('moderation_outbox_expires_at_idx').on(t.expiresAt),
    ],
  );

  /**
   * Every webhook event CrowdSource has delivered to this deployment.
   *
   * Two jobs, and they are the same row on purpose.
   *
   * **Deduplication.** A receiver must record the processed event id. `id` IS
   * the event id, so the primary key is the dedupe: a redelivery cannot insert a
   * second row, and a claim therefore cannot succeed twice. Doing this in the
   * database rather than in the SDK's default in-process store is not
   * optimisation — an application running several tasks behind one load balancer
   * would otherwise dedupe only whichever task happened to receive both copies.
   *
   * **Audit.** What arrived, when, and whether it was acted on. `payload` is the
   * event's `data` exactly as delivered.
   *
   * The stored payload is a decision — an outcome, findings, policy versions, a
   * jury summary. It is not the reported material and must not become a place
   * where reported material is kept: nothing in this table is read into a log
   * line.
   */
  const events = pgTable(
    EVENT_TABLE,
    {
      /** The webhook event id. The primary key IS the deduplication. */
      id: text('id').primaryKey(),
      type: text('type'),
      caseId: text('case_id'),
      payload: jsonb('payload'),
      state: text('state').$type<(typeof EVENT_STATES)[number]>().notNull().default('claimed'),
      receivedAt: timestamptz().notNull(),
      queuedAt: timestamptz(),
      expiresAt: timestamptz().notNull(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (t) => [
      check(
        'moderation_events_state_check',
        sql`${t.state} in (${sql.raw(inList(EVENT_STATES))})`,
      ),
      index('moderation_events_case_id_idx').on(t.caseId),
      // Operational: what arrived recently, and what never got past `claimed`.
      index('moderation_events_state_received_at_idx').on(t.state, t.receivedAt),
      index('moderation_events_expires_at_idx').on(t.expiresAt),
    ],
  );

  /**
   * What the application did about a decision — one row per action, and the
   * reason it is impossible to do twice.
   *
   * The idempotency key is `decision_id + decision_revision + action`, and here
   * it is the PRIMARY KEY. That is the whole mechanism: a redelivered webhook, a
   * reclaimed outbox lease and a manual replay all try to insert the same row,
   * and only the first can. Checking "have I done this?" with a read before a
   * write would leave the window between them, which is precisely the window a
   * redelivery arrives in.
   *
   * `decision_revision` is in the key for a reason of its own. A correction is a
   * NEW revision that supersedes the old one, so the restore it asks for is a
   * different action from the removal that came before and must be allowed to
   * happen — while still being impossible to apply twice itself.
   *
   * `previous_state` is what makes reversibility real rather than aspirational.
   * It is the application's own opaque record of what an effect replaced, so a
   * restore returns an object to what it WAS and a correction does not silently
   * lift a content warning moderation never set.
   */
  const enforcements = pgTable(
    ENFORCEMENT_TABLE,
    {
      decisionId: text('decision_id').notNull(),
      decisionRevision: integer('decision_revision').notNull(),
      action: text('action').notNull(),

      caseId: text('case_id').notNull(),
      /** The application's own noun. Never a CrowdSource resource id. */
      subjectType: text('subject_type').notNull(),
      subjectId: text('subject_id').notNull(),

      outcome: text('outcome').notNull(),
      recommendedAction: text('recommended_action'),
      /**
       * What the action amounted to, when the effect said it was not what was
       * planned. The `action` column stays the PLANNED one — it is part of the
       * primary key and it is what was decided.
       */
      recordedAs: text('recorded_as'),
      /** Why this action, in words an operator can read. Never reported material. */
      reason: varchar('reason', { length: 500 }).notNull(),

      mode: text('mode').$type<(typeof ENFORCEMENT_MODES)[number]>().notNull(),
      /**
       * Whether the effect was actually carried out.
       *
       * `false` in `observe` mode for every action, which is the point of the
       * mode: the plan is recorded and auditable, and nothing is removed.
       */
      applied: boolean('applied').notNull().default(false),
      appliedAt: timestamptz(),
      /** Why an action was recorded but not carried out. */
      skippedReason: varchar('skipped_reason', { length: 300 }),

      /**
       * What to put back on a reversal. Only set for an action that changed
       * state, so NULL here means "this action displaced nothing" — which is a
       * different claim from "we did not look", and is why the reversal lookup
       * filters on `applied` rather than reading whichever row is newest.
       */
      previousState: jsonb('previous_state').$type<EnforcementPreviousState>(),

      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (t) => [
      /**
       * The idempotency key. Unique because it is the PRIMARY KEY, and
       * load-bearing: without it a redelivered decision removes an object twice,
       * and a redelivered correction restores it twice.
       */
      primaryKey({
        name: 'moderation_enforcements_pkey',
        columns: [t.decisionId, t.decisionRevision, t.action],
      }),
      check('moderation_enforcements_revision_check', sql`${t.decisionRevision} >= 1`),
      check('moderation_enforcements_action_check', sql`${t.action} in (${sql.raw(actions)})`),
      check(
        'moderation_enforcements_recorded_as_check',
        sql`${t.recordedAs} is null or ${t.recordedAs} in (${sql.raw(actions)})`,
      ),
      check(
        'moderation_enforcements_mode_check',
        sql`${t.mode} in (${sql.raw(inList(ENFORCEMENT_MODES))})`,
      ),
      index('moderation_enforcements_case_id_idx').on(t.caseId),
      // Operational: what has been done to this object, newest first.
      index('moderation_enforcements_subject_chrono_idx').on(
        t.subjectType,
        t.subjectId,
        t.createdAt.desc(),
      ),
      // The reversal lookup: the most recent APPLIED row for one action set on
      // one object. `applied` is in the index because it is in every such query.
      index('moderation_enforcements_subject_action_applied_idx').on(
        t.subjectType,
        t.subjectId,
        t.action,
        t.applied,
        t.createdAt.desc(),
      ),
    ],
  );

  return { outbox, events, enforcements };
}

export type ModerationTables = ReturnType<typeof moderationTables>;
