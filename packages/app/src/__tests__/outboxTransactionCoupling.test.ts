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
import { ModerationOutboxTransactionError, reportSubmitEventId } from '../outbox/service';
import type { CreateReportInput } from '../types';
import { createHarness, type Harness } from './support/harness';

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
