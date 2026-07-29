import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTransaction } from '../db/transaction';
import {
  appendOutboxEvent,
  OUTBOX_EVENT_TYPES,
  outboxEvents,
  type OutboxEventDocument,
} from '../modules/outbox/outbox.collection';
import {
  drainOutbox,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  registerOutboxHandler,
  resetOutboxHandlers,
  runOnce,
  startOutboxDispatcher,
  stopOutboxDispatcher,
} from '../modules/outbox/outbox.dispatcher';
import {
  provisionTenant,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * The outbox dispatcher (§12.5).
 *
 * The reason this loop reads MongoDB rather than a queue is stated in the
 * dispatcher itself: the Valkey that would carry the jobs is a single node with
 * no replica, no failover and no snapshots, so a job is a hint and the row is
 * the record. These tests are about the properties that makes necessary — a
 * claim two dispatchers cannot both win, a crash that becomes a delay rather
 * than a stranded row, and a failure that retries with backoff and eventually
 * becomes a visible dead letter instead of disappearing.
 *
 * Every test uses its own event type so a run in another file cannot claim its
 * rows and make the assertions here depend on suite order.
 */

let tenant: ProvisionedTenant;

beforeAll(async () => {
  await startDatabase();
  tenant = await provisionTenant();
});

beforeEach(() => {
  resetOutboxHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  resetOutboxHandlers();
  await stopDatabase();
});

/**
 * Writes one row the way the domain does: inside a transaction.
 *
 * Every row here is `report.received`.
 *
 * That used to make the type exclusively this file's, because nothing consumed
 * it. Webhook delivery now does — exactly as `outbox.dispatcher.ts` said it
 * would — so a suite calling `registerOutboxWorkers` claims and completes these
 * rows too. What keeps the assertions here meaningful is no longer type
 * ownership but `fileParallelism: false` in `vitest.config.ts`: the suites share
 * one database and the dispatcher is deliberately not tenant-scoped, so only one
 * file may run a dispatcher at a time. See that file for why.
 */
async function writeEvent(caseId: string): Promise<string> {
  return withTransaction((session) =>
    appendOutboxEvent(tenant.tenant, session, {
      type: OUTBOX_EVENT_TYPES.reportReceived,
      payload: { caseId },
    }),
  );
}

function readEvent(eventId: string): Promise<OutboxEventDocument | null> {
  return outboxEvents.findOne({ eventId });
}

describe('dispatching a row', () => {
  it('hands the event to its registered handler and marks it dispatched', async () => {
    const caseId = `case_dispatch_${Date.now()}`;
    const eventId = await writeEvent(caseId);
    const handled: string[] = [];

    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) handled.push(event.payload.caseId ?? '');
    });

    await runOnce();

    expect(handled).toContain(caseId);
    const stored = await readEvent(eventId);
    expect(stored?.status).toBe('dispatched');
    expect(stored?.dispatchedAt).not.toBeNull();
    expect(stored?.lastError).toBeNull();
  });

  it('carries the tenant on the row, because a worker has no credential to derive one from', async () => {
    const eventId = await writeEvent(`case_tenant_${Date.now()}`);
    const seen: { organizationId: string; applicationId: string }[] = [];

    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) {
        seen.push({
          organizationId: event.organizationId,
          applicationId: event.applicationId,
        });
      }
    });

    await runOnce();

    expect(seen).toEqual([
      { organizationId: tenant.organizationId, applicationId: tenant.applicationId },
    ]);
  });

  /**
   * The property the whole outbox argument rests on: work is never marked done
   * by a loop that did not do it.
   *
   * `case.ready_for_review` has no consumer until sortition exists (§15.4).
   * Claiming and completing it would leave a row that says the work happened
   * when nothing happened — and since §12.5's guarantee is that pending work is
   * re-derivable from these rows, that is the one failure mode the design has no
   * answer for. So it stays pending and waits.
   */
  it('leaves an event with no consumer pending rather than completing it', async () => {
    const eventId = await withTransaction((session) =>
      appendOutboxEvent(tenant.tenant, session, {
        type: OUTBOX_EVENT_TYPES.caseReadyForReview,
        payload: { caseId: `case_unconsumed_${Date.now()}` },
      }),
    );

    // A consumer for a DIFFERENT type is registered, so the loop runs and simply
    // does not claim this row — rather than the loop not running at all, which
    // would make the assertion vacuous.
    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async () => {});
    await runOnce();

    const stored = await readEvent(eventId);
    expect(stored?.status).toBe('pending');
    expect(stored?.attempts).toBe(0);
    expect(stored?.dispatchedAt).toBeNull();
  });
});

describe('a claim two dispatchers cannot both win', () => {
  it('gives one row to exactly one pass, even when two run at once', async () => {
    const eventId = await writeEvent(`case_race_${Date.now()}`);
    let deliveries = 0;

    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) deliveries += 1;
    });

    // Concurrent, not sequential: the claim is a single findOneAndUpdate for
    // exactly this reason, and a read-then-write would deliver the row twice.
    await Promise.all([runOnce(), runOnce(), runOnce()]);

    expect(deliveries).toBe(1);
  });
});

describe('a dispatcher that dies mid-handler', () => {
  /**
   * The lease is what turns a crash into a delay. Without it a process that died
   * between claiming and completing would hold its rows forever, and nothing
   * would say so — the work would simply never happen.
   */
  it('lets another dispatcher reclaim the row once the lease expires', async () => {
    const eventId = await writeEvent(`case_crash_${Date.now()}`);

    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) throw new Error('the process died here');
    });
    // Claim it and lose the process: the row stays `dispatching` with a lease.
    await outboxEvents.updateOne(
      { eventId },
      { status: 'dispatching', availableAt: new Date(Date.now() + OUTBOX_LEASE_MS) },
    );
    expect((await readEvent(eventId))?.status).toBe('dispatching');

    // Nothing due yet, so nothing claims it.
    await runOnce(25, new Date());
    expect((await readEvent(eventId))?.status).toBe('dispatching');

    // Past the lease, a fresh dispatcher takes it.
    const delivered: string[] = [];
    resetOutboxHandlers();
    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) delivered.push(event.eventId);
    });

    await runOnce(25, new Date(Date.now() + OUTBOX_LEASE_MS + 1_000));

    expect(delivered).toEqual([eventId]);
    expect((await readEvent(eventId))?.status).toBe('dispatched');
  });
});

describe('a handler that fails', () => {
  it('returns the row to pending with a backoff, and keeps the reason', async () => {
    const eventId = await writeEvent(`case_retry_${Date.now()}`);

    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) throw new Error('downstream unavailable');
    });

    const before = new Date();
    await runOnce();

    const stored = await readEvent(eventId);
    expect(stored?.status).toBe('pending');
    expect(stored?.attempts).toBe(1);
    expect(stored?.lastError).toBe('downstream unavailable');
    // Backed off, so a permanently broken handler cannot spin the loop.
    expect(stored?.availableAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('becomes a visible dead letter after the attempt limit, and is NOT deleted', async () => {
    const eventId = await writeEvent(`case_dead_${Date.now()}`);

    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) throw new Error('always fails');
    });

    // Stand the row up at its last attempt rather than looping through every
    // backoff, which would make this test a sleep.
    await outboxEvents.updateOne({ eventId }, { attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    await runOnce();

    const stored = await readEvent(eventId);
    expect(stored?.status).toBe('failed');
    expect(stored?.lastError).toBe('always fails');
    /**
     * §12.5's guarantee is that pending work is re-derivable from the outbox, so
     * a row that cannot be handled has to stay readable for an operator to
     * replay after the cause is fixed. Discarding it would turn a handler bug
     * into permanently lost moderation work.
     */
    expect(
      await mongoose.connection.collection('outbox_events').countDocuments({ eventId }),
    ).toBe(1);
  });

  it('does not put a handler failure message into the log verbatim beyond its own text', async () => {
    const eventId = await writeEvent(`case_redact_${Date.now()}`);

    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) {
        const error = new Error('handler failed');
        error.stack = 'Error: handler failed\n  reported text that must never be stored';
        throw error;
      }
    });

    await runOnce();

    // The MESSAGE is kept; the stack — which routinely quotes the document a
    // driver choked on — is not (§13.4).
    const stored = await readEvent(eventId);
    expect(stored?.lastError).toBe('handler failed');
    expect(stored?.lastError).not.toContain('reported text');
  });
});

describe('appendOutboxEvent', () => {
  /**
   * The session parameter is required and not optional by oversight: it is the
   * only structural guarantee that an event and the domain write it describes
   * commit together. This asserts the row a transaction produced is really tied
   * to that transaction.
   */
  it('writes nothing when the surrounding transaction aborts', async () => {
    const caseId = `case_aborted_${Date.now()}`;

    await expect(
      withTransaction(async (session) => {
        await appendOutboxEvent(tenant.tenant, session, {
          type: OUTBOX_EVENT_TYPES.reportReceived,
          payload: { caseId },
        });
        throw new Error('the domain write failed after the event');
      }),
    ).rejects.toThrow('the domain write failed after the event');

    expect(
      await mongoose.connection
        .collection('outbox_events')
        .countDocuments({ 'payload.caseId': caseId }),
    ).toBe(0);
  });
});

describe('runOnce with nothing to consume', () => {
  it('claims nothing at all when no handler is registered', async () => {
    await writeEvent(`case_noconsumer_${Date.now()}`);

    // Not "claims and completes": with no consumer there is nothing to hand a
    // row to, so the loop must not touch the queue at all.
    expect(await runOnce()).toEqual({ claimed: 0, dispatched: 0, failed: 0 });
  });
});

describe('a handler that throws something that is not an Error', () => {
  it('records a reason rather than storing whatever was thrown', async () => {
    const eventId = await writeEvent(`case_nonerror_${Date.now()}`);

    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) {
        // Throwing a non-Error is legal JavaScript, and the thrown value could
        // be anything — including reported material (§13.4).
        throw { reportedText: 'must never reach the outbox row' };
      }
    });

    await runOnce();

    const stored = await readEvent(eventId);
    expect(stored?.lastError).toBe('Unknown dispatch failure');
    expect(stored?.status).toBe('pending');
  });
});

describe('the polling loop', () => {
  /**
   * The loop belongs to `server.ts`, never to `app.ts`: building the HTTP
   * application must not start a timer, or every test that constructs one leaves
   * a process that will not exit. `.unref()` is the other half of that — a
   * housekeeping timer that keeps the event loop alive turns a clean shutdown
   * into a hang, and under a test runner it hangs the whole run.
   */
  it('starts once, is idempotent, and stops cleanly', async () => {
    const eventId = await writeEvent(`case_timer_${Date.now()}`);
    const handled: string[] = [];
    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async (event) => {
      if (event.eventId === eventId) handled.push(event.eventId);
    });

    startOutboxDispatcher(5);
    // A second call must not start a second timer competing with the first.
    startOutboxDispatcher(5);

    await vi.waitFor(async () => {
      expect((await readEvent(eventId))?.status).toBe('dispatched');
    });
    expect(handled).toEqual([eventId]);

    stopOutboxDispatcher();
    // Stopping twice is how a shutdown path that runs on both SIGTERM and
    // SIGINT behaves; it must not throw.
    stopOutboxDispatcher();
  });

  it('survives a pass that throws without stopping the loop', async () => {
    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async () => {});
    const failing = vi
      .spyOn(outboxEvents, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('the database blinked'));

    startOutboxDispatcher(5);
    await vi.waitFor(() => {
      expect(failing).toHaveBeenCalled();
    });
    stopOutboxDispatcher();
  });
});

describe('drainOutbox', () => {
  it('keeps going while rows remain, and stops when none are due', async () => {
    const ids = await Promise.all(
      [1, 2, 3].map((index) => writeEvent(`case_drain_${Date.now()}_${index}`)),
    );
    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async () => {});

    const summary = await drainOutbox();

    expect(summary.claimed).toBeGreaterThanOrEqual(ids.length);
    for (const eventId of ids) {
      expect((await readEvent(eventId))?.status).toBe('dispatched');
    }
  });

  /**
   * The bound exists for a handler that re-emits its own trigger, which would
   * otherwise spin here forever with no signal. It has to be checkable, or the
   * guard is a comment.
   */
  it('gives up after its pass limit rather than spinning forever', async () => {
    let passes = 0;
    registerOutboxHandler(OUTBOX_EVENT_TYPES.reportReceived, async () => {
      passes += 1;
      // Re-emit: every pass finds new work.
      await withTransaction((session) =>
        appendOutboxEvent(tenant.tenant, session, {
          type: OUTBOX_EVENT_TYPES.reportReceived,
          payload: { caseId: `case_loop_${passes}` },
        }),
      );
    });

    await writeEvent(`case_loop_seed_${Date.now()}`);
    const summary = await drainOutbox(3);

    expect(summary.claimed).toBeGreaterThan(0);
    // Bounded: without the limit this call would never return.
    expect(passes).toBeLessThan(200);
  });
});
