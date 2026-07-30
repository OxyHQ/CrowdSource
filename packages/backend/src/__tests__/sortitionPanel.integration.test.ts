import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubOxySession } from './support/reviewers';

/**
 * §15.4's definition of done, end to end against the real replica set.
 *
 *   "A standard case selects three eligible reviewers with the seed and the
 *    candidate snapshot persisted. A user who was not selected cannot open or
 *    vote. A recusal creates a replacement."
 *
 * Plus the two failure modes the plan warns about, both of which the system this
 * replaces gets wrong: a pool too small must REFUSE rather than open a panel
 * that can only expire (§8.8), and a reviewer must not be able to vote twice or
 * reuse a spent token (§8.7).
 *
 * ## What is stubbed, and what is not
 *
 * Exactly one thing: the network call that asks Oxy whether a bearer token is a
 * real session. Everything this phase owns runs for real — the outbox chain from
 * ingestion through triage to the draw, the eligibility query against real
 * indexes, the exclusions, the transaction that writes the draw record and the
 * assignments together, and every authorisation decision.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { registerOutboxWorkers } = await import('../modules/outbox/workers');
const { assignments } = await import('../modules/sortition/assignment.collection');
const { sortitionDraws } = await import('../modules/sortition/draw.collection');
const { openPanel, replayDraw } = await import('../modules/sortition/sortition.service');
const { MAX_PANEL_ROUND } = await import('../modules/sortition/panelSpec');
const { MAX_OPEN_ASSIGNMENTS } = await import('../modules/reviewer/eligibility');
const { expireDueAssignments } = await import('../modules/sortition/assignment.service');
const { reviews } = await import('../modules/review/review.collection');
const { affinityPairKey, reviewerAffinities, reviewerProfiles } = await import(
  '../modules/reviewer/reviewer.collection'
);
const { createReviewer, createReviewerPool } = await import('./support/reviewers');
const { deliveryBody, drainUntil, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;
type ReviewerFixture = Awaited<ReturnType<typeof createReviewer>>;

const app = createApp();

/**
 * The isolation axis.
 *
 * Reviewer profiles are global — a reviewer belongs to no tenant — so reviewers
 * created here would be candidates for every other suite's cases running against
 * the same replica set. `commerce` is a family no other test file alleges, and
 * §8.2 requires a reviewer to accept EVERY family a case alleges, so this file's
 * reviewers and everybody else's cases cannot see each other. The isolation is
 * the product's own rule rather than a fixture trick.
 */
const FAMILY = 'commerce' as const;
const CODE = 'commerce.counterfeit';

/**
 * Each behavioural block gets its OWN family and its own pool.
 *
 * Not tidiness — determinism. `POST /assignments/next` hands back the assignment
 * a reviewer was given longest ago (§8.7), which is correct behaviour and makes
 * a shared pool ambiguous: a reviewer drawn for the recusal case might already
 * be holding one from the panel case, and the test would recuse from the wrong
 * one. Separate families mean every reviewer in a block holds exactly the
 * assignment that block gave them.
 */
const VOTING_FAMILY = 'platform_abuse' as const;
const VOTING_CODE = 'platform_abuse.ban_evasion';
const RECUSAL_FAMILY = 'other' as const;
const RECUSAL_CODE = 'other.policy_specific';

/** A family nobody in this file accepts, for the refusal case. */
const UNSERVED_CODE = 'hate.slur';

let tenant: ProvisionedTenant;
let pool: ReviewerFixture[];
let caseId: string;
let drawnReviewerIds: string[];

async function openCaseFor(code: string, subject: string): Promise<string> {
  const externalReportId = `${subject}-${Date.now()}`;
  const created = await request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', externalReportId)
    .send(
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: subject,
        allegationCode: code,
        text: `material for ${subject}`,
      }),
    );

  expect(created.status).toBe(202);
  await settle(created.body.caseId);
  return created.body.caseId;
}

/**
 * Drives the outbox chain until sortition has ruled on this case.
 *
 * Waiting on the DRAW RECORD — a panel or a recorded refusal — rather than on a
 * number of dispatcher passes. See `drainUntil` for why one pass is not enough.
 */
async function settle(forCaseId: string): Promise<void> {
  await drainUntil(
    async () => (await sortitionDraws.findOne({ caseId: forCaseId })) !== null,
    `a sortition draw for case '${forCaseId}'`,
  );
}

function asReviewer(oxyUserId: string) {
  return { 'x-test-oxy-user': oxyUserId };
}

beforeAll(async () => {
  await startDatabase();
  registerOutboxWorkers();
  tenant = await provisionTenant();

  // Comfortably more than the three seats, so a refusal below is a refusal and
  // not merely an empty database.
  pool = await createReviewerPool(FAMILY, 12);

  caseId = await openCaseFor(CODE, `post_panel_${Date.now()}`);
  const seats = await assignments.find({ caseId });
  drawnReviewerIds = seats.map((seat) => seat.reviewerId);
}, 120_000);

afterAll(async () => {
  await stopDatabase();
});

describe('§15.4: a standard case selects three eligible reviewers', () => {
  it('opens a panel of exactly three, all different people', () => {
    expect(drawnReviewerIds).toHaveLength(3);
    expect(new Set(drawnReviewerIds).size).toBe(3);
  });

  it('draws only from the eligible pool', () => {
    const eligible = new Set(pool.map((reviewer) => reviewer.reviewerId));
    for (const reviewerId of drawnReviewerIds) {
      expect(eligible.has(reviewerId)).toBe(true);
    }
  });

  it('fills §8.3’s slots rather than taking the three best', async () => {
    const seats = await assignments.find({ caseId });
    expect(seats.map((seat) => seat.slotType).sort()).toEqual([
      'calibrated_newcomer',
      'reliable_general',
      'reliable_general',
    ]);
  });

  it('moves the case to awaiting_review and nowhere further', async () => {
    const stored = await mongoose.connection.collection('cases').findOne({ caseId });
    expect(stored?.status).toBe('awaiting_review');
  });
});

describe('§8.5: the seed and the candidate snapshot are persisted', () => {
  it('records the draw with a real seed, the snapshot and the rules version', async () => {
    const draw = await sortitionDraws.findOne({ caseId });

    expect(draw).not.toBeNull();
    expect(draw?.status).toBe('drawn');
    // 32 bytes of hex — the CSPRNG draw, not a placeholder.
    expect(draw?.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(draw?.rulesVersion).toBe('2026.1');
    expect(draw?.panelSpecId).toBe('community.round1');
    expect(draw?.candidateSnapshot.length).toBeGreaterThanOrEqual(3);
    expect(draw?.selected).toHaveLength(3);
  });

  it('the snapshot carries what the draw actually read, per candidate', async () => {
    const draw = await sortitionDraws.findOne({ caseId });
    for (const candidate of draw?.candidateSnapshot ?? []) {
      expect(candidate.reviewerId).toMatch(/^rvw_/);
      expect(candidate.selectionWeight).toBeGreaterThanOrEqual(0.75);
      expect(candidate.selectionWeight).toBeLessThanOrEqual(1.25);
      expect(candidate.eligibleSlots.length).toBeGreaterThan(0);
    }
  });

  it('the assignments exist because the draw does, not the other way round', async () => {
    const draw = await sortitionDraws.findOne({ caseId });
    const seats = await assignments.find({ caseId });

    expect([...(draw?.selected ?? [])].map((seat) => seat.assignmentId).sort()).toEqual(
      seats.map((seat) => seat.assignmentId).sort(),
    );
  });

  it('§16.3: replaying the persisted draw reproduces the same panel', async () => {
    const draw = await sortitionDraws.findOne({ caseId });
    if (!draw) throw new Error('expected a draw');

    const replayed = await replayDraw(draw.drawId);
    expect(replayed?.slice().sort()).toEqual([...drawnReviewerIds].sort());
  });

  it('§16.3: two draws of the same case never share a seed', async () => {
    const second = await openCaseFor(CODE, `post_seed_${Date.now()}`);
    const [first, other] = await Promise.all([
      sortitionDraws.findOne({ caseId }),
      sortitionDraws.findOne({ caseId: second }),
    ]);

    expect(other?.seed).toBeDefined();
    expect(other?.seed).not.toBe(first?.seed);
  });
});

describe('§15.4: a user who was not selected cannot open or vote', () => {
  let outsider: ReviewerFixture;
  let victimAssignmentId: string;

  beforeAll(async () => {
    outsider = await createReviewer({ family: FAMILY, reliability: 0.9, available: false });
    const seats = await assignments.find({ caseId });
    victimAssignmentId = seats[0].assignmentId;
  });

  it('cannot reach the case by id: no reviewer route accepts one', async () => {
    /**
     * The strongest form of "cannot open it knowing the caseId" — there is
     * nothing to ask. The only case-addressed route in the service is the
     * application API, which requires a service credential; an Oxy session does
     * not satisfy it, and a reviewer has no credential.
     */
    const response = await request(app).get(`/v1/cases/${caseId}`).set(asReviewer(outsider.oxyUserId));
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('commerce');
  });

  it('cannot open somebody else’s assignment, even knowing its id', async () => {
    const response = await request(app)
      .get(`/v1/reviewer/assignments/${victimAssignmentId}`)
      .set(asReviewer(outsider.oxyUserId));

    /**
     * 404, not 403, and the same message a nonexistent id gets. A 403 would
     * confirm the assignment exists — which tells the asker a case exists and
     * that somebody was drawn for it, exactly what §9.1's blind review keeps
     * from a juror about their own panel.
     */
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');

    const invented = await request(app)
      .get('/v1/reviewer/assignments/asg_00000000000000000000000000000000')
      .set(asReviewer(outsider.oxyUserId));

    expect(invented.status).toBe(404);
    expect(invented.body).toEqual(response.body);
  });

  it('cannot vote on it', async () => {
    const response = await request(app)
      .post(`/v1/reviewer/assignments/${victimAssignmentId}/reviews`)
      .set(asReviewer(outsider.oxyUserId))
      .send({
        outcome: 'violation',
        contextSufficiency: 'sufficient',
        findings: [
          { code: CODE, resourceIds: ['res_post'], severity: 'medium', confidence: 0.9 },
        ],
        recommendedActions: [],
      });

    expect(response.status).toBe(404);
    expect(await reviews.findOne({ assignmentId: victimAssignmentId })).toBeNull();
  });

  it('cannot recuse from it either', async () => {
    const response = await request(app)
      .post(`/v1/reviewer/assignments/${victimAssignmentId}/recuse`)
      .set(asReviewer(outsider.oxyUserId))
      .send({ reason: 'conflict_of_interest' });

    expect(response.status).toBe(404);

    const untouched = await assignments.findOne({ assignmentId: victimAssignmentId });
    expect(untouched?.status).not.toBe('recused');
  });

  it('gets nothing from "next", because nothing was assigned to them', async () => {
    const response = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(outsider.oxyUserId));

    expect(response.status).toBe(204);
  });

  it('refuses a request with no session at all', async () => {
    const response = await request(app).post('/v1/reviewer/assignments/next');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });
});

describe('§8.7: one assignment authorises exactly one vote', () => {
  let voter: ReviewerFixture;
  let votingCaseId: string;
  let assignmentId: string;
  let token: string;
  let reviewsBefore: number;

  const ballot = {
    outcome: 'violation' as const,
    contextSufficiency: 'sufficient' as const,
    findings: [
      { code: VOTING_CODE, resourceIds: ['res_post'], severity: 'medium' as const, confidence: 0.9 },
    ],
    recommendedActions: [],
  };

  beforeAll(async () => {
    await createReviewerPool(VOTING_FAMILY, 9);
    votingCaseId = await openCaseFor(VOTING_CODE, `post_vote_${Date.now()}`);

    const seats = await assignments.find({ caseId: votingCaseId });
    expect(seats).toHaveLength(3);

    const seat = seats[0];
    const profile = await reviewerProfiles.findOne({ reviewerId: seat.reviewerId });
    if (!profile) throw new Error('expected the drawn reviewer to have a profile');

    voter = { reviewerId: profile.reviewerId, oxyUserId: profile.oxyUserId };
    assignmentId = seat.assignmentId;
    reviewsBefore = profile.completedReviewCount;

    const opened = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(voter.oxyUserId));

    expect(opened.status).toBe(200);
    // The reviewer holds exactly one assignment, so "next" is unambiguous.
    expect(opened.body.assignmentId).toBe(assignmentId);
    token = opened.body.token;
  });

  it('hands the juror the material, the allegation and the policy (§9.1)', async () => {
    const response = await request(app)
      .get(`/v1/reviewer/assignments/${assignmentId}`)
      .set(asReviewer(voter.oxyUserId))
      .set('x-assignment-token', token);

    expect(response.status).toBe(200);
    expect(response.body.allegations).toMatchObject({ unverified: true });
    expect(response.body.policy.rules.length).toBeGreaterThan(0);
    expect(response.body.resources.length).toBeGreaterThan(0);
  });

  it('withholds report counts, other jurors and the application (§9.1)', async () => {
    const response = await request(app)
      .get(`/v1/reviewer/assignments/${assignmentId}`)
      .set(asReviewer(voter.oxyUserId))
      .set('x-assignment-token', token);

    const body = JSON.stringify(response.body);
    expect(response.body.reportCount).toBeUndefined();
    expect(response.body.priorityScore).toBeUndefined();
    expect(body).not.toContain(tenant.applicationId);
    expect(body).not.toContain(votingCaseId);

    const panel = await assignments.find({ caseId: votingCaseId });
    for (const juror of panel) {
      expect(body).not.toContain(juror.reviewerId);
    }
  });

  it('refuses the case without the assignment token', async () => {
    const response = await request(app)
      .get(`/v1/reviewer/assignments/${assignmentId}`)
      .set(asReviewer(voter.oxyUserId));

    expect(response.status).toBe(404);
  });

  it('accepts the review once', async () => {
    const response = await request(app)
      .post(`/v1/reviewer/assignments/${assignmentId}/reviews`)
      .set(asReviewer(voter.oxyUserId))
      .set('x-assignment-token', token)
      .send(ballot);

    expect(response.status).toBe(201);
    expect(response.body.reviewId).toMatch(/^rev_/);

    const stored = await reviews.findOne({ assignmentId });
    expect(stored?.reviewerId).toBe(voter.reviewerId);
    expect(stored?.caseId).toBe(votingCaseId);
  });

  it('refuses the second attempt, and stores no second review', async () => {
    const response = await request(app)
      .post(`/v1/reviewer/assignments/${assignmentId}/reviews`)
      .set(asReviewer(voter.oxyUserId))
      .set('x-assignment-token', token)
      .send(ballot);

    // The assignment is spent: `authorizeAssignment` no longer considers it
    // live, so the answer is the same 404 an outsider gets.
    expect(response.status).toBe(404);
    expect(
      await reviews.countDocuments({ caseId: votingCaseId, reviewerId: voter.reviewerId }),
    ).toBe(1);
  });

  it('counts the review toward the reviewer’s record, exactly once', async () => {
    /**
     * Relative to what the reviewer had before, not an absolute number: the
     * draw decides who votes, and pinning an absolute would be asserting which
     * slot they happened to fill. The refused second submission above must not
     * have moved it either — that is the "exactly once".
     */
    const profile = await reviewerProfiles.findOne({ reviewerId: voter.reviewerId });
    expect(profile?.completedReviewCount).toBe(reviewsBefore + 1);
  });

  it('a token from a previous opening no longer works (§8.7 rotation)', async () => {
    /**
     * A reviewer who reloads the page must get a working token, and the one they
     * held before must stop working. Both halves matter: without rotation a
     * captured token lives as long as the assignment, and without re-issue a
     * reviewer who lost their tab could never open their own case again.
     */
    const rotationCaseId = await openCaseFor(VOTING_CODE, `post_rotate_${Date.now()}`);
    const seats = await assignments.find({ caseId: rotationCaseId });
    const holder = await reviewerProfiles.findOne({
      reviewerId: seats.find((seat) => seat.reviewerId !== voter.reviewerId)?.reviewerId ?? '',
    });
    if (!holder) throw new Error('expected a profile');

    const first = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(holder.oxyUserId));
    const staleToken = first.body.token;

    const reopened = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(holder.oxyUserId));
    const freshToken = reopened.body.token;

    expect(freshToken).not.toBe(staleToken);

    const withStale = await request(app)
      .get(`/v1/reviewer/assignments/${first.body.assignmentId}`)
      .set(asReviewer(holder.oxyUserId))
      .set('x-assignment-token', staleToken);
    expect(withStale.status).toBe(404);

    const withFresh = await request(app)
      .get(`/v1/reviewer/assignments/${reopened.body.assignmentId}`)
      .set(asReviewer(holder.oxyUserId))
      .set('x-assignment-token', freshToken);
    expect(withFresh.status).toBe(200);
  });
});

describe('§8.7: a recusal is not a vote, and it creates a replacement', () => {
  let recusedCaseId: string;
  let recusedReviewerId: string;
  let originalSlot: string;
  let reliabilityBefore: Record<string, number>;

  beforeAll(async () => {
    await createReviewerPool(RECUSAL_FAMILY, 9);
    recusedCaseId = await openCaseFor(RECUSAL_CODE, `post_recuse_${Date.now()}`);
    const seats = await assignments.find({ caseId: recusedCaseId });
    expect(seats).toHaveLength(3);

    const seat = seats[0];
    recusedReviewerId = seat.reviewerId;
    originalSlot = seat.slotType;

    const profile = await reviewerProfiles.findOne({ reviewerId: recusedReviewerId });
    if (!profile) throw new Error('expected a profile');
    reliabilityBefore = { ...profile.reliabilityByCategory };

    const opened = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(profile.oxyUserId));
    expect(opened.status).toBe(200);
    // This reviewer holds only this case, so "next" cannot return another one.
    expect(opened.body.assignmentId).toBe(seat.assignmentId);

    const recusal = await request(app)
      .post(`/v1/reviewer/assignments/${opened.body.assignmentId}/recuse`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', opened.body.token)
      .send({ reason: 'conflict_of_interest' });

    expect(recusal.status).toBe(204);

    // The replacement is a second draw, reached through the outbox — same
    // reasoning as `settle`, one record further on.
    await drainUntil(
      async () => (await sortitionDraws.find({ caseId: recusedCaseId })).length >= 2,
      'the replacement draw after a recusal',
    );
  });

  it('records a recusal, not a review', async () => {
    expect(await reviews.countDocuments({ caseId: recusedCaseId, reviewerId: recusedReviewerId })).toBe(
      0,
    );

    const seat = await assignments.findOne({
      caseId: recusedCaseId,
      reviewerId: recusedReviewerId,
    });
    expect(seat?.status).toBe('recused');
    expect(seat?.recusalReason).toBe('conflict_of_interest');
    expect(seat?.completedAt).toBeNull();
  });

  it('draws a replacement into the SAME slot, without lowering the threshold', async () => {
    const live = await assignments.find({
      caseId: recusedCaseId,
      status: { $in: ['offered', 'accepted'] },
    });

    expect(live).toHaveLength(3);
    expect(live.map((seat) => seat.reviewerId)).not.toContain(recusedReviewerId);
    expect(live.filter((seat) => seat.slotType === originalSlot).length).toBe(
      originalSlot === 'reliable_general' ? 2 : 1,
    );
  });

  it('links the vacated seat to the one that replaced it', async () => {
    const vacated = await assignments.findOne({
      caseId: recusedCaseId,
      reviewerId: recusedReviewerId,
    });
    expect(vacated?.replacementAssignmentId).toMatch(/^asg_/);

    const replacement = await assignments.findOne({
      assignmentId: vacated?.replacementAssignmentId ?? '',
    });
    expect(replacement?.caseId).toBe(recusedCaseId);
  });

  it('records the replacement as its own draw, with its own seed', async () => {
    const draws = await sortitionDraws.find(
      { caseId: recusedCaseId },
      { sort: { drawnAt: 1 } },
    );

    expect(draws).toHaveLength(2);
    expect(draws[0].kind).toBe('initial');
    expect(draws[1].kind).toBe('replacement');
    expect(draws[1].seed).not.toBe(draws[0].seed);
    expect(draws[1].requestedSlots).toEqual([originalSlot]);
  });

  it('never re-draws the person who recused (§8.5 prior jurors)', async () => {
    const everySeat = await assignments.find({ caseId: recusedCaseId });
    expect(everySeat.filter((seat) => seat.reviewerId === recusedReviewerId)).toHaveLength(1);
  });

  it('costs the reviewer nothing (§8.7, §13.7)', async () => {
    const profile = await reviewerProfiles.findOne({ reviewerId: recusedReviewerId });

    // No reliability change, no suspension, no counter. The one thing that DID
    // happen is a recorded relationship, so they are not drawn for the same
    // people again — which is a benefit, not a penalty.
    expect(profile?.state).not.toBe('suspended');
    expect(profile?.suspendedUntil).toBeNull();
    expect(profile?.available).toBe(true);
    expect(profile?.reliabilityByCategory).toEqual(reliabilityBefore);

    const relations = await mongoose.connection
      .collection('reviewer_relations')
      .find({ reviewerId: recusedReviewerId })
      .toArray();
    expect(relations.length).toBeGreaterThan(0);
    expect(relations[0].source).toBe('recusal');
  });
});

/**
 * §8.5's exclusions, in a REAL draw rather than against the pure predicate.
 *
 * `sortitionExclusions.test.ts` proves each rule fires. This proves the draw
 * actually consults them, which is a different claim and the one that fails
 * silently: an exclusion set that is computed and then not passed to the sampler
 * looks identical from the outside, and the symptom is the reporter of a case
 * sitting on its jury.
 *
 * Both scenarios are built so the answer is DETERMINISTIC in both directions —
 * the excluded people are the only ones who could fill the remaining slots, so
 * the draw either refuses (rules on) or seats somebody it must not (rules off).
 * A pool where the excluded merely *might* be picked would make this a coin
 * flip dressed up as a test.
 */
describe('§8.5: the exclusions bite in a real draw', () => {
  const PARTY_FAMILY = 'violence' as const;
  const PARTY_CODE = 'violence.instruction';

  let partyCaseId: string;

  beforeAll(async () => {
    /**
     * Two clean reviewers — one short of a panel — plus the case's own author
     * and its reporter, who between them WOULD complete it.
     *
     * `sampleEnvelope` binds `user_author` as the author and `reporter_1` as the
     * reporter, and `deliveryBody` passes both through unchanged, so these links
     * name the real parties to the case rather than a fixture's idea of them.
     */
    await createReviewer({ family: PARTY_FAMILY, reliability: 0.9, completedReviewCount: 40 });
    await createReviewer({ family: PARTY_FAMILY, reliability: 0.4, completedReviewCount: 0 });

    await createReviewer({
      family: PARTY_FAMILY,
      reliability: 0.9,
      completedReviewCount: 40,
      principalLinks: [
        { applicationId: tenant.applicationId, externalPrincipalId: 'user_author' },
      ],
    });
    await createReviewer({
      family: PARTY_FAMILY,
      reliability: 0.9,
      completedReviewCount: 40,
      principalLinks: [
        { applicationId: tenant.applicationId, externalPrincipalId: 'reporter_1' },
      ],
    });

    partyCaseId = await openCaseFor(PARTY_CODE, `post_parties_${Date.now()}`);
  });

  it('refuses rather than seating the author or the reporter of the case', async () => {
    expect(await assignments.countDocuments({ caseId: partyCaseId })).toBe(0);

    const draw = await sortitionDraws.findOne({ caseId: partyCaseId });
    expect(draw?.status).toBe('refused');
    // Four reviewers matched the eligibility index; two survived the exclusions,
    // which is one fewer than the panel needs.
    expect(draw?.eligibleCount).toBe(2);
    expect(draw?.sampledCount).toBe(4);
  });

  it('records WHO was excluded and WHY, in the audit trail', async () => {
    const draw = await sortitionDraws.findOne({ caseId: partyCaseId });
    const reasons = (draw?.rejections ?? []).map((rejection) => rejection.reason).sort();

    expect(reasons).toEqual(['reporter', 'subject_principal']);
  });
});

/**
 * The prior-juror rule, forced to be the only thing that can decide the outcome.
 *
 * The pool is exactly the size of one panel, so after the initial draw every
 * eligible person is already a juror. Recusing one leaves a seat that only the
 * person who just recused could fill — and §8.5 says they must not, while §8.7
 * says the threshold must not drop to accommodate them. The correct answer is a
 * recorded refusal, and it is the ONLY answer that does not involve re-seating
 * somebody who stepped away.
 */
describe('§8.5 + §8.7: a recused juror is never re-drawn to fill their own seat', () => {
  const TIGHT_FAMILY = 'self_harm' as const;
  const TIGHT_CODE = 'self_harm.promotion';

  let tightCaseId: string;
  let steppedAsideId: string;

  beforeAll(async () => {
    /**
     * Exactly one panel's worth: two reliable and one newcomer. They also carry
     * the consent this route requires — `self_harm.promotion` is `sensitive`
     * (§7.5), so an unconsenting reviewer is not eligible for it at all.
     */
    const consent = {
      family: TIGHT_FAMILY,
      maxSensitivityRank: 1,
      consentedSensitiveCategories: [TIGHT_FAMILY],
    } as const;

    await createReviewer({ ...consent, reliability: 0.9, completedReviewCount: 40 });
    await createReviewer({ ...consent, reliability: 0.9, completedReviewCount: 40 });
    await createReviewer({ ...consent, reliability: 0.4, completedReviewCount: 0 });

    tightCaseId = await openCaseFor(TIGHT_CODE, `post_tight_${Date.now()}`);
    const seats = await assignments.find({ caseId: tightCaseId });
    expect(seats).toHaveLength(3);

    const seat = seats.find((entry) => entry.slotType === 'calibrated_newcomer');
    if (!seat) throw new Error('expected a newcomer seat');
    steppedAsideId = seat.reviewerId;

    const profile = await reviewerProfiles.findOne({ reviewerId: steppedAsideId });
    if (!profile) throw new Error('expected a profile');

    const opened = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(profile.oxyUserId));
    expect(opened.body.assignmentId).toBe(seat.assignmentId);

    const recusal = await request(app)
      .post(`/v1/reviewer/assignments/${seat.assignmentId}/recuse`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', opened.body.token)
      .send({ reason: 'too_sensitive' });
    expect(recusal.status).toBe(204);

    await drainUntil(
      async () => (await sortitionDraws.find({ caseId: tightCaseId })).length >= 2,
      'the refused replacement draw',
    );
  });

  it('leaves the seat empty rather than re-seating the person who stepped away', async () => {
    /**
     * Two independent guards hold this, and mutation-testing the first revealed
     * the second. §8.5's prior-juror exclusion keeps the recused reviewer out of
     * the candidate pool; if that rule is bypassed, the unique index on
     * `caseId + reviewerId + caseRevision` still refuses the insert and the
     * whole replacement transaction rolls back. The count below is the assertion
     * that survives either way — one row for that reviewer on this case, ever.
     */
    const live = await assignments.find({
      caseId: tightCaseId,
      status: { $in: ['offered', 'accepted'] },
    });

    expect(live).toHaveLength(2);
    expect(live.map((seat) => seat.reviewerId)).not.toContain(steppedAsideId);
    expect(
      await assignments.countDocuments({ caseId: tightCaseId, reviewerId: steppedAsideId }),
    ).toBe(1);
  });

  it('records the refused replacement, so the short panel is visible', async () => {
    const draws = await sortitionDraws.find({ caseId: tightCaseId }, { sort: { drawnAt: 1 } });

    expect(draws).toHaveLength(2);
    expect(draws[1].kind).toBe('replacement');
    expect(draws[1].status).toBe('refused');
    expect(draws[1].requestedSlots).toEqual(['calibrated_newcomer']);
    // Everybody eligible is already on the panel, so nobody survives exclusion.
    expect(draws[1].eligibleCount).toBe(0);
    expect(draws[1].rejections.every((rejection) => rejection.reason === 'prior_juror')).toBe(true);
  });

  it('does not punish the reviewer who recused (§8.7, §13.7)', async () => {
    const profile = await reviewerProfiles.findOne({ reviewerId: steppedAsideId });
    expect(profile?.state).toBe('community');
    expect(profile?.available).toBe(true);
    expect(profile?.suspendedUntil).toBeNull();
    expect(profile?.completedReviewCount).toBe(0);
  });
});

/**
 * §8.7's other way of losing a juror: the clock.
 *
 * "If it expires or the reviewer recuses, the system selects a replacement
 * without lowering the threshold." Expiry is the half nobody performs by hand,
 * so it is the half that rots unnoticed — the sweep runs on a timer in
 * `server.ts` and would fail silently in production. Driven here directly, with
 * the assignment backdated rather than by waiting a day.
 */
describe('§8.7: an expired assignment is replaced', () => {
  const EXPIRY_FAMILY = 'sexual_content' as const;
  const EXPIRY_CODE = 'sexual_content.explicit_activity';

  let expiryCaseId: string;
  let expiredAssignmentId: string;
  let expiredReviewerId: string;

  beforeAll(async () => {
    /**
     * This route is `sensitive` (§7.5 row 5) and adult-only, so the pool needs
     * both the class ceiling and the per-family consent — which also means the
     * draw exercises §13.7's consent gate rather than routing around it.
     */
    for (let index = 0; index < 6; index += 1) {
      await createReviewer({
        family: EXPIRY_FAMILY,
        reliability: index % 3 === 2 ? 0.4 : 0.9,
        completedReviewCount: index % 3 === 2 ? 0 : 40,
        maxSensitivityRank: 1,
        consentedSensitiveCategories: [EXPIRY_FAMILY],
      });
    }

    expiryCaseId = await openCaseFor(EXPIRY_CODE, `post_expiry_${Date.now()}`);
    const seats = await assignments.find({ caseId: expiryCaseId });
    expect(seats).toHaveLength(3);

    expiredAssignmentId = seats[0].assignmentId;
    expiredReviewerId = seats[0].reviewerId;

    // Backdate it past its own deadline, then run the sweep exactly as the
    // timer in `server.ts` does.
    await assignments.updateOne(
      { assignmentId: expiredAssignmentId },
      { expiresAt: new Date(Date.now() - 60_000) },
    );

    const swept = await expireDueAssignments();
    expect(swept).toBeGreaterThanOrEqual(1);

    await drainUntil(
      async () => (await sortitionDraws.find({ caseId: expiryCaseId })).length >= 2,
      'the replacement draw after an expiry',
    );
  });

  it('marks it expired and draws somebody else into the seat', async () => {
    const expired = await assignments.findOne({ assignmentId: expiredAssignmentId });
    expect(expired?.status).toBe('expired');
    expect(expired?.replacementAssignmentId).toMatch(/^asg_/);

    const live = await assignments.find({
      caseId: expiryCaseId,
      status: { $in: ['offered', 'accepted'] },
    });
    expect(live).toHaveLength(3);
    expect(live.map((seat) => seat.reviewerId)).not.toContain(expiredReviewerId);
  });

  it('the reviewer whose assignment lapsed can no longer open it', async () => {
    const profile = await reviewerProfiles.findOne({ reviewerId: expiredReviewerId });
    if (!profile) throw new Error('expected a profile');

    // Not even with a token: an expired assignment is not live, and every
    // refusal on this surface looks the same.
    const response = await request(app)
      .get(`/v1/reviewer/assignments/${expiredAssignmentId}`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', 'whatever-they-still-hold');

    expect(response.status).toBe(404);
  });

  it('does not punish them for running out of time (§13.7)', async () => {
    const profile = await reviewerProfiles.findOne({ reviewerId: expiredReviewerId });
    expect(profile?.available).toBe(true);
    expect(profile?.suspendedUntil).toBeNull();
    expect(profile?.state).toBe('community');
  });

  it('is idempotent: a second sweep finds nothing more to expire here', async () => {
    await expireDueAssignments();
    expect(
      await assignments.countDocuments({ caseId: expiryCaseId, status: 'expired' }),
    ).toBe(1);
  });
});

/**
 * §8.6's escalation, driven end to end.
 *
 * The consensus engine is what will call this (§15.5) — it decides when a panel
 * disagrees enough to need more people. What belongs to THIS phase is that
 * expanding works and obeys the same rules: the sitting jurors keep their seats,
 * the new seats come from a second draw with its own seed, and nobody is seated
 * twice.
 */
describe('§8.6: expanding a panel from three to five', () => {
  let expandedCaseId: string;
  let originalPanel: string[];

  beforeAll(async () => {
    await createReviewerPool(FAMILY, 9);
    expandedCaseId = await openCaseFor(CODE, `post_expand_${Date.now()}`);
    originalPanel = (await assignments.find({ caseId: expandedCaseId })).map(
      (seat) => seat.reviewerId,
    );
    expect(originalPanel).toHaveLength(3);

    const outcome = await openPanel({
      context: tenant.tenant,
      caseId: expandedCaseId,
      kind: 'expansion',
      round: 2,
    });
    expect(outcome.status).toBe('drawn');
  });

  it('adds two seats and keeps the original three', async () => {
    const seats = await assignments.find({ caseId: expandedCaseId });

    expect(seats).toHaveLength(5);
    for (const reviewerId of originalPanel) {
      expect(seats.map((seat) => seat.reviewerId)).toContain(reviewerId);
    }
    expect(new Set(seats.map((seat) => seat.reviewerId)).size).toBe(5);
  });

  it('records the expansion as its own draw, at round 2', async () => {
    const draws = await sortitionDraws.find(
      { caseId: expandedCaseId },
      { sort: { drawnAt: 1 } },
    );

    expect(draws).toHaveLength(2);
    expect(draws[1]).toMatchObject({ kind: 'expansion', round: 2, panelSpecId: 'community.round2' });
    expect(draws[1].seed).not.toBe(draws[0].seed);
    // Only the seats round 1 did not already fill.
    expect(draws[1].requestedSlots).toHaveLength(2);
    expect(draws[1].selected).toHaveLength(2);
  });

  it('counts every pair on the finished panel (§8.5 affinity)', async () => {
    /**
     * Affinity is about who SAT TOGETHER, so a five-person panel owes ten pairs
     * — not merely the pairs the second draw introduced. Two people who keep
     * landing on the same juries stop being two independent judgements, and the
     * ledger that notices is only useful if it counts the whole room.
     */
    const seats = await assignments.find({ caseId: expandedCaseId });
    const ids = seats.map((seat) => seat.reviewerId);

    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const pair = await reviewerAffinities.findOne({
          pairKey: affinityPairKey(ids[left], ids[right]),
        });
        expect(pair?.coServedCount, `${ids[left]} + ${ids[right]}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('replays the expansion draw with its incumbents in place (§16.3)', async () => {
    const draws = await sortitionDraws.find(
      { caseId: expandedCaseId },
      { sort: { drawnAt: 1 } },
    );

    const replayed = await replayDraw(draws[1].drawId);
    expect(replayed?.slice().sort()).toEqual(
      draws[1].selected.map((seat) => seat.reviewerId).sort(),
    );
  });

  it('refuses to expand past the ladder (§8.6)', async () => {
    await expect(
      openPanel({
        context: tenant.tenant,
        caseId: expandedCaseId,
        kind: 'expansion',
        round: MAX_PANEL_ROUND + 1,
      }),
    ).rejects.toThrow(/cannot expand past round/);
  });

  it('refuses a draw asked to fill no seat at all', async () => {
    await expect(
      openPanel({
        context: tenant.tenant,
        caseId: expandedCaseId,
        kind: 'replacement',
        slots: [],
      }),
    ).rejects.toThrow(/no seat to fill/);
  });
});

/**
 * §13.7's exposure ceiling, in a real draw.
 *
 * Invisible against a fresh pool — nobody is carrying anything — so it needs a
 * reviewer who already is. The assertion reads the rejection the DRAW recorded
 * for that specific person, which makes it independent of how large the pool
 * happens to be: the claim is that the draw consulted the exposure rules, not
 * that a particular panel came out a particular way.
 */
describe('§13.7: a reviewer at their open-case ceiling is not drawn', () => {
  it('records them as rejected for the limit, by name', async () => {
    const busy = await createReviewer({
      family: FAMILY,
      reliability: 0.95,
      completedReviewCount: 40,
    });

    /**
     * Three open assignments is the ceiling. They point at cases that do not
     * exist, and that is fine — the count is about how much this person is
     * carrying, not about what.
     */
    for (let index = 0; index < MAX_OPEN_ASSIGNMENTS; index += 1) {
      await assignments.insertOne({
        assignmentId: `asg_busy${String(index).padStart(27, '0')}`,
        organizationId: tenant.organizationId,
        applicationId: tenant.applicationId,
        caseId: `case_busy${String(index).padStart(26, '0')}`,
        caseRevision: 1,
        drawId: 'drw_busy0000000000000000000000000',
        incidentId: null,
        reviewerId: busy.reviewerId,
        slotType: 'reliable_general',
        filledAs: 'reliable_general',
        status: 'offered',
        tokenHash: 'x'.repeat(64),
        sensitivityClass: 'standard',
        offeredAt: new Date(),
        acceptedAt: null,
        expiresAt: new Date(Date.now() + 3_600_000),
        completedAt: null,
        recusalReason: null,
        replacementAssignmentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const busyCaseId = await openCaseFor(CODE, `post_busy_${Date.now()}`);
    const draw = await sortitionDraws.findOne({ caseId: busyCaseId });

    expect(
      draw?.rejections.find((rejection) => rejection.reviewerId === busy.reviewerId)?.reason,
    ).toBe('open_assignment_limit');
    expect(draw?.selected.map((seat) => seat.reviewerId)).not.toContain(busy.reviewerId);
  });
});

describe('§8.8: an undersized pool refuses rather than opening', () => {
  /**
   * The behaviour that separates this from the system it replaces.
   *
   * Oxy's `selectValidators` has no minimum-pool guard, so it opens a panel
   * below quorum which can only ever expire — twenty of twenty-one civic
   * validation requests in production expired with zero votes ever cast. Here
   * the draw refuses, records WHY, and leaves the case where a later draw can
   * pick it up.
   */
  let starvedCaseId: string;

  beforeAll(async () => {
    starvedCaseId = await openCaseFor(UNSERVED_CODE, `post_starved_${Date.now()}`);
  });

  it('opens no assignments at all', async () => {
    expect(await assignments.countDocuments({ caseId: starvedCaseId })).toBe(0);
  });

  it('leaves the case where it was, rather than in a state nobody can resolve', async () => {
    const stored = await mongoose.connection.collection('cases').findOne({ caseId: starvedCaseId });
    expect(stored?.status).toBe('triaged');
  });

  it('records the refusal, with the reason and the counts an operator needs', async () => {
    const draw = await sortitionDraws.findOne({ caseId: starvedCaseId });

    expect(draw?.status).toBe('refused');
    expect(draw?.refusalReason).toBe('candidate_pool_too_small');
    expect(draw?.selected).toEqual([]);
    // Fewer than a panel needs. Not necessarily zero: this file deliberately
    // reuses families across blocks, so the claim is "too few", which is the
    // claim the guard actually makes.
    expect(draw?.eligibleCount).toBeLessThan(3);
    // The seed is still written: a refusal is a draw that happened.
    expect(draw?.seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not dead-letter the event: an empty pool is a state, not a fault', async () => {
    const rows = await mongoose.connection
      .collection('outbox_events')
      .find({ 'payload.caseId': starvedCaseId, type: 'case.ready_for_review' })
      .toArray();

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('dispatched');
  });

  /**
   * The control, and the reason the refusal above means something.
   *
   * Without it, a selector that refused EVERYTHING would pass every assertion in
   * this block. Give the same family a pool and the panel opens.
   */
  it('mutation control: with reviewers for that family, the same case opens a panel', async () => {
    await createReviewerPool('hate', 9);

    const openable = await openCaseFor(UNSERVED_CODE, `post_unstarved_${Date.now()}`);
    const seats = await assignments.find({ caseId: openable });

    expect(seats).toHaveLength(3);
    const draw = await sortitionDraws.findOne({ caseId: openable });
    expect(draw?.status).toBe('drawn');
  });
});
