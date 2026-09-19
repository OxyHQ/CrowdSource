import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  ModerationEnforcementKey,
  ModerationEnforcementStore,
} from '../../store/types.js';
import type { ModerationTables } from '../tables.js';
import type { ModerationPgHandle } from './transaction.js';

/**
 * The enforcement ledger, in Postgres.
 *
 * Two operations carry everything: the CLAIM that makes an action happen at most
 * once, and the reversal LOOKUP that decides what a correction puts back. Two of
 * this package's eleven proven mutations attack the second one, which makes its
 * predicate the most load-bearing SQL in the Postgres half.
 *
 * ## The idempotency key IS the primary key
 *
 * `decision_id + decision_revision + action`. Mongo needed a surrogate `_id` plus
 * a unique index on that triple; here the triple is the key, so
 * `onConflictDoNothing()` needs no explicit `target` — there is only one
 * constraint it could mean — and there is no second object to keep in step.
 *
 * `decision_revision` being IN the key is what lets a correction act: a new
 * revision is a different row, so the restore it asks for is allowed to happen
 * while still being impossible to apply twice itself.
 *
 * ## Addressed by the key, never by a record id
 *
 * Every write after the claim addresses the row by the same three values the
 * claim used. PostgreSQL reaches it through the composite primary key, so no
 * opaque record id crosses the port.
 */
export function postgresEnforcementStore(input: {
  db: ModerationPgHandle;
  tables: ModerationTables;
}): ModerationEnforcementStore {
  const { db } = input;
  const enforcements = input.tables.enforcements;

  /** The primary key, as a predicate. Addresses at most one row, by construction. */
  const keyFilter = (key: ModerationEnforcementKey) =>
    and(
      eq(enforcements.decisionId, key.decisionId),
      eq(enforcements.decisionRevision, key.decisionRevision),
      eq(enforcements.action, key.action),
    );

  return {
    async claim(row) {
      /**
       * The insert IS the check, and a lost race is zero rows rather than an
       * error — the same shape as the event store's claim, and for the same
       * reason: there is no catch block whose predicate could be widened into
       * swallowing a real fault as "another delivery already handled it".
       *
       * `created_at` and `updated_at` are written from the caller's `now`. The
       * Mongo store lets Mongoose own them; here nothing does, and the reversal
       * lookup ORDERS BY `created_at`, so the clock that decides which row is
       * "most recent" is the caller's rather than two different defaults'.
       */
      const rows = await db
        .insert(enforcements)
        .values({
          decisionId: row.decisionId,
          decisionRevision: row.decisionRevision,
          action: row.action,
          caseId: row.caseId,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          outcome: row.outcome,
          ...(row.recommendedAction === undefined
            ? {}
            : { recommendedAction: row.recommendedAction }),
          reason: row.reason,
          mode: row.mode,
          applied: false,
          createdAt: row.now,
          updatedAt: row.now,
        })
        .onConflictDoNothing()
        .returning({ decisionId: enforcements.decisionId });

      return rows.length === 1;
    },

    async markSkipped(key, { skippedReason, recordedAs, now }) {
      await db
        .update(enforcements)
        .set({
          skippedReason,
          // Absent means leave it: `recorded_as` only carries a value when the
          // effect said the planned action amounted to something else.
          ...(recordedAs === undefined ? {} : { recordedAs }),
          updatedAt: now,
        })
        .where(keyFilter(key));
    },

    async markApplied(key, { appliedAt, previousState, now }) {
      await db
        .update(enforcements)
        .set({
          applied: true,
          appliedAt,
          /**
           * Written as `jsonb`, so it round-trips as the object it was rather
           * than as its `JSON.stringify` — a `text` column would hand a reversal
           * a string, and `previousState?.status` on a string is `undefined`,
           * which reads as "moderation displaced nothing" and restores a guess.
           *
           * Absent means leave it NULL: an action that changed state records what
           * it displaced, and one that did not must not claim it displaced
           * nothing-in-particular.
           */
          ...(previousState === undefined ? {} : { previousState }),
          updatedAt: now,
        })
        .where(keyFilter(key));
    },

    async releaseClaim(key) {
      await db.delete(enforcements).where(keyFilter(key));
    },

    async latestApplied({ subjectType, subjectId, actions }) {
      /**
       * The reversal lookup, and every clause in it is load-bearing.
       *
       * `eq(applied, true)` — a row that was RECORDED and never carried out
       * describes a state change that never happened, and it carries no
       * `previous_state` at all. Reading it hands a reversal nothing and the
       * application's fallback publishes a draft moderation only ever hid.
       *
       * `inArray(action, actions)` — one action may reverse several. The most
       * recent APPLIED row across the whole declared set wins, so `apply`
       * receives whatever actually happened last rather than whichever action
       * happens to be first in the array. Note the membership is POSITIVE: a
       * negated set (`not in (…)`) would render as `<> ALL (…)`, which no btree
       * can serve, and the supporting index would quietly stop being used.
       *
       * `created_at desc NULLS LAST` with `limit(1)` — newest first, and the
       * NULLS placement is written out because drizzle's two spellings of "desc"
       * DISAGREE and the difference is a blocking sort.
       *
       * Measured on Postgres 17. `.desc()` inside a drizzle INDEX emits
       * `DESC NULLS LAST`; `desc(column)` in an ORDER BY emits plain `DESC`,
       * which in Postgres means NULLS FIRST. Those two orderings do not match, so
       * no index can satisfy the sort and the plan gains a `Sort` node — even
       * though `created_at` is NOT NULL and the two orderings can differ by
       * nothing at all. With `nulls last` the plan is a plain index scan under
       * the Limit:
       *
       *     desc            -> Limit → Sort (created_at DESC) → Index Scan …
       *     desc nulls last -> Limit → Index Scan …
       *
       * Correct results either way, and a sort that grows with the number of
       * enforcement rows for one subject. `postgresEnforcementStore.test.ts`
       * asserts the absence of that `Sort` against the real planner.
       */
      const rows = await db
        .select({
          action: enforcements.action,
          previousState: enforcements.previousState,
        })
        .from(enforcements)
        .where(
          and(
            eq(enforcements.subjectType, subjectType),
            eq(enforcements.subjectId, subjectId),
            inArray(enforcements.action, [...actions]),
            eq(enforcements.applied, true),
          ),
        )
        .orderBy(sql`${enforcements.createdAt} desc nulls last`)
        .limit(1);

      const [row] = rows;
      if (row === undefined) return null;
      return {
        action: row.action,
        ...(row.previousState === null ? {} : { previousState: row.previousState }),
      };
    },
  };
}
