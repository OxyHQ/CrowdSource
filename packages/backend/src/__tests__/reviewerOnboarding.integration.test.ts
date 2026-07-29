import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubOxySession } from './support/reviewers';

/**
 * §8.1's onboarding, end to end through the reviewer API.
 *
 * The route a real person takes: authenticate, land as an `applicant`, set
 * preferences and consent, work through training, calibrate, and only then
 * become drawable. Every gate is exercised in the order somebody would meet it,
 * because the failure this phase exists to avoid is a ladder whose lower rungs
 * nobody can actually climb.
 *
 * `personhoodConfidence` is checked at each step against what the rules say it
 * should be. It is a stored, denormalised value, and a denormalised eligibility
 * number nobody verifies is one that eventually decides who judges for a reason
 * nobody can state.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { CALIBRATION_ITEMS, TRAINING_MODULES } = await import('../modules/reviewer/calibration');
const { personhoodConfidence } = await import('../modules/reviewer/personhood');
const { reviewerProfiles } = await import('../modules/reviewer/reviewer.collection');
const { promotionFor, PROMOTION } = await import('../modules/reviewer/reviewer.service');
const { startDatabase, stopDatabase } = await import('./support/tenants');

const app = createApp();

function asReviewer(oxyUserId: string, verified = false) {
  return {
    'x-test-oxy-user': oxyUserId,
    ...(verified ? { 'x-test-oxy-verified': 'true' } : {}),
  };
}

function newOxyUserId(): string {
  return `oxy_onboarding_${randomUUID().replace(/-/g, '')}`;
}

/**
 * The family this suite's reviewers accept.
 *
 * Reviewer profiles are global — a reviewer belongs to no tenant — so anyone who
 * completes onboarding here becomes a candidate for every case in the database,
 * including other suites' running concurrently against the same replica set.
 * `privacy` is a family no test case alleges, and §8.2 requires a reviewer to
 * accept EVERY family a case alleges, so these reviewers can never be drawn.
 * The isolation is the product's own eligibility rule, not a fixture trick.
 */
const FAMILY = 'privacy' as const;

const CORRECT_ANSWERS = CALIBRATION_ITEMS.map((item) => ({
  itemId: item.itemId,
  violation: item.expectedViolation,
  ...(item.expectedCode === undefined ? {} : { code: item.expectedCode }),
}));

beforeAll(async () => {
  await startDatabase();
}, 120_000);

afterAll(async () => {
  await stopDatabase();
});

describe('the first request creates the profile (§8.1)', () => {
  it('lands a new person as an applicant, with no separate registration step', async () => {
    const oxyUserId = newOxyUserId();
    const response = await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    expect(response.status).toBe(200);
    expect(response.body.state).toBe('applicant');
    expect(response.body.reviewerId).toMatch(/^rvw_/);
    expect(response.body.preferences.categories).toEqual([]);
    // Consent starts at the safe end: standard material only, no families, and
    // no acceptance of the reviewing rules until this person gives it.
    expect(response.body.consent.maxSensitivity).toBe('standard');
    expect(response.body.consent.sensitiveCategories).toEqual([]);
    expect(response.body.consent.ageConfirmed).toBe(false);
    expect(response.body.consent.rulesAcceptedAt).toBeNull();
  });

  it('names the eligibility a new applicant has not met yet (§8.2)', async () => {
    /**
     * The list is what lets the app say WHY the button is unavailable instead of
     * letting somebody press it and receive a refusal with no explanation. Every
     * entry has to be a check the server actually performs, so an applicant who
     * has done nothing must show every acquirable one unmet.
     */
    const response = await request(app)
      .get('/v1/reviewer/profile')
      .set(asReviewer(newOxyUserId()));

    const unmet = response.body.eligibility
      .filter((requirement: { met: boolean }) => !requirement.met)
      .map((requirement: { id: string }) => requirement.id)
      .sort();

    expect(unmet).toEqual([
      'age',
      'calibration_current',
      'categories_selected',
      'languages_selected',
      'personhood',
      'rules_accepted',
      'training_current',
    ]);
    // The account is the one thing they arrived with.
    expect(response.body.eligibility).toContainEqual({ id: 'oxy_account', met: true });
  });

  it('is idempotent — a second request is the same reviewer, not a second one', async () => {
    const oxyUserId = newOxyUserId();
    const first = await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));
    const second = await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    expect(second.body.reviewerId).toBe(first.body.reviewerId);
    expect(await reviewerProfiles.countDocuments({ oxyUserId })).toBe(1);
  });

  it('never returns the Oxy user id, so a reviewer id stays unusable elsewhere (§8.7)', async () => {
    const oxyUserId = newOxyUserId();
    const response = await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    expect(JSON.stringify(response.body)).not.toContain(oxyUserId);
  });

  it('does not leak the sampling key, which is how the draw windows the pool', async () => {
    const response = await request(app).get('/v1/reviewer/profile').set(asReviewer(newOxyUserId()));
    expect(response.body.samplingKey).toBeUndefined();
    expect(response.body.riskClusterId).toBeUndefined();
    expect(response.body.suspectedSockPuppet).toBeUndefined();
    expect(response.body.personhoodConfidence).toBeUndefined();
  });

  it('refuses without a session', async () => {
    const response = await request(app).get('/v1/reviewer/profile');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('tracks the Oxy verification flag as it changes', async () => {
    /**
     * The number is asserted against the DOCUMENT and the gate against the API,
     * because the projection does not publish `personhoodConfidence`: what a
     * reviewer needs is whether they clear the threshold, and a bare score
     * invites them to optimise a figure whose inputs they cannot see. Checking
     * both keeps the stored value honest AND the disclosure minimal.
     */
    const oxyUserId = newOxyUserId();

    async function personhoodMet(verified: boolean): Promise<boolean> {
      const response = await request(app)
        .get('/v1/reviewer/profile')
        .set(asReviewer(oxyUserId, verified));
      expect(response.body.personhoodConfidence).toBeUndefined();
      return response.body.eligibility.some(
        (requirement: { id: string; met: boolean }) =>
          requirement.id === 'personhood' && requirement.met,
      );
    }

    expect(await personhoodMet(false)).toBe(false);
    expect((await reviewerProfiles.findOne({ oxyUserId }))?.personhoodConfidence).toBe(0.3);

    expect(await personhoodMet(true)).toBe(true);
    expect((await reviewerProfiles.findOne({ oxyUserId }))?.personhoodConfidence).toBe(0.7);

    // And back down again: losing verification must lower the score without
    // waiting for the reviewer to edit something.
    expect(await personhoodMet(false)).toBe(false);
    expect((await reviewerProfiles.findOne({ oxyUserId }))?.personhoodConfidence).toBe(0.3);
  });
});

describe('preferences and consent (§13.7)', () => {
  it('records languages, categories and availability', async () => {
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    const response = await request(app)
      .post('/v1/reviewer/preferences')
      .set(asReviewer(oxyUserId))
      .send({ languages: ['es', 'en'], categories: [FAMILY], dailyReviewLimit: 8 });

    expect(response.status).toBe(200);
    expect(response.body.preferences.languages).toEqual(['es', 'en']);
    expect(response.body.preferences.categories).toEqual([FAMILY]);
    expect(response.body.preferences.dailyLimit).toBe(8);
    // §13.7's exposure travels with the profile, so a screen showing the limit
    // can show what is left of it without a second request.
    expect(response.body.exposure).toEqual({
      reviewedToday: 0,
      dailyLimit: 8,
      openAssignments: 0,
      maxOpenAssignments: 3,
      breakRequiredUntil: null,
    });
  });

  it('records acceptance of the reviewing rules once, and never moves it (§13.7)', async () => {
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    const accepted = await request(app)
      .post('/v1/reviewer/preferences')
      .set(asReviewer(oxyUserId))
      .send({ rulesAccepted: true });

    expect(accepted.status).toBe(200);
    const acceptedAt = accepted.body.consent.rulesAcceptedAt;
    expect(typeof acceptedAt).toBe('string');

    const again = await request(app)
      .post('/v1/reviewer/preferences')
      .set(asReviewer(oxyUserId))
      .send({ rulesAccepted: true });

    // A second acceptance is not a second consent, and overwriting the instant
    // would lose the moment an audit needs.
    expect(again.body.consent.rulesAcceptedAt).toBe(acceptedAt);
  });

  it('refuses an attempt to UN-accept the rules', async () => {
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    const response = await request(app)
      .post('/v1/reviewer/preferences')
      .set(asReviewer(oxyUserId))
      .send({ rulesAccepted: false });

    expect(response.status).toBe(400);
  });

  it('lets consent be WITHDRAWN, not only added', async () => {
    /**
     * §13.7 requires consent to be revocable at any moment, which is why every
     * consent field is replaced wholesale rather than merged. An additive merge
     * would make withdrawal impossible to express.
     */
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    await request(app)
      .post('/v1/reviewer/preferences')
      .set(asReviewer(oxyUserId))
      .send({
        isAdult: true,
        maxSensitivity: 'sensitive',
        consentedSensitiveCategories: ['violence', 'harassment'],
      });

    const withdrawn = await request(app)
      .post('/v1/reviewer/preferences')
      .set(asReviewer(oxyUserId))
      .send({ consentedSensitiveCategories: ['harassment'], maxSensitivity: 'standard' });

    expect(withdrawn.body.consent.sensitiveCategories).toEqual(['harassment']);
    expect(withdrawn.body.consent.maxSensitivity).toBe('standard');
  });

  it('refuses adult-category consent from a profile that has not attested adulthood', async () => {
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    const response = await request(app)
      .post('/v1/reviewer/preferences')
      .set(asReviewer(oxyUserId))
      .send({ maxSensitivity: 'sensitive', consentedSensitiveCategories: ['sexual_content'] });

    // Refused rather than silently dropped: a reviewer who believes they
    // consented and was ignored has no way to find out.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('refuses a field the schema does not know, so nothing can be mass-assigned', async () => {
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    for (const forbidden of [
      { state: 'trusted' },
      { personhoodConfidence: 1 },
      { reliabilityByCategory: { harassment: 1 } },
      { completedReviewCount: 500 },
      { samplingKey: 0.1 },
    ]) {
      const response = await request(app)
        .post('/v1/reviewer/preferences')
        .set(asReviewer(oxyUserId))
        .send(forbidden);
      expect(response.status).toBe(400);
    }

    const profile = await reviewerProfiles.findOne({ oxyUserId });
    expect(profile?.state).toBe('applicant');
    expect(profile?.completedReviewCount).toBe(0);
    expect(profile?.personhoodConfidence).toBe(0.3);
  });

  it('caps the daily review limit (§13.7)', async () => {
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    const response = await request(app)
      .post('/v1/reviewer/preferences')
      .set(asReviewer(oxyUserId))
      .send({ dailyReviewLimit: 500 });

    expect(response.status).toBe(400);
  });
});

describe('training and calibration (§8.1, §9.7)', () => {
  async function trainedReviewer(): Promise<string> {
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));
    await request(app)
      .post('/v1/reviewer/preferences')
      .set(asReviewer(oxyUserId))
      .send({ rulesAccepted: true, languages: ['es'], categories: [FAMILY] });

    for (const module of TRAINING_MODULES) {
      const response = await request(app)
        .post(`/v1/reviewer/training/${module.moduleId}/complete`)
        .set(asReviewer(oxyUserId));
      expect(response.status).toBe(200);
    }
    return oxyUserId;
  }

  it('keeps calibration shut until every module is complete', async () => {
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    const before = await request(app).get('/v1/reviewer/training').set(asReviewer(oxyUserId));
    expect(before.body.calibrationOpen).toBe(false);
    expect(before.body.calibrationItems).toEqual([]);

    const refused = await request(app)
      .post('/v1/reviewer/training/calibration')
      .set(asReviewer(oxyUserId))
      .send({ answers: CORRECT_ANSWERS });

    expect(refused.status).toBe(403);
  });

  it('never hands back the answer key', async () => {
    const oxyUserId = await trainedReviewer();
    const view = await request(app).get('/v1/reviewer/training').set(asReviewer(oxyUserId));

    expect(view.body.calibrationOpen).toBe(true);
    expect(view.body.calibrationItems).toHaveLength(CALIBRATION_ITEMS.length);
    for (const item of view.body.calibrationItems) {
      expect(Object.keys(item).sort()).toEqual(['itemId', 'text']);
    }
  });

  it('moves an applicant to calibrating once trained and configured', async () => {
    const oxyUserId = await trainedReviewer();
    const profile = await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));
    expect(profile.body.state).toBe('calibrating');
  });

  it('promotes to community on a pass, and seeds per-family reliability', async () => {
    const oxyUserId = await trainedReviewer();

    const response = await request(app)
      .post('/v1/reviewer/training/calibration')
      .set(asReviewer(oxyUserId))
      .send({ answers: CORRECT_ANSWERS });

    expect(response.status).toBe(200);
    expect(response.body.passed).toBe(true);
    expect(response.body.state).toBe('community');

    const profile = await reviewerProfiles.findOne({ oxyUserId });
    expect(profile?.reliabilityByCategory.harassment).toBe(1);
    // §8.2's threshold, reached WITHOUT Oxy verification.
    expect(profile?.personhoodConfidence).toBe(0.6);
  });

  it('keeps a failing reviewer in calibrating, without punishing them (§9.7)', async () => {
    const oxyUserId = await trainedReviewer();

    const wrong = CORRECT_ANSWERS.map((answer) => ({ ...answer, violation: !answer.violation }));
    const response = await request(app)
      .post('/v1/reviewer/training/calibration')
      .set(asReviewer(oxyUserId))
      .send({ answers: wrong });

    expect(response.status).toBe(200);
    expect(response.body.passed).toBe(false);
    expect(response.body.state).toBe('calibrating');
    expect(response.body.incorrectItemIds.length).toBeGreaterThan(0);

    const profile = await reviewerProfiles.findOne({ oxyUserId });
    // Attempted and scored, but no reliability written and no suspension: being
    // wrong in calibration is what calibration is for.
    expect(profile?.calibrationAttempts).toBe(1);
    expect(profile?.calibrationPassedAt).toBeNull();
    expect(profile?.reliabilityByCategory).toEqual({});
    expect(profile?.suspendedUntil).toBeNull();

    // And they may try again.
    const retry = await request(app)
      .post('/v1/reviewer/training/calibration')
      .set(asReviewer(oxyUserId))
      .send({ answers: CORRECT_ANSWERS });
    expect(retry.body.passed).toBe(true);
  });

  it('refuses an answer to an item that is not in the set', async () => {
    const oxyUserId = await trainedReviewer();
    const response = await request(app)
      .post('/v1/reviewer/training/calibration')
      .set(asReviewer(oxyUserId))
      .send({ answers: [{ itemId: 'cal_invented', violation: true }] });

    expect(response.status).toBe(400);
  });

  it('404s an unknown training module', async () => {
    const oxyUserId = newOxyUserId();
    await request(app).get('/v1/reviewer/profile').set(asReviewer(oxyUserId));

    const response = await request(app)
      .post('/v1/reviewer/training/not-a-module/complete')
      .set(asReviewer(oxyUserId));

    expect(response.status).toBe(404);
  });
});

describe('the stored personhood score is always the derived one', () => {
  /**
   * `personhoodConfidence` is denormalised so the eligibility query can filter on
   * it. That is only safe while the stored value equals what the rules produce
   * from the stored signals — otherwise it becomes a second, silently divergent
   * definition of who may judge.
   */
  it('holds for every profile this suite created', async () => {
    const profiles = await reviewerProfiles.find({ oxyUserId: /^oxy_onboarding_/ });
    expect(profiles.length).toBeGreaterThan(5);

    for (const profile of profiles) {
      expect(profile.personhoodConfidence, profile.reviewerId).toBe(
        personhoodConfidence({
          accountActive: profile.accountActive,
          oxyAccountVerified: profile.oxyAccountVerified,
          trainingCompletedAt: profile.trainingCompletedAt,
          calibrationPassedAt: profile.calibrationPassedAt,
          suspectedSockPuppet: profile.suspectedSockPuppet,
        }),
      );
    }
  });
});

describe('promotion (§8.1)', () => {
  /**
   * Exercised against the pure function rather than by submitting fifty real
   * reviews: the interesting cases are the boundaries, and reaching them through
   * the HTTP surface would prove nothing extra while taking a minute.
   */
  const base = {
    reviewerId: 'rvw_p',
    oxyUserId: 'oxy_p',
    accountActive: true,
    oxyAccountVerified: false,
    isAdult: true,
    suspectedSockPuppet: false,
    riskClusterId: null,
    languages: ['es'],
    categories: ['harassment' as const],
    specialistCategories: [],
    maxSensitivityRank: 0,
    consentedSensitiveCategories: [],
    declaredConflictApplications: [],
    rulesAcceptedAt: new Date(),
    available: true,
    dailyReviewLimit: 20,
    trainingCompletedModules: [],
    trainingCompletedAt: new Date(),
    calibrationPassedAt: new Date(),
    calibrationScore: 0.9,
    calibrationAttempts: 1,
    lastCalibrationAt: new Date(),
    completedReviewCount: 0,
    personhoodConfidence: 0.6,
    samplingKey: 0.5,
    principalLinks: [],
    suspendedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('needs BOTH volume and measured reliability to reach trusted', () => {
    expect(
      promotionFor({
        ...base,
        state: 'community',
        completedReviewCount: PROMOTION.trustedMinReviews,
        reliabilityByCategory: { harassment: 0.5 },
      }),
    ).toBeNull();

    expect(
      promotionFor({
        ...base,
        state: 'community',
        completedReviewCount: PROMOTION.trustedMinReviews - 1,
        reliabilityByCategory: { harassment: 0.95 },
      }),
    ).toBeNull();

    expect(
      promotionFor({
        ...base,
        state: 'community',
        completedReviewCount: PROMOTION.trustedMinReviews,
        reliabilityByCategory: { harassment: 0.95 },
      }),
    ).toMatchObject({ state: 'trusted' });
  });

  it('makes a specialist in the families they are actually reliable in', () => {
    const promotion = promotionFor({
      ...base,
      state: 'trusted',
      completedReviewCount: PROMOTION.specialistMinReviews,
      reliabilityByCategory: { harassment: 0.95, integrity: 0.6 },
    });

    expect(promotion?.state).toBe('specialist');
    expect(promotion?.specialistCategories).toEqual(['harassment']);
  });

  it('never promotes an applicant, a calibrating or a suspended reviewer', () => {
    for (const state of ['applicant', 'calibrating', 'suspended'] as const) {
      expect(
        promotionFor({
          ...base,
          state,
          completedReviewCount: 10_000,
          reliabilityByCategory: { harassment: 1 },
        }),
      ).toBeNull();
    }
  });

  it('§8.1: a specialist who has judged enough becomes an appeals reviewer', () => {
    /**
     * The top of §8.1's ladder, and the state that makes an appeal panel's
     * `appeals_reviewer` slot fillable by somebody rather than always by its
     * fallback. `canTransition` has allowed `specialist → appeals` since phase 3;
     * nothing produced the transition until appeals existed.
     */
    const promotion = promotionFor({
      ...base,
      state: 'specialist',
      specialistCategories: ['harassment'],
      completedReviewCount: PROMOTION.appealsMinReviews,
      reliabilityByCategory: { harassment: 0.95 },
    });

    expect(promotion?.state).toBe('appeals');
    // §7.5 still needs the family competence, so the specialisms travel with them.
    expect(promotion?.specialistCategories).toEqual(['harassment']);
  });

  it('needs the volume AND the reliability for the appeals state too', () => {
    expect(
      promotionFor({
        ...base,
        state: 'specialist',
        completedReviewCount: PROMOTION.appealsMinReviews - 1,
        reliabilityByCategory: { harassment: 0.95 },
      }),
    ).toBeNull();

    expect(
      promotionFor({
        ...base,
        state: 'specialist',
        completedReviewCount: PROMOTION.appealsMinReviews,
        reliabilityByCategory: { harassment: 0.8 },
      }),
    ).toBeNull();
  });

  it('never promotes past the top of the ladder', () => {
    expect(
      promotionFor({
        ...base,
        state: 'appeals',
        completedReviewCount: 10_000,
        reliabilityByCategory: { harassment: 1 },
      }),
    ).toBeNull();
  });
});
