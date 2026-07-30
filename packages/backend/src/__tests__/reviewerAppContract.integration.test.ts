import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { reviewerAxesFor } from './support/reviewerAxes';
import { stubOxySession } from './support/reviewers';

/**
 * Type-only, so it is erased before `vi.mock` hoists and cannot pull the reviewer
 * app in ahead of the session stub. The VALUES all come through the dynamic
 * imports below, like every other module this suite touches.
 */
import type {
  ReviewFormAction,
  ReviewFormState,
} from '../../../reviewer/lib/review-form';

/**
 * The backend↔app payload contract, driven end to end.
 *
 * ## Why this file exists
 *
 * The reviewer app and the reviewer API agreed on almost nothing, and nothing
 * caught it. The state vocabularies differed outright (`community` against
 * `community_reviewer`), so did the sensitivity classes; the assignment package
 * disagreed on `allegation` against `allegations`, on `policyVersion` against
 * `version`, and on five fields that existed on one side only; the app called two
 * endpoints that had never existed and sent a review body a strict schema
 * refused; and it never sent §8.7's assignment token, so every assignment-scoped
 * call would have 404'd. All of it was reachable and none of it was tested,
 * because no test anywhere fed a backend payload to an app projection.
 *
 * This is that test. Its absence was the actual defect.
 *
 * ## Why it is shaped this way
 *
 * The fixture is not written by hand. It is produced by the REAL HTTP routes —
 * a report ingested through `POST /v1/reports`, triaged, drawn by sortition,
 * picked up through `POST /v1/reviewer/assignments/next` — and the response body
 * is handed to the reviewer app's REAL projections, imported across the package
 * boundary from `packages/reviewer/lib/reviewer-api`. Nothing in between is
 * stubbed except the network call that asks Oxy whether a bearer token is a live
 * session.
 *
 * That shape is what makes it unfakeable in both directions:
 *
 *  - If the backend stops producing the fixture — a broken draw, a route that
 *    stops calling `buildReviewPackage`, a field renamed on the wire — the
 *    request fails or the projection throws. It cannot pass vacuously, because
 *    every payload is asserted to carry real content BEFORE it is projected and
 *    the projected result is compared against the server's own values.
 *  - If the app stops matching — a projection loosened, a field dropped — the
 *    comparison fails here rather than in a browser.
 *
 * The submit direction runs through the app's own `buildReviewSubmission`, so the
 * body the server accepts is the body the form actually produces. A test that
 * hand-wrote that body would have passed on the day the app was sending
 * `descriptive` and `appliedExceptionIds` to a `.strict()` schema.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { assignments } = await import('../modules/sortition/assignment.collection');
const { assignmentWatermark } = await import('../modules/sortition/reviewPackage');
const { sortitionDraws } = await import('../modules/sortition/draw.collection');
const { registerOutboxWorkers } = await import('../modules/outbox/workers');
const { CALIBRATION_ITEMS, TRAINING_MODULES } = await import('../modules/reviewer/calibration');
const { createReviewerPool } = await import('./support/reviewers');
const { reviewerProfiles } = await import('../modules/reviewer/reviewer.collection');
const { deliveryBody, drainUntil, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);

/**
 * The reviewer app's own code, across the package boundary.
 *
 * Relative paths on purpose. `@crowdsource/reviewer` is a private Expo package
 * with no `exports` map, and inventing one so a test could import it would be
 * a production-facing change made for a test's convenience. These modules are
 * pure TypeScript — no React, no React Native, no Expo — which is a property
 * worth keeping: `redaction.ts` is the §9.1 enforcement boundary and a boundary
 * that can only run inside a renderer cannot be tested against a real payload.
 */
const {
  projectAssignmentPackage,
  projectCalibrationResult,
  projectHistoryPage,
  projectIssuedAssignment,
  projectReviewerProfile,
  projectTrainingState,
  scanForForbiddenFields,
} = await import('../../../reviewer/lib/reviewer-api/redaction');
const { assignmentBlockers } = await import('../../../reviewer/lib/eligibility');
const { buildReviewSubmission, createInitialReviewFormState, reviewFormReducer } = await import(
  '../../../reviewer/lib/review-form'
);

const { ASSIGNMENT_TOKEN_HEADER } = await import('@oxyhq/crowdsource-contracts');

type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();

/**
 * This suite's isolation axis, which it does not get to choose for itself.
 *
 * Reviewer profiles are global, so anybody created here is a candidate for every
 * case in the database — including other suites' running against the same replica
 * set. §8.2 requires a reviewer to accept the case's family AND hold its
 * language, so a `(family, language)` cell no other file holds is a wall in both
 * directions. This file used to name that cell itself, in a comment asserting it
 * was unique. It was not: `appeals.integration.test.ts` had claimed
 * `(harassment, ast)` too, and the two suites were one shift in execution order
 * away from seating each other's reviewers. `support/reviewerAxes.ts` now owns
 * the assignment for every suite and `reviewerAxes.test.ts` fails if two claim
 * the same cell, which is the only version of this rule that a reader cannot
 * accidentally break.
 */
const axes = reviewerAxesFor(import.meta.url);
const FAMILY = axes('contract').family;
const CODE = 'harassment.targeted_abuse';
const LANGUAGE = axes('contract').language;

/** The reported text, so the assertion can prove the MATERIAL survived. */
const REPORTED_TEXT = 'you are worthless and everyone should tell you so';

let tenant: ProvisionedTenant;
let reviewerOxyUserId: string;
let assignmentId: string;
let assignmentToken: string;

function asReviewer(oxyUserId: string) {
  return { 'x-test-oxy-user': oxyUserId };
}

async function openCase(subject: string): Promise<string> {
  const externalReportId = `${subject}-${Date.now()}`;
  const created = await request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', externalReportId)
    .send(
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: subject,
        allegationCode: CODE,
        language: LANGUAGE,
        text: REPORTED_TEXT,
      }),
    );

  expect(created.status).toBe(202);
  await drainUntil(
    async () => (await sortitionDraws.findOne({ caseId: created.body.caseId })) !== null,
    `a sortition draw for case '${created.body.caseId}'`,
  );
  return created.body.caseId;
}

beforeAll(async () => {
  await startDatabase();
  registerOutboxWorkers();
  tenant = await provisionTenant();

  /**
   * Comfortably more than a round-1 panel of three, so a draw that refused would
   * be a refusal rather than an empty database. The RESULT is deliberately
   * unused: this file needs candidates to exist, not to be the ones drawn.
   */
  await createReviewerPool(FAMILY, 9, [LANGUAGE]);

  const caseId = await openCase(`post_contract_${Date.now()}`);
  const seats = await assignments.find({ caseId });
  expect(seats).toHaveLength(3);

  /**
   * The seated reviewer, read from the profile store rather than matched against
   * this file's own pool.
   *
   * Every test below acts AS a seated juror, so the fixture needs one seat and
   * that juror's Oxy id — NOT that the draw happened to pick reviewers this file
   * created. Requiring the latter made the fixture depend on the outcome of a
   * random selection over a GLOBAL pool (`candidatePool` has no tenant filter,
   * because juries are cross-tenant by design), which is a property this file is
   * not named for and was never trying to test.
   *
   * `support/reviewerAxes.ts` and `reviewerAxes.test.ts` detect a collision on
   * this suite's `(family, language)` cell directly, and they detect it first.
   * With both in place a collision degrades to a slower draw here rather than a
   * red suite three screens from its cause.
   *
   * Reported rather than asserted so the type narrows without a `!` and the
   * failure carries its evidence; a `?? ''` would swallow it into a 404 on every
   * request in the file instead.
   */
  const [seat] = seats;
  const holder = await reviewerProfiles.findOne({ reviewerId: seat.reviewerId });
  if (holder === null) {
    throw new Error(
      `no reviewer profile exists for seated reviewer '${seat.reviewerId}'. ` +
        'A seat naming a reviewer the profile store does not have means the draw ' +
        'and the profiles have diverged, not that this suite is misconfigured.',
    );
  }

  reviewerOxyUserId = holder.oxyUserId;
}, 180_000);

afterAll(async () => {
  await stopDatabase();
});

describe('POST /v1/reviewer/assignments/next → the app’s assignment projection', () => {
  it('produces a package the app parses, with the material intact', async () => {
    const response = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(reviewerOxyUserId));

    expect(response.status).toBe(200);

    /**
     * The vacuity floor, asserted on the RAW body before anything projects it.
     *
     * A backend that answered `{}` would satisfy a lenient projection and every
     * assertion below it. This is the line that makes "the fixture is still being
     * produced" a checked fact rather than an assumption.
     */
    expect(typeof response.body.token).toBe('string');
    expect(response.body.resources.length).toBeGreaterThan(0);
    expect(response.body.policy.rules.length).toBeGreaterThan(0);
    expect(response.body.allegations.codes).toContain(CODE);

    // §9.1's alarm, on the real payload: the backend must not be sending anything
    // from the hidden column.
    expect(scanForForbiddenFields(response.body)).toEqual([]);

    const issued = projectIssuedAssignment(response.body);

    // The token, which the app used to drop — and which every later call needs.
    expect(issued.token).toBe(response.body.token);
    assignmentId = issued.assignmentId;
    assignmentToken = issued.token;

    // The case facts the server derived, compared against the server's own body,
    // so a projection returning constants could not pass.
    expect(issued.language).toBe(LANGUAGE);
    expect(issued.families).toEqual([FAMILY]);
    expect(issued.allegations.unverified).toBe(true);
    expect(issued.caseRevision).toBe(1);
    expect(issued.presentation.sensitivityClass).toBe(response.body.presentation.sensitivityClass);

    // The material itself, through the app's own resource union.
    const text = issued.resources.find((resource) => resource.type === 'text');
    expect(text?.type === 'text' ? text.data.text : null).toBe(REPORTED_TEXT);

    // §13.8's watermark, recomputed independently: the app renders what the server
    // issued and never synthesises one, so it has to actually arrive.
    expect(issued.watermark).toBe(assignmentWatermark(assignmentId));
  });

  it('is refused without §8.7’s token, which is why the app has to send it', async () => {
    const withoutToken = await request(app)
      .get(`/v1/reviewer/assignments/${assignmentId}`)
      .set(asReviewer(reviewerOxyUserId));

    // The failure the app shipped with: a 404 identical to an expiry, three
    // screens away from the cause.
    expect(withoutToken.status).toBe(404);
  });

  it('serves the same package again when the token IS presented', async () => {
    const refreshed = await request(app)
      .get(`/v1/reviewer/assignments/${assignmentId}`)
      .set(asReviewer(reviewerOxyUserId))
      .set(ASSIGNMENT_TOKEN_HEADER, assignmentToken);

    expect(refreshed.status).toBe(200);
    // No token on this response: the one `next` issued is still the live one.
    expect(refreshed.body.token).toBeUndefined();

    const projected = projectAssignmentPackage(refreshed.body);
    expect(projected.assignmentId).toBe(assignmentId);
    expect(projected.resources.length).toBeGreaterThan(0);
  });
});

describe('GET /v1/reviewer/profile → the app’s profile projection', () => {
  it('produces a profile the app parses, and a blocker list it can explain', async () => {
    const response = await request(app)
      .get('/v1/reviewer/profile')
      .set(asReviewer(reviewerOxyUserId));

    expect(response.status).toBe(200);
    // Vacuity floor: the eligibility list and the categories must actually be
    // populated, or every assertion below is about an empty object.
    expect(response.body.eligibility.length).toBeGreaterThan(4);
    expect(response.body.preferences.categories).toContain(FAMILY);

    const profile = projectReviewerProfile(response.body);

    // The state vocabulary that used to differ outright.
    expect(profile.state).toBe('community');
    expect(profile.consent.maxSensitivity).toBe(response.body.consent.maxSensitivity);
    expect(profile.exposure.maxOpenAssignments).toBeGreaterThan(0);

    /**
     * And the app's own eligibility logic, on the real profile.
     *
     * `assignmentBlockers` is what decides whether the "review next case" button
     * is available, and it reads six fields across three branches of the profile.
     * Running it here is what catches a field that parses but means something
     * else — this reviewer is drawable, so the list must be empty.
     */
    expect(assignmentBlockers(profile, new Date())).toEqual([]);
  });
});

describe('GET /v1/reviewer/training → the app’s training projection', () => {
  it('produces a training view the app parses', async () => {
    const response = await request(app)
      .get('/v1/reviewer/training')
      .set(asReviewer(reviewerOxyUserId));

    expect(response.status).toBe(200);
    expect(response.body.modules.length).toBe(TRAINING_MODULES.length);

    const training = projectTrainingState(response.body);
    expect(training.modules).toHaveLength(TRAINING_MODULES.length);
    expect(training.trainingComplete).toBe(true);
    expect(training.calibrationOpen).toBe(true);
    expect(training.calibrationItems).toHaveLength(CALIBRATION_ITEMS.length);
    expect(training.calibrationPassScore).toBeGreaterThan(0);

    // The answer key is not on the wire, and the app's strict parse is what would
    // refuse it if it ever were.
    for (const item of training.calibrationItems) {
      expect(Object.keys(item).sort()).toEqual(['itemId', 'text']);
    }
  });

  it('produces a calibration result the app parses', async () => {
    const response = await request(app)
      .post('/v1/reviewer/training/calibration')
      .set(asReviewer(reviewerOxyUserId))
      .send({
        answers: CALIBRATION_ITEMS.map((item) => ({
          itemId: item.itemId,
          violation: item.expectedViolation,
          ...(item.expectedCode === undefined ? {} : { code: item.expectedCode }),
        })),
      });

    expect(response.status).toBe(200);
    const result = projectCalibrationResult(response.body);
    expect(result.passed).toBe(true);
    expect(result.incorrectItemIds).toEqual([]);
    // A re-calibration keeps a drawable reviewer's state (§8.2's currency
    // requirement, not a demotion followed by a promotion).
    expect(result.state).toBe('community');
  });
});

describe('the app’s review form → POST .../reviews', () => {
  it('builds a body the strict submission contract accepts', async () => {
    /**
     * The form is driven through its own reducer, from the package the server
     * actually sent, so the rule ids and the resource ids are the server's. A
     * hand-written body would have passed while the app was sending `descriptive`
     * and `appliedExceptionIds` — the two fields that made every real submission a
     * `400`.
     */
    const opened = await request(app)
      .get(`/v1/reviewer/assignments/${assignmentId}`)
      .set(asReviewer(reviewerOxyUserId))
      .set(ASSIGNMENT_TOKEN_HEADER, assignmentToken);
    expect(opened.status).toBe(200);

    const assignment = projectAssignmentPackage(opened.body);
    const rule = assignment.policy.rules[0];
    const resource = assignment.resources[0];
    expect(rule).toBeDefined();
    expect(resource).toBeDefined();

    const apply = (state: ReviewFormState, ...actions: ReviewFormAction[]): ReviewFormState =>
      actions.reduce(reviewFormReducer, state);

    const state = apply(
      createInitialReviewFormState(),
      { type: 'toggleDescriptor', descriptor: 'insults_or_slurs' },
      { type: 'toggleResource', resourceId: resource?.id ?? '' },
      { type: 'toggleMissingContext', code: 'none' },
      { type: 'setCertainty', certainty: 'high' },
      { type: 'advance' },
      { type: 'setOutcome', outcome: 'violation' },
      { type: 'setContextSufficiency', sufficiency: 'sufficient' },
      { type: 'toggleFinding', ruleId: rule?.id ?? '' },
      { type: 'toggleAction', action: 'remove_or_restrict' },
      { type: 'setNotes', notes: 'the material targets one person directly' },
    );

    const submission = buildReviewSubmission(state, assignment.policy.rules);
    expect(submission).not.toBeNull();
    // Vacuity floor: a builder that returned an empty findings list would satisfy
    // the schema and prove nothing about the taxonomy code crossing correctly.
    expect(submission?.findings).toHaveLength(1);
    expect(submission?.findings[0]?.policyRuleIds).toEqual([rule?.id]);

    // `buildReviewSubmission` returns null for an incomplete form, and the point
    // of this test is that a COMPLETE one crosses — so narrow rather than coerce.
    if (submission === null) throw new Error('the form produced no submission to send');

    const submitted = await request(app)
      .post(`/v1/reviewer/assignments/${assignmentId}/reviews`)
      .set(asReviewer(reviewerOxyUserId))
      .set(ASSIGNMENT_TOKEN_HEADER, assignmentToken)
      .send(submission);

    expect(submitted.status).toBe(201);
    expect(submitted.body.reviewId).toMatch(/^rev_/);
  });
});

describe('GET /v1/reviewer/reviews → the app’s history projection', () => {
  it('produces a history page the app parses, with the review just submitted', async () => {
    const response = await request(app)
      .get('/v1/reviewer/reviews')
      .set(asReviewer(reviewerOxyUserId));

    expect(response.status).toBe(200);
    // Vacuity floor: the page must contain the review the block above submitted.
    expect(response.body.entries.length).toBeGreaterThan(0);

    const page = projectHistoryPage(response.body);
    const entry = page.entries[0];
    expect(entry?.outcome).toBe('violation');
    expect(entry?.families).toEqual([FAMILY]);
    expect(entry?.language).toBe(LANGUAGE);
    // §9.1: nothing about where the panel is heading. The decision is null until
    // one is published for this revision, and a partial result has no field at all.
    expect(entry?.decision).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it('takes no case id and no filter, so no case can be looked for', async () => {
    /**
     * "Nobody chooses the case they review" has to hold on the history screen too.
     * The query schema is strict, so an invented filter is a `400` rather than a
     * search that happens to return nothing today.
     */
    const filtered = await request(app)
      .get('/v1/reviewer/reviews?caseId=case_whatever')
      .set(asReviewer(reviewerOxyUserId));

    expect(filtered.status).toBe(400);
  });
});
