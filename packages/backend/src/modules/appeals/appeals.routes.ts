import { Router, type Request } from 'express';
import { AppealSubmissionSchema } from '@oxyhq/crowdsource-contracts';

import { ApiError } from '../../http/apiError';
import { isPublicId } from '../../utils/identifiers';
import { appendAuditEvent } from '../audit/audit.collection';
import {
  requestCredentialId,
  requestTenant,
  requireServiceCredential,
} from '../tenancy/serviceCredentialAuth';
import { appealDecision, appealView, fileAppeal } from './appeal.service';

/**
 * `POST /v1/cases/{id}/appeals` (§10.2) — "crear apelación autorizada".
 *
 * The word §10.2 uses is *authorized*, and this is where that is decided. Three
 * independent facts have to hold and none substitutes for another:
 *
 *  1. The caller holds a service credential with `crowdsource:appeals:write`.
 *     The tenant comes from it, never from the body or the path.
 *  2. The case belongs to that tenant, is decided at its current revision, and
 *     the decision carries a consequence §9.8 makes appealable.
 *  3. The appellant is a principal the reported MATERIAL identifies — §9.8's "el
 *     autor" — which a reporter never is.
 *
 * ## Why the appeal surface is the application API and not a reviewer route
 *
 * §9.8 gives the right to the author, and CrowdSource has no relationship with an
 * application's users: it never sees them, never authenticates them, and stores
 * only opaque ids the application chose. So the application files on their behalf,
 * exactly as it files reports. The alternative — CrowdSource authenticating the
 * subject of a case directly — would need it to hold an identity for every user of
 * every tenant, which is the opposite of §13.5's minimisation and of the
 * near-zero-configuration integration the product is built around.
 */
export const appealsRouter: Router = Router();

/**
 * The retry key, required exactly as `POST /v1/reports` requires one (§10.4).
 *
 * Two appeals of two different revisions can carry byte-identical content — same
 * author, same reason, same explanation, filed again against the decision the
 * first appeal produced — so content cannot distinguish a retry from a new filing.
 * The key can, and requiring it removes the class of integrations that look
 * correct until the first timeout.
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

appealsRouter.post(
  '/cases/:caseId/appeals',
  requireServiceCredential('crowdsource:appeals:write'),
  async (request, response) => {
    const caseId = request.params.caseId;
    if (typeof caseId !== 'string' || !isPublicId('case', caseId)) {
      throw new ApiError('not_found', 'No such case.');
    }

    const tenant = requestTenant(request);
    const credentialId = requestCredentialId(request);
    const idempotencyKey = readIdempotencyKey(request);

    const parsed = AppealSubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('invalid_request', 'The appeal is not valid.', {
        issues: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')
          .slice(0, 500),
      });
    }

    const filed = await fileAppeal(tenant, caseId, {
      submission: parsed.data,
      idempotencyKey,
      credentialId,
    });

    /**
     * The audit row records THAT an appeal was filed and by which credential —
     * never the reason and never a syllable of the author's context. §13.6 keeps
     * audit rows longer than the case itself, so a field that occasionally held a
     * fragment of an author's statement would outlive the material it was about.
     */
    await appendAuditEvent(tenant, {
      action: filed.replayed ? 'appeal.filed.replayed' : 'appeal.filed',
      actorCredentialId: credentialId,
      caseId,
    });

    const decision = await appealDecision(tenant, filed.appeal);

    /**
     * `201` for a filing and `200` for a retry of one already stored.
     *
     * The appeal and the revision it opened both exist by the time this answers —
     * unlike a report, whose 202 means "durably queued". What is asynchronous is
     * the JURY: `case.ready_for_review` is committed with the appeal, and sortition
     * draws the panel when the outbox reaches it.
     */
    response.status(filed.replayed ? 200 : 201).json(appealView(filed.appeal, decision));
  },
);
