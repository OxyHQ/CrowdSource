import { Router } from 'express';
import {
  RecusalSubmissionSchema,
  ReviewSubmissionSchema,
  type CaseEnvelope,
} from '@oxyhq/crowdsource-contracts';

import { createTenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { isPublicId } from '../../utils/identifiers';
import { cases } from '../cases/case.collection';
import { policyVersionOfToken } from '../cases/caseDedupKey';
import { resolvePolicy } from '../policy/policy.registry';
import { requestReviewer, requireReviewerSession } from '../reviewer/reviewerAuth';
import { submitReview } from '../review/review.service';
import type { AssignmentDocument } from './assignment.collection';
import {
  authorizeAssignment,
  nextAssignment,
  recuseAssignment,
} from './assignment.service';

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

/** The header the assignment token travels in (§8.7). */
const ASSIGNMENT_TOKEN_HEADER = 'x-assignment-token';

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
 * The renderable package a juror is authorised to see.
 *
 * `caseId` is deliberately absent even though the reviewer holds an assignment
 * for it: §8.7 asks for resource and application ids to be pseudonymised where
 * they are not needed, and a case id is not needed to judge material. The
 * resource ids ARE needed — a finding names the resource it is about — so they
 * stay.
 */
async function reviewPackage(assignment: AssignmentDocument): Promise<Record<string, unknown>> {
  const context = createTenantContext(assignment.organizationId, assignment.applicationId);
  const stored = await cases.findOne(context, { caseId: assignment.caseId });
  if (!stored) {
    throw new ApiError('not_found', 'No such assignment.');
  }

  const snapshot: CaseEnvelope['resources'] = stored.contentSnapshot.resources;
  const policy = await resolvePolicy(context, {
    policySetId: stored.policySetId,
    version: policyVersionOfToken(stored.policyVersion, stored.policySetId),
  });

  return {
    assignmentId: assignment.assignmentId,
    caseRevision: assignment.caseRevision,
    expiresAt: assignment.expiresAt.toISOString(),

    /** §9.1: the allegation, labelled as what it is — a claim nobody verified. */
    allegations: {
      unverified: true,
      codes: stored.allegationCodes,
    },

    /**
     * §9.1: the applicable policy and its rules, in full.
     *
     * A reviewer is asked whether material breaks a rule, so they are given the
     * rules — including the severities and actions each rule suggests, which is
     * §9.2's second step. Withholding them would be asking somebody to apply a
     * standard nobody showed them.
     */
    policy: {
      policySetId: policy.policySetId,
      version: policy.version,
      taxonomyVersion: policy.taxonomyVersion,
      rules: policy.policySet.rules,
    },

    /** §9.1: language, warnings, sensitivity — and §13.7's blur decision. */
    presentation: {
      sensitivityClass: assignment.sensitivityClass,
      requiresRedaction: stored.requiresRedaction,
      blurBeforeReveal: assignment.sensitivityClass !== 'standard',
    },

    resources: snapshot,
    relations: stored.contentSnapshot.relations,
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

    response.status(200).json({
      /** Returned once, here. Only its hash is stored (§8.7). */
      token: issued.token,
      ...(await reviewPackage(assignment)),
    });
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

    const parsed = ReviewSubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('invalid_request', 'The review is not valid.', {
        issues: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')
          .slice(0, 500),
      });
    }

    const submitted = await submitReview({
      assignmentId,
      reviewerId: reviewer.reviewerId,
      submission: parsed.data,
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

    const parsed = RecusalSubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('invalid_request', 'The recusal is not valid.');
    }

    await recuseAssignment(
      reviewer.reviewerId,
      assignmentId,
      presentedToken(request.get(ASSIGNMENT_TOKEN_HEADER)),
      parsed.data.reason,
    );

    /**
     * `204`, with nothing in it. §8.7 and §13.7 both say a recusal costs the
     * reviewer nothing, and a body reporting consequences — a new score, a
     * warning, a count — would be the first step toward it costing something.
     */
    response.status(204).end();
  },
);
