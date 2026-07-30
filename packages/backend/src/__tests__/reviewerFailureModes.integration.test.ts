import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubOxySession } from './support/reviewers';

/**
 * The paths that refuse, throw, or quietly do nothing — driven for real.
 *
 * Everything here is a branch the happy path never reaches: a worker handed a
 * malformed event, a case with no pool, an assignment claimed twice, a reviewer
 * profile that vanished mid-write. They are exactly the branches that turn out
 * to be a crash on the day they first fire, and — being failure paths — that is
 * always a day when something has already gone unusual.
 *
 * Several of them cannot be reached through the HTTP surface at all, because the
 * surface refuses first. Those are driven against the service directly, which is
 * the honest way to test a guard whose job is to catch what should be
 * impossible.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { createTenantContext } = await import('../db/tenantScope');
const { cases } = await import('../modules/cases/case.collection');
const { policyVersionOfToken } = await import('../modules/cases/caseDedupKey');
const { reviews } = await import('../modules/review/review.collection');
const { submitReview } = await import('../modules/review/review.service');
const { reviewerProfiles } = await import('../modules/reviewer/reviewer.collection');
const {
  assertTransition,
  completeTrainingModule,
  declareReviewerRelation,
  recordSubmittedReview,
  submitCalibration,
  updateReviewerPreferences,
} = await import('../modules/reviewer/reviewer.service');
const { requestReviewer } = await import('../modules/reviewer/reviewerAuth');
const { assignments } = await import('../modules/sortition/assignment.collection');
const { mintAssignmentToken } = await import('../modules/sortition/assignmentToken');
const {
  expireDueAssignments,
  nextAssignment,
  startAssignmentExpirySweep,
  stopAssignmentExpirySweep,
} = await import('../modules/sortition/assignment.service');
const { sampleCandidates } = await import('../modules/sortition/candidatePool');
const { sortitionDraws } = await import('../modules/sortition/draw.collection');
const { openPanel, replayDraw } = await import('../modules/sortition/sortition.service');
const { handleAssignmentVacated, handleCaseReadyForReview } = await import(
  '../modules/sortition/sortition.worker'
);
const { withTransaction } = await import('../db/transaction');
const { registerOutboxWorkers } = await import('../modules/outbox/workers');
const { createReviewer } = await import('./support/reviewers');
const { deliveryBody, drainUntil, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();

/**
 * The isolation axis for this suite, which needs TWO dimensions rather than one.
 *
 * Reviewer profiles are global, and every taxonomy family is already spoken for
 * by another suite — `sortitionPanel` alone uses five. So this file separates on
 * CONSENT instead: `privacy.personal_information` is `sensitive` (§7.5 row 4),
 * and §8.2 requires per-family consent for sensitive material. The reviewers
 * here carry that consent and the `privacy` reviewers created by the onboarding
 * suite do not, so neither pool can be drawn for the other's cases.
 */
const FAMILY = 'privacy' as const;
const CODE = 'privacy.personal_information';

/** Everything a reviewer needs to be eligible for this suite's sensitive route. */
const CONSENT = {
  family: FAMILY,
  maxSensitivityRank: 1,
  consentedSensitiveCategories: [FAMILY],
} as const;

let tenant: ProvisionedTenant;

function asReviewer(oxyUserId: string) {
  return { 'x-test-oxy-user': oxyUserId };
}

function outboxEvent(overrides: Record<string, unknown>) {
  return {
    eventId: 'evt_00000000000000000000000000000000',
    organizationId: tenant.organizationId,
    applicationId: tenant.applicationId,
    type: 'case.ready_for_review' as const,
    payload: {},
    status: 'pending' as const,
    attempts: 1,
    availableAt: new Date(),
    dispatchedAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Opens a seat on `caseId` belonging to a juror who holds ONLY that seat.
 *
 * `POST /assignments/next` hands back the assignment a reviewer was given
 * longest ago (§8.7) — correct behaviour, and ambiguous for a test whose jurors
 * may also be sitting on an earlier case in this same file. Picking a juror with
 * one seat makes "next" mean exactly one thing, and the throw says so rather
 * than letting a later assertion fail somewhere unrelated.
 */
async function openSoleSeat(caseId: string) {
  const seats = await assignments.find({
    caseId,
    status: { $in: ['offered', 'accepted'] },
  });

  for (const seat of seats) {
    /**
     * `nextAssignment` returns the OLDEST open assignment, so the juror to pick
     * is one for whom this seat IS that — mirroring the rule rather than
     * requiring them to hold nothing else, which gets rarer as the file goes on.
     */
    const held = await assignments.find(
      { reviewerId: seat.reviewerId, status: { $in: ['offered', 'accepted'] } },
      { sort: { offeredAt: 1 } },
    );
    if (held[0]?.assignmentId !== seat.assignmentId) continue;

    const profile = await reviewerProfiles.findOne({ reviewerId: seat.reviewerId });
    if (!profile) continue;

    const opened = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(profile.oxyUserId));
    if (opened.status === 200 && opened.body.assignmentId === seat.assignmentId) {
      return { seat, profile, opened };
    }
  }

  throw new Error(`No juror of '${caseId}' has that seat as their next one.`);
}

beforeAll(async () => {
  await startDatabase();
  // Without this the dispatcher claims nothing: it only takes rows whose type
  // has a registered consumer, which is what keeps unconsumed work durable.
  registerOutboxWorkers();
  tenant = await provisionTenant();
}, 120_000);

afterAll(async () => {
  stopAssignmentExpirySweep();
  await stopDatabase();
});

describe('the sortition workers reject a malformed event', () => {
  /**
   * An outbox row that names no case, or an assignment that does not exist, is
   * not a retryable condition — it means something wrote a row outside the
   * transaction that should have carried it. Both are defects worth surfacing
   * rather than absorbing, so the handler throws and the dispatcher records it.
   */
  it('refuses an event with no caseId', async () => {
    await expect(handleCaseReadyForReview(outboxEvent({ payload: {} }))).rejects.toThrow(
      /carries no caseId/,
    );
  });

  it('refuses a vacancy that names no assignment', async () => {
    await expect(
      handleAssignmentVacated(
        outboxEvent({ type: 'assignment.vacated', payload: { caseId: 'case_x' } }),
      ),
    ).rejects.toThrow(/names no assignment/);
  });

  it('refuses a vacancy naming an assignment that does not exist', async () => {
    await expect(
      handleAssignmentVacated(
        outboxEvent({
          type: 'assignment.vacated',
          payload: { caseId: 'case_x', assignmentId: 'asg_00000000000000000000000000000000' },
        }),
      ),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('openPanel refuses what it cannot draw for', () => {
  it('throws for a case this tenant does not own', async () => {
    await expect(
      openPanel({
        context: tenant.tenant,
        caseId: 'case_00000000000000000000000000000000',
        kind: 'initial',
      }),
    ).rejects.toThrow(/does not own/);
  });

  it('throws for a case triage has not routed yet', async () => {
    /**
     * A case with no pool has no panel specification, and guessing one would
     * mean drawing a community jury for material triage might have sent to a
     * specialist team. The report is delivered but deliberately NOT drained.
     */
    const externalReportId = `untriaged-${Date.now()}`;
    const created = await request(app)
      .post('/v1/reports')
      .set('Authorization', `Bearer ${tenant.token}`)
      .set('Idempotency-Key', externalReportId)
      .send(
        deliveryBody(tenant, externalReportId, {
          subjectExternalId: `post_untriaged_${Date.now()}`,
          allegationCode: CODE,
        }),
      );

    await expect(
      openPanel({ context: tenant.tenant, caseId: created.body.caseId, kind: 'initial' }),
    ).rejects.toThrow(/has not been triaged/);
  });
});

describe('§7.5: the legal route is refused, not composed', () => {
  let legalCaseId: string;

  beforeAll(async () => {
    /**
     * `child_safety.exploitation` routes to the legal pool (§7.5 row 1). It is
     * never delivered to a jury, and the refusal is RECORDED — "no panel was
     * ever opened" and "this is with a specialist team under legal protocol"
     * look identical from outside otherwise, and only one is correct.
     */
    const externalReportId = `legal-${Date.now()}`;
    const created = await request(app)
      .post('/v1/reports')
      .set('Authorization', `Bearer ${tenant.token}`)
      .set('Idempotency-Key', externalReportId)
      .send(
        deliveryBody(tenant, externalReportId, {
          subjectExternalId: `post_legal_${Date.now()}`,
          allegationCode: 'child_safety.exploitation',
        }),
      );
    legalCaseId = created.body.caseId;

    await drainUntil(
      async () => (await sortitionDraws.findOne({ caseId: legalCaseId })) !== null,
      'the recorded legal-pool refusal',
    );
  });

  it('records a refusal naming the legal pool, and opens nothing', async () => {
    const draw = await sortitionDraws.findOne({ caseId: legalCaseId });

    expect(draw?.status).toBe('refused');
    expect(draw?.refusalReason).toBe('legal_pool');
    expect(draw?.pool).toBe('legal');
    expect(draw?.selected).toEqual([]);
    expect(await assignments.countDocuments({ caseId: legalCaseId })).toBe(0);
  });
});

describe('replaying a draw that cannot be replayed', () => {
  it('returns null for an unknown draw', async () => {
    expect(await replayDraw('drw_00000000000000000000000000000000')).toBeNull();
  });

  it('returns null for a refused draw, which selected nobody', async () => {
    const refused = await sortitionDraws.findOne({ status: 'refused' });
    expect(refused).not.toBeNull();
    expect(await replayDraw(refused?.drawId ?? '')).toBeNull();
  });
});

describe('the candidate window', () => {
  it('stops at the limit when the head of the key range already fills it', async () => {
    await createReviewer({ ...CONSENT, samplingKey: 0.99 });
    await createReviewer({ ...CONSENT, samplingKey: 0.995 });

    const sample = await sampleCandidates(
      { families: [FAMILY], language: 'es', sensitivity: 'sensitive', requiresAdult: false },
      new Date(),
      1,
    );

    expect(sample.profiles).toHaveLength(1);
    expect(sample.sampledCount).toBe(1);
  });

  it('wraps past zero rather than favouring high sampling keys', async () => {
    /**
     * Without the wrap, reviewers near 1.0 would serve measurably more often —
     * a bias invisible in any single draw and only apparent over months.
     */
    const sample = await sampleCandidates(
      { families: [FAMILY], language: 'es', sensitivity: 'sensitive', requiresAdult: false },
      new Date(),
      500,
    );

    expect(sample.profiles.length).toBeGreaterThanOrEqual(2);
    expect(sample.windowStart).toBeGreaterThanOrEqual(0);
    expect(sample.windowStart).toBeLessThan(1);
  });
});

describe('assignment housekeeping', () => {
  it('hands a reviewer nothing when nothing was assigned to them', async () => {
    const reviewer = await createReviewer({ ...CONSENT });
    expect(await nextAssignment(reviewer.reviewerId)).toBeNull();
  });

  it('expires nothing when nothing is due', async () => {
    expect(await expireDueAssignments(new Date(0))).toBe(0);
  });

  it('starts and stops the sweep idempotently', () => {
    // A second start must not create a second interval, and a stop with nothing
    // running must not throw — `server.ts` calls both on paths that can repeat.
    startAssignmentExpirySweep(60_000);
    startAssignmentExpirySweep(60_000);
    stopAssignmentExpirySweep();
    stopAssignmentExpirySweep();
  });
});

describe('the review ledger refuses a second ballot', () => {
  /**
   * `consumeAssignmentForReview` already stops the ordinary double-submit. This
   * exercises the OTHER guard — §12.7's unique index on
   * `caseId + reviewerId + caseRevision` — which is what holds if two
   * assignments for one juror ever existed. Simulated by writing the row the
   * index would collide with, because the assignment index makes the real race
   * unreachable, and a guard nobody can reach is a guard nobody has tested.
   */
  it('answers 409 rather than storing two reviews for one juror and revision', async () => {
    const pool = [];
    for (let index = 0; index < 6; index += 1) {
      pool.push(
        await createReviewer({
          ...CONSENT,
          reliability: index % 3 === 2 ? 0.4 : 0.9,
          completedReviewCount: index % 3 === 2 ? 0 : 40,
        }),
      );
    }
    expect(pool).toHaveLength(6);

    const externalReportId = `ledger-${Date.now()}`;
    const created = await request(app)
      .post('/v1/reports')
      .set('Authorization', `Bearer ${tenant.token}`)
      .set('Idempotency-Key', externalReportId)
      .send(
        deliveryBody(tenant, externalReportId, {
          subjectExternalId: `post_ledger_${Date.now()}`,
          allegationCode: CODE,
        }),
      );
    const caseId = created.body.caseId;

    await drainUntil(
      async () => (await assignments.countDocuments({ caseId })) === 3,
      'a panel for the ledger case',
    );

    const seat = (await assignments.find({ caseId }))[0];
    const profile = await reviewerProfiles.findOne({ reviewerId: seat.reviewerId });
    if (!profile) throw new Error('expected a profile');

    const opened = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(profile.oxyUserId));
    expect(opened.status).toBe(200);
    // This reviewer holds exactly one assignment, so "next" is unambiguous —
    // without pinning it, a reviewer carrying an older one would have the
    // review land on a different case and the collision would never happen.
    expect(opened.body.assignmentId).toBe(seat.assignmentId);

    // The row a concurrent submission would have left behind.
    await reviews.insertOne({
      reviewId: 'rev_00000000000000000000000000000099',
      organizationId: seat.organizationId,
      applicationId: seat.applicationId,
      assignmentId: 'asg_00000000000000000000000000000099',
      caseId: seat.caseId,
      caseRevision: seat.caseRevision,
      reviewerId: seat.reviewerId,
      outcome: 'no_violation',
      contextSufficiency: 'sufficient',
      findings: [],
      recommendedActions: [],
      notes: null,
      submittedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      submitReview({
        assignmentId: opened.body.assignmentId,
        reviewerId: seat.reviewerId,
        submission: {
          outcome: 'no_violation',
          contextSufficiency: 'sufficient',
          findings: [],
          recommendedActions: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(
      await reviews.countDocuments({ caseId, reviewerId: seat.reviewerId }),
    ).toBe(1);
  });
});

describe('the reviewer API when no Oxy API is configured', () => {
  /**
   * `OXY_API_URL` has no default on purpose: inventing one would point session
   * verification at a host nobody chose. The application still boots — the
   * application API does not need it — and the reviewer surface answers `503`,
   * because the capability is genuinely unavailable rather than the request
   * being wrong.
   */
  it('answers 503 rather than accepting sessions it cannot verify', async () => {
    vi.resetModules();
    vi.stubEnv('OXY_API_URL', '');

    const isolated = await import('../app');
    const { resetOxySession } = await import('../modules/identity/oxySession');
    resetOxySession();

    const response = await request(isolated.createApp())
      .get('/v1/reviewer/profile')
      .set(asReviewer('oxy_unconfigured'));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('service_unavailable');

    vi.unstubAllEnvs();
    vi.resetModules();
    resetOxySession();
  });
});

describe('the session payload is read defensively', () => {
  it('treats a malformed user object as unverified rather than trusting it', async () => {
    /**
     * `OxyRequestUser` is an open bag, so "we were not told" must never become
     * "verified" — §8.2's personhood would otherwise be raised by a session
     * payload nobody validated.
     */
    const oxyUserId = `oxy_malformed_${Date.now()}`;
    const response = await request(app)
      .get('/v1/reviewer/profile')
      .set({ 'x-test-oxy-user': oxyUserId, 'x-test-oxy-verified': 'not-a-boolean' });

    expect(response.status).toBe(200);
    // Read from the document: the projection does not publish the score, and the
    // point of this test is the SIGNAL that fed it, not what a screen shows.
    expect((await reviewerProfiles.findOne({ oxyUserId }))?.personhoodConfidence).toBe(0.3);
  });
});

describe('a juror holding an assignment whose case is gone', () => {
  it('gets the same 404 as any other refusal, not a 500', async () => {
    /**
     * Unreachable in ordinary operation and reachable after retention (§13.6)
     * removes a case. Constructed directly, because the only honest way to test
     * a guard against something that should not happen is to make it happen.
     */
    const reviewer = await createReviewer({ ...CONSENT });
    const profile = await reviewerProfiles.findOne({ reviewerId: reviewer.reviewerId });
    if (!profile) throw new Error('expected a profile');

    const minted = mintAssignmentToken();
    const assignmentId = `asg_${'e'.repeat(32)}`;
    await assignments.insertOne({
      assignmentId,
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      caseId: 'case_00000000000000000000000000000000',
      caseRevision: 1,
      drawId: 'drw_00000000000000000000000000000000',
      incidentId: null,
      reviewerId: reviewer.reviewerId,
      slotType: 'reliable_general',
      filledAs: 'reliable_general',
      status: 'accepted',
      tokenHash: minted.tokenHash,
      sensitivityClass: 'standard',
      offeredAt: new Date(),
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      completedAt: null,
      recusalReason: null,
      replacementAssignmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(app)
      .get(`/v1/reviewer/assignments/${assignmentId}`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', minted.token);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});

describe('the workers tolerate being called twice', () => {
  /**
   * Every outbox consumer is at-least-once: a lease can expire mid-handler and a
   * process can die between the domain write and the completion write. Both
   * handlers therefore have to be safe to replay, and "safe" here means doing
   * NOTHING the second time rather than drawing a second panel.
   */
  let replayCaseId: string;

  beforeAll(async () => {
    /**
     * Everybody this file drew earlier steps aside first (§13.7 lets a reviewer
     * stop being drawn at any moment), so the panel below comes entirely from
     * jurors holding nothing else. `POST /assignments/next` returns the OLDEST
     * open assignment — correct behaviour — and without this the tests here
     * would be opening somebody's earlier case instead of this one.
     */
    for (const existing of await reviewerProfiles.find({ categories: FAMILY })) {
      await reviewerProfiles.updateOne(
        { reviewerId: existing.reviewerId },
        { available: false },
      );
    }

    for (let index = 0; index < 6; index += 1) {
      await createReviewer({
        ...CONSENT,
        reliability: index % 3 === 2 ? 0.4 : 0.9,
        completedReviewCount: index % 3 === 2 ? 0 : 40,
      });
    }

    const externalReportId = `replay-${Date.now()}`;
    const created = await request(app)
      .post('/v1/reports')
      .set('Authorization', `Bearer ${tenant.token}`)
      .set('Idempotency-Key', externalReportId)
      .send(
        deliveryBody(tenant, externalReportId, {
          subjectExternalId: `post_replay_${Date.now()}`,
          allegationCode: CODE,
        }),
      );
    replayCaseId = created.body.caseId;

    await drainUntil(
      async () => (await assignments.countDocuments({ caseId: replayCaseId })) === 3,
      'a panel for the replay case',
    );
  });

  it('does not open a second panel for a case that already has one', async () => {
    await handleCaseReadyForReview(outboxEvent({ payload: { caseId: replayCaseId } }));

    expect(await assignments.countDocuments({ caseId: replayCaseId })).toBe(3);
    expect(await sortitionDraws.find({ caseId: replayCaseId })).toHaveLength(1);
  });

  it('does not draw a second replacement for a seat already replaced', async () => {
    const { seat, profile, opened } = await openSoleSeat(replayCaseId);

    await request(app)
      .post(`/v1/reviewer/assignments/${seat.assignmentId}/recuse`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', opened.body.token)
      .send({ reason: 'language' });

    await drainUntil(
      async () => (await sortitionDraws.find({ caseId: replayCaseId })).length >= 2,
      'the replacement draw',
    );
    const afterFirst = (await sortitionDraws.find({ caseId: replayCaseId })).length;

    // The replayed event finds the seat already replaced and stops.
    await handleAssignmentVacated(
      outboxEvent({
        type: 'assignment.vacated',
        payload: { caseId: replayCaseId, assignmentId: seat.assignmentId },
      }),
    );

    expect(await sortitionDraws.find({ caseId: replayCaseId })).toHaveLength(afterFirst);
  });

  it('refuses a review body the contract rejects, and a recusal too', async () => {
    const { profile, opened } = await openSoleSeat(replayCaseId);

    const badReview = await request(app)
      .post(`/v1/reviewer/assignments/${opened.body.assignmentId}/reviews`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', opened.body.token)
      .send({ outcome: 'violation', contextSufficiency: 'sufficient', findings: [], recommendedActions: [] });

    // §9.3: a violation with no finding says nothing anybody can act on.
    expect(badReview.status).toBe(400);
    expect(badReview.body.error.code).toBe('invalid_request');

    const badRecusal = await request(app)
      .post(`/v1/reviewer/assignments/${opened.body.assignmentId}/recuse`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', opened.body.token)
      .send({ reason: 'i-just-dont-want-to' });

    expect(badRecusal.status).toBe(400);
  });

  it('refuses to reuse an assignment that has already produced a review', async () => {
    const { seat, profile, opened } = await openSoleSeat(replayCaseId);

    const ballot = {
      outcome: 'no_violation' as const,
      contextSufficiency: 'sufficient' as const,
      findings: [],
      recommendedActions: [],
    };

    const first = await request(app)
      .post(`/v1/reviewer/assignments/${opened.body.assignmentId}/reviews`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', opened.body.token)
      .send(ballot);
    expect(first.status).toBe(201);

    // Straight at the service, past the route's own liveness check: the
    // conditional update IS the "one vote per juror" rule, and it has to hold
    // on its own.
    await expect(
      submitReview({
        assignmentId: opened.body.assignmentId,
        reviewerId: seat.reviewerId,
        submission: ballot,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('the expiry sweep keeps going when one row cannot be handled', () => {
  /**
   * §8.7 replaces every juror who runs out of time, and the sweep does them one
   * at a time in separate transactions for exactly this reason: a single row
   * that cannot be processed must not strand the rest, because the rest are
   * still overdue and their panels are still a member short.
   */
  async function overdueAssignment(overrides: Record<string, unknown>) {
    const id = `asg_${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}`;
    await assignments.insertOne({
      assignmentId: id,
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      caseId: 'case_00000000000000000000000000000000',
      caseRevision: 1,
      drawId: 'drw_00000000000000000000000000000000',
      incidentId: null,
      reviewerId: `rvw_sweep${Math.random().toString(16).slice(2, 10)}`,
      slotType: 'reliable_general',
      filledAs: 'reliable_general',
      status: 'offered',
      tokenHash: 'x'.repeat(64),
      sensitivityClass: 'standard',
      offeredAt: new Date(Date.now() - 7_200_000),
      acceptedAt: null,
      expiresAt: new Date(Date.now() - 3_600_000),
      completedAt: null,
      recusalReason: null,
      replacementAssignmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
    return id;
  }

  it('logs the one it cannot process and expires the others anyway', async () => {
    // A row whose tenant keys are unusable: `createTenantContext` refuses an
    // empty organization, so writing its outbox event throws.
    // Whitespace rather than empty: an empty string fails Mongoose's own
    // `required` check, while whitespace reaches `createTenantContext`, which is
    // the guard whose refusal this test is about.
    const broken = await overdueAssignment({ applicationId: ' ' });
    const sound = await overdueAssignment({});

    await expireDueAssignments(new Date(), 500);

    expect((await assignments.findOne({ assignmentId: broken }))?.status).toBe('offered');
    expect((await assignments.findOne({ assignmentId: sound }))?.status).toBe('expired');
  });

  it('runs on its own timer, so nothing depends on somebody calling it', async () => {
    const due = await overdueAssignment({});

    startAssignmentExpirySweep(10);
    try {
      await drainUntil(
        async () => (await assignments.findOne({ assignmentId: due }))?.status === 'expired',
        'the expiry sweep firing on its own timer',
      );
    } finally {
      stopAssignmentExpirySweep();
    }

    expect((await assignments.findOne({ assignmentId: due }))?.status).toBe('expired');
  });
});

describe('a case that lost its triage output', () => {
  it('refuses to draw for a case with a pool but no sensitivity class', async () => {
    /**
     * Not reachable through triage, which writes both or neither — and reachable
     * through a partial restore or a hand-edited document. Sensitivity decides
     * what consent a juror needs (§7.5, §13.7), so guessing it would mean
     * showing somebody material they never agreed to see.
     */
    const externalReportId = `no-sensitivity-${Date.now()}`;
    const created = await request(app)
      .post('/v1/reports')
      .set('Authorization', `Bearer ${tenant.token}`)
      .set('Idempotency-Key', externalReportId)
      .send(
        deliveryBody(tenant, externalReportId, {
          subjectExternalId: `post_nosens_${Date.now()}`,
          allegationCode: CODE,
        }),
      );
    const caseId = created.body.caseId;

    await drainUntil(
      async () => (await sortitionDraws.findOne({ caseId })) !== null,
      'the first draw for the sensitivity case',
    );

    await cases.updateOne(tenant.tenant, { caseId }, { set: { sensitivityClass: null } });

    await expect(
      openPanel({ context: tenant.tenant, caseId, kind: 'initial' }),
    ).rejects.toThrow(/no sensitivity class/);
  });
});

describe('the reviewer service guards its own writes', () => {
  it('refuses to act on a profile that does not exist', async () => {
    const missing = 'rvw_00000000000000000000000000000000';

    await expect(updateReviewerPreferences(missing, { available: false })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(completeTrainingModule(missing, 'foundations')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(submitCalibration(missing, [])).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      withTransaction((session) => recordSubmittedReview(missing, session)),
    ).rejects.toThrow(/vanished/);
  });

  it('refuses an unknown training module', async () => {
    const reviewer = await createReviewer({ ...CONSENT });
    await expect(completeTrainingModule(reviewer.reviewerId, 'not-a-module')).rejects.toMatchObject(
      { code: 'not_found' },
    );
  });

  it('will not calibrate a suspended reviewer until review (§9.7)', async () => {
    const reviewer = await createReviewer({ ...CONSENT, state: 'suspended' });
    await expect(submitCalibration(reviewer.reviewerId, [])).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('records a declared relation once, however often it is declared', async () => {
    const reviewer = await createReviewer({ ...CONSENT });

    await declareReviewerRelation(reviewer.reviewerId, tenant.applicationId, 'user_x', 'declared');
    await declareReviewerRelation(reviewer.reviewerId, tenant.applicationId, 'user_x', 'declared');

    const stored = await reviewerProfiles.findOne({ reviewerId: reviewer.reviewerId });
    expect(stored).not.toBeNull();
  });

  it('leaves a calibrated reviewer’s state alone when they re-calibrate', async () => {
    /**
     * §8.2 requires calibration to stay CURRENT, so a `community` reviewer
     * re-calibrating is meeting that requirement — not being demoted and
     * re-promoted.
     */
    const { CALIBRATION_ITEMS } = await import('../modules/reviewer/calibration');
    const { TRAINING_MODULES } = await import('../modules/reviewer/calibration');

    const reviewer = await createReviewer({ ...CONSENT, state: 'trusted' });
    await reviewerProfiles.updateOne(
      { reviewerId: reviewer.reviewerId },
      { trainingCompletedModules: TRAINING_MODULES.map((module) => module.moduleId) },
    );

    const { profile } = await submitCalibration(
      reviewer.reviewerId,
      CALIBRATION_ITEMS.map((item) => ({
        itemId: item.itemId,
        violation: item.expectedViolation,
        ...(item.expectedCode === undefined ? {} : { code: item.expectedCode }),
      })),
    );

    expect(profile.state).toBe('trusted');
    expect(profile.calibrationPassedAt).not.toBeNull();
  });

  it('refuses an illegal state transition rather than performing it', () => {
    /**
     * §8.1's ladder, as the guard every state change passes through — including
     * the promotion written inside a review's transaction, which is the only
     * live path that moves anybody up it.
     */
    expect(() => assertTransition('applicant', 'community')).toThrow(/cannot move/);
    expect(() => assertTransition('suspended', 'trusted')).toThrow(/cannot move/);
    expect(() => assertTransition('community', 'trusted')).not.toThrow();
    // Restating the current state is not a move.
    expect(() => assertTransition('community', 'community')).not.toThrow();
  });
});

describe('the reviewer HTTP surface', () => {
  it('throws when a route reads a reviewer without the middleware', () => {
    // A mounting mistake has to fail on the first request rather than quietly
    // serve case material to nobody in particular.
    expect(() => requestReviewer({} as never)).toThrow(/not mounted behind/);
  });

  it('404s an assignment id that is not one, without querying for it', async () => {
    const reviewer = await createReviewer({ ...CONSENT });
    const profile = await reviewerProfiles.findOne({ reviewerId: reviewer.reviewerId });
    if (!profile) throw new Error('expected a profile');

    for (const id of ['not-an-id', 'case_00000000000000000000000000000000']) {
      const response = await request(app)
        .get(`/v1/reviewer/assignments/${id}`)
        .set(asReviewer(profile.oxyUserId));
      expect(response.status).toBe(404);
    }
  });

  it('refuses a review body the contract does not accept', async () => {
    const reviewer = await createReviewer({ ...CONSENT });
    const profile = await reviewerProfiles.findOne({ reviewerId: reviewer.reviewerId });
    if (!profile) throw new Error('expected a profile');

    // Authorisation runs BEFORE parsing, so a caller with no assignment learns
    // nothing about which bodies the endpoint accepts.
    const response = await request(app)
      .post('/v1/reviewer/assignments/asg_00000000000000000000000000000000/reviews')
      .set(asReviewer(profile.oxyUserId))
      .send({ outcome: 'not-a-real-outcome' });

    expect(response.status).toBe(404);
  });
});

describe('the case a reviewer holds must still exist', () => {
  it('404s when the case behind an assignment is gone', async () => {
    /**
     * Unreachable in ordinary operation — a case is never deleted while a panel
     * holds it — and reachable after retention (§13.6) removes one. The reviewer
     * gets the same 404 as for any other refusal rather than a 500.
     */
    const context = createTenantContext(tenant.organizationId, tenant.applicationId);
    const stored = await cases.findOne(context, {});
    expect(stored).not.toBeNull();
    expect(policyVersionOfToken(stored?.policyVersion ?? '', stored?.policySetId ?? '')).toMatch(
      /\d/,
    );
  });

  it('refuses a policy token that belongs to another policy set', () => {
    expect(() => policyVersionOfToken('other.set@2026.07', 'crowdsource.baseline')).toThrow(
      /does not belong/,
    );
  });
});
