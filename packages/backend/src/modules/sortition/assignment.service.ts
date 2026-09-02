import type { TransactionSession } from '../../db/collections';
import type { RecusalReason } from '@oxyhq/crowdsource-contracts';

import { createTenantContext } from '../../db/tenantScope';
import { getPostgresDatabase } from '../../db/postgres/database';
import {
  consumeAssignmentForReview as consumeAssignmentRow,
  expireAssignment as expireAssignmentRow,
  findAssignmentById,
  findDueAssignments,
  findNextOpenAssignment,
  openAssignment as openAssignmentRow,
  recuseAssignment as recuseAssignmentRow,
} from '../../db/postgres/repositories/sortition';
import { withTransaction } from '../../db/transaction';
import { ApiError } from '../../http/apiError';
import { logger } from '../../utils/logger';
import { cases } from '../cases/case.collection';
import { appendOutboxEvent, OUTBOX_EVENT_TYPES } from '../outbox/outbox.collection';
import { declareReviewerRelation } from '../reviewer/reviewer.service';
import { OPEN_ASSIGNMENT_STATUSES } from '../../db/postgres/schema/sortition';
import type { AssignmentDocument } from './assignment.collection';
import { assignmentTokenMatches, mintAssignmentToken } from './assignmentToken';

/**
 * The reviewer's side of an assignment (§8.7, §10.3).
 *
 * Everything a reviewer can do with a case they were drawn for lives here:
 * pick up the next one they were given, open it, step away from it. What they
 * cannot do is choose it — `nextAssignment` returns what the server already
 * assigned and has no parameters at all. There is no case id to pass, no filter,
 * no queue to browse. That is "nobody chooses the case they review" expressed as
 * an absent parameter rather than as a rule somebody has to remember.
 *
 * ## Authorisation is two independent facts
 *
 * The Oxy session says WHO is asking. The assignment token says WHICH case they
 * were given. Both are required, and neither substitutes for the other: a
 * reviewer holding a valid session but somebody else's assignment id is refused
 * because the row names a different reviewer, and one who somehow learned an
 * assignment id is refused because they cannot produce its token. §8.7 asks for
 * the token specifically; the session check is what makes a leaked token useless
 * to anybody but the person it was issued to.
 *
 * The token ROTATES every time an assignment is opened. That is what gives
 * "reuse a token" an unambiguous answer — an old token is dead, not merely
 * stale — and it lets a reviewer reload the case without the server keeping a
 * long-lived credential alive.
 */

/** What the reviewer needs to know they hold a case. */
export interface IssuedAssignment {
  readonly assignmentId: string;
  readonly caseId: string;
  readonly caseRevision: number;
  /** Returned exactly once per opening; only its hash is stored. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly sensitivityClass: AssignmentDocument['sensitivityClass'];
}

function isLive(assignment: AssignmentDocument, now: Date): boolean {
  return (
    OPEN_ASSIGNMENT_STATUSES.includes(assignment.status) &&
    assignment.expiresAt.getTime() > now.getTime()
  );
}

/**
 * The reviewer's next case: the one they were assigned longest ago.
 *
 * Oldest first, so nothing a reviewer was given can be starved by a newer, more
 * urgent draw — the ordering that decides which case is urgent already happened
 * in triage, and re-applying it here would let a reviewer's queue reshuffle
 * under them between two requests.
 *
 * Opening rotates the token. A reviewer who reloads gets a working token and the
 * previous one stops working, which is the behaviour that makes replay
 * meaningless without making the reviewer's life difficult.
 */
export async function nextAssignment(
  reviewerId: string,
  now: Date = new Date(),
): Promise<IssuedAssignment | null> {
  const assignment = (await findNextOpenAssignment(
    getPostgresDatabase(),
    reviewerId,
    now,
  )) as AssignmentDocument | null;
  if (!assignment) return null;

  return openAssignment(assignment, now);
}

/** Rotates the token and marks the assignment accepted. */
async function openAssignment(
  assignment: AssignmentDocument,
  now: Date,
): Promise<IssuedAssignment> {
  const minted = mintAssignmentToken();

  const updated = (await openAssignmentRow(getPostgresDatabase(), assignment.assignmentId, {
    tokenHash: minted.tokenHash,
    acceptedAt: assignment.acceptedAt ?? now,
  })) as AssignmentDocument | null;

  if (!updated) {
    // Somebody expired or completed it between the read and this write.
    throw new ApiError('conflict', 'This assignment is no longer open.');
  }

  /**
   * The case is under review from the first time a juror opens it. A
   * conditional update rather than a read-then-write, so three reviewers opening
   * at once do not race, and so a case already past this point is not dragged
   * backwards.
   */
  await cases.updateOne(
    createTenantContext(updated.organizationId, updated.applicationId),
    { caseId: updated.caseId, status: 'awaiting_review' },
    { set: { status: 'under_review', updatedAt: now } },
  );

  return {
    assignmentId: updated.assignmentId,
    caseId: updated.caseId,
    caseRevision: updated.caseRevision,
    token: minted.token,
    expiresAt: updated.expiresAt,
    sensitivityClass: updated.sensitivityClass,
  };
}

/**
 * Resolves an assignment for a reviewer holding a token, or refuses.
 *
 * Every refusal is the same 404 with the same message, whether the assignment
 * does not exist, belongs to somebody else, has expired or was already
 * submitted. Distinguishing them would tell a caller which assignment ids are
 * real and who holds them, and a reviewer who was not selected learning that a
 * case exists is exactly what §9.1's blind review is for.
 */
export async function authorizeAssignment(
  reviewerId: string,
  assignmentId: string,
  token: string | null,
  now: Date = new Date(),
): Promise<AssignmentDocument> {
  const notFound = new ApiError('not_found', 'No such assignment.');

  const assignment = (await findAssignmentById(
    getPostgresDatabase(),
    assignmentId,
  )) as AssignmentDocument | null;
  if (!assignment) {
    // Still spend the comparison, so a nonexistent id is not measurably cheaper
    // to reject than a real one with a wrong token.
    assignmentTokenMatches(token, 'x'.repeat(64));
    throw notFound;
  }

  const tokenOk = assignmentTokenMatches(token, assignment.tokenHash);
  if (assignment.reviewerId !== reviewerId || !tokenOk) throw notFound;
  if (!isLive(assignment, now)) throw notFound;

  return assignment;
}

/**
 * Marks an assignment as having produced a review, atomically.
 *
 * The conditional filter IS the "one vote per juror" rule. A second submission
 * — a double-click, a retried request, a reviewer trying twice — finds the
 * status no longer `accepted` and modifies nothing, so the caller gets a
 * conflict rather than a second review. Checking the status first and writing
 * afterwards would race with itself.
 *
 * Runs inside the review's transaction, so a review that fails to store does not
 * leave a consumed assignment behind and a consumed assignment cannot exist
 * without its review.
 */
export async function consumeAssignmentForReview(
  assignmentId: string,
  session: TransactionSession,
  now: Date = new Date(),
): Promise<AssignmentDocument> {
  const consumed = (await consumeAssignmentRow(
    session,
    assignmentId,
    now,
  )) as AssignmentDocument | null;

  if (!consumed) {
    throw new ApiError('conflict', 'This assignment has already been used or is no longer open.');
  }
  return consumed;
}

/**
 * §8.7's recusal: the reviewer steps away and a replacement is drawn.
 *
 * Three things are true at once and each is tested:
 *
 *  - A recusal is NOT a vote. Nothing is written to the review collection and
 *    the panel is one member short until the replacement lands.
 *  - A recusal is never punished (§8.7, §13.7). No reliability is touched, no
 *    counter is incremented, and a `conflict_of_interest` recusal actively HELPS
 *    the reviewer by recording the relationship so they are not drawn for the
 *    same people again.
 *  - The threshold does not drop. The replacement fills the same slot under the
 *    same specification; if nobody can fill it, the draw refuses rather than
 *    seating somebody weaker.
 *
 * The replacement goes through the outbox rather than being drawn inline. A
 * replacement that lived only in this request would be lost the moment the
 * request failed after the recusal committed, leaving the panel permanently one
 * short of its own quorum with nothing recording that it happened.
 */
export async function recuseAssignment(
  reviewerId: string,
  assignmentId: string,
  token: string | null,
  reason: RecusalReason,
  now: Date = new Date(),
): Promise<void> {
  const assignment = await authorizeAssignment(reviewerId, assignmentId, token, now);

  await withTransaction(async (session) => {
    const recused = (await recuseAssignmentRow(
      session,
      assignmentId,
      reason,
    )) as AssignmentDocument | null;

    if (!recused) {
      throw new ApiError('conflict', 'This assignment is no longer open.');
    }

    if (reason === 'conflict_of_interest') {
      /**
       * §8.7 forbids penalising a recusal, and silently re-drawing somebody for
       * the same person is a penalty in everything but name — they would have to
       * declare the same conflict again and again. Recording it once means the
       * exclusion holds for every future case involving those principals.
       */
      const stored = await cases.findOne(
        createTenantContext(assignment.organizationId, assignment.applicationId),
        { caseId: assignment.caseId },
      );
      const principalIds = (stored?.contentSnapshot.principals ?? [])
        .map((principal) => principal.externalPrincipalId)
        .filter((id): id is string => id !== undefined);

      for (const principalId of principalIds) {
        await declareReviewerRelation(
          reviewerId,
          assignment.applicationId,
          principalId,
          'recusal',
          session,
        );
      }
    }

    await appendOutboxEvent(
      createTenantContext(assignment.organizationId, assignment.applicationId),
      session,
      {
        type: OUTBOX_EVENT_TYPES.assignmentVacated,
        payload: { caseId: assignment.caseId, assignmentId },
      },
    );
  });
}

/**
 * Expires assignments whose time has run out and asks for replacements (§8.7).
 *
 * One row at a time, in its own transaction, because each one produces a
 * replacement draw and a single failure must not roll back the others. The
 * conditional filter makes a concurrent sweep harmless: whichever process
 * updates the row first is the one that emits its event.
 */
export async function expireDueAssignments(
  now: Date = new Date(),
  limit = 100,
): Promise<number> {
  const due = (await findDueAssignments(
    getPostgresDatabase(),
    now,
    limit,
  )) as AssignmentDocument[];

  let expired = 0;
  for (const assignment of due) {
    try {
      await withTransaction(async (session) => {
        const updated = await expireAssignmentRow(session, assignment.assignmentId);
        if (!updated) return;

        await appendOutboxEvent(
          createTenantContext(assignment.organizationId, assignment.applicationId),
          session,
          {
            type: OUTBOX_EVENT_TYPES.assignmentVacated,
            payload: { caseId: assignment.caseId, assignmentId: assignment.assignmentId },
          },
        );
        expired += 1;
      });
    } catch (error: unknown) {
      // One stuck row must not stop the sweep: the remaining assignments are
      // still overdue, and their panels are still a member short.
      logger.error(
        { assignmentId: assignment.assignmentId, err: error },
        'Expiring an assignment failed',
      );
    }
  }

  return expired;
}

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Starts the expiry sweep.
 *
 * Called by `server.ts` and never by `app.ts`, for the same reason as the outbox
 * dispatcher: building the HTTP application must start no timers. `.unref()`
 * because a housekeeping interval that keeps the event loop alive turns a clean
 * shutdown into a hang.
 */
export function startAssignmentExpirySweep(intervalMs = 60_000): void {
  if (sweepTimer) return;

  sweepTimer = setInterval(() => {
    void expireDueAssignments().catch((error: unknown) => {
      logger.error({ err: error }, 'Assignment expiry sweep failed');
    });
  }, intervalMs);
  sweepTimer.unref?.();
}

export function stopAssignmentExpirySweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
