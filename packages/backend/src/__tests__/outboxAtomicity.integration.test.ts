import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { reports } from '../modules/ingestion/report.collection';
import { deliverReport } from '../modules/ingestion/report.service';
import { appendAuditEvent } from '../modules/audit/audit.collection';
import { appendOutboxEvent } from '../modules/outbox/outbox.collection';
import {
  provisionTenant,
  sampleEnvelope,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/** A delivery for this tenant, distinct from every other test's material. */
function delivery(externalReportId: string) {
  return {
    externalReportId,
    idempotencyKey: externalReportId,
    envelope: sampleEnvelope({
      applicationId: tenant.applicationId,
      externalReportId,
      subjectExternalId: `post_${externalReportId}`,
    }),
    credentialId: 'csk_00000000000000000000000000000003',
  };
}

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

vi.mock('../modules/audit/audit.collection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/audit/audit.collection')>();
  return { ...actual, appendAuditEvent: vi.fn(actual.appendAuditEvent) };
});

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
  vi.mocked(appendAuditEvent).mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await stopDatabase();
});

describe('a report and its outbox event commit together', () => {
  it('control: the happy path stores both', async () => {
    const externalReportId = `atomic-ok-${Date.now()}`;
    const delivered = await deliverReport(tenant.tenant, delivery(externalReportId));

    expect(await reports.findOne(tenant.tenant, { externalReportId })).not.toBeNull();
    expect(
      await mongoose.connection
        .collection('outbox_events')
        .countDocuments({ 'payload.reportId': delivered.reportId }),
    ).toBe(1);
    /**
     * Two rows: the report's own, and the case's trigger for triage — asserted
     * on the DATABASE rather than on the call count. `withTransaction` uses the
     * driver's own retry, which re-runs the whole callback on a write conflict,
     * so the number of CALLS depends on contention from whatever else is running
     * against the replica set. What must be exact is what committed.
     */
    expect(
      await mongoose.connection
        .collection('outbox_events')
        .countDocuments({ type: 'case.ready_for_triage', 'payload.caseId': delivered.caseId }),
    ).toBe(1);
  });

  it('rolls the report back when the outbox event cannot be written', async () => {
    const externalReportId = `atomic-fail-${Date.now()}`;
    vi.mocked(appendOutboxEvent).mockRejectedValueOnce(new Error('outbox write failed'));

    await expect(
      deliverReport(tenant.tenant, delivery(externalReportId)),
    ).rejects.toThrow(/outbox write failed/);

    // The report must not exist. If it did, an application would hold a 202 for
    // a report nothing will ever triage.
    expect(await reports.findOne(tenant.tenant, { externalReportId })).toBeNull();
    expect(
      await mongoose.connection.collection('reports').countDocuments({ externalReportId }),
    ).toBe(0);

    /**
     * And no case either. The case is written before the report in the same
     * transaction, so a case surviving a rolled-back delivery would be an
     * expedient with no report behind it — a jury asked to review material
     * nobody actually reported.
     */
    expect(
      await mongoose.connection
        .collection('cases')
        .countDocuments({ externalSubjectId: `post_${externalReportId}` }),
    ).toBe(0);

    // The audit row is part of the same transaction and rolls back with it: a
    // trail claiming an accepted ingress that never happened is worse than none.
    expect(
      await mongoose.connection
        .collection('audit_events')
        .countDocuments({ externalReportId, action: 'report.ingress.accepted' }),
    ).toBe(0);
  });

  /**
   * The other direction, and the one that actually pins the mechanism.
   *
   * The test above makes the outbox write FAIL, which rolls the report back
   * whether or not the event ever joined the transaction — so it would still
   * pass if `appendOutboxEvent` quietly ignored its session. Here the outbox
   * write SUCCEEDS and a later write in the same transaction fails: the row
   * survives if and only if it escaped the transaction, which is precisely the
   * bug that would leave moderation work with no trace.
   */
  it('rolls the outbox row back when a LATER write in the same transaction fails', async () => {
    const externalReportId = `atomic-escape-${Date.now()}`;
    const rowsBefore = await mongoose.connection
      .collection('outbox_events')
      .countDocuments({ applicationId: tenant.applicationId });

    vi.mocked(appendAuditEvent).mockRejectedValueOnce(new Error('audit write failed'));

    await expect(
      deliverReport(tenant.tenant, delivery(externalReportId)),
    ).rejects.toThrow(/audit write failed/);

    // The events WERE written; the transaction they were written in did not
    // commit, so nothing of them may survive.
    expect(appendOutboxEvent).toHaveBeenCalled();
    expect(
      await mongoose.connection
        .collection('outbox_events')
        .countDocuments({ applicationId: tenant.applicationId }),
    ).toBe(rowsBefore);
    expect(await reports.findOne(tenant.tenant, { externalReportId })).toBeNull();
  });

  it('leaves the idempotency key free after a rolled-back delivery', async () => {
    const externalReportId = `atomic-retry-${Date.now()}`;
    vi.mocked(appendOutboxEvent).mockRejectedValueOnce(new Error('outbox write failed'));

    await expect(
      deliverReport(tenant.tenant, delivery(externalReportId)),
    ).rejects.toThrow();

    // §7.1: the application retries from its own outbox. A rolled-back attempt
    // that left its unique keys behind would make every retry a permanent 409.
    const retried = await deliverReport(tenant.tenant, delivery(externalReportId));

    expect(retried.replayed).toBe(false);
    expect(await reports.findOne(tenant.tenant, { externalReportId })).not.toBeNull();
  });
});
