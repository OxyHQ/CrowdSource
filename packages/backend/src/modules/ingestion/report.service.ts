import type { CaseEnvelope } from '@oxyhq/crowdsource-contracts';

import {
  duplicateKeyViolation,
  withTransaction,
  type DuplicateKeyViolation,
} from '../../db/transaction';
import type { TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { canonicalHash } from '../../utils/canonicalJson';
import { newPublicId } from '../../utils/identifiers';
import { logger } from '../../utils/logger';
import { appendAuditEvent, type AuditReason } from '../audit/audit.collection';
import { attachReportToCase } from '../cases/case.service';
import { appendOutboxEvent, OUTBOX_EVENT_TYPES } from '../outbox/outbox.collection';
import { resolvePolicy, type ResolvedPolicy } from '../policy/policy.registry';
import { reports } from './report.collection';

/**
 * The report write path (§7.1, §7.3, §10.4).
 *
 * Three properties are load-bearing and none is negotiable:
 *
 *  1. **The report, its case, the link between them, the outbox events and the
 *     audit row commit in ONE transaction.** The queue that will carry those
 *     events is a single-node Valkey that can lose them; the rows are what make
 *     the work re-derivable. Enqueueing before writing would be lost moderation
 *     work with no trace.
 *  2. **Idempotency is the unique index, not this code** — for the report
 *     (`applicationId + externalReportId`) and for the case
 *     (`applicationId + externalSubjectId + contentHash + policyVersion`). The
 *     write is attempted first and the collision interpreted afterwards, because
 *     "look, then insert" races against a concurrent retry of the same delivery
 *     and, for the case, against a second person reporting the same post in the
 *     same instant.
 *  3. **Two reports about the same version of the same object produce ONE case**
 *     (§7.3, §15.3). That is what stops a hundred reports becoming a hundred
 *     penalties.
 */

export interface ReportDelivery {
  readonly externalReportId: string;
  readonly idempotencyKey: string;
  readonly envelope: CaseEnvelope;
  /** The credential that delivered it, for the audit trail (§13.2). */
  readonly credentialId: string;
}

export interface DeliveredReport {
  readonly reportId: string;
  readonly caseId: string;
  readonly status: 'received' | 'merged';
  /** True when the report joined a case that already existed (§10.4). */
  readonly merged: boolean;
  /** True when this delivery matched one already stored and stored nothing new. */
  readonly replayed: boolean;
}

/** What the application API may read back about a report (§10.2). */
export interface ReportReceipt {
  readonly reportId: string;
  readonly externalReportId: string;
  readonly caseId: string;
  readonly status: ReportStatus;
  readonly receivedAt: Date;
}

type ReportStatus = 'received' | 'merged' | 'invalid' | 'withdrawn' | 'closed';

/**
 * How many times a delivery is retried when the CASE dedup index rejects it.
 *
 * Only one narrow window produces that: two reports about a brand-new case
 * arriving together, where both upserts try to insert and one loses. The retry
 * finds the case the winner created and merges into it. Three attempts is far
 * past what that window can produce; a fourth would mean something is wrong that
 * retrying will not fix.
 */
const CASE_CONTENTION_ATTEMPTS = 3;

/**
 * Stores a report and attaches it to its case, or recognises a delivery already
 * stored.
 *
 * The tenant comes from `context`, which the credential produced. Nothing in
 * `delivery` can influence which application the report belongs to — and the
 * envelope's own `applicationId` was compared against it at the route, so a
 * mismatch never reaches here.
 */
export async function deliverReport(
  context: TenantContext,
  delivery: ReportDelivery,
): Promise<DeliveredReport> {
  /**
   * Resolved BEFORE the transaction, deliberately. An unknown or unpublished
   * policy version is an ordinary refusal (§10.5, 422) and no write should be
   * attempted for it; resolving inside the transaction would run the abort path
   * for something that is not a failure.
   */
  const policy = await resolvePolicy(context, delivery.envelope.policy).catch(
    async (error: unknown) => {
      if (error instanceof ApiError) {
        await recordIngressRefusal(context, delivery, 'policy_unknown');
      }
      throw error;
    },
  );

  // The fingerprint covers what was delivered, not how it was addressed: the
  // idempotency key is deliberately absent, so the same content re-sent under a
  // fresh key is recognised as the same report rather than conflicting with it.
  const payloadHash = canonicalHash({
    externalReportId: delivery.externalReportId,
    envelope: delivery.envelope,
  });

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await storeDelivery(context, delivery, policy, payloadHash);
    } catch (error: unknown) {
      const violation = duplicateKeyViolation(error);
      if (!violation) throw error;

      /**
       * A collision on the case dedup index means another delivery created this
       * case between the upsert reading and writing. The transaction is already
       * doomed, so nothing was stored; retrying finds the case they created.
       *
       * Exhausting the attempts is contention, not a caller error and not a
       * defect, so it answers 503 — which §10.5 defines as "retry from your own
       * outbox". A 500 would tell an integrator to stop retrying a delivery that
       * would succeed on the next attempt.
       */
      if (violation.indexFields.includes('externalSubjectId')) {
        if (attempt < CASE_CONTENTION_ATTEMPTS) continue;
        throw new ApiError(
          'service_unavailable',
          'The case for this report could not be resolved under contention. Retry this delivery.',
        );
      }

      return await resolveDuplicateDelivery(context, violation, delivery, payloadHash, error);
    }
  }
}

async function storeDelivery(
  context: TenantContext,
  delivery: ReportDelivery,
  policy: ResolvedPolicy,
  payloadHash: string,
): Promise<DeliveredReport> {
  const reportId = newPublicId('report');
  const receivedAt = new Date();

  return withTransaction(async (session) => {
    /**
     * The case first, because the report stores its `caseId` and §10.4 answers
     * with it. A delivery that turns out to be a retry aborts the transaction a
     * few lines below, and the counters this incremented roll back with it.
     */
    const attached = await attachReportToCase(context, session, {
      reportId,
      envelope: delivery.envelope,
      policy,
      receivedAt,
    });

    const status = attached.merged ? 'merged' : 'received';

    await reports.insertOne(
      context,
      {
        reportId,
        externalReportId: delivery.externalReportId,
        idempotencyKey: delivery.idempotencyKey,
        payloadHash,
        envelope: delivery.envelope,
        caseId: attached.caseId,
        contentHash: attached.contentHash,
        status,
        receivedAt,
        createdAt: receivedAt,
        updatedAt: receivedAt,
      },
      session,
    );

    // Same transaction, no exceptions. If these lines and the writes above ever
    // end up in separate commits, a report can exist that nothing will ever
    // triage, and nothing will report that it happened.
    await appendOutboxEvent(context, session, {
      type: OUTBOX_EVENT_TYPES.reportReceived,
      payload: { reportId, caseId: attached.caseId },
    });

    /**
     * Triage runs for a merged report too: a second reporter changes velocity
     * and the distinct-reporter count, and can withdraw community review for the
     * whole case (§7.4). What that means for a case already past triage is the
     * worker's decision — it refreshes the numbers without publishing a second
     * `case.ready_for_review`.
     */
    await appendOutboxEvent(context, session, {
      type: OUTBOX_EVENT_TYPES.caseReadyForTriage,
      payload: { caseId: attached.caseId },
    });

    await appendAuditEvent(
      context,
      {
        action: 'report.ingress.accepted',
        actorCredentialId: delivery.credentialId,
        reportId,
        caseId: attached.caseId,
        externalReportId: delivery.externalReportId,
      },
      session,
    );

    return {
      reportId,
      caseId: attached.caseId,
      status,
      merged: attached.merged,
      replayed: false,
    };
  });
}

/**
 * Answers a delivery that collided with one already stored.
 *
 * Same content — whichever index caught it — is a retry and gets the original
 * `reportId` and `caseId`. Different content under a key that was already used
 * is a 409: silently overwriting would destroy the evidence the first delivery
 * captured, and silently ignoring would tell the caller its new report was
 * accepted.
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
  // defect in a collection, not a caller error. Re-raise it rather than
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
    await recordIngressRefusal(context, delivery, 'payload_conflict');
    throw new ApiError('conflict', collision.conflict);
  }

  await appendAuditEvent(context, {
    action: 'report.ingress.replayed',
    actorCredentialId: delivery.credentialId,
    reportId: existing.reportId,
    caseId: existing.caseId,
    externalReportId: existing.externalReportId,
  });

  return {
    reportId: existing.reportId,
    caseId: existing.caseId,
    status: existing.status === 'merged' ? 'merged' : 'received',
    merged: existing.status === 'merged',
    replayed: true,
  };
}

/**
 * Records a refused ingress (§15.3, audit of ingress).
 *
 * A refusal has no transaction to join — nothing was written — and it must not
 * be able to turn a correct 409 into a 500, so a failure to write the trail is
 * logged and the refusal stands. Losing the record of a rejection is bad;
 * converting a clear answer into an opaque server error is worse, because the
 * integrator then retries something that can never succeed.
 */
export async function recordIngressRefusal(
  context: TenantContext,
  /**
   * `externalReportId` is nullable because the earliest refusal happens before
   * the envelope has been parsed, and at that point there is no validated id to
   * record — only an unvalidated caller string, which must not be stored.
   */
  delivery: { readonly externalReportId: string | null; readonly credentialId: string },
  reason: AuditReason,
): Promise<void> {
  try {
    await appendAuditEvent(context, {
      action: 'report.ingress.rejected',
      actorCredentialId: delivery.credentialId,
      ...(delivery.externalReportId === null
        ? {}
        : { externalReportId: delivery.externalReportId }),
      reason,
    });
  } catch (error: unknown) {
    logger.error(
      { err: error, applicationId: context.applicationId, reason },
      'Failed to record a rejected ingress in the audit trail',
    );
  }
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
    caseId: report.caseId,
    status: report.status,
    receivedAt: report.receivedAt,
  };
}
