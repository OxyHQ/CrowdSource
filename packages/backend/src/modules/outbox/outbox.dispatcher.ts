import { logger } from '../../utils/logger';
import { getPostgresDatabase } from '../../db/postgres/database';
import {
  claimNextOutboxEvent,
  markOutboxEventDispatched,
  markOutboxEventFailed,
} from '../../db/postgres/repositories/outbox';
import {
  type OutboxEventDocument,
  type OutboxEventType,
} from './outbox.collection';

/**
 * The outbox dispatcher (§12.5).
 *
 * The plan's flow is: a transaction writes the domain object and an outbox row;
 * a dispatcher publishes the row; a worker consumes it idempotently, updates
 * domain state, and writes the next outbox rows. This file is the middle step,
 * and it reads the durable PostgreSQL rows rather than from a queue on purpose.
 *
 * ## Why there is no BullMQ here
 *
 * `AGENTS.md` is explicit that BullMQ is dispatch and never the durable record,
 * because the Valkey it would run on is a single `cache.t4g.micro` node with no
 * replica, no failover and no snapshots, shared with six live backends. A node
 * replacement loses whatever was queued. The outbox is what makes that a delay:
 * every pending piece of work is re-derivable by re-reading these rows.
 *
 * Which means the queue is a LATENCY optimisation over this loop, not a
 * correctness component — and adding it is not free. It needs `REDIS_URL` to
 * carry an explicit non-zero database index, enforced in `deploy-aws.yml`, or
 * two Oxy backends elect one leader between them and consume each other's jobs.
 * That guard lives outside this package. So the dispatcher is written against
 * the durable record it is allowed to depend on, and a queue can later wake it
 * sooner without changing a line of the domain: `runOnce` would be called by a
 * job handler instead of by a timer, and everything below would still hold if
 * the job never arrived.
 *
 * ## What a handler must guarantee
 *
 * At-least-once, so every handler is idempotent. A lease can expire while a
 * handler is still running, a process can die between the domain write and the
 * completion write, and both produce a second delivery of the same event. The
 * domain absorbs that through the same unique indexes idempotency rests on
 * everywhere else.
 */

/** A consumer of one event type. Must tolerate being called twice. */
export type OutboxHandler = (event: OutboxEventDocument) => Promise<void>;

const handlers = new Map<OutboxEventType, OutboxHandler>();

/**
 * Registers the consumer for an event type.
 *
 * One handler per type, and re-registering replaces it. A second handler for the
 * same type would mean the row is complete when one of them has run, which is a
 * dropped consumer that nothing reports.
 */
export function registerOutboxHandler(type: OutboxEventType, handler: OutboxHandler): void {
  handlers.set(type, handler);
}

/** Test seam: forget every registration. */
export function resetOutboxHandlers(): void {
  handlers.clear();
}

/**
 * The event types that currently have a consumer.
 *
 * This is the set `claimNext` filters on, and it is the whole reason the outbox
 * can be trusted: a type absent from it is one whose rows stay pending rather
 * than being marked done by a loop that did nothing with them. Exposing it makes
 * "which consumers did this process wire up?" answerable without running a pass
 * — and running a pass is exactly what a second suite must not do against a
 * shared database.
 */
export function registeredOutboxEventTypes(): readonly OutboxEventType[] {
  return [...handlers.keys()];
}

/**
 * How long a claim is held before another dispatcher may take the row.
 *
 * Longer than any handler should run and short enough that a crashed process
 * does not strand work for an operator to notice.
 */
export const OUTBOX_LEASE_MS = 60_000;

/** Base of the exponential backoff between failed attempts. */
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 15 * 60 * 1_000;

/**
 * After this many attempts a row stops being retried and becomes a dead letter.
 *
 * It is NOT deleted, and that is the point: §12.5's guarantee is that pending
 * work is re-derivable from the outbox, so a row that cannot be handled has to
 * stay visible for an operator to replay after the cause is fixed. Discarding it
 * would turn a handler bug into permanently lost moderation work.
 */
export const OUTBOX_MAX_ATTEMPTS = 8;

function backoffMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Claims the next due row, atomically.
 *
 * `pending` and an EXPIRED `dispatching` are both claimable — the second is
 * crash recovery, and without it a dispatcher that died mid-handler would hold
 * its rows forever. One guarded PostgreSQL claim statement makes two dispatchers
 * safe: the loser sees the row already leased and moves on.
 *
 * Only types with a registered consumer are claimed, and that is the whole
 * reason the outbox can be trusted. An event nobody consumes yet — today
 * `report.received`, whose consumer is webhook delivery (§10.6), and
 * `case.ready_for_review`, whose consumer is sortition (§15.4) — stays PENDING
 * rather than being marked dispatched by a loop that did nothing with it.
 * Marking it would destroy exactly the property §12.5 exists for: that pending
 * work is re-derivable by re-reading these rows.
 *
 * The cost is a backlog that a new consumer meets on its first run. That is the
 * correct direction — a consumer arriving to find work waiting is a design
 * decision it can act on, whereas one arriving to find the work already marked
 * done has no way to know anything was lost.
 */
async function claimNext(now: Date): Promise<OutboxEventDocument | null> {
  const consumed = [...handlers.keys()];
  if (consumed.length === 0) return null;

  return (await claimNextOutboxEvent(getPostgresDatabase(), {
    types: consumed,
    now,
    leaseUntil: new Date(now.getTime() + OUTBOX_LEASE_MS),
  })) as OutboxEventDocument | null;
}

async function markDispatched(event: OutboxEventDocument, now: Date): Promise<void> {
  await markOutboxEventDispatched(getPostgresDatabase(), event.eventId, now);
}

async function markFailed(
  event: OutboxEventDocument,
  now: Date,
): Promise<void> {
  const deadLettered = event.attempts >= OUTBOX_MAX_ATTEMPTS;
  /**
   * A handler or driver message can quote the document it choked on, so neither
   * the durable row nor the log receives the thrown value, message or stack.
   * The event id/type/attempt count are the safe operator correlation surface.
   */
  await markOutboxEventFailed(getPostgresDatabase(), event.eventId, {
    status: deadLettered ? 'failed' : 'pending',
    availableAt: deadLettered ? now : new Date(now.getTime() + backoffMs(event.attempts)),
    lastError: 'dispatch_failed',
  });

  logger.error(
    {
      eventId: event.eventId,
      type: event.type,
      attempts: event.attempts,
      classification: 'outbox_dispatch_failed',
      deadLettered,
    },
    deadLettered ? 'Outbox event dead-lettered' : 'Outbox event dispatch failed; will retry',
  );
}

export interface DispatchSummary {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
}

/** Drains up to `limit` due rows whose type has a consumer. */
export async function runOnce(limit = 25, now: Date = new Date()): Promise<DispatchSummary> {
  let claimed = 0;
  let dispatched = 0;
  let failed = 0;

  for (let index = 0; index < limit; index += 1) {
    const event = await claimNext(now);
    if (!event) break;
    claimed += 1;

    const handler = handlers.get(event.type);
    if (!handler) {
      // Unreachable: the claim filters on the registered types. Returning the
      // row rather than marking it dispatched keeps the "nothing is completed
      // without being handled" property true even if that ever changes.
      await markFailed(event, new Date());
      failed += 1;
      continue;
    }

    try {
      await handler(event);
      await markDispatched(event, new Date());
      dispatched += 1;
    } catch (_error: unknown) {
      await markFailed(event, new Date());
      failed += 1;
    }
  }

  return { claimed, dispatched, failed };
}

/**
 * Drains until nothing is due.
 *
 * Handlers write further outbox rows — a triage handler emits
 * `case.ready_for_review` — so one pass is not the whole chain. The bound is a
 * guard against a handler that re-emits its own trigger, which would otherwise
 * spin here forever with no signal.
 */
export async function drainOutbox(maxPasses = 10): Promise<DispatchSummary> {
  let claimed = 0;
  let dispatched = 0;
  let failed = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const summary = await runOnce();
    claimed += summary.claimed;
    dispatched += summary.dispatched;
    failed += summary.failed;
    if (summary.claimed === 0) break;
  }

  return { claimed, dispatched, failed };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the polling loop.
 *
 * Called by `server.ts` and never by `app.ts`: building the HTTP application
 * must not start a timer, or every test that constructs one leaves a process
 * that will not exit.
 *
 * `.unref()` for the same reason the ecosystem requires it of every module-level
 * interval — a housekeeping timer that keeps the event loop alive turns a clean
 * shutdown into a hang, and under a test runner it hangs the whole run.
 */
export function startOutboxDispatcher(intervalMs = 1_000): void {
  if (timer) return;

  timer = setInterval(() => {
    void runOnce().catch((_error: unknown) => {
      logger.error({ classification: 'outbox_dispatcher_pass_failed' }, 'Outbox dispatcher pass failed');
    });
  }, intervalMs);
  timer.unref?.();
}

export function stopOutboxDispatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
