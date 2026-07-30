import { Router } from 'express';
import {
  ASSIGNMENT_TOKEN_HEADER,
  RecusalSubmissionSchema,
  ReviewSubmissionSchema,
  type AssignmentPackage,
  type IssuedAssignmentPackage,
} from '@oxyhq/crowdsource-contracts';

import { createTenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { parseOrThrow } from '../../http/parseBody';
import { isPublicId } from '../../utils/identifiers';
import { appealForRevision } from '../appeals/appeal.service';
import { cases } from '../cases/case.collection';
import { policyVersionOfToken } from '../cases/caseDedupKey';
import { resolvePolicy } from '../policy/policy.registry';
import { requestReviewer, requireReviewerSession } from '../reviewer/reviewerAuth';
import { submitReview } from '../review/review.service';
import type { AssignmentDocument } from './assignment.collection';
import { authorizeAssignment, nextAssignment, recuseAssignment } from './assignment.service';
import { buildReviewPackage } from './reviewPackage';

/**
 * The reviewer's assignment surface (§10.3), and §9.1's blind review.
 *
 * ## There is no case id anywhere in this file
 *
 * Every route is addressed by ASSIGNMENT. `POST /assignments/next` takes no
 * parameters at all — not a category, not a filter, not a case id — so "nobody
 * chooses the case they review" is a fact about the interface rather than a rule
 * somebody enforces. There is no reviewer route that accepts a case id, which
 * makes "a user who was not selected cannot open the case" true by there being
 * nothing to ask.
 *
 * ## Why every refusal is 404
 *
 * A reviewer who presents an assignment id that is not theirs gets exactly the
 * same answer as one who presents an id that does not exist: `404`, same
 * message. `403` would be more informative and that is the problem — it would
 * confirm the assignment exists, which tells the asker that a case exists and
 * that somebody was drawn for it. §9.1 keeps a reviewer from learning who else
 * is on a panel; the same reasoning applies with more force to somebody who is
 * not on it.
 *
 * ## What the package shows
 *
 * §9.1's two lists, implemented as a projection. SHOWN: the resources and the
 * context needed to judge them, the allegation AS AN UNVERIFIED ALLEGATION, the
 * applicable policy and its rules, language, warnings and sensitivity. HIDDEN:
 * the number of reports, any reputation, prior votes or partial results, the
 * identity of other jurors, and the application's identity — a reviewer who
 * knows which product a case came from is a reviewer who knows its brand.
 */

export const assignmentsRouter: Router = Router();

function presentedToken(headerValue: string | undefined): string | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireAssignmentId(value: unknown): string {
  if (typeof value !== 'string' || !isPublicId('assignment', value)) {
    throw new ApiError('not_found', 'No such assignment.');
  }
  return value;
}

/**
 * Loads what `buildReviewPackage` needs, and does nothing else.
 *
 * The projection itself is pure and lives in `reviewPackage.ts`, because §9.1 is
 * a statement about which fields exist and testing that should not require a
 * database, a draw and an HTTP request. This function is the I/O half: the case
 * and its policy, read under the tenant the ASSIGNMENT was stamped with — never a
 * tenant from the request, which a reviewer's session could not carry anyway.
 */
async function reviewPackage(assignment: AssignmentDocument): Promise<AssignmentPackage> {
  const context = createTenantContext(assignment.organizationId, assignment.applicationId);
  const stored = await cases.findOne(context, { caseId: assignment.caseId });
  if (!stored) {
    throw new ApiError('not_found', 'No such assignment.');
  }

  const policy = await resolvePolicy(context, {
    policySetId: stored.policySetId,
    version: policyVersionOfToken(stored.policyVersion, stored.policySetId),
  });

  return buildReviewPackage(
    assignment,
    stored,
    policy,
    await appealAuthorContext(assignment),
  );
}

/**
 * §9.8's "contexto adicional", for a panel reviewing an appeal.
 *
 * The author's own explanation is the one thing an appeal adds to what a first
 * panel saw, and it is the whole reason §9.8 lets them file one. It arrives here
 * already redacted — that happens once, at ingress, so the raw bytes are never
 * stored — and it is labelled `unverified` exactly as an allegation is: a claim by
 * an interested party, not a finding.
 *
 * What is deliberately withheld is everything ELSE about the appeal. Not the
 * reason code, which is an argument about the verdict and would anchor the reviewer
 * against §9.1's list. Not the superseded decision, its outcome, its findings or
 * its jury — §9.8's blindness rule. Not the threshold this panel is held to, which
 * is a property of the count and not of the material. A reviewer can tell they are
 * looking at a contested case, because somebody is contesting it in their own
 * words; they cannot tell what anybody concluded.
 */
async function appealAuthorContext(
  assignment: AssignmentDocument,
): Promise<AssignmentPackage['authorContext']> {
  if (assignment.caseRevision <= 1) return undefined;

  const appeal = await appealForRevision(
    createTenantContext(assignment.organizationId, assignment.applicationId),
    assignment.caseId,
    assignment.caseRevision,
  );
  if (!appeal || appeal.authorContext === null) return undefined;

  return {
    unverified: true,
    statement: appeal.authorContext.statement,
    resourceIds: appeal.authorContext.resourceIds,
    fields: appeal.authorContext.fields,
  };
}

/**
 * §10.3's "request the next eligible case".
 *
 * It returns what the server already assigned. The draw happened elsewhere, on
 * the case's schedule, and this is the reviewer picking up what they were given
 * — which is why there is nothing to pass and nothing to choose.
 */
assignmentsRouter.post(
  '/reviewer/assignments/next',
  ...requireReviewerSession(),
  async (request, response) => {
    const issued = await nextAssignment(requestReviewer(request).reviewerId);
    if (!issued) {
      response.status(204).end();
      return;
    }

    const assignment = await authorizeAssignment(
      requestReviewer(request).reviewerId,
      issued.assignmentId,
      issued.token,
    );

    const issuedPackage: IssuedAssignmentPackage = {
      ...(await reviewPackage(assignment)),
      /** Returned once, here. Only its hash is stored (§8.7). */
      token: issued.token,
    };
    response.status(200).json(issuedPackage);
  },
);

assignmentsRouter.get(
  '/reviewer/assignments/:assignmentId',
  ...requireReviewerSession(),
  async (request, response) => {
    const assignment = await authorizeAssignment(
      requestReviewer(request).reviewerId,
      requireAssignmentId(request.params.assignmentId),
      presentedToken(request.get(ASSIGNMENT_TOKEN_HEADER)),
    );

    response.status(200).json(await reviewPackage(assignment));
  },
);

assignmentsRouter.post(
  '/reviewer/assignments/:assignmentId/reviews',
  ...requireReviewerSession(),
  async (request, response) => {
    const reviewer = requestReviewer(request);
    const assignmentId = requireAssignmentId(request.params.assignmentId);

    // Authorisation BEFORE parsing, so an unauthorised caller learns nothing
    // about which bodies this endpoint accepts.
    await authorizeAssignment(
      reviewer.reviewerId,
      assignmentId,
      presentedToken(request.get(ASSIGNMENT_TOKEN_HEADER)),
    );

    const submission = parseOrThrow(
      ReviewSubmissionSchema,
      request.body,
      'The review is not valid.',
    );

    const submitted = await submitReview({
      assignmentId,
      reviewerId: reviewer.reviewerId,
      submission,
    });

    /**
     * The receipt carries no case id and no hint of what anybody else
     * concluded. §9.1 forbids showing partial results, and a reviewer learning
     * "you were the third of three" is a partial result.
     */
    response.status(201).json({
      reviewId: submitted.reviewId,
      submittedAt: submitted.submittedAt.toISOString(),
    });
  },
);

assignmentsRouter.post(
  '/reviewer/assignments/:assignmentId/recuse',
  ...requireReviewerSession(),
  async (request, response) => {
    const reviewer = requestReviewer(request);
    const assignmentId = requireAssignmentId(request.params.assignmentId);

    const recusal = parseOrThrow(
      RecusalSubmissionSchema,
      request.body,
      'The recusal is not valid.',
    );

    await recuseAssignment(
      reviewer.reviewerId,
      assignmentId,
      presentedToken(request.get(ASSIGNMENT_TOKEN_HEADER)),
      recusal.reason,
    );

    /**
     * `204`, with nothing in it. §8.7 and §13.7 both say a recusal costs the
     * reviewer nothing, and a body reporting consequences — a new score, a
     * warning, a count — would be the first step toward it costing something.
     */
    response.status(204).end();
  },
);
