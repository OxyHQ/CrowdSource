import { eq } from 'drizzle-orm';
import type { ModerationEventStore } from '../../store/types.js';
import type { ModerationTables } from '../tables.js';
import type { ModerationPgHandle } from './transaction.js';

/**
 * The inbound webhook event log, in Postgres.
 *
 * ## The one place this backend is structurally better rather than equivalent
 *
 * Everything else in this port aims for parity. This claim does not: it removes a
 * failure mode instead of handling it, and the difference is worth being precise
 * about, because "better" is otherwise just an adjective.
 *
 * **Mongo's claim throws and catches.** It inserts, and reads `code === 11000` to
 * tell "somebody else has this event" from a real fault; everything that is not
 * 11000 is rethrown, so a lost connection or a failover answers non-2xx and the
 * event stays on the sender's retry schedule. That property is correct — and it
 * lives in a PREDICATE. `catch { return false }` is one keystroke away, it
 * type-checks, and it turns a connection failure into "already processed": the
 * receiver answers 200 and a decision is retired that nobody ever handled. The
 * only thing standing between those two behaviours is a conditional somebody
 * could widen, and a test can only catch that by injecting a driver failure.
 *
 * **Postgres's claim does not throw at all.** `ON CONFLICT DO NOTHING` plus
 * `RETURNING` makes a duplicate a ROW COUNT rather than an error: one row means
 * this call took the claim, zero means somebody else holds it. So there is no
 * catch block here — and therefore
 *
 *   - no predicate to widen,
 *   - no code path that can convert a fault into a negative answer,
 *   - and the "rethrow everything else" guarantee holds by the ABSENCE of code
 *     rather than by the presence of correct code.
 *
 * That is the mechanism: the Mongo version is a property of code that exists and
 * can be edited wrongly; this one is a property of code that does not exist. Only
 * the second cannot be broken by a well-meaning change.
 *
 * The consequence for the mutation suite, stated because its absence would
 * otherwise look like a gap: there is nothing to DELETE on the insert side, so no
 * mutation can attack it. The one that exists attacks the READ — `rows.length === 1`
 * collapsing to `true`, which would hand the same event to two handlers.
 */
export function postgresEventStore(input: {
  db: ModerationPgHandle;
  tables: ModerationTables;
}): ModerationEventStore<ModerationPgHandle> {
  const { db } = input;
  const events = input.tables.events;

  return {
    async claim({ eventId, receivedAt, expiresAt }) {
      /**
       * The insert IS the claim, and a lost race is zero rows rather than an
       * exception. `created_at`/`updated_at` are left to their column defaults:
       * unlike the outbox, nothing here needs a repeated write to be provably a
       * no-op, so the database's clock is the simpler authority.
       */
      const rows = await db
        .insert(events)
        .values({ id: eventId, state: 'claimed', receivedAt, expiresAt })
        .onConflictDoNothing({ target: events.id })
        .returning({ id: events.id });

      return rows.length === 1;
    },

    /** Give the claim back so a redelivery can be processed. */
    async release(eventId) {
      await db.delete(events).where(eq(events.id, eventId));
    },

    async markQueued({ eventId, type, caseId, payload, now }, tx) {
      /**
       * On the CALLER's transaction, which is the whole point: this row's
       * completion and the outbox row that carries the work commit together, or a
       * crash between them leaves an event permanently deduplicated with no work
       * queued — a decision silently lost, with a row saying it arrived.
       */
      await tx
        .update(events)
        .set({
          type,
          caseId,
          payload,
          state: 'queued',
          queuedAt: now,
          updatedAt: now,
        })
        .where(eq(events.id, eventId));
    },

    async markIgnored({ eventId, type, caseId, now }) {
      await db
        .update(events)
        .set({
          type,
          /**
           * Absent means LEAVE IT, not write something. An event type carrying no
           * case id is ordinary — `case.created` before a case is linked — and
           * `caseId: String(caseId)` would store the four characters `null` or
           * the nine characters `undefined`, which then reads as a case id
           * everywhere downstream. Postgres keeps the column NULL.
           */
          ...(caseId === undefined ? {} : { caseId }),
          state: 'ignored',
          updatedAt: now,
        })
        .where(eq(events.id, eventId));
    },
  };
}
