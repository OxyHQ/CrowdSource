import { and, desc, eq, sql } from 'drizzle-orm';

import { webhookDeliveries } from '../schema/webhooks';
import { type PgHandle } from '../withTenant';

/**
 * The webhook delivery queue, as a PostgreSQL repository.
 *
 * Fifteen call sites, all in `delivery.service.ts`, and this file is nine
 * functions because the eight `countDocuments` calls are two grouped queries.
 *
 * NOTHING CALLS THIS IN PRODUCTION YET. `webhookDeliveryRepository.realdb.test.ts`
 * is what makes these statements ones that have genuinely run — and it matters
 * more here than for the other tables in this port, because two of the functions
 * below have no mocked equivalent at all: `SELECT … FOR UPDATE SKIP LOCKED` and
 * `ON CONFLICT … DO NOTHING RETURNING` are behaviours of the server, and a mock
 * agrees with whatever you assert about them.
 *
 * The table is UNSCOPED by design — the delivery worker claims across every
 * tenant — so the reads that serve a caller state the tenant pair explicitly.
 * They are all here rather than in the console module for the reason
 * `delivery.service.ts` gives: one file to audit, instead of a second place where
 * forgetting two clauses leaks another tenant's delivery log.
 */

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

/** The four counts §16.4 and §4.2 report. */
export interface DeliveryStatusCounts {
  readonly pending: number;
  readonly delivering: number;
  readonly succeeded: number;
  readonly deadLetter: number;
}

/**
 * Records a delivery, or reports that this `(endpoint, event)` pair already had
 * one.
 *
 * `ON CONFLICT … DO NOTHING RETURNING`, and the empty result IS the answer —
 * never a caught duplicate-key error. The Mongo site catches `11000` and returns
 * `false`, which ports badly for a reason that has nothing to do with style: in
 * PostgreSQL one failed statement aborts the WHOLE transaction (`25P02`), so a
 * caught duplicate inside the fan-out transaction would doom every write around
 * it. Here no statement fails, so a genuine infrastructure error still
 * propagates instead of being read as "already delivered".
 *
 * The conflict target is `(webhook_endpoint_id, event_id)`, which is the unique
 * the race is against and the reason §10.7 shares the outbox row's id: a
 * redelivered outbox row produces the same pair, the second insert does nothing,
 * and the receiver's own idempotency keys on the same value.
 */
export async function insertDeliveryIfAbsent(
  db: PgHandle,
  row: typeof webhookDeliveries.$inferInsert,
): Promise<boolean> {
  const inserted = await db
    .insert(webhookDeliveries)
    .values(row)
    .onConflictDoNothing({
      target: [webhookDeliveries.webhookEndpointId, webhookDeliveries.eventId],
    })
    .returning({ deliveryId: webhookDeliveries.deliveryId });

  return inserted.length > 0;
}

/**
 * Claims the next due delivery, atomically and across every tenant.
 *
 * ## Two claimable shapes, and the second is crash recovery
 *
 * A `pending` row whose time has come, and a `delivering` row whose lease ran out
 * because the worker holding it died. Without the second, a task killed
 * mid-attempt strands its delivery forever and nothing says so.
 *
 * ## Why the sub-select, and why `SKIP LOCKED`
 *
 * Mongo's `findOneAndUpdate` with a sort is a single atomic claim. The PostgreSQL
 * equivalent is `UPDATE … WHERE delivery_id = (SELECT … ORDER BY … FOR UPDATE
 * SKIP LOCKED LIMIT 1)`. A plain `UPDATE … LIMIT 1` has no such spelling, and an
 * `UPDATE` whose `WHERE` merely repeats the predicate lets two workers pick the
 * same row: under READ COMMITTED the loser blocks, re-evaluates, and — because
 * the row now says `delivering` with a fresh lease — matches nothing and claims
 * NOTHING, which looks like an empty queue rather than contention. `SKIP LOCKED`
 * makes the loser move to the next row instead.
 *
 * `NULLS LAST` is deliberate and not decoration. `next_attempt_at` is NULLABLE —
 * a `delivering` row has none while its lease runs — and under `ASC` a NULL sorts
 * LAST in PostgreSQL by default, which is what we want, but the `delivering`
 * branch of the predicate can return exactly such a row. Writing it explicitly
 * means a later change to `DESC` cannot silently promote lease-expired rows to
 * the head of the queue ahead of everything genuinely due.
 *
 * ## `now` is bound as an ISO STRING with an explicit cast, not as a `Date`
 *
 * Inside a raw `sql` fragment a bare `Date` fails at SERIALISATION in the driver
 * — `The "string" argument must be of type string … Received an instance of Date`
 * — not at the server, and not at typecheck. Drizzle converts a `Date` for a
 * TYPED column in `.set()`, which is why the two halves of this same statement
 * behave differently and why the failure looks arbitrary. `::timestamptz` is
 * required with it: an unadorned string parameter compared against a timestamptz
 * column is not something PostgreSQL will infer here.
 *
 * Caught by this file's realdb suite on first run. A mocked driver accepts the
 * `Date` and every assertion about this query would have passed.
 *
 * ## The counters increment HERE, at the claim
 *
 * A process that dies between sending and recording has already spent an attempt,
 * and counting it is what stops a request that reliably kills the worker from
 * being retried forever. Ported verbatim; the failure it prevents is a loop.
 */
export async function claimDueDelivery(
  db: PgHandle,
  now: Date,
  leaseExpiresAt: Date,
): Promise<WebhookDeliveryRow | null> {
  const [row] = await db
    .update(webhookDeliveries)
    .set({
      status: 'delivering',
      leaseExpiresAt,
      attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
      cycleAttemptCount: sql`${webhookDeliveries.cycleAttemptCount} + 1`,
    })
    .where(
      eq(
        webhookDeliveries.deliveryId,
        sql`(
          select ${webhookDeliveries.deliveryId} from ${webhookDeliveries}
          where (${webhookDeliveries.status} = 'pending' and ${webhookDeliveries.nextAttemptAt} <= ${now.toISOString()}::timestamptz)
             or (${webhookDeliveries.status} = 'delivering' and ${webhookDeliveries.leaseExpiresAt} <= ${now.toISOString()}::timestamptz)
          order by ${webhookDeliveries.nextAttemptAt} asc nulls last
          for update skip locked
          limit 1
        )`,
      ),
    )
    .returning();

  return row ?? null;
}

/** Everything the attempt's outcome writes back. */
export interface DeliveryOutcomePatch {
  readonly status: string;
  readonly nextAttemptAt: Date | null;
  readonly lastResponseStatus: number | null;
  readonly deadLetterReason: string | null;
  readonly succeededAt: Date | null;
  readonly deadLetteredAt: Date | null;
}

/**
 * Writes the result of one attempt and releases the lease.
 *
 * Every nullable field is written EXPLICITLY, including the nulls. Drizzle omits
 * an `undefined` from the `SET`, so a patch that left `deadLetterReason` off
 * would keep the previous attempt's reason on a delivery that has since
 * succeeded — and `lease_expires_at` must be cleared or the row stays claimable
 * by the crash-recovery branch above while it is finished. The Mongo call site
 * passes all six for the same reason; `undefined` there is a no-op, but here it
 * would be one too, which is exactly the trap.
 */
export async function recordDeliveryOutcome(
  db: PgHandle,
  deliveryId: string,
  patch: DeliveryOutcomePatch,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ ...patch, leaseExpiresAt: null })
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
}

/**
 * Returns a dead-lettered delivery to the queue (§4.2's replay).
 *
 * `cycle_attempt_count` resets to 0 and `attempt_count` does NOT. The §10.9
 * ladder reads the cycle counter, so a replay gets the full schedule again while
 * the total keeps numbering attempts monotonically and the history stays
 * complete. Getting these two the wrong way round gives a replayed delivery one
 * attempt before it dead-letters again.
 */
export async function replayDeadLetteredDelivery(
  db: PgHandle,
  deliveryId: string,
  nextAttemptAt: Date,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: 'pending',
      cycleAttemptCount: 0,
      nextAttemptAt,
      leaseExpiresAt: null,
      deadLetterReason: null,
      deadLetteredAt: null,
      replayCount: sql`${webhookDeliveries.replayCount} + 1`,
    })
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
}

/** One delivery, scoped to the tenant that owns it. */
export async function findTenantDelivery(
  db: PgHandle,
  organizationId: string,
  applicationId: string,
  deliveryId: string,
): Promise<WebhookDeliveryRow | null> {
  const [row] = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.deliveryId, deliveryId),
        eq(webhookDeliveries.organizationId, organizationId),
        eq(webhookDeliveries.applicationId, applicationId),
      ),
    )
    .limit(1);

  return row ?? null;
}

/** One page of a tenant's deliveries, newest first. */
export async function listTenantDeliveries(
  db: PgHandle,
  organizationId: string,
  applicationId: string,
  filter: { readonly status?: string; readonly webhookEndpointId?: string },
  limit: number,
): Promise<WebhookDeliveryRow[]> {
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organizationId, organizationId),
        eq(webhookDeliveries.applicationId, applicationId),
        ...(filter.status === undefined ? [] : [eq(webhookDeliveries.status, filter.status)]),
        ...(filter.webhookEndpointId === undefined
          ? []
          : [eq(webhookDeliveries.webhookEndpointId, filter.webhookEndpointId)]),
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
}

/**
 * Dead-lettered deliveries across every tenant, for Trust & Safety (§4.3).
 *
 * `dead_lettered_at DESC NULLS LAST`, and the `NULLS LAST` is load-bearing rather
 * than defensive: the column is nullable, a `dead_letter` row always has one, and
 * under `DESC` PostgreSQL puts NULLs FIRST by default — so a row that somehow
 * reached `dead_letter` without a timestamp would sit at the head of the operator's
 * queue ahead of every real one. That is the house bug (`DESC` without
 * `NULLS LAST` putting undated rows at the head of a feed), and it is cheap to
 * refuse here.
 */
export async function listDeadLetteredAcrossTenants(
  db: PgHandle,
  limit: number,
): Promise<WebhookDeliveryRow[]> {
  return db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.status, 'dead_letter'))
    .orderBy(sql`${webhookDeliveries.deadLetteredAt} desc nulls last`)
    .limit(limit);
}

/**
 * Turns grouped rows into the four counts, with ZERO for the absent statuses.
 *
 * This is the whole reason the eight `countDocuments` calls do not become eight
 * queries. A `GROUP BY` omits a status nobody is in — it does not return zero for
 * it — so a naive port reports `undefined` where Mongo reported `0`, and
 * `undefined` reaching a health payload reads as "unknown" or renders as blank
 * where the honest answer is "none". Every status is seeded from the tuple first
 * and then overwritten, so a queue with no dead letters says `deadLetter: 0`.
 *
 * `count(*)` comes back from postgres.js as a STRING (`int8` is decoded as text,
 * because it does not fit a JS number), and drizzle types it `number`. `Number(…)`
 * at the boundary is not defensive — without it these values are strings that
 * compare and add as strings, and `"12" + 1` is `"121"`.
 */
function countsFromRows(rows: readonly { status: string; count: unknown }[]): DeliveryStatusCounts {
  const byStatus = new Map<string, number>();
  for (const row of rows) byStatus.set(row.status, Number(row.count));

  return {
    pending: byStatus.get('pending') ?? 0,
    delivering: byStatus.get('delivering') ?? 0,
    succeeded: byStatus.get('succeeded') ?? 0,
    deadLetter: byStatus.get('dead_letter') ?? 0,
  };
}

/** How many of one endpoint's deliveries sit in each state, for one tenant. */
export async function countDeliveriesForEndpoint(
  db: PgHandle,
  organizationId: string,
  applicationId: string,
  webhookEndpointId: string,
): Promise<DeliveryStatusCounts> {
  const rows = await db
    .select({ status: webhookDeliveries.status, count: sql<number>`count(*)` })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organizationId, organizationId),
        eq(webhookDeliveries.applicationId, applicationId),
        eq(webhookDeliveries.webhookEndpointId, webhookEndpointId),
      ),
    )
    .groupBy(webhookDeliveries.status);

  return countsFromRows(rows);
}

/** How many deliveries sit in each state across every tenant (§16.4). */
export async function countDeliveriesAcrossTenants(
  db: PgHandle,
): Promise<DeliveryStatusCounts> {
  const rows = await db
    .select({ status: webhookDeliveries.status, count: sql<number>`count(*)` })
    .from(webhookDeliveries)
    .groupBy(webhookDeliveries.status);

  return countsFromRows(rows);
}
