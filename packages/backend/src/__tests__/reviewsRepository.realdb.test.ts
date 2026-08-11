import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isCheckViolation, isUniqueViolation } from '@oxyhq/db';

import * as reviewsRepository from '../db/postgres/repositories/reviews';
import { reviews } from '../db/postgres/schema/sortition';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './support/postgresTestDatabase';

/**
 * The review ledger repository, against a real PostgreSQL server.
 *
 * It has no production caller yet, and this suite is why that is acceptable: a
 * repository that only type-checks is a set of statements whose first execution
 * happens in production. Below they have genuinely run, against the real schema,
 * the real uniques, the real CHECKs and the real unprivileged role.
 *
 * Not in the reviewer axis registry: this file seeds no reviewer profile, only
 * reviews, whose `reviewer_id` is a bare string with no row behind it. It matches
 * none of that gate's seeding markers and needs no exemption — an exemption would
 * claim a population this file does not have.
 *
 * Every instant is written RELATIVE to a `now` captured per test. A hardcoded
 * absolute date in a committed fixture is a time bomb that detonates in whichever
 * sibling file happens to run beside it.
 */

let database: PostgresTestDatabase;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.asMigrator`TRUNCATE reviews`;
});

const ORGANIZATION_ID = 'org_reviews_repo_fixture';
const APPLICATION_ID = 'app_reviews_repo_fixture';
const CASE_ID = 'case_reviews_repo_fixture';
const REVIEWER_ID = 'rvw_reviews_repo_fixture';

const MINUTE_MS = 60 * 1000;

/**
 * One submitted review.
 *
 * `reviewerId` and `assignmentId` DERIVE from `reviewId` rather than defaulting to
 * a constant: `reviews_case_id_reviewer_id_case_revision_key` permits one vote per
 * juror per revision and `reviews_assignment_id_key` one review per assignment, so
 * shared defaults would make most multi-row fixtures unrepresentable. Deriving
 * means the default shape is production's — distinct jurors on one panel — and a
 * test wanting several rows for ONE reviewer has to say so.
 */
function reviewRow(
  overrides: Partial<typeof reviews.$inferInsert> & { readonly reviewId: string },
): typeof reviews.$inferInsert {
  return {
    organizationId: ORGANIZATION_ID,
    applicationId: APPLICATION_ID,
    assignmentId: `asg_${overrides.reviewId}`,
    caseId: CASE_ID,
    caseRevision: 1,
    reviewerId: `rvw_${overrides.reviewId}`,
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    findings: [],
    recommendedActions: [],
    notes: null,
    submittedAt: new Date(),
    ...overrides,
  };
}

/** Seeds directly, so a repository write is never its own fixture. */
async function seed(rows: readonly (typeof reviews.$inferInsert)[]): Promise<void> {
  await database.db.insert(reviews).values([...rows]);
}

describe('recording a vote', () => {
  it('writes the review inside a transaction and reads it back', async () => {
    const now = new Date();

    await database.db.transaction(async (tx) => {
      await reviewsRepository.insertReview(
        tx,
        reviewRow({
          reviewId: 'rev_written',
          outcome: 'no_violation',
          contextSufficiency: 'insufficient',
          recommendedActions: ['no_action'],
          notes: 'a note',
          submittedAt: now,
        }),
      );
    });

    const stored = await reviewsRepository.findReviewsForCaseRevision(database.db, CASE_ID, 1);

    expect(stored).toHaveLength(1);
    expect(stored[0].outcome).toBe('no_violation');
    expect(stored[0].contextSufficiency).toBe('insufficient');
    expect(stored[0].recommendedActions).toEqual(['no_action']);
    expect(stored[0].notes).toBe('a note');
    expect(stored[0].submittedAt.getTime()).toBe(now.getTime());
  });
});

describe("the consensus engine's read", () => {
  /**
   * The revision term is the load-bearing half.
   *
   * §9.9: an appeal opens a NEW revision with a NEW panel. A read that dropped the
   * revision term would hand the appeal panel the first-instance votes as well —
   * and consensus counts ballots, so the extra votes would not error, they would
   * change the verdict.
   */
  it('returns only the votes cast on the revision asked for', async () => {
    await seed([
      reviewRow({ reviewId: 'rev_r1_a', caseRevision: 1 }),
      reviewRow({ reviewId: 'rev_r1_b', caseRevision: 1 }),
      reviewRow({ reviewId: 'rev_r2_a', caseRevision: 2 }),
      reviewRow({ reviewId: 'rev_other', caseId: 'case_elsewhere' }),
    ]);

    const first = await reviewsRepository.findReviewsForCaseRevision(database.db, CASE_ID, 1);
    expect(first.map((r) => r.reviewId).sort()).toEqual(['rev_r1_a', 'rev_r1_b']);

    const second = await reviewsRepository.findReviewsForCaseRevision(database.db, CASE_ID, 2);
    expect(second.map((r) => r.reviewId)).toEqual(['rev_r2_a']);
  });

  it('returns nothing for a revision nobody has voted on', async () => {
    await seed([reviewRow({ reviewId: 'rev_only', caseRevision: 1 })]);

    const none = await reviewsRepository.findReviewsForCaseRevision(database.db, CASE_ID, 99);

    expect(none).toEqual([]);
  });
});

describe("§4.1's history page", () => {
  /**
   * Newest first, and the TIE is the case that matters.
   *
   * Two reviews sharing a `submitted_at` is not exotic — a juror finishing two
   * cases in the same millisecond is ordinary at any volume — and it is the only
   * input on which a correct cursor and a broken one disagree. A cursor keyed on
   * `submitted_at` alone returns the right rows for every fixture where the
   * timestamps differ, which is why the happy path proves nothing here.
   */
  it('pages newest first and never repeats or drops a row across a tie', async () => {
    const now = new Date();
    const tied = new Date(now.getTime() - MINUTE_MS);

    await seed([
      reviewRow({ reviewId: 'rev_c_newest', reviewerId: REVIEWER_ID, caseId: 'case_1', submittedAt: now }),
      // Two rows sharing an instant: only the id can break the tie.
      reviewRow({ reviewId: 'rev_b_tie_hi', reviewerId: REVIEWER_ID, caseId: 'case_2', submittedAt: tied }),
      reviewRow({ reviewId: 'rev_a_tie_lo', reviewerId: REVIEWER_ID, caseId: 'case_3', submittedAt: tied }),
      reviewRow({
        reviewId: 'rev_0_oldest',
        reviewerId: REVIEWER_ID,
        caseId: 'case_4',
        submittedAt: new Date(now.getTime() - 5 * MINUTE_MS),
      }),
    ]);

    const first = await reviewsRepository.findReviewHistoryPage(database.db, REVIEWER_ID, null, 2);
    expect(first.map((r) => r.reviewId)).toEqual(['rev_c_newest', 'rev_b_tie_hi']);

    const cursor = { submittedAt: first[1].submittedAt, reviewId: first[1].reviewId };
    const second = await reviewsRepository.findReviewHistoryPage(database.db, REVIEWER_ID, cursor, 2);

    /**
     * `rev_a_tie_lo` shares its instant with the cursor row and must appear
     * exactly once. A cursor comparing only `submitted_at` with `<` DROPS it; one
     * comparing with `<=` REPEATS `rev_b_tie_hi`. Both are asserted here.
     */
    expect(second.map((r) => r.reviewId)).toEqual(['rev_a_tie_lo', 'rev_0_oldest']);

    const seen = [...first, ...second].map((r) => r.reviewId);
    expect(new Set(seen).size, 'a row was repeated across two pages').toBe(seen.length);
    expect(seen.sort()).toEqual(['rev_0_oldest', 'rev_a_tie_lo', 'rev_b_tie_hi', 'rev_c_newest']);
  });

  it('returns only this reviewer, and honours the limit', async () => {
    const now = new Date();
    await seed([
      reviewRow({ reviewId: 'rev_mine_1', reviewerId: REVIEWER_ID, caseId: 'case_a', submittedAt: now }),
      reviewRow({
        reviewId: 'rev_mine_2',
        reviewerId: REVIEWER_ID,
        caseId: 'case_b',
        submittedAt: new Date(now.getTime() - MINUTE_MS),
      }),
      reviewRow({ reviewId: 'rev_theirs', reviewerId: 'rvw_someone_else', caseId: 'case_a' }),
    ]);

    const page = await reviewsRepository.findReviewHistoryPage(database.db, REVIEWER_ID, null, 1);

    expect(page.map((r) => r.reviewId)).toEqual(['rev_mine_1']);
  });

  it('returns nothing for a reviewer who has never voted', async () => {
    await seed([reviewRow({ reviewId: 'rev_somebody', reviewerId: REVIEWER_ID })]);

    const page = await reviewsRepository.findReviewHistoryPage(
      database.db,
      'rvw_never_voted',
      null,
      10,
    );

    expect(page).toEqual([]);
  });
});

/**
 * §12.7, as two constraints rather than one.
 *
 * `review.collection.ts` says both are needed and why. Both directions are
 * asserted here BY NAME, because `isUniqueViolation(error)` alone cannot tell
 * which of the two fired — and the whole point of restoring the second was that
 * the first does not imply it.
 */
describe('one review per juror per revision, and one per assignment', () => {
  it('refuses a second vote by the same juror on the same revision, by name', async () => {
    await seed([reviewRow({ reviewId: 'rev_first', reviewerId: REVIEWER_ID, caseRevision: 1 })]);

    /**
     * A DIFFERENT assignment, so `reviews_assignment_id_key` cannot be what
     * rejects this. Without that difference the test would pass on the constraint
     * that already existed and prove nothing about the one being restored.
     */
    const refused = await seed([
      reviewRow({
        reviewId: 'rev_second',
        reviewerId: REVIEWER_ID,
        caseRevision: 1,
        assignmentId: 'asg_a_different_seat',
      }),
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused, 'the same juror voted twice on one revision').not.toBeNull();
    expect(isUniqueViolation(refused, 'reviews_case_id_reviewer_id_case_revision_key')).toBe(true);
  });

  /**
   * The control that keeps the constraint from being too strict: §9.9's appeal
   * opens a new revision, and the same juror may sit on it.
   */
  it('admits the same juror on a NEW revision', async () => {
    await seed([
      reviewRow({ reviewId: 'rev_rev1', reviewerId: REVIEWER_ID, caseRevision: 1 }),
      reviewRow({ reviewId: 'rev_rev2', reviewerId: REVIEWER_ID, caseRevision: 2 }),
    ]);

    const onAppeal = await reviewsRepository.findReviewsForCaseRevision(database.db, CASE_ID, 2);

    expect(onAppeal.map((r) => r.reviewId)).toEqual(['rev_rev2']);
  });

  it('still refuses two reviews from ONE assignment, by name', async () => {
    await seed([reviewRow({ reviewId: 'rev_seat_a', assignmentId: 'asg_shared' })]);

    const refused = await seed([
      reviewRow({ reviewId: 'rev_seat_b', assignmentId: 'asg_shared' }),
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused, 'one assignment produced two reviews').not.toBeNull();
    expect(isUniqueViolation(refused, 'reviews_assignment_id_key')).toBe(true);
  });
});

/**
 * The two closed value sets migration 0006 restores.
 *
 * Asserted against a real server because there is no other way: a mocked insert
 * accepts any statement, and a synthetic `{ code: '23514' }` fixture satisfies any
 * predicate written to read it. Each is NAMED — this table now carries two CHECKs
 * and two uniques, so an unnamed assertion would keep passing after the specific
 * one was dropped — and each has a control in the same currency.
 */
describe('the restored closed value sets are enforced by the database', () => {
  it('refuses an outcome outside REVIEW_OUTCOMES', async () => {
    await seed([reviewRow({ reviewId: 'rev_outcome_ok', outcome: 'content_unavailable' })]);
    const control = await reviewsRepository.findReviewsForCaseRevision(database.db, CASE_ID, 1);
    expect(control[0].outcome, 'the control member was itself rejected').toBe('content_unavailable');

    const refused = await seed([reviewRow({ reviewId: 'rev_outcome_bad', outcome: 'guilty' })]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused, 'the outcome CHECK did not fire').not.toBeNull();
    expect(isCheckViolation(refused, 'reviews_outcome_check')).toBe(true);
  });

  it('refuses a context sufficiency outside CONTEXT_SUFFICIENCIES', async () => {
    await seed([
      reviewRow({ reviewId: 'rev_ctx_ok', contextSufficiency: 'insufficient' }),
    ]);
    const control = await reviewsRepository.findReviewsForCaseRevision(database.db, CASE_ID, 1);
    expect(control[0].contextSufficiency, 'the control member was itself rejected').toBe(
      'insufficient',
    );

    const refused = await seed([
      reviewRow({ reviewId: 'rev_ctx_bad', contextSufficiency: 'partial' }),
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused, 'the context-sufficiency CHECK did not fire').not.toBeNull();
    expect(isCheckViolation(refused, 'reviews_context_sufficiency_check')).toBe(true);
  });

  /**
   * `recommended_actions` is deliberately UNCONSTRAINED — it had no Mongoose
   * `enum`, so a containment check would be a new restriction rather than a
   * restored one. Asserted so the omission reads as a decision: without this, the
   * next reader who notices the column is a closed vocabulary in TypeScript adds
   * the constraint, and the first application to send a member this build does not
   * know about is dead-lettered at the database instead of at the contract.
   */
  it('ACCEPTS a recommended action the schema does not enumerate', async () => {
    const accepted = await seed([
      reviewRow({ reviewId: 'rev_actions', recommendedActions: ['no_action', 'something_new'] }),
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(accepted, 'recommended_actions has acquired a constraint it should not have').toBeNull();
  });
});

/**
 * A vacuity floor for the whole file.
 *
 * Every assertion above is "these rows come back" or "no rows come back", and the
 * second is also what a suite pointed at an empty or wrong database reports.
 */
describe('the fixtures reach the table under test', () => {
  it('writes rows that are really in reviews, and reads them back through the repository', async () => {
    await database.asMigrator`
      INSERT INTO reviews (
        review_id, organization_id, application_id, assignment_id, case_id,
        case_revision, reviewer_id, outcome, context_sufficiency, findings,
        recommended_actions, submitted_at
      ) VALUES (
        'rev_raw', ${ORGANIZATION_ID}, ${APPLICATION_ID}, 'asg_raw', ${CASE_ID},
        1, ${REVIEWER_ID}, 'violation', 'sufficient', '[]'::jsonb,
        ARRAY[]::text[], now()
      )
    `;

    const rows = await database.asMigrator<{ count: string }[]>`
      SELECT count(*)::text AS count FROM reviews WHERE review_id = 'rev_raw'
    `;
    expect(rows[0].count).toBe('1');

    const throughRepository = await reviewsRepository.findReviewsForCaseRevision(
      database.db,
      CASE_ID,
      1,
    );
    expect(throughRepository.map((r) => r.reviewId)).toEqual(['rev_raw']);
  });
});
