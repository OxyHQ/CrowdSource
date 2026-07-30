/**
 * Invariant: nothing is enqueued that is not already recorded in the outbox, in
 * the same transaction.
 *
 * A job is a hint that work is pending, never the only evidence it exists. Work
 * enqueued without its outbox row is lost moderation work with no trace, and it
 * fails silently until something restarts.
 *
 * These tests run against a real replica set with a real `ClientSession`,
 * because the property is `session.inTransaction()` and a fake session can be
 * made to answer anything. `scripts/test-invariants.mjs` deletes the guard and
 * asserts that the first two tests below fail — an assertion that is worth
 * nothing unless it can.
 */

import mongoose from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';
import { ModerationOutboxTransactionError, reportSubmitEventId } from '../outbox/service.js';
import type { CreateReportInput } from '../types.js';
import { createHarness, type Harness } from './support/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('the outbox refuses to be written outside a transaction', () => {
  it('throws ModerationOutboxTransactionError for a session with no transaction open', async () => {
    harness = await createHarness();
    const session = await harness.connection.startSession();
    try {
      /**
       * A bare `startSession()` is the mistake worth catching. It satisfies the
       * required parameter, it type-checks perfectly, and the row it writes
       * commits on its own — so a test that only asserted the row exists would
       * pass while the guarantee was gone.
       */
      expect(session.inTransaction()).toBe(false);

      await expect(
        harness.moderation.outbox.enqueue(
          {
            eventId: 'moderation:report.submit:no-transaction',
            kind: 'report.submit',
            payload: { reportId: 'no-transaction' },
          },
          session,
        ),
      ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);
    } finally {
      await session.endSession();
    }
  });

  it('writes no row at all when it refuses', async () => {
    harness = await createHarness();
    const session = await harness.connection.startSession();
    try {
      await harness.moderation.outbox
        .enqueue(
          {
            eventId: 'moderation:report.submit:refused',
            kind: 'report.submit',
            payload: { reportId: 'refused' },
          },
          session,
        )
        .catch(() => undefined);
    } finally {
      await session.endSession();
    }

    expect(await harness.moderation.models.outbox.countDocuments({})).toBe(0);
  });

  it('accepts a session that IS in a transaction', async () => {
    harness = await createHarness();
    const session = await harness.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await harness?.moderation.outbox.enqueue(
          {
            eventId: 'moderation:report.submit:in-transaction',
            kind: 'report.submit',
            payload: { reportId: 'in-transaction' },
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    expect(
      await harness.moderation.models.outbox.countDocuments({
        _id: 'moderation:report.submit:in-transaction',
      }),
    ).toBe(1);
  });
});

describe('intake commits the report and its delivery event together, or neither', () => {
  it('stores both when the reported type has a subject provider', async () => {
    harness = await createHarness();
    const widget = await harness.widgets.create({ body: 'hello', ownerId: 'oxy-owner' });

    const result = await harness.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'widget',
      reportedId: String(widget._id),
      categories: ['spam'],
    });

    expect(result.report.localStatus).toBe('queued');
    expect(result.outboxEventId).toBe(reportSubmitEventId(String(result.report._id)));

    const event = await harness.moderation.models.outbox
      .findById(result.outboxEventId)
      .lean();
    expect(event?.kind).toBe('report.submit');
    expect(event?.status).toBe('pending');
  });

  it('stores the report and NO delivery event when the type has no provider', async () => {
    harness = await createHarness();

    const result = await harness.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'gizmo',
      reportedId: String(new mongoose.Types.ObjectId()),
      categories: ['other'],
    });

    expect(result.report.localStatus).toBe('received');
    expect(result.report.localStatusReason).toContain('gizmo');
    expect(result.outboxEventId).toBeUndefined();
    expect(await harness.moderation.models.outbox.countDocuments({})).toBe(0);
  });

  it('rolls the report back when the outbox write fails inside the transaction', async () => {
    harness = await createHarness();
    const widget = await harness.widgets.create({ body: 'hello', ownerId: 'oxy-owner' });

    /**
     * The failure is injected at the outbox, which is the half that commits
     * second. If the two writes were merely ordered rather than atomic, the
     * report would survive with nothing to deliver it — the silent failure this
     * whole design exists to prevent.
     */
    const enqueue = harness.moderation.outbox.enqueue;
    harness.moderation.outbox.enqueue = async () => {
      throw new Error('injected outbox failure');
    };

    await expect(
      harness.moderation.createReport({
        reporter: 'oxy-reporter',
        reportedType: 'widget',
        reportedId: String(widget._id),
        categories: ['spam'],
      }),
    ).rejects.toThrow('injected outbox failure');

    harness.moderation.outbox.enqueue = enqueue;

    expect(await harness.reports.countDocuments({})).toBe(0);
    expect(await harness.moderation.models.outbox.countDocuments({})).toBe(0);
  });

  it('is the same event id for a repeated enqueue, so one report never queues two deliveries', async () => {
    harness = await createHarness();
    const widget = await harness.widgets.create({ body: 'hello', ownerId: 'oxy-owner' });
    const created = await harness.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'widget',
      reportedId: String(widget._id),
      categories: ['spam'],
    });

    const session = await harness.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await harness?.moderation.outbox.enqueue(
          {
            eventId: reportSubmitEventId(String(created.report._id)),
            kind: 'report.submit',
            payload: { reportId: String(created.report._id) },
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    expect(await harness.moderation.models.outbox.countDocuments({})).toBe(1);
  });

  it('leaves an existing row completely untouched on a repeated enqueue', async () => {
    /**
     * The property that makes a repeated enqueue safe, and it is stronger than
     * "no duplicate row": the upsert must not WRITE at all.
     *
     * A repeated enqueue is ordinary — a transaction retry, two concurrent
     * duplicate submissions, a reconciliation sweep re-deriving an event — and
     * the dispatcher is concurrently taking, renewing and completing leases on
     * these same rows. If the upsert wrote (which it does when Mongoose owns
     * `updatedAt` and adds its own `$set`), it would conflict with a live lease
     * update and abort the enclosing transaction. `updatedAt` is the observable
     * edge of that: unchanged means nothing was written.
     */
    harness = await createHarness();
    const eventId = 'moderation:report.submit:repeat-is-a-no-op';
    const enqueueOnce = async (): Promise<void> => {
      const session = await harness?.connection.startSession();
      if (session === undefined) throw new Error('no connection');
      try {
        await session.withTransaction(async () => {
          await harness?.moderation.outbox.enqueue(
            { eventId, kind: 'report.submit', payload: { reportId: 'repeat' } },
            session,
          );
        });
      } finally {
        await session.endSession();
      }
    };

    await enqueueOnce();
    const first = await harness.moderation.models.outbox.findById(eventId).lean();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await enqueueOnce();
    const second = await harness.moderation.models.outbox.findById(eventId).lean();

    expect(first?.createdAt).toBeInstanceOf(Date);
    expect(second?.updatedAt?.getTime()).toBe(first?.updatedAt?.getTime());
    expect(await harness.moderation.models.outbox.countDocuments({})).toBe(1);
  });

  it('re-enqueues inside a transaction without blocking a live lease write', async () => {
    /**
     * The reconciliation shape: a sweep re-derives a delivery event in its own
     * transaction while the dispatcher writes the lease on the same row.
     *
     * ## This is a regression guard, NOT the evidence for the fix
     *
     * Stated plainly because it would otherwise read as the proof, and it is
     * not: the load-bearing assertion is the `updatedAt`-unchanged test above,
     * which is deterministic everywhere. This one observes a LOCK, and an
     * UNBOUNDED lock observation has no stable verdict.
     *
     * Three of us measured the same defect on the same topology — a single-node
     * `MongoMemoryReplSet` — with three different results. `allo`'s unbounded
     * probe ABORTED (the write fails code 112 `WriteConflict`, and the commit
     * that follows fails code 251 `NoSuchTransaction`; both carry
     * `TransientTransactionError`). This one HUNG for 88 seconds until
     * the runner's timeout. `mercaria` ran this test's earlier, unbounded shape
     * and saw NO conflict at all, so it passed with and without the defect for
     * them.
     *
     * Same defect, same topology, three verdicts — which is the whole argument.
     * It is not that some environments are unlucky; it is that "did the
     * contending write throw" is not a question with one answer, so a test
     * asking it can go green, red, or nowhere, and none of the three means
     * anything. (`allo` established this by checking their own topology after I
     * had loosely blamed environment differences; the variable was the bound.)
     *
     * ## Why it is bounded
     *
     * `maxTimeMS` is the difference between a guard and a trap. Unbounded, this
     * test does fail under the defect — measured, by HANGING for 88 seconds
     * until the runner's timeout. A failure mode of "hang" cannot distinguish a
     * broken guard from a broken harness (a slow CI box, a stalled mongod), so
     * a red run would tell the next person nothing about which. Bounded, the
     * blocked write fails as a NAMED server error in about two seconds.
     *
     * Credit: `noted-moovo` designed this bound for Moovo's copy and named the
     * reason before I had measured the hang here.
     */
    harness = await createHarness();
    const eventId = 'moderation:report.submit:contended';
    const enqueue = async (): Promise<void> => {
      const session = await harness?.connection.startSession();
      if (session === undefined) throw new Error('no connection');
      try {
        await session.withTransaction(async () => {
          await harness?.moderation.outbox.enqueue(
            { eventId, kind: 'report.submit', payload: { reportId: 'contended' } },
            session,
          );
          // The dispatcher, mid-flight on the same row and outside the
          // transaction. A no-op enqueue takes no lock, so this returns at once.
          await harness?.moderation.models.outbox
            .updateOne({ _id: eventId }, { $set: { leaseOwner: 'another-task' } })
            .maxTimeMS(2_000);
        });
      } finally {
        await session.endSession();
      }
    };

    await enqueue();
    await expect(enqueue()).resolves.toBeUndefined();
    expect(await harness.moderation.models.outbox.countDocuments({})).toBe(1);
  });
});

describe('intake refuses an identifier that is not a string', () => {
  it.each([
    ['reporter', { reporter: { $ne: null } }],
    ['reportedId', { reportedId: { $ne: null } }],
    ['reportedType', { reportedType: { $ne: null } }],
  ])('rejects a query operator supplied as %s', async (_field, override) => {
    harness = await createHarness();
    const input: CreateReportInput = {
      reporter: 'oxy-reporter',
      reportedType: 'widget',
      reportedId: String(new mongoose.Types.ObjectId()),
      categories: ['spam'],
    };

    /**
     * `Object.assign` rather than a cast: the point is a value that is a string
     * to the compiler and an operator at runtime, which is exactly the shape
     * that reaches a route from an untrusted body. A truthiness check passes
     * `{ $ne: null }`, and handed that the duplicate lookup matches an UNRELATED
     * report and answers "you already reported this" about somebody else's row.
     */
    Object.assign(input, override);

    await expect(harness.moderation.createReport(input)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(await harness.reports.countDocuments({})).toBe(0);
  });
});
