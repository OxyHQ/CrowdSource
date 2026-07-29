import { Router, type Request } from 'express';

import { ApiError } from '../../http/apiError';
import { isPublicId } from '../../utils/identifiers';
import { appendAuditEvent } from '../audit/audit.collection';
import {
  requestCredentialId,
  requestTenant,
  requireServiceCredential,
} from '../tenancy/serviceCredentialAuth';
import {
  assertEnvelopeBelongsToTenant,
  assertNoUnsafeUrls,
  parseDelivery,
  type ValidatedDelivery,
} from './envelopeValidation';
import {
  deliverReport,
  findReportReceipt,
  recordIngressRefusal,
  type DeliveredReport,
} from './report.service';

/**
 * The application-facing report endpoints (§10.2, §10.4).
 *
 * Ingress validation is §7.2 and lives in `envelopeValidation.ts`, which states
 * which of its eight steps this service performs and which it cannot yet. This
 * file is the transport: read the idempotency key, run the validation, record
 * what happened, answer with the codes §10.5 assigns meanings to.
 */

/**
 * The retry key of §10.4.
 *
 * Required, not optional. §7.1 makes the caller responsible for retrying from
 * its own outbox until CrowdSource accepts a delivery, and a retry with no key
 * can only be recognised by `externalReportId` — which works right up until an
 * integration reuses one. Requiring the header removes a whole class of
 * integrations that appear correct because they were never retried.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

function readIdempotencyKey(request: Request): string {
  const value = request.get('idempotency-key')?.trim();
  if (!value) {
    throw new ApiError('invalid_request', 'The Idempotency-Key header is required.');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ApiError(
      'invalid_request',
      'The Idempotency-Key header must be 1-255 characters of letters, digits, dot, colon, underscore or hyphen.',
    );
  }
  return value;
}

export const reportsRouter: Router = Router();

reportsRouter.post(
  '/reports',
  requireServiceCredential('crowdsource:reports:write'),
  async (request, response) => {
    const tenant = requestTenant(request);
    const credentialId = requestCredentialId(request);
    const idempotencyKey = readIdempotencyKey(request);

    /**
     * Every refusal below is audited before it is thrown (§15.3 asks for audit
     * of ingress, and a refusal IS an ingress event). The `externalReportId`
     * recorded is only ever one the contract has already validated the shape of
     * — echoing an unvalidated caller string into the longest-retained
     * collection in the system is how an audit row acquires a payload.
     */
    let delivery: ValidatedDelivery;
    try {
      delivery = parseDelivery(request.body);
    } catch (error: unknown) {
      await recordIngressRefusal(tenant, { externalReportId: null, credentialId }, 'schema_invalid');
      throw error;
    }

    const refusalContext = { externalReportId: delivery.externalReportId, credentialId };

    try {
      assertEnvelopeBelongsToTenant(tenant, delivery.envelope);
    } catch (error: unknown) {
      await recordIngressRefusal(tenant, refusalContext, 'application_mismatch');
      throw error;
    }

    try {
      assertNoUnsafeUrls(delivery.envelope);
    } catch (error: unknown) {
      await recordIngressRefusal(tenant, refusalContext, 'unsafe_resource_url');
      throw error;
    }

    /**
     * No canonicalisation guard here on purpose. `canonicalize` refuses nesting
     * past 64 levels and non-finite numbers; the envelope reaching this line has
     * already been parsed by the contract, whose deepest structure is a bounded
     * custom payload nowhere near that limit, and a JSON body cannot express a
     * non-finite number at all. A catch for a branch that cannot be taken is a
     * claim the tests cannot check.
     */
    const delivered: DeliveredReport = await deliverReport(tenant, {
      externalReportId: delivery.externalReportId,
      idempotencyKey,
      envelope: delivery.envelope,
      credentialId,
    });

    /**
     * 202, and only 202: the report is stored, its case exists, and durable rows
     * exist for everything that happens next (§7.1). It does not mean a jury has
     * been drawn or that anything downstream has run.
     */
    response.status(202).json({
      reportId: delivered.reportId,
      caseId: delivered.caseId,
      status: delivered.status,
      merged: delivered.merged,
    });
  },
);

reportsRouter.get(
  '/reports/:reportId',
  requireServiceCredential('crowdsource:reports:read'),
  async (request, response) => {
    const reportId = request.params.reportId;
    // A well-formed id that belongs to another tenant and a malformed id get the
    // same 404 — the tenant filter is what decides, and the shape check only
    // saves a query.
    if (typeof reportId !== 'string' || !isPublicId('report', reportId)) {
      throw new ApiError('not_found', 'No such report.');
    }

    const tenant = requestTenant(request);
    const receipt = await findReportReceipt(tenant, reportId);
    if (!receipt) {
      throw new ApiError('not_found', 'No such report.');
    }

    await appendAuditEvent(tenant, {
      action: 'report.receipt.read',
      actorCredentialId: requestCredentialId(request),
      reportId: receipt.reportId,
      caseId: receipt.caseId,
      externalReportId: receipt.externalReportId,
    });

    response.status(200).json({
      reportId: receipt.reportId,
      externalReportId: receipt.externalReportId,
      caseId: receipt.caseId,
      status: receipt.status,
      receivedAt: receipt.receivedAt.toISOString(),
    });
  },
);
