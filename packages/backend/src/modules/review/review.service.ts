import type { ReviewSubmission } from '@oxyhq/crowdsource-contracts';

import { createTenantContext } from '../../db/tenantScope';
import { duplicateKeyViolation, withTransaction } from '../../db/transaction';
import { ApiError } from '../../http/apiError';
import { newPublicId } from '../../utils/identifiers';
import { appendOutboxEvent, OUTBOX_EVENT_TYPES } from '../outbox/outbox.collection';
import { recordSubmittedReview } from '../reviewer/reviewer.service';
import { consumeAssignmentForReview } from '../sortition/assignment.service';
import { reviews } from './review.collection';

/**
 * Recording one juror's vote (§9.3).
 *
 * The whole of it is: consume the assignment, store the review, count it toward
 * the reviewer's record — in ONE transaction, so a review cannot exist without
 * the assignment that authorised it having been spent, and a spent assignment
 * cannot exist without its review.
 *
 * The consensus engine (§9.4) is not here and is not implied. This phase owes
 * §15.4's "a user who was not selected cannot open or vote", and that is a
 * question about authorisation and about the ledger, not about what a panel
 * concludes.
 *
 * Three refusals are worth naming, because each is a rule rather than an error:
 *
 *  - No assignment, wrong reviewer, wrong token → 404, from
 *    `authorizeAssignment`. Not 403: telling somebody an assignment exists but
 *    is not theirs is telling them a case exists.
 *  - The assignment was already used → 409, from `consumeAssignmentForReview`,
 *    decided by a conditional update rather than a prior read.
 *  - A review already exists for this juror and revision → 409, from the unique
 *    index. Belt and braces with the previous one, and the belt is the index.
 */

export interface SubmitReviewInput {
  readonly assignmentId: string;
  readonly reviewerId: string;
  readonly submission: ReviewSubmission;
}

export interface SubmittedReview {
  readonly reviewId: string;
  readonly caseId: string;
  readonly caseRevision: number;
  readonly submittedAt: Date;
}

export async function submitReview(input: SubmitReviewInput): Promise<SubmittedReview> {
  const now = new Date();
  const reviewId = newPublicId('review');

  try {
    return await withTransaction(async (session) => {
      const assignment = await consumeAssignmentForReview(input.assignmentId, session, now);

      /**
       * The assignment names the case, the revision and the reviewer. The
       * submission contract is `.strict()` and carries none of them, so there is
       * no field a client could set that would move a vote onto another case —
       * which is the shape "nobody chooses the case they review" takes at the
       * write path.
       */
      await reviews.insertOne(
        {
          reviewId,
          organizationId: assignment.organizationId,
          applicationId: assignment.applicationId,
          assignmentId: assignment.assignmentId,
          caseId: assignment.caseId,
          caseRevision: assignment.caseRevision,
          reviewerId: assignment.reviewerId,
          outcome: input.submission.outcome,
          contextSufficiency: input.submission.contextSufficiency,
          findings: [...input.submission.findings],
          recommendedActions: [...input.submission.recommendedActions],
          notes: input.submission.notes ?? null,
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        session,
      );

      await recordSubmittedReview(assignment.reviewerId, session);

      /**
       * Wakes the consensus engine (§9.4), in this transaction and never inline.
       *
       * Inline evaluation would put the count on the critical path of the third
       * juror's request, and §9.1 forbids a reviewer learning anything about the
       * result — including from a response that took two seconds longer than the
       * previous two. Through the outbox it is also durable: a process that dies
       * between the vote landing and the panel being counted leaves a row that
       * says the panel still needs counting, rather than a case that waits
       * forever for an event nobody recorded.
       */
      await appendOutboxEvent(
        createTenantContext(assignment.organizationId, assignment.applicationId),
        session,
        {
          type: OUTBOX_EVENT_TYPES.reviewSubmitted,
          payload: { caseId: assignment.caseId, assignmentId: assignment.assignmentId },
        },
      );

      return {
        reviewId,
        caseId: assignment.caseId,
        caseRevision: assignment.caseRevision,
        submittedAt: now,
      };
    });
  } catch (error: unknown) {
    const violation = duplicateKeyViolation(error);
    if (violation) {
      throw new ApiError('conflict', 'This juror has already reviewed this case revision.');
    }
    throw error;
  }
}
