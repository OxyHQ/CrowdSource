import { and, asc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { ModerationOutboxTransactionError } from '../../outbox/service.js';
import type { ModerationOutboxStore } from '../../store/types.js';
import type { ModerationOutboxEvent } from '../../types.js';
import type { ModerationTables } from '../tables.js';
import type { ModerationPgHandle } from './transaction.js';

/**
 * The moderation outbox, in Postgres.
 *
 * Same six operations as the Mongo store, same policy handed down from the
 * service above it, four places where the mechanism differs — and each of those
 * is where the correctness lives:
 *
 * 1. **The transaction guard is `instanceof PgTransaction`.** Mongo's equivalent
 *    asks a session whether a transaction is open; here the mistake is passing
 *    the POOL handle where the `tx` belongs, which runs on a different connection
 *    and commits independently. Same lost guarantee, different shape, and it
 *    type-checks perfectly because both are `ModerationPgHandle`.
 * 2. **The insert-if-absent is `ON CONFLICT DO NOTHING`.** A no-op by
 *    construction rather than by suppressing an ORM's timestamp behaviour: it
 *    writes nothing and takes no row lock on an already-committed conflicting
 *    row. Never `DO UPDATE` — that reintroduces exactly the defect the Mongo
 *    side's `timestamps: false` exists to prevent.
 * 3. **The claim is `FOR UPDATE SKIP LOCKED`.** Load-bearing, not tuning: see
 *    `claim`.
 * 4. **Every lease transition asks `RETURNING` how many rows matched.**
 */

/** The columns a claimed event is read back through. */
type ClaimedRow = {
  id: string;
  kind: ModerationOutboxEvent['kind'];
  payload: ModerationOutboxEvent['payload'];
  attempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  expiresAt: Date;
  createdAt: Date;
};

export function postgresOutboxStore(input: {
  db: ModerationPgHandle;
  tables: ModerationTables;
}): ModerationOutboxStore<ModerationPgHandle> {
  const { db } = input;
  const outbox = input.tables.outbox;

  /**
   * Due work, as one predicate.
   *
   * Either `pending` and past its `available_at`, or `processing` with an EXPIRED
   * lease — the second arm is what makes a dead worker's event reclaimable rather
   * than stranded. The two arms have an index each
   * (`moderation_outbox_due_idx`, `moderation_outbox_lease_idx`).
   */
  const dueOrExpired = (now: Date) =>
    or(
      and(eq(outbox.status, 'pending'), lte(outbox.availableAt, now)),
      and(eq(outbox.status, 'processing'), lte(outbox.leaseUntil, now)),
    );

  /** The lease this caller claims to hold, still live. Shared by all three transitions. */
  const heldLease = (eventId: string, leaseOwner: string, now: Date) =>
    and(
      eq(outbox.id, eventId),
      eq(outbox.status, 'processing'),
      eq(outbox.leaseOwner, leaseOwner),
      gt(outbox.leaseUntil, now),
    );

  const toEvent = (row: ClaimedRow): ModerationOutboxEvent => ({
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    attempts: row.attempts,
    availableAt: row.availableAt,
    // `null` is how Postgres stores "no lease"; the event type says absent.
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseUntil === null ? {} : { leaseUntil: row.leaseUntil }),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  });

  return {
    async enqueue(event, tx) {
      /**
       * The guard, and it is not the same mistake Mongo's guards against.
       *
       * Both `db` and `tx` are a `ModerationPgHandle`, so handing this the POOL
       * handle type-checks perfectly — and then the row commits on its own
       * connection, independently of the domain write it was supposed to be
       * atomic with. That is "the report was answered 201 and never delivered",
       * reached by a different route than a session nobody opened a transaction
       * on, with the same silence.
       *
       * `PgTransaction` is a real runtime class in `drizzle-orm/pg-core`, so this
       * is a genuine check rather than a duck-typed guess.
       */
      if (!(tx instanceof PgTransaction)) {
        throw new ModerationOutboxTransactionError(event.eventId);
      }

      /**
       * `ON CONFLICT DO NOTHING`, never `DO UPDATE`.
       *
       * A repeated enqueue is ORDINARY — a transaction retry, two concurrent
       * duplicate submissions, a reconciliation sweep re-deriving an event — and
       * the dispatcher is concurrently taking, renewing and completing leases on
       * these same rows. `DO UPDATE` would make each repeat a real write, which
       * conflicts with a live lease update and aborts the enclosing transaction:
       * the exact defect the Mongo store's `timestamps: false` exists to prevent,
       * reintroduced in a dialect where nothing forces it on you.
       *
       * One behavioural difference from Mongo, and Postgres has the better end of
       * it: if a CONCURRENT UNCOMMITTED transaction holds this same key, Postgres
       * WAITS for it and then proceeds (finding the row committed, and doing
       * nothing), where Mongo raises `WriteConflict` (code 112) and aborts the
       * enclosing transaction. Waiting is the outcome a caller wants.
       *
       * `created_at` and `updated_at` are written explicitly from the caller's
       * clock rather than left to their defaults, so both backends stamp a row
       * from one instant — and so a test can assert that a repeat changed
       * NOTHING, which is a stronger claim than "no duplicate row".
       */
      await tx
        .insert(outbox)
        .values({
          id: event.eventId,
          kind: event.kind,
          payload: event.payload,
          status: 'pending',
          attempts: 0,
          availableAt: event.availableAt,
          expiresAt: event.expiresAt,
          createdAt: event.now,
          updatedAt: event.now,
        })
        .onConflictDoNothing({ target: outbox.id });
    },

    async claim({ leaseOwner, leaseUntil, now, eventId }) {
      /**
       * `SKIP LOCKED` is load-bearing, not tuning.
       *
       * Without it, under READ COMMITTED the sub-select is evaluated once: the
       * loser blocks on the head row and then returns ZERO rows. `claim` answers
       * `null`, `dispatch` breaks out of its batch, and a deployment running N
       * tasks silently drains at 1/N the rate with nothing failing anywhere.
       *
       * The `FOR UPDATE` lives in the SUB-SELECT because that is what locks the
       * one row this claim intends to take, before the UPDATE touches it — the
       * documented Postgres idiom for a work queue.
       */
      const due = db
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          eventId === undefined
            ? dueOrExpired(now)
            : and(eq(outbox.id, eventId), dueOrExpired(now)),
        )
        // Oldest first, so a backlog drains in the order it was filed rather than
        // in whatever order the storage engine finds convenient.
        .orderBy(asc(outbox.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });

      const rows = await db
        .update(outbox)
        .set({
          status: 'processing',
          leaseOwner,
          leaseUntil,
          // The COLUMN is interpolated, not a value: `attempts` is incremented by
          // the database so two claimers cannot both read 3 and both write 4.
          attempts: sql`${outbox.attempts} + 1`,
          // The previous attempt's error, cleared with the claim so a stale
          // message can never be read as this attempt's. `null` CLEARS in
          // drizzle; `undefined` would leave it alone.
          lastError: null,
          updatedAt: now,
        })
        .where(inArray(outbox.id, due))
        .returning({
          id: outbox.id,
          kind: outbox.kind,
          payload: outbox.payload,
          attempts: outbox.attempts,
          availableAt: outbox.availableAt,
          leaseOwner: outbox.leaseOwner,
          leaseUntil: outbox.leaseUntil,
          expiresAt: outbox.expiresAt,
          createdAt: outbox.createdAt,
        });

      const [row] = rows;
      return row === undefined ? null : toEvent(row);
    },

    /**
     * ## Why all three transitions read `RETURNING`, and what that collapses
     *
     * Mongo's `complete` and `fail` answer `modifiedCount === 1` while its
     * `renew` answers `matchedCount === 1`. `RETURNING` counts MATCHED rows, so
     * this store answers the `matchedCount` question in all three places.
     *
     * That is equivalent HERE, and the argument is worth writing down because it
     * is an argument rather than a test: the WHERE clause requires
     * `status = 'processing'`, and `complete` and `fail` both write a different
     * status, so a matched row is always a modified row. `renew` writes only
     * `lease_until`/`updated_at` and Mongo already used `matchedCount` for it —
     * a renewal that lands on the values already stored is still a lease this
     * caller holds, and reporting it as lost would make a dispatcher abandon an
     * event it still owns.
     *
     * If a later transition ever stops changing `status`, this equivalence stops
     * holding and the difference becomes silent.
     */
    async complete({ eventId, leaseOwner, now }) {
      const rows = await db
        .update(outbox)
        .set({
          status: 'processed',
          processedAt: now,
          updatedAt: now,
          leaseOwner: null,
          leaseUntil: null,
          lastError: null,
        })
        .where(heldLease(eventId, leaseOwner, now))
        .returning({ id: outbox.id });
      return rows.length === 1;
    },

    async renew({ eventId, leaseOwner, leaseUntil, now }) {
      const rows = await db
        .update(outbox)
        .set({ leaseUntil, updatedAt: now })
        .where(heldLease(eventId, leaseOwner, now))
        .returning({ id: outbox.id });
      return rows.length === 1;
    },

    async fail({ eventId, leaseOwner, status, availableAt, lastError, now }) {
      const rows = await db
        .update(outbox)
        .set({
          status,
          availableAt,
          lastError,
          updatedAt: now,
          leaseOwner: null,
          leaseUntil: null,
        })
        .where(heldLease(eventId, leaseOwner, now))
        .returning({ id: outbox.id });
      return rows.length === 1;
    },

    async statusOf(eventId) {
      const rows = await db
        .select({ status: outbox.status })
        .from(outbox)
        .where(eq(outbox.id, eventId))
        .limit(1);
      const [row] = rows;
      return row === undefined ? null : row.status;
    },
  };
}
