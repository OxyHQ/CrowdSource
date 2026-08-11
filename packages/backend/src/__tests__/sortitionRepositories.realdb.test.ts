import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isCheckViolation, isUniqueViolation } from '@oxyhq/db';

import * as sortitionRepository from '../db/postgres/repositories/sortition';
import { assignments, sortitionDraws } from '../db/postgres/schema/sortition';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './support/postgresTestDatabase';

/**
 * The jury repositories — `assignments` and `sortition_draws` — against a real
 * PostgreSQL server.
 *
 * These functions have no production caller yet, and this suite is why that is
 * acceptable: a repository that only type-checks is a set of statements whose
 * first execution happens in production. Below they have genuinely run, against
 * the real schema, the real CHECK constraints and the real unprivileged role.
 *
 * ## Not in the reviewer axis registry, and that is correct rather than an
 * oversight
 *
 * `reviewerAxes.test.ts` requires every suite seeding a globally drawable
 * reviewer to own a `(family, language)` cell. This file seeds no reviewer at
 * all — only assignments and draws, which reference `reviewer_id` as a bare
 * string with no row behind it, exactly as the schema does (a reviewer belongs to
 * no tenant and these columns carry no FK). So it matches none of that gate's
 * seeding markers and needs no exemption; an exemption would be a claim about a
 * population this file does not have.
 *
 * ## Fixture policy
 *
 * Every instant is written RELATIVE to a `now` captured per test. A hardcoded
 * absolute date in a committed fixture is a time bomb that detonates later, in
 * whichever sibling file happens to run beside it.
 */

let database: PostgresTestDatabase;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.asMigrator`TRUNCATE assignments, sortition_draws`;
});

const ORGANIZATION_ID = 'org_sortition_repo_fixture';
const APPLICATION_ID = 'app_sortition_repo_fixture';
const CASE_ID = 'case_sortition_repo_fixture';
/** The one reviewer the reviewer-scoped queries ask about. */
const REVIEWER_ID = 'rvw_sortition_repo_fixture';

const HOUR_MS = 60 * 60 * 1000;

/**
 * A seated assignment, open and live, unless a test says otherwise.
 *
 * `reviewerId` DERIVES from `assignmentId` rather than defaulting to a constant,
 * and that is not tidiness: `assignments_case_id_reviewer_id_case_revision_key`
 * permits one seat per person per case revision, so a shared default would make
 * most multi-row fixtures below unrepresentable. Deriving it means the default
 * fixture shape is the shape production has — distinct people on one panel — and
 * a test wanting several seats for ONE reviewer has to say so, and then vary the
 * case, which is what production does too.
 */
function assignmentRow(
  overrides: Partial<typeof assignments.$inferInsert> & { readonly assignmentId: string },
): typeof assignments.$inferInsert {
  const now = new Date();
  return {
    organizationId: ORGANIZATION_ID,
    applicationId: APPLICATION_ID,
    caseId: CASE_ID,
    caseRevision: 1,
    drawId: 'drw_fixture',
    incidentId: null,
    reviewerId: `rvw_${overrides.assignmentId}`,
    slotType: 'reliable_general',
    filledAs: 'reliable_general',
    status: 'offered',
    tokenHash: 'a'.repeat(64),
    sensitivityClass: 'standard',
    offeredAt: now,
    acceptedAt: null,
    expiresAt: new Date(now.getTime() + HOUR_MS),
    completedAt: null,
    recusalReason: null,
    replacementAssignmentId: null,
    ...overrides,
  };
}

/** A draw that seated a panel, unless a test says otherwise. */
function drawRow(
  overrides: Partial<typeof sortitionDraws.$inferInsert> & { readonly drawId: string },
): typeof sortitionDraws.$inferInsert {
  return {
    organizationId: ORGANIZATION_ID,
    applicationId: APPLICATION_ID,
    caseId: CASE_ID,
    caseRevision: 1,
    pool: 'community',
    round: 1,
    kind: 'initial',
    panelSpecId: 'community.r1',
    rulesVersion: '2026.1',
    seed: 'ab'.repeat(16),
    requestedSlots: ['reliable_general'],
    candidateSnapshot: [],
    rejections: [],
    selected: [],
    sampledCount: 0,
    eligibleCount: 0,
    status: 'drawn',
    refusalReason: null,
    drawnAt: new Date(),
    ...overrides,
  };
}

/** Inserts fixtures directly, so a repository write is never its own fixture. */
async function seedAssignments(
  rows: readonly (typeof assignments.$inferInsert)[],
): Promise<void> {
  await database.db.insert(assignments).values([...rows]);
}

describe('reading the panel', () => {
  /**
   * The revision term is the load-bearing half, not the case id.
   *
   * `sortition.worker.ts:60` uses this as the idempotency check that stops a
   * replayed `caseReadyForReview` drawing a second panel — and it is keyed on the
   * CURRENT revision precisely so an appeal's new revision is correctly seen as
   * having no panel yet. A query that dropped the revision term would answer
   * "there is already a panel" for every appeal, forever, and §9.8's new jury
   * would never be drawn: no error, no log line, the outbox row marked dispatched.
   */
  it('returns only the seats on the revision asked for', async () => {
    await seedAssignments([
      assignmentRow({ assignmentId: 'asg_r1_a', caseRevision: 1, reviewerId: 'rvw_1' }),
      assignmentRow({ assignmentId: 'asg_r1_b', caseRevision: 1, reviewerId: 'rvw_2' }),
      assignmentRow({ assignmentId: 'asg_r2_a', caseRevision: 2, reviewerId: 'rvw_3' }),
    ]);

    const firstRevision = await sortitionRepository.findAssignmentsForCaseRevision(
      database.db,
      CASE_ID,
      1,
    );
    expect(firstRevision.map((row) => row.assignmentId).sort()).toEqual(['asg_r1_a', 'asg_r1_b']);

    /**
     * The appeal case, stated as its own assertion rather than left implied by
     * the one above: revision 2 must see its own seat and NOT revision 1's.
     */
    const secondRevision = await sortitionRepository.findAssignmentsForCaseRevision(
      database.db,
      CASE_ID,
      2,
    );
    expect(secondRevision.map((row) => row.assignmentId)).toEqual(['asg_r2_a']);
  });

  it('returns every seat on a case across all its revisions', async () => {
    await seedAssignments([
      assignmentRow({ assignmentId: 'asg_all_1', caseRevision: 1 }),
      assignmentRow({ assignmentId: 'asg_all_2', caseRevision: 2 }),
      assignmentRow({ assignmentId: 'asg_other', caseId: 'case_elsewhere' }),
    ]);

    const rows = await sortitionRepository.findAssignmentsForCase(database.db, CASE_ID);

    expect(rows.map((row) => row.assignmentId).sort()).toEqual(['asg_all_1', 'asg_all_2']);
  });

  /**
   * The null-incident row is the assertion that matters here.
   *
   * `incident_id` is nullable and null on most rows. Had the repository taken
   * `string | null` and been handed a null, the predicate would render as
   * `incident_id = NULL`, which is never TRUE — so it would return no prior jurors
   * at all, i.e. §8.5's exclusion rule quietly ceasing to exclude anybody, with
   * the draw still succeeding and the panel still looking full.
   */
  it('returns prior jurors on an incident, and never the rows with no incident', async () => {
    await seedAssignments([
      assignmentRow({ assignmentId: 'asg_inc_1', incidentId: 'inc_shared' }),
      assignmentRow({ assignmentId: 'asg_inc_2', incidentId: 'inc_shared' }),
      assignmentRow({ assignmentId: 'asg_inc_other', incidentId: 'inc_elsewhere' }),
      assignmentRow({ assignmentId: 'asg_inc_null', incidentId: null }),
    ]);

    const rows = await sortitionRepository.findAssignmentsForIncident(database.db, 'inc_shared');

    expect(rows.map((row) => row.assignmentId).sort()).toEqual(['asg_inc_1', 'asg_inc_2']);
  });

  it('finds one assignment by id, and answers null for one that does not exist', async () => {
    await seedAssignments([assignmentRow({ assignmentId: 'asg_by_id' })]);

    const found = await sortitionRepository.findAssignmentById(database.db, 'asg_by_id');
    expect(found?.assignmentId).toBe('asg_by_id');

    const missing = await sortitionRepository.findAssignmentById(database.db, 'asg_nonexistent');
    expect(missing).toBeNull();
  });

  it('finds one draw by id, and answers null for one that does not exist', async () => {
    await database.db.insert(sortitionDraws).values(drawRow({ drawId: 'drw_by_id' }));

    const found = await sortitionRepository.findSortitionDrawById(database.db, 'drw_by_id');
    expect(found?.drawId).toBe('drw_by_id');

    const missing = await sortitionRepository.findSortitionDrawById(database.db, 'drw_nonexistent');
    expect(missing).toBeNull();
  });
});

describe("the reviewer's next case", () => {
  /**
   * Oldest first, so nothing a reviewer was given can be starved by a newer draw.
   *
   * Both seats here are open and live; only the ORDER decides which comes back,
   * so a query that lost its `ORDER BY` would return either one and fail about
   * half the time — which is why the fixture writes explicit, well-separated
   * `offered_at` values rather than relying on insertion order.
   */
  it('returns the assignment offered longest ago', async () => {
    const now = new Date();
    await seedAssignments([
      assignmentRow({
        assignmentId: 'asg_newer',
        reviewerId: REVIEWER_ID,
        caseId: 'case_newer',
        offeredAt: new Date(now.getTime() - HOUR_MS),
        expiresAt: new Date(now.getTime() + HOUR_MS),
      }),
      assignmentRow({
        assignmentId: 'asg_older',
        reviewerId: REVIEWER_ID,
        caseId: 'case_older',
        offeredAt: new Date(now.getTime() - 5 * HOUR_MS),
        expiresAt: new Date(now.getTime() + HOUR_MS),
      }),
    ]);

    const next = await sortitionRepository.findNextOpenAssignment(database.db, REVIEWER_ID, now);

    expect(next?.assignmentId).toBe('asg_older');
  });

  it('ignores expired seats, closed seats and other reviewers, and answers null', async () => {
    const now = new Date();
    await seedAssignments([
      /** Open, but its deadline has passed. */
      assignmentRow({
        assignmentId: 'asg_expired',
        reviewerId: REVIEWER_ID,
        caseId: 'case_expired',
        expiresAt: new Date(now.getTime() - HOUR_MS),
      }),
      /** Live, but no longer open. */
      assignmentRow({
        assignmentId: 'asg_submitted',
        reviewerId: REVIEWER_ID,
        caseId: 'case_submitted',
        status: 'submitted',
      }),
      /** Open and live, but somebody else's. */
      assignmentRow({ assignmentId: 'asg_theirs', reviewerId: 'rvw_someone_else' }),
    ]);

    const next = await sortitionRepository.findNextOpenAssignment(database.db, REVIEWER_ID, now);

    expect(next).toBeNull();
  });
});

describe('the expiry sweep', () => {
  /**
   * `<=` here and `>` in `findNextOpenAssignment` are complements ON PURPOSE.
   *
   * Together they partition the open assignments at any instant. A seat expiring
   * exactly now is swept by this query and refused by that one; had both been
   * strict, such a seat would be invisible to both — never offered and never
   * expired, so its panel stays a member short with nothing to explain it.
   */
  it('sweeps the seat expiring exactly now, which the next-case query refuses', async () => {
    const now = new Date();
    await seedAssignments([
      assignmentRow({ assignmentId: 'asg_boundary', reviewerId: REVIEWER_ID, expiresAt: now }),
    ]);

    const due = await sortitionRepository.findDueAssignments(database.db, now, 10);
    expect(due.map((row) => row.assignmentId)).toEqual(['asg_boundary']);

    const next = await sortitionRepository.findNextOpenAssignment(database.db, REVIEWER_ID, now);
    expect(next).toBeNull();
  });

  it('returns overdue seats oldest first, honours the limit, and skips the not-yet-due', async () => {
    const now = new Date();
    await seedAssignments([
      assignmentRow({
        assignmentId: 'asg_due_second',
        expiresAt: new Date(now.getTime() - HOUR_MS),
      }),
      assignmentRow({
        assignmentId: 'asg_due_first',
        expiresAt: new Date(now.getTime() - 5 * HOUR_MS),
      }),
      assignmentRow({
        assignmentId: 'asg_not_due',
        expiresAt: new Date(now.getTime() + HOUR_MS),
      }),
      assignmentRow({
        assignmentId: 'asg_due_but_closed',
        status: 'expired',
        expiresAt: new Date(now.getTime() - 9 * HOUR_MS),
      }),
    ]);

    const all = await sortitionRepository.findDueAssignments(database.db, now, 10);
    expect(all.map((row) => row.assignmentId)).toEqual(['asg_due_first', 'asg_due_second']);

    /** The limit, and that it takes the OLDEST rather than an arbitrary one. */
    const limited = await sortitionRepository.findDueAssignments(database.db, now, 1);
    expect(limited.map((row) => row.assignmentId)).toEqual(['asg_due_first']);
  });
});

describe("§13.7's exposure rows", () => {
  /**
   * The `OR` has two arms and each one has to be shown to matter.
   *
   * A query that lost the `completed_at` arm would report every reviewer as having
   * completed nothing today, which is the direction that OVERLOADS a person — the
   * daily limit would never bite. A query that lost the open arm would under-count
   * what somebody is holding. So both a submitted-today row and an open row are
   * seeded, and a completed-yesterday row is seeded to prove the window is real
   * rather than the arm matching everything.
   */
  it("returns open seats and today's completions, and nothing older", async () => {
    const now = new Date();
    const dayStart = new Date(now.getTime() - 6 * HOUR_MS);

    await seedAssignments([
      assignmentRow({
        assignmentId: 'asg_exp_open',
        reviewerId: REVIEWER_ID,
        caseId: 'case_exp_open',
        status: 'accepted',
        completedAt: null,
      }),
      assignmentRow({
        assignmentId: 'asg_exp_today',
        reviewerId: REVIEWER_ID,
        caseId: 'case_exp_today',
        status: 'submitted',
        completedAt: new Date(now.getTime() - HOUR_MS),
      }),
      assignmentRow({
        assignmentId: 'asg_exp_yesterday',
        reviewerId: REVIEWER_ID,
        caseId: 'case_exp_yesterday',
        status: 'submitted',
        completedAt: new Date(dayStart.getTime() - HOUR_MS),
      }),
      assignmentRow({
        assignmentId: 'asg_exp_other_reviewer',
        reviewerId: 'rvw_someone_else',
        status: 'accepted',
      }),
    ]);

    const rows = await sortitionRepository.findExposureAssignments(
      database.db,
      [REVIEWER_ID],
      dayStart,
    );

    expect(rows.map((row) => row.assignmentId).sort()).toEqual(['asg_exp_open', 'asg_exp_today']);
  });

  /**
   * `inArray(column, [])` renders as the literal `false`, which is what Mongo's
   * `$in: []` matches too. Asserted rather than assumed, because the two stores
   * disagreeing on a degenerate input is the shape of bug this port keeps finding
   * — and here they agree, so no length guard is needed at the call site.
   */
  it('returns nothing for an empty reviewer list, matching Mongo', async () => {
    await seedAssignments([assignmentRow({ assignmentId: 'asg_exp_present' })]);

    const rows = await sortitionRepository.findExposureAssignments(database.db, [], new Date(0));

    expect(rows).toEqual([]);
  });
});

describe('opening an assignment', () => {
  it('rotates the token, marks it accepted, and returns the row after the write', async () => {
    const now = new Date();
    await seedAssignments([assignmentRow({ assignmentId: 'asg_open' })]);

    const opened = await sortitionRepository.openAssignment(database.db, 'asg_open', {
      tokenHash: 'b'.repeat(64),
      acceptedAt: now,
    });

    expect(opened?.status).toBe('accepted');
    expect(opened?.tokenHash).toBe('b'.repeat(64));
    expect(opened?.acceptedAt?.getTime()).toBe(now.getTime());
  });

  /**
   * The conditional WHERE is the whole mechanism, so it gets its own assertion.
   *
   * Somebody expiring or completing the seat between the caller's read and this
   * write must produce NO row — which the caller turns into a 409 — rather than
   * dragging a finished assignment back to `accepted`. A read-then-write would
   * race with itself and lose silently.
   */
  it('updates nothing when the seat is no longer open, and leaves it alone', async () => {
    await seedAssignments([
      assignmentRow({ assignmentId: 'asg_closed', status: 'expired', tokenHash: 'c'.repeat(64) }),
    ]);

    const opened = await sortitionRepository.openAssignment(database.db, 'asg_closed', {
      tokenHash: 'd'.repeat(64),
      acceptedAt: new Date(),
    });

    expect(opened).toBeNull();

    const after = await sortitionRepository.findAssignmentById(database.db, 'asg_closed');
    expect(after?.status).toBe('expired');
    expect(after?.tokenHash, 'the refused update still rotated the token').toBe('c'.repeat(64));
  });
});

describe('consuming an assignment for a review', () => {
  /**
   * ONE VOTE PER JUROR, as a property of the database rather than of the caller.
   *
   * The second call is the test: a double-click, a retried request or a reviewer
   * trying twice finds the status no longer `accepted` and updates nothing.
   */
  it('consumes an accepted seat once, and never a second time', async () => {
    const now = new Date();
    await seedAssignments([assignmentRow({ assignmentId: 'asg_consume', status: 'accepted' })]);

    const first = await database.db.transaction(async (tx) =>
      sortitionRepository.consumeAssignmentForReview(tx, 'asg_consume', now),
    );
    expect(first?.status).toBe('submitted');
    expect(first?.completedAt?.getTime()).toBe(now.getTime());

    const second = await database.db.transaction(async (tx) =>
      sortitionRepository.consumeAssignmentForReview(tx, 'asg_consume', now),
    );
    expect(second, 'a second submission consumed the seat again').toBeNull();
  });

  /**
   * `accepted` EXACTLY, not the open set.
   *
   * An `offered` seat has never been opened, so its token was never rotated to the
   * one the reviewer is holding. Widening this to the open set would let a
   * submission skip the acceptance step entirely — which no type and no other test
   * in this file would notice.
   */
  it('refuses an offered seat, which was never opened', async () => {
    await seedAssignments([assignmentRow({ assignmentId: 'asg_offered', status: 'offered' })]);

    const consumed = await database.db.transaction(async (tx) =>
      sortitionRepository.consumeAssignmentForReview(tx, 'asg_offered', new Date()),
    );

    expect(consumed).toBeNull();
  });

  it('refuses a seat whose deadline has already passed', async () => {
    const now = new Date();
    await seedAssignments([
      assignmentRow({
        assignmentId: 'asg_consume_late',
        status: 'accepted',
        expiresAt: new Date(now.getTime() - HOUR_MS),
      }),
    ]);

    const consumed = await database.db.transaction(async (tx) =>
      sortitionRepository.consumeAssignmentForReview(tx, 'asg_consume_late', now),
    );

    expect(consumed).toBeNull();
  });
});

describe('recusal and expiry', () => {
  /**
   * The `completed_at: null` write is the assertion worth having.
   *
   * A recusal is NOT a completion: §13.7 counts completions toward a reviewer's
   * daily exposure, so a recusal leaving a stale `completed_at` behind would
   * charge somebody for work they declined. Drizzle omits an `undefined`, so this
   * only works because the null is written explicitly.
   *
   * The fixture — an OPEN seat that already carries a `completed_at` — is not a
   * state production reaches, and it is used deliberately: it is the only shape in
   * which "the null was written" and "the column happened to be null already" give
   * different answers.
   */
  it('records the recusal and clears any completion timestamp', async () => {
    await seedAssignments([
      assignmentRow({
        assignmentId: 'asg_recuse',
        status: 'accepted',
        completedAt: new Date(),
      }),
    ]);

    const recused = await database.db.transaction(async (tx) =>
      sortitionRepository.recuseAssignment(tx, 'asg_recuse', 'conflict_of_interest'),
    );

    expect(recused?.status).toBe('recused');
    expect(recused?.recusalReason).toBe('conflict_of_interest');
    expect(recused?.completedAt, 'the recusal left a completion timestamp behind').toBeNull();
  });

  it('refuses to recuse a seat that is no longer open', async () => {
    await seedAssignments([assignmentRow({ assignmentId: 'asg_recuse_closed', status: 'submitted' })]);

    const recused = await database.db.transaction(async (tx) =>
      sortitionRepository.recuseAssignment(tx, 'asg_recuse_closed', 'conflict_of_interest'),
    );

    expect(recused).toBeNull();
  });

  /**
   * Two sweeps racing must produce ONE replacement, not two.
   *
   * The second call standing in for a concurrent sweep is what shows the condition
   * carries that: whichever process updates the row gets it back and is therefore
   * the one that emits the vacancy event.
   */
  it('expires an open seat once, so a concurrent sweep emits nothing', async () => {
    await seedAssignments([assignmentRow({ assignmentId: 'asg_expire' })]);

    const first = await database.db.transaction(async (tx) =>
      sortitionRepository.expireAssignment(tx, 'asg_expire'),
    );
    expect(first?.status).toBe('expired');

    const second = await database.db.transaction(async (tx) =>
      sortitionRepository.expireAssignment(tx, 'asg_expire'),
    );
    expect(second, 'a second sweep expired the same seat again').toBeNull();
  });
});

describe('seating a panel and recording its draw', () => {
  it('inserts a seat and points a vacated one at its replacement', async () => {
    await database.db.transaction(async (tx) => {
      await sortitionRepository.insertAssignment(
        tx,
        assignmentRow({ assignmentId: 'asg_seated' }),
      );
    });

    await seedAssignments([assignmentRow({ assignmentId: 'asg_vacated', status: 'recused' })]);
    await sortitionRepository.setReplacementAssignment(
      database.db,
      'asg_vacated',
      'asg_seated',
    );

    const seated = await sortitionRepository.findAssignmentById(database.db, 'asg_seated');
    expect(seated?.assignmentId).toBe('asg_seated');

    const vacated = await sortitionRepository.findAssignmentById(database.db, 'asg_vacated');
    expect(vacated?.replacementAssignmentId).toBe('asg_seated');
  });

  it('writes the record of a draw that seated a panel', async () => {
    await database.db.transaction(async (tx) => {
      await sortitionRepository.insertDrawnRecord(
        tx,
        drawRow({
          drawId: 'drw_seated',
          requestedSlots: ['reliable_general', 'calibrated_newcomer'],
          selected: [{ reviewerId: 'rvw_1', slotType: 'reliable_general' }],
          sampledCount: 12,
          eligibleCount: 7,
        }),
      );
    });

    const stored = await sortitionRepository.findSortitionDrawById(database.db, 'drw_seated');
    expect(stored?.status).toBe('drawn');
    expect(stored?.requestedSlots).toEqual(['reliable_general', 'calibrated_newcomer']);
    expect(stored?.sampledCount).toBe(12);
  });

  /**
   * The refusal path takes a POOL handle, and that is a decision.
   *
   * `recordRefusal` runs outside a transaction on purpose: there is no domain
   * write to be atomic with, and a refusal that failed to record because some
   * surrounding transaction aborted would leave exactly the silence the row exists
   * to break. Calling it here with `database.db` — the pool — is what shows the
   * signature genuinely permits that, rather than permitting it only in principle.
   */
  it('records a refusal on the pool handle, outside any transaction', async () => {
    await sortitionRepository.recordRefusedDraw(
      database.db,
      drawRow({
        drawId: 'drw_refused',
        status: 'refused',
        refusalReason: 'candidate_pool_too_small',
        selected: [],
      }),
    );

    const stored = await sortitionRepository.findSortitionDrawById(database.db, 'drw_refused');
    expect(stored?.status).toBe('refused');
    expect(stored?.refusalReason).toBe('candidate_pool_too_small');
  });
});

/**
 * The closed value sets migration 0005 restores, asserted against a real server.
 *
 * There is no other way to assert them: a mocked insert accepts any statement,
 * and a synthetic `{ code: '23514' }` fixture satisfies any predicate written to
 * read it. Every error below is caught from the server that raised it.
 *
 * Each is NAMED. `isCheckViolation(error)` alone cannot tell "this constraint
 * fired" from "some other constraint on the same table fired" — and these two
 * tables now carry seven and eight constraints respectively, so an unnamed
 * assertion would keep passing after the specific one was dropped.
 *
 * Each has a CONTROL in the same currency: a legitimate member written through
 * the same repository function, on the same column. Without it, a refusal proves
 * only that SOMETHING rejected the row.
 */
describe('the restored closed value sets are enforced by the database', () => {
  async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => null,
      (error: unknown) => error,
    );
  }

  it('refuses an assignment status outside ASSIGNMENT_STATUSES', async () => {
    await seedAssignments([assignmentRow({ assignmentId: 'asg_status_ok', status: 'replaced' })]);
    const control = await sortitionRepository.findAssignmentById(database.db, 'asg_status_ok');
    expect(control?.status, 'the control member was itself rejected').toBe('replaced');

    const refused = await refusalOf(
      seedAssignments([assignmentRow({ assignmentId: 'asg_status_bad', status: 'ascended' })]),
    );

    expect(refused, 'the status CHECK did not fire; the value was accepted').not.toBeNull();
    expect(isCheckViolation(refused, 'assignments_status_check')).toBe(true);
  });

  /**
   * `slot_type` and `filled_as` render from the SAME tuple and are still two
   * constraints, so both are asserted: §8.3's fallback means the class that filled
   * a seat need not be the class the seat asked for, and a single constraint could
   * not say that both are separately closed.
   */
  it('refuses a slot type outside SLOT_TYPES, on both slot columns', async () => {
    await seedAssignments([
      assignmentRow({
        assignmentId: 'asg_slots_ok',
        slotType: 'category_specialist',
        filledAs: 'intermediate',
      }),
    ]);
    const control = await sortitionRepository.findAssignmentById(database.db, 'asg_slots_ok');
    expect(control?.filledAs, 'the control member was itself rejected').toBe('intermediate');

    const badSlot = await refusalOf(
      seedAssignments([assignmentRow({ assignmentId: 'asg_slot_bad', slotType: 'archbishop' })]),
    );
    expect(isCheckViolation(badSlot, 'assignments_slot_type_check')).toBe(true);

    const badFilled = await refusalOf(
      seedAssignments([assignmentRow({ assignmentId: 'asg_filled_bad', filledAs: 'archbishop' })]),
    );
    expect(isCheckViolation(badFilled, 'assignments_filled_as_check')).toBe(true);
  });

  it('refuses a draw status, kind or pool outside its tuple', async () => {
    await database.db.insert(sortitionDraws).values(
      drawRow({ drawId: 'drw_sets_ok', status: 'refused', kind: 'expansion', pool: 'legal' }),
    );
    const control = await sortitionRepository.findSortitionDrawById(database.db, 'drw_sets_ok');
    expect(control?.pool, 'the control member was itself rejected').toBe('legal');

    const badStatus = await refusalOf(
      database.db.insert(sortitionDraws).values(drawRow({ drawId: 'drw_s', status: 'pending' })),
    );
    expect(isCheckViolation(badStatus, 'sortition_draws_status_check')).toBe(true);

    const badKind = await refusalOf(
      database.db.insert(sortitionDraws).values(drawRow({ drawId: 'drw_k', kind: 'rerun' })),
    );
    expect(isCheckViolation(badKind, 'sortition_draws_kind_check')).toBe(true);

    const badPool = await refusalOf(
      database.db.insert(sortitionDraws).values(drawRow({ drawId: 'drw_p', pool: 'tribunal' })),
    );
    expect(isCheckViolation(badPool, 'sortition_draws_pool_check')).toBe(true);
  });

  /**
   * `requested_slots` is `text[]`, so its constraint is CONTAINMENT.
   *
   * Mongo put the `enum` on the CASTER — it constrains each ELEMENT — and `<@` is
   * the operator that says the same thing. The third assertion is the one that
   * earns its place: `<@` is vacuously TRUE for `{}`, so this constraint alone
   * says nothing whatever about empty. That is why the cardinality constraint
   * below is a SECOND constraint rather than a stricter spelling of this one.
   */
  it('refuses a requested slot outside SLOT_TYPES, and admits the empty array', async () => {
    await database.db.insert(sortitionDraws).values(
      drawRow({
        drawId: 'drw_slots_ok',
        requestedSlots: ['appeals_reviewer', 'intermediate'],
      }),
    );
    const control = await sortitionRepository.findSortitionDrawById(database.db, 'drw_slots_ok');
    expect(control?.requestedSlots, 'the control members were themselves rejected').toEqual([
      'appeals_reviewer',
      'intermediate',
    ]);

    const refused = await refusalOf(
      database.db.insert(sortitionDraws).values(
        drawRow({
          drawId: 'drw_slots_bad',
          requestedSlots: ['reliable_general', 'archbishop'],
        }),
      ),
    );
    expect(refused, 'the containment CHECK did not fire').not.toBeNull();
    expect(isCheckViolation(refused, 'sortition_draws_requested_slots_check')).toBe(true);

    /**
     * The empty array passes CONTAINMENT. Asserted so that nobody reads the
     * constraint above as covering emptiness — it does not, and an
     * `array_length(col, 1) >= 1` spelling of the one below would not either.
     */
    const empty = await refusalOf(
      database.db.insert(sortitionDraws).values(
        drawRow({ drawId: 'drw_slots_empty', status: 'refused', requestedSlots: [] }),
      ),
    );
    expect(empty, 'containment rejected the empty array, which it cannot do').toBeNull();
  });
});

/**
 * ONE SEAT PER PERSON PER CASE REVISION.
 *
 * This constraint is the one migration 0005 RESTORES rather than adds: Mongo
 * carried it as `{ caseId, reviewerId, caseRevision }, { unique: true }` and the
 * PostgreSQL schema had no counterpart, so it was a structural guarantee the port
 * had silently downgraded to a comment. No gate would have caught it —
 * `closedValueSets.realdb.test.ts` censuses `enum` validators, and a `unique` is a
 * different shape entirely.
 *
 * `openPanel` names it as the reason a replayed draw is safe, so the replay is
 * what is fixtured: the same person, the same case, the same revision, twice.
 */
describe('a person cannot be seated twice on one case revision', () => {
  it('refuses the second seat by name, and admits the same person on a new revision', async () => {
    await seedAssignments([
      assignmentRow({ assignmentId: 'asg_seat_first', reviewerId: REVIEWER_ID, caseRevision: 1 }),
    ]);

    /**
     * A replayed draw: a different assignment id, the same person on the same
     * revision. Without the constraint this succeeds and the panel holds one
     * person twice, with no error and no log line.
     */
    const replayed = await seedAssignments([
      assignmentRow({ assignmentId: 'asg_seat_replay', reviewerId: REVIEWER_ID, caseRevision: 1 }),
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(replayed, 'the same person was seated twice on one revision').not.toBeNull();
    expect(isUniqueViolation(replayed, 'assignments_case_id_reviewer_id_case_revision_key')).toBe(
      true,
    );

    /**
     * The control, and it is the half that stops this constraint being too
     * strict: §9.9's appeal opens a NEW revision, and the same person may be
     * drawn onto it. A unique on `(case_id, reviewer_id)` alone would forbid
     * that.
     */
    await seedAssignments([
      assignmentRow({ assignmentId: 'asg_seat_appeal', reviewerId: REVIEWER_ID, caseRevision: 2 }),
    ]);
    const onAppeal = await sortitionRepository.findAssignmentsForCaseRevision(
      database.db,
      CASE_ID,
      2,
    );
    expect(onAppeal.map((row) => row.assignmentId)).toEqual(['asg_seat_appeal']);
  });

  /**
   * A recused seat still occupies the person's place, so the uniqueness is TOTAL
   * rather than partial.
   *
   * Asserted because a partial unique — `WHERE status IN (open)` — is the obvious
   * "improvement" somebody reaches for when a replacement flow first hits this
   * constraint, and it would readmit exactly the replay above.
   */
  it('still refuses a second seat when the first was recused', async () => {
    await seedAssignments([
      assignmentRow({
        assignmentId: 'asg_seat_recused',
        reviewerId: REVIEWER_ID,
        status: 'recused',
      }),
    ]);

    const again = await seedAssignments([
      assignmentRow({ assignmentId: 'asg_seat_after_recusal', reviewerId: REVIEWER_ID }),
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(again, 'a recused seat stopped reserving the person’s place').not.toBeNull();
    expect(isUniqueViolation(again, 'assignments_case_id_reviewer_id_case_revision_key')).toBe(true);
  });
});

/**
 * The cardinality implication, from both sides.
 *
 * This is the ONE constraint in migration 0005 that is a new restriction rather
 * than a restored one, and it is an IMPLICATION rather than a floor because a
 * floor would refuse a legitimate production write.
 *
 * BOTH tests below are required, and the accepting one is the more important of
 * the two. Without it, the next person to notice the asymmetry and "tidy" it into
 * a flat `cardinality(requested_slots) >= 1` has nothing failing to stop them —
 * and what they would break is §7.5 row 1: the legal-pool refusal, which records
 * `slots: []` deliberately so that "no panel was ever opened for this case" stays
 * distinguishable from "this case is under legal protocol".
 */
describe('a drawn panel asked for a seat; a refusal need not have', () => {
  it('ACCEPTS the legal-pool refusal, which records no slots at all', async () => {
    await sortitionRepository.recordRefusedDraw(
      database.db,
      drawRow({
        drawId: 'drw_legal',
        pool: 'legal',
        panelSpecId: 'none.legal',
        status: 'refused',
        refusalReason: 'legal_pool',
        requestedSlots: [],
        selected: [],
      }),
    );

    const stored = await sortitionRepository.findSortitionDrawById(database.db, 'drw_legal');
    expect(stored?.requestedSlots).toEqual([]);
    expect(stored?.refusalReason).toBe('legal_pool');
  });

  it('REFUSES a drawn record that asked for no seats, by name', async () => {
    const refused = await database.db
      .insert(sortitionDraws)
      .values(drawRow({ drawId: 'drw_empty_drawn', status: 'drawn', requestedSlots: [] }))
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refused, 'a drawn draw with no requested seat was accepted').not.toBeNull();
    expect(
      isCheckViolation(refused, 'sortition_draws_requested_slots_cardinality_check'),
      'something rejected the row, but not the cardinality constraint',
    ).toBe(true);
  });
});

/**
 * A vacuity floor for the whole file.
 *
 * Every assertion above is of the form "these rows come back" or "no rows come
 * back", and the second form is also what a suite connected to an empty or wrong
 * database reports. This states that the tables under test are the ones being
 * written to.
 */
describe('the fixtures reach the tables under test', () => {
  it('writes rows that are really in assignments and sortition_draws', async () => {
    await seedAssignments([assignmentRow({ assignmentId: 'asg_floor' })]);
    await database.db.insert(sortitionDraws).values(drawRow({ drawId: 'drw_floor' }));

    const seats = await database.asMigrator<{ count: string }[]>`
      SELECT count(*)::text AS count FROM assignments WHERE assignment_id = 'asg_floor'
    `;
    const draws = await database.asMigrator<{ count: string }[]>`
      SELECT count(*)::text AS count FROM sortition_draws WHERE draw_id = 'drw_floor'
    `;

    expect(seats[0].count).toBe('1');
    expect(draws[0].count).toBe('1');
  });

  /**
   * And that the repository reads the same table the fixture wrote — a repository
   * pointed at a different table would return nothing, which every "no rows come
   * back" assertion above would also report.
   */
  it('reads back through the repository what the raw fixture wrote', async () => {
    await database.asMigrator`
      INSERT INTO assignments (
        assignment_id, organization_id, application_id, case_id, case_revision,
        draw_id, reviewer_id, slot_type, filled_as, status, token_hash,
        sensitivity_class, offered_at, expires_at
      ) VALUES (
        'asg_raw', ${ORGANIZATION_ID}, ${APPLICATION_ID}, ${CASE_ID}, 1,
        'drw_raw', 'rvw_fixture', 'reliable_general', 'reliable_general', 'offered',
        ${'e'.repeat(64)}, 'standard', now(), now() + interval '1 hour'
      )
    `;

    const found = await sortitionRepository.findAssignmentById(database.db, 'asg_raw');

    expect(found?.tokenHash).toBe('e'.repeat(64));
  });
});
