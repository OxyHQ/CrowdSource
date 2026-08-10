import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';

import { outboxEvents } from '../schema/infrastructure';
import type { TenantContext } from '../../tenantScope';
import { requireTransaction, type PgHandle, type PgTransactionHandle } from '../withTenant';
import {
  type OutboxEventPayload,
  type OutboxEventType,
  type OutboxStatus,
} from '../../../modules/outbox/outbox.collection';
import { newPublicId } from '../../../utils/identifiers';

/**
 * The transactional outbox, as a PostgreSQL repository.
 *
 * `outbox_events` is UNSCOPED — the dispatcher publishes across every tenant, so
 * a policy keyed on the runtime parameters would hide from it exactly the rows it
 * exists to claim. The registry files it under
 * `tenant_stamped_reached_through_parent` and that is what these signatures
 * reflect: `PgHandle` for the dispatcher's three, because it runs outside any
 * tenant, and a TRANSACTION for the append, for the reason below.
 *
 * NOTHING CALLS THIS IN PRODUCTION YET. `outboxRepository.realdb.test.ts` is what
 * makes these statements ones that have genuinely run rather than ones whose first
 * execution is in production.
 *
 * ## Why the append takes a transaction and the other three do not
 *
 * BullMQ runs on a single-node Valkey with no replica, no failover and no
 * snapshots, so a queued job can be lost outright. That is survivable only
 * because a domain write and its outbox row commit TOGETHER: if the queue is
 * wiped, every pending piece of work is still re-derivable by re-reading these
 * rows. A row written OUTSIDE that transaction is lost moderation work with no
 * trace, and it fails silently until the day a node is replaced.
 *
 * On Mongo the enforcement was a required `ClientSession` parameter. Here it is
 * two layers, and the second is not redundant:
 *
 *  1. `PgTransactionHandle` — drizzle's own `PgTransaction` type, which the pool
 *     is not assignable to. Passing the pool is a `tsc` error at every call site
 *     that is honestly typed, and `TenantScopedHandle` is branded onto it, so a
 *     domain service already inside `withTenant` passes its `tx` straight through
 *     with no cast.
 *  2. `requireTransaction` — the runtime half, for a handle that arrives through
 *     a cast, an `any` or a generic boundary, which is precisely the case the
 *     Mongo guard was written for.
 *
 * ## What NEITHER layer covers, said here so they are not read as sufficient
 *
 * Both prove the handle is A transaction. Neither proves it is THE SAME
 * transaction as the domain write it records — a caller holding two open
 * transactions and passing the wrong one satisfies both. No type closes that, in
 * either store, and the Mongo side had the identical gap.
 *
 * What closes it is a test, and only in one direction. A test that makes the
 * OUTBOX write fail and finds the domain write rolled back passes whether or not
 * the append ever joined the transaction, because the failure rolls the caller
 * back regardless. The discriminating case is the other way round: the append
 * SUCCEEDS and a later write in the same transaction throws, so the row survives
 * if and only if it escaped. That case, with a positive control beside it, is in
 * the realdb file and is the actual guarantee.
 *
 * ## Where the event vocabulary lives
 *
 * `OUTBOX_EVENT_TYPES`, `OUTBOX_STATUSES` and `OutboxEventPayload` are imported
 * from the Mongo collection file rather than restated here. They are domain
 * vocabulary that happens to sit beside a Mongoose schema, and two copies of a
 * closed value set is how they drift. At the switch that file loses its schema
 * and keeps the constants, which is a shrink rather than a move.
 */

/**
 * A row as the database returns it.
 *
 * `payload` is `unknown` because the column is `jsonb` and that is what drizzle
 * infers. It is NOT narrowed here, deliberately: there is no consumer yet, and the
 * narrowing belongs with the dispatcher at the switch, where a caller exists to
 * state what it expects. Narrowing now would be a claim nothing checks.
 */
export type OutboxEventRow = typeof outboxEvents.$inferSelect;

/**
 * The statuses a due row may be claimed from.
 *
 * `pending` and an EXPIRED `dispatching` both, because the second is crash
 * recovery — without it a dispatcher that died mid-handler would hold its rows
 * forever and nothing would say so. `failed` is absent on purpose: a dead letter
 * stays visible for an operator to replay rather than being retried forever.
 *
 * Typed as `OutboxStatus[]` so a typo is a compile error rather than a filter that
 * matches nothing — which would read as an empty queue.
 */
const CLAIMABLE_STATUSES: readonly OutboxStatus[] = ['pending', 'dispatching'];

/**
 * Appends an event inside the caller's transaction.
 *
 * The handle comes first, as everywhere in this layer, rather than second as in
 * the Mongo function this replaces. That is a visible edit at every call site at
 * the switch, which is the point — the two arguments have unrelated types, so
 * `tsc` decides it rather than a reviewer.
 *
 * COUNTED on 2026-08-10, because the switch has to touch all of them: ELEVEN call
 * sites across SEVEN files — `ingestion/report.service.ts` (2),
 * `decision/decision.service.ts` (3), `sortition/assignment.service.ts` (2), and
 * one each in `decision/revision.service.ts`, `appeals/appeal.service.ts`,
 * `triage/triage.worker.ts` and `review/review.service.ts`. That is not the same
 * number as the eight `withTransaction` boundaries they sit inside; several
 * transactions append more than one event, and conflating the two counts is how a
 * switch misses a file.
 */
export async function appendOutboxEvent(
  tx: PgTransactionHandle,
  context: TenantContext,
  event: { readonly type: OutboxEventType; readonly payload: OutboxEventPayload },
): Promise<string> {
  requireTransaction(tx);

  const eventId = newPublicId('outboxEvent');

  await tx.insert(outboxEvents).values({
    eventId,
    organizationId: context.organizationId,
    applicationId: context.applicationId,
    type: event.type,
    payload: event.payload,
    status: 'pending',
    attempts: 0,
    /**
     * Available immediately, as on Mongo. `created_at` and `updated_at` come from
     * the column defaults instead, which resolve to the TRANSACTION's `now()`
     * rather than this process's clock — a difference of milliseconds that
     * nothing reads, whereas `available_at` is compared against the dispatcher's
     * own clock and has to be a value this process chose.
     */
    availableAt: new Date(),
    dispatchedAt: null,
    lastError: null,
  });

  return eventId;
}

export interface OutboxClaim {
  /** Only types with a registered consumer; a type with none stays pending. */
  readonly types: readonly OutboxEventType[];
  readonly now: Date;
  /** When the claim expires and the row becomes claimable again. */
  readonly leaseUntil: Date;
}

/**
 * Claims the next due row, atomically.
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` inside the `UPDATE`, which is the Postgres
 * form of Mongo's single `findOneAndUpdate` and differs from it in one way worth
 * naming: `SKIP LOCKED` makes a second dispatcher take the NEXT row rather than
 * BLOCK on this one. Plain `FOR UPDATE` would block, and a blocked dispatcher is
 * indistinguishable from a slow one — the failure mode that has no diagnostic.
 *
 * Three details that are each a silent wrong answer if changed:
 *
 *  - **`returning()` yields the row AFTER the update**, which is what Mongo's
 *    `returnDocument: 'after'` gave (hardcoded in `collections.ts`). The
 *    dispatcher's dead-letter test reads `attempts` off this row, so a
 *    before-image would dead-letter every row one attempt late.
 *  - **`inArray`, never a bare array.** A bare array interpolated into a `sql`
 *    template renders as a ROW CONSTRUCTOR, which matches nothing and reads as an
 *    empty queue.
 *  - **`updated_at` is not set here.** `@oxyhq/db`'s `updatedAt()` carries
 *    `$onUpdate`, which the query BUILDER applies; it would not apply to a raw
 *    `db.execute`, which is why the claim is built rather than written as one SQL
 *    string. The realdb file asserts the stamp actually moved.
 *
 * `available_at` is `NOT NULL`, so the ordering needs no `NULLS LAST` — stated
 * because an ordering that silently drops or misplaces null rows is the house bug
 * and the next reader should not have to go and check.
 */
export async function claimNextOutboxEvent(
  db: PgHandle,
  claim: OutboxClaim,
): Promise<OutboxEventRow | null> {
  /**
   * A round trip saved, NOT a safety property — said plainly because the shape
   * invites the opposite reading.
   *
   * Measured against drizzle 0.45: `inArray(column, [])` renders as the literal
   * `false`, so the claim already matches nothing without this line. Mutation-
   * tested by deleting it, and the suite stayed green — which is the honest
   * result and is recorded here rather than dressed up with a test that would
   * only be re-measuring drizzle. Delete it if you like; what you lose is one
   * pointless statement per idle pass, and nothing else.
   */
  if (claim.types.length === 0) return null;

  const due = db
    .select({ eventId: outboxEvents.eventId })
    .from(outboxEvents)
    .where(
      and(
        inArray(outboxEvents.type, [...claim.types]),
        inArray(outboxEvents.status, [...CLAIMABLE_STATUSES]),
        lte(outboxEvents.availableAt, claim.now),
      ),
    )
    // Oldest first, so a row that keeps failing cannot starve the queue behind
    // it: its backoff pushes `available_at` forward and everything due sooner
    // goes first.
    .orderBy(asc(outboxEvents.availableAt))
    .limit(1)
    .for('update', { skipLocked: true });

  const [row] = await db
    .update(outboxEvents)
    .set({
      status: 'dispatching',
      availableAt: claim.leaseUntil,
      /**
       * `attempts + 1` in SQL rather than read-then-write. `attempts` is
       * `integer`, which postgres.js decodes as a number — the string-decoding
       * trap is `bigint`/`int8` only — but the increment is done by the server
       * regardless, because a read-modify-write here would race two dispatchers
       * even with the row lock held only for the SELECT.
       */
      attempts: sql`${outboxEvents.attempts} + 1`,
    })
    .where(inArray(outboxEvents.eventId, due))
    .returning();

  return row ?? null;
}

/**
 * Marks a claimed row done.
 *
 * The count comes off `returning()`, never off `rows.length` of a non-returning
 * UPDATE — that is 0 whether or not the statement applied, so the obvious spelling
 * reports "not applied" for every update that did. Nothing consumes the count
 * today; it is returned so the switch does not have to change the signature to
 * find out.
 */
export async function markOutboxEventDispatched(
  db: PgHandle,
  eventId: string,
  dispatchedAt: Date,
): Promise<number> {
  const rows = await db
    .update(outboxEvents)
    .set({ status: 'dispatched', dispatchedAt, lastError: null })
    .where(eq(outboxEvents.eventId, eventId))
    .returning({ eventId: outboxEvents.eventId });

  return rows.length;
}

/**
 * What a failed attempt leaves behind.
 *
 * The dispatcher decides all three — the backoff schedule, the dead-letter
 * threshold and the redaction of the reason to a message without a stack. None of
 * that is the repository's business, and computing it here would put §13.4's log
 * redaction rule in two places.
 */
export interface FailedOutboxEvent {
  /** `pending` for a retry, `failed` for a dead letter. */
  readonly status: OutboxStatus;
  /** When it may next be claimed; for a dead letter, when it stopped being retried. */
  readonly availableAt: Date;
  readonly lastError: string;
}

export async function markOutboxEventFailed(
  db: PgHandle,
  eventId: string,
  outcome: FailedOutboxEvent,
): Promise<number> {
  const rows = await db
    .update(outboxEvents)
    .set({
      status: outcome.status,
      availableAt: outcome.availableAt,
      lastError: outcome.lastError,
    })
    .where(eq(outboxEvents.eventId, eventId))
    .returning({ eventId: outboxEvents.eventId });

  return rows.length;
}

/**
 * One row by id, across every tenant.
 *
 * The dispatcher does not need this; a test and an operator do. It exists because
 * the alternative — every caller reaching past the repository to the table — is
 * the thing the layer exists to prevent, and because `markOutboxEventFailed`'s
 * effect is otherwise unobservable through this module.
 */
export async function findOutboxEventById(
  db: PgHandle,
  eventId: string,
): Promise<OutboxEventRow | null> {
  const [row] = await db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.eventId, eventId))
    .limit(1);

  return row ?? null;
}
