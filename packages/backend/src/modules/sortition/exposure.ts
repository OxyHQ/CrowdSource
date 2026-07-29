import {
  SENSITIVE_EXPOSURE_MAX,
  SENSITIVE_EXPOSURE_WINDOW_HOURS,
  type ExposureFacts,
} from '../reviewer/eligibility';
import {
  assignments,
  OPEN_ASSIGNMENT_STATUSES,
  type AssignmentDocument,
} from './assignment.collection';

/**
 * §13.7's exposure and rest, counted from the assignments themselves.
 *
 * Counted rather than stored. A counter on the profile drifts every time a write
 * fails between the two documents, and the drift always runs the same way —
 * toward believing somebody has done less than they have, which is the direction
 * that overloads a person.
 *
 * Two callers, ONE fold. The draw needs the numbers for every sampled candidate,
 * and the reviewer's own profile screen needs them for one person plus the moment
 * their rest lifts. Those are the same rules applied to the same rows, so they
 * are the same code: a second implementation of "how many did this person do
 * today" is a second answer to a question §13.7 makes load-bearing, and the two
 * would disagree the first time either was edited. `foldExposure` is that single
 * definition; the two exported functions differ only in how many reviewers they
 * ask about and in whether they also report the rest instant.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The start of the current UTC day, for §13.7's daily limits. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** What one reviewer's rows add up to, before anything is decided about them. */
interface ExposureTally {
  readonly facts: ExposureFacts;
  /**
   * The earliest sensitive review still inside the rest window.
   *
   * Kept alongside the count because the count answers "is this person resting"
   * and only the instant answers "until when" — and a screen that can say the
   * first without the second leaves a reviewer with a block and no end to it.
   */
  readonly oldestSensitiveInWindow: Date | null;
}

const EMPTY: ExposureTally = {
  facts: { openAssignments: 0, reviewsToday: 0, sensitiveReviewsInWindow: 0 },
  oldestSensitiveInWindow: null,
};

/**
 * The rows §13.7 is computed from: what this person is holding now, and what
 * they completed today.
 *
 * The `$or` is what makes it one query rather than two. Open assignments are
 * bounded by `MAX_OPEN_ASSIGNMENTS` and today's completions by the daily limit,
 * so the result is small by construction for every reviewer in the system.
 */
function exposureRows(
  reviewerIds: readonly string[],
  dayStart: Date,
): Promise<AssignmentDocument[]> {
  return assignments.find({
    reviewerId: { $in: [...reviewerIds] },
    $or: [{ status: { $in: [...OPEN_ASSIGNMENT_STATUSES] } }, { completedAt: { $gte: dayStart } }],
  });
}

function foldExposure(
  reviewerIds: readonly string[],
  rows: readonly AssignmentDocument[],
  now: Date,
): Map<string, ExposureTally> {
  const tallies = new Map<string, ExposureTally>();
  for (const reviewerId of reviewerIds) {
    tallies.set(reviewerId, EMPTY);
  }

  const dayStart = startOfUtcDay(now);
  const windowStart = new Date(now.getTime() - SENSITIVE_EXPOSURE_WINDOW_HOURS * HOUR_MS);

  for (const row of rows) {
    const tally = tallies.get(row.reviewerId);
    if (!tally) continue;

    const openAssignments =
      tally.facts.openAssignments +
      (OPEN_ASSIGNMENT_STATUSES.includes(row.status) && row.expiresAt.getTime() > now.getTime()
        ? 1
        : 0);
    const completedAt = row.completedAt;
    const completedToday = completedAt !== null && completedAt >= dayStart;
    const sensitiveInWindow =
      completedToday &&
      row.sensitivityClass !== 'standard' &&
      completedAt !== null &&
      completedAt >= windowStart;

    tallies.set(row.reviewerId, {
      facts: {
        openAssignments,
        reviewsToday: tally.facts.reviewsToday + (completedToday ? 1 : 0),
        sensitiveReviewsInWindow:
          tally.facts.sensitiveReviewsInWindow + (sensitiveInWindow ? 1 : 0),
      },
      oldestSensitiveInWindow:
        sensitiveInWindow && completedAt !== null
          ? tally.oldestSensitiveInWindow === null || completedAt < tally.oldestSensitiveInWindow
            ? completedAt
            : tally.oldestSensitiveInWindow
          : tally.oldestSensitiveInWindow,
    });
  }

  return tallies;
}

/** §13.7's exposure for every sampled candidate, in one query. */
export async function gatherExposure(
  reviewerIds: readonly string[],
  now: Date,
): Promise<ReadonlyMap<string, ExposureFacts>> {
  const facts = new Map<string, ExposureFacts>();
  for (const reviewerId of reviewerIds) {
    facts.set(reviewerId, EMPTY.facts);
  }
  if (reviewerIds.length === 0) return facts;

  const rows = await exposureRows(reviewerIds, startOfUtcDay(now));
  for (const [reviewerId, tally] of foldExposure(reviewerIds, rows, now)) {
    facts.set(reviewerId, tally.facts);
  }
  return facts;
}

export interface ReviewerExposure {
  readonly facts: ExposureFacts;
  /**
   * When the sensitive-material rest lifts, or null when none is in force.
   *
   * §13.7's rest rests only the SENSITIVE route: a reviewer who has just worked
   * through several distressing cases is still able to judge a spam report, and a
   * rest that removed them from everything would make looking after yourself cost
   * you your place in the pool. So this is never a blanket block, and a screen
   * showing it has to say which route it applies to.
   */
  readonly breakRequiredUntil: Date | null;
}

/** §13.7's exposure and rest for ONE reviewer — their own profile screen. */
export async function reviewerExposure(
  reviewerId: string,
  now: Date = new Date(),
): Promise<ReviewerExposure> {
  const rows = await exposureRows([reviewerId], startOfUtcDay(now));
  const tally = foldExposure([reviewerId], rows, now).get(reviewerId) ?? EMPTY;

  const resting = tally.facts.sensitiveReviewsInWindow >= SENSITIVE_EXPOSURE_MAX;
  return {
    facts: tally.facts,
    breakRequiredUntil:
      resting && tally.oldestSensitiveInWindow !== null
        ? new Date(
            tally.oldestSensitiveInWindow.getTime() + SENSITIVE_EXPOSURE_WINDOW_HOURS * HOUR_MS,
          )
        : null,
  };
}
