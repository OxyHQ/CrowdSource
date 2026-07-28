import { Router, type Request } from 'express';
import { z } from 'zod';

import { ApiError } from '../../http/apiError';
import { CanonicalJsonError } from '../../utils/canonicalJson';
import { isPublicId } from '../../utils/identifiers';
import { requestTenant, requireServiceCredential } from '../tenancy/serviceCredentialAuth';
import { deliverReport, findReportReceipt, type DeliveredReport } from './report.service';

/**
 * The application-facing report endpoints (§10.2).
 *
 * Ingress validation here covers what Phase 1 owns: the request envelope, the
 * idempotency key and the delivery's addressing. Validating the CASE ENVELOPE
 * itself — `schemaVersion`, resource types, relation references, hashes, upload
 * completion (§7.2 steps 2-7) — belongs to `@oxyhq/crowdsource-contracts`, which
 * is being written separately. That boundary is stated rather than faked: this
 * module refuses a body that is not a JSON object and stores what it is given,
 * and it does not pretend to have checked a schema it has never seen.
 */

/**
 * A JSON object, and specifically not an array or a scalar.
 *
 * `z.record` would also accept an array, since an array is an object; a Case
 * Envelope never is one, and accepting it would push the failure into hashing.
 */
const jsonObjectSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  { message: 'Expected a JSON object' },
);

const deliverySchema = z.object({
  externalReportId: z.string().trim().min(1).max(200),
  envelope: jsonObjectSchema,
});

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

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export const reportsRouter: Router = Router();

reportsRouter.post(
  '/reports',
  requireServiceCredential('crowdsource:reports:write'),
  async (request, response) => {
    const idempotencyKey = readIdempotencyKey(request);

    const parsed = deliverySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('invalid_request', `Invalid report delivery — ${describeIssues(parsed.error)}`);
    }

    const delivered: DeliveredReport = await deliverReport(requestTenant(request), {
      externalReportId: parsed.data.externalReportId,
      idempotencyKey,
      envelope: parsed.data.envelope,
    }).catch((error: unknown) => {
      // Valid JSON that cannot be fingerprinted — too deeply nested to walk
      // safely. §10.5 calls that an unprocessable envelope, not a malformed one.
      if (error instanceof CanonicalJsonError) {
        throw new ApiError(
          'unprocessable_envelope',
          `The envelope cannot be processed — ${error.message}`,
        );
      }
      throw error;
    });

    // 202, and only 202: the report is stored and a durable retry path exists
    // (§7.1). It does not mean a case was created or that anything downstream
    // has run. `caseId` and `merged` join this body when the case orchestrator
    // is built — additive, per §10.11.
    response.status(202).json({ reportId: delivered.reportId, status: delivered.status });
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

    const receipt = await findReportReceipt(requestTenant(request), reportId);
    if (!receipt) {
      throw new ApiError('not_found', 'No such report.');
    }

    response.status(200).json({
      reportId: receipt.reportId,
      externalReportId: receipt.externalReportId,
      status: receipt.status,
      receivedAt: receipt.receivedAt.toISOString(),
    });
  },
);
