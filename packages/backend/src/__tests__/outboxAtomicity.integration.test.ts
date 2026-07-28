import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { reports } from '../modules/ingestion/report.collection';
import { deliverReport } from '../modules/ingestion/report.service';
import { appendOutboxEvent } from '../modules/outbox/outbox.collection';
import {
  provisionTenant,
  sampleEnvelope,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * The outbox invariant, tested as an invariant rather than as a comment.
 *
 * BullMQ runs on a single-node Valkey with no replica, no failover and no
 * snapshots, so a queued job can vanish. What makes that a delay rather than
 * lost moderation work is that the domain write and the outbox row commit
 * TOGETHER: if the queue is wiped, everything pending is still re-derivable from
 * the outbox. A report stored WITHOUT its row is work nothing will ever pick up
 * and nothing will ever report — and it fails silently until the day a node is
 * replaced, which is far too late to discover it.
 *
 * So the test does not check that both writes happen on the happy path. It makes
 * the outbox write fail and checks the report is not there either.
 */

vi.mock('../modules/outbox/outbox.collection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/outbox/outbox.collection')>();
  return { ...actual, appendOutboxEvent: vi.fn(actual.appendOutboxEvent) };
});

let tenant: ProvisionedTenant;

beforeAll(async () => {
  await startDatabase();
  tenant = await provisionTenant();
});

afterEach(() => {
  vi.mocked(appendOutboxEvent).mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await stopDatabase();
});

describe('a report and its outbox event commit together', () => {
  it('control: the happy path stores both', async () => {
    const externalReportId = `atomic-ok-${Date.now()}`;
    const delivered = await deliverReport(tenant.tenant, {
      externalReportId,
      idempotencyKey: externalReportId,
      envelope: sampleEnvelope(),
    });

    expect(await reports.findOne(tenant.tenant, { externalReportId })).not.toBeNull();
    expect(
      await mongoose.connection
        .collection('outbox_events')
        .countDocuments({ 'payload.reportId': delivered.reportId }),
    ).toBe(1);
    expect(appendOutboxEvent).toHaveBeenCalledTimes(1);
  });

  it('rolls the report back when the outbox event cannot be written', async () => {
    const externalReportId = `atomic-fail-${Date.now()}`;
    vi.mocked(appendOutboxEvent).mockRejectedValueOnce(new Error('outbox write failed'));

    await expect(
      deliverReport(tenant.tenant, {
        externalReportId,
        idempotencyKey: externalReportId,
        envelope: sampleEnvelope(),
      }),
    ).rejects.toThrow(/outbox write failed/);

    // The report must not exist. If it did, an application would hold a 202 for
    // a report nothing will ever triage.
    expect(await reports.findOne(tenant.tenant, { externalReportId })).toBeNull();
    expect(
      await mongoose.connection.collection('reports').countDocuments({ externalReportId }),
    ).toBe(0);
  });

  it('leaves the idempotency key free after a rolled-back delivery', async () => {
    const externalReportId = `atomic-retry-${Date.now()}`;
    vi.mocked(appendOutboxEvent).mockRejectedValueOnce(new Error('outbox write failed'));

    await expect(
      deliverReport(tenant.tenant, {
        externalReportId,
        idempotencyKey: externalReportId,
        envelope: sampleEnvelope(),
      }),
    ).rejects.toThrow();

    // §7.1: the application retries from its own outbox. A rolled-back attempt
    // that left its unique keys behind would make every retry a permanent 409.
    const retried = await deliverReport(tenant.tenant, {
      externalReportId,
      idempotencyKey: externalReportId,
      envelope: sampleEnvelope(),
    });

    expect(retried.replayed).toBe(false);
    expect(await reports.findOne(tenant.tenant, { externalReportId })).not.toBeNull();
  });
});
