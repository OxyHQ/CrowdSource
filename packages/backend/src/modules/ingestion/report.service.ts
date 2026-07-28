import {
  duplicateKeyViolation,
  withTransaction,
  type DuplicateKeyViolation,
} from '../../db/transaction';
import type { TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { canonicalHash } from '../../utils/canonicalJson';
import { newPublicId } from '../../utils/identifiers';
import { appendOutboxEvent, OUTBOX_EVENT_TYPES } from '../outbox/outbox.collection';
import { reports } from './report.collection';

/**
 * The report write path (§7.1, §10.4).
 *
 * Two properties are load-bearing and neither is negotiable:
 *
 *  1. The report and its outbox event commit in ONE transaction. The queue that
 *     will carry the event is a single-node Valkey that can lose it; the row is
 *     what makes the work re-derivable. Enqueueing before writing would be lost
 *     moderation work with no trace.
 *  2. Idempotency is the unique index, not this code. The insert is attempted
 *     first and the collision is interpreted afterwards, because "look, then
 *     insert" races against a concurrent retry of the same delivery.
 */

export interface ReportDelivery {
  readonly externalReportId: string;
  readonly idempotencyKey: string;
  readonly envelope: Record<string, unknown>;
}

export interface DeliveredReport {
  readonly reportId: string;
  readonly status: 'received';
  /** True when this delivery matched one already stored and stored nothing new. */
  readonly replayed: boolean;
}

/** What the application API may read back about a report (§10.2). */
export interface ReportReceipt {
  readonly reportId: string;
  readonly externalReportId: string;
  readonly status: ReportStatus;
  readonly receivedAt: Date;
}

type ReportStatus = 'received' | 'merged' | 'invalid' | 'withdrawn' | 'closed';

/**
 * Stores a report, or recognises it as a delivery already stored.
 *
 * The tenant comes from `context`, which the credential produced. Nothing in
 * `delivery` can influence which application the report belongs to.
 */
export async function deliverReport(
  context: TenantContext,
  delivery: ReportDelivery,
): Promise<DeliveredReport> {
  // The fingerprint covers what was delivered, not how it was addressed: the
  // idempotency key is deliberately absent, so the same content re-sent under a
  // fresh key is recognised as the same report rather than conflicting with it.
  const payloadHash = canonicalHash({
    externalReportId: delivery.externalReportId,
    envelope: delivery.envelope,
  });
  const reportId = newPublicId('report');
  const receivedAt = new Date();

  try {
    return await withTransaction(async (session) => {
      await reports.insertOne(
        context,
        {
          reportId,
          externalReportId: delivery.externalReportId,
          idempotencyKey: delivery.idempotencyKey,
          payloadHash,
          envelope: delivery.envelope,
          status: 'received',
          receivedAt,
          createdAt: receivedAt,
          updatedAt: receivedAt,
        },
        session,
      );

      // Same transaction, no exceptions. If this line and the insert above ever
      // end up in separate commits, a report can exist that nothing will ever
      // triage, and nothing will report that it happened.
      await appendOutboxEvent(context, session, {
        type: OUTBOX_EVENT_TYPES.reportReceived,
        payload: { reportId },
      });

      return { reportId, status: 'received', replayed: false };
    });
  } catch (error: unknown) {
    const violation = duplicateKeyViolation(error);
    if (!violation) throw error;
    return resolveDuplicateDelivery(context, violation, delivery, payloadHash, error);
  }
}

/**
 * Answers a delivery that collided with one already stored.
 *
 * Same content — whichever index caught it — is a retry and gets the original
 * `reportId`. Different content under a key that was already used is a 409:
 * silently overwriting would destroy the evidence the first delivery captured,
 * and silently ignoring would tell the caller its new report was accepted.
 */
async function resolveDuplicateDelivery(
  context: TenantContext,
  violation: DuplicateKeyViolation,
  delivery: ReportDelivery,
  payloadHash: string,
  cause: unknown,
): Promise<DeliveredReport> {
  const fields = new Set(violation.indexFields);

  const collision = fields.has('externalReportId')
    ? {
        filter: { externalReportId: delivery.externalReportId },
        conflict: `externalReportId '${delivery.externalReportId}' was already delivered with different content.`,
      }
    : fields.has('idempotencyKey')
      ? {
          filter: { idempotencyKey: delivery.idempotencyKey },
          conflict: `Idempotency-Key '${delivery.idempotencyKey}' was already used for a different payload.`,
        }
      : null;

  // A collision on an index this function does not know how to interpret is a
  // defect in the collection, not a caller error. Re-raise it rather than
  // guessing which stored report the caller meant.
  if (!collision) throw cause;

  const existing = await reports.findOne(context, collision.filter);
  if (!existing) {
    // The colliding report belongs to another tenant, or was removed between
    // the failed insert and this read. Either way this delivery is neither
    // stored nor refused, and the caller must retry from its own outbox (§10.5).
    throw new ApiError(
      'service_unavailable',
      'The report could not be stored. Retry this delivery.',
    );
  }

  if (existing.payloadHash !== payloadHash) {
    throw new ApiError('conflict', collision.conflict);
  }

  return { reportId: existing.reportId, status: 'received', replayed: true };
}

/** Reads back a report belonging to this tenant, or null. */
export async function findReportReceipt(
  context: TenantContext,
  reportId: string,
): Promise<ReportReceipt | null> {
  const report = await reports.findOne(context, { reportId });
  if (!report) return null;

  // A deliberate projection rather than the stored document: the envelope is
  // evidence, and the application API is not a route back to it.
  return {
    reportId: report.reportId,
    externalReportId: report.externalReportId,
    status: report.status,
    receivedAt: report.receivedAt,
  };
}
