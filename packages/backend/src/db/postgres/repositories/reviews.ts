import { and, desc, eq, lt, or } from 'drizzle-orm';

import { reviews } from '../schema/sortition';
import { requireTransaction, type PgHandle, type PgTransactionHandle } from '../withTenant';

/**
 * The review ledger, as a PostgreSQL repository.
 *
 * Three call sites, and they are the whole surface: `review.service.ts:64` writes
 * one, `consensus.service.ts:322` reads a revision's panel, and
 * `reviewHistory.ts:192` pages a reviewer's own history. Not tenant-owned, for the
 * reason `schema/sortition.ts` gives: a review joins a tenant's case to a reviewer
 * who belongs to none, and the caller writing it presents an Oxy session carrying
 * no tenant to scope by.
 *
 * NOTHING CALLS THIS IN PRODUCTION YET. `reviewsRepository.realdb.test.ts` is what
 * makes these statements ones that have genuinely run against the real schema, the
 * real uniques and the real unprivileged role.
 */

export type ReviewRow = typeof reviews.$inferSelect;

/**
 * Records one juror's vote, inside the submission's transaction.
 *
 * Transactional because the Mongo call site is: `submitReview` consumes the
 * assignment, writes this row, promotes the reviewer and appends the outbox event
 * in ONE transaction. That is not tidiness — a review stored without its consumed
 * assignment would let the same juror vote again, and an outbox row that failed to
 * commit with the vote leaves a panel that is complete and never counted.
 *
 * No `onConflict` handling, deliberately. A duplicate here is not a retry to be
 * absorbed: it means either the same assignment produced two reviews
 * (`reviews_assignment_id_key`) or one juror voted twice on one revision
 * (`reviews_case_id_reviewer_id_case_revision_key`), and both are §12.7 violations
 * the caller must see. The unique violation aborts the transaction, which is
 * exactly right — the assignment must not stay consumed if the vote did not land.
 */
export async function insertReview(
  tx: PgTransactionHandle,
  row: typeof reviews.$inferInsert,
): Promise<void> {
  requireTransaction(tx);

  await tx.insert(reviews).values(row);
}

/**
 * Every review submitted for one revision of one case — the consensus read.
 *
 * No ordering, matching the Mongo call site, because `evaluateConsensus` folds
 * ballots into counts and a fold does not depend on order. Stated rather than left
 * implicit: adding an `ORDER BY` here would be harmless but would suggest the
 * engine reads them in sequence, which it does not.
 */
export async function findReviewsForCaseRevision(
  db: PgHandle,
  caseId: string,
  caseRevision: number,
): Promise<ReviewRow[]> {
  return db
    .select()
    .from(reviews)
    .where(and(eq(reviews.caseId, caseId), eq(reviews.caseRevision, caseRevision)));
}

/** Where a history page resumes from. Both halves, because one is not a cursor. */
export interface ReviewHistoryCursor {
  readonly submittedAt: Date;
  readonly reviewId: string;
}

/**
 * §4.1's history screen: one reviewer's own reviews, newest first.
 *
 * ## The cursor is the delicate part, so read the comparison before changing it
 *
 * `submitted_at` alone is not a cursor. Review ids are `randomUUID`-derived and
 * carry no order, so two reviews landing in the same millisecond have no tiebreak
 * — and a keyset cursor without a TOTAL order either repeats a row across two
 * pages or drops one entirely. The Mongo site spells that as an `$or` of
 * "strictly older" plus "same instant, smaller id", and this is the same predicate:
 *
 *     submitted_at < $1  OR  (submitted_at = $1 AND review_id < $2)
 *
 * Written as an explicit `OR` rather than as the row comparison
 * `(submitted_at, review_id) < ($1, $2)`. The row form is equivalent HERE and is
 * the more usual spelling — but it evaluates to NULL if either side is NULL, and a
 * NULL predicate silently drops rows rather than erroring. Both columns are
 * `NOT NULL` today, so the two forms agree; the explicit form is chosen because it
 * keeps agreeing if that ever stops being true.
 *
 * `DESC` on both, and neither needs `NULLS LAST` for the same reason. Stated
 * because an ordering that silently misplaces null rows is the house bug, and the
 * next reader should not have to go and check the columns.
 *
 * `limit + 1` is the caller's, not this function's: it asks for one row more than
 * the page to answer "is there a next page" without a second query. The extra row
 * is sliced off by the caller, which is where the page size lives.
 */
export async function findReviewHistoryPage(
  db: PgHandle,
  reviewerId: string,
  after: ReviewHistoryCursor | null,
  limit: number,
): Promise<ReviewRow[]> {
  return db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.reviewerId, reviewerId),
        ...(after === null
          ? []
          : [
              or(
                lt(reviews.submittedAt, after.submittedAt),
                and(
                  eq(reviews.submittedAt, after.submittedAt),
                  lt(reviews.reviewId, after.reviewId),
                ),
              ),
            ]),
      ),
    )
    .orderBy(desc(reviews.submittedAt), desc(reviews.reviewId))
    .limit(limit);
}
