import { describe, expect, it } from 'vitest';

import { config } from '../config';
import {
  CALIBRATION_ITEMS,
  CALIBRATION_PASS_SCORE,
  CALIBRATION_VALID_DAYS,
  calibrationRecency,
  gradeCalibration,
  hasCompletedTraining,
  isCalibrationCurrent,
  TRAINING_MODULES,
} from '../modules/reviewer/calibration';
import {
  availabilityScore,
  eligibilityRejection,
  ELIGIBILITY_REJECTIONS,
  MAX_OPEN_ASSIGNMENTS,
  requiresAdultReviewer,
  SENSITIVE_EXPOSURE_MAX,
  type CaseEligibilityCriteria,
  type EligibilityRejection,
  type ExposureFacts,
} from '../modules/reviewer/eligibility';
import {
  personhoodConfidence,
  PERSONHOOD_WEIGHTS,
} from '../modules/reviewer/personhood';
import type { ReviewerProfileDocument } from '../modules/reviewer/reviewer.collection';
import { REVIEWER_STATES } from '@oxyhq/crowdsource-contracts';

import { canTransition, DRAWABLE_STATES } from '../modules/reviewer/reviewerState';

/**
 * §8.2's eligibility, §8.1's ladder and the personhood model — the part of this
 * phase that exists because Oxy's pool could not be inherited.
 *
 * The production check that forced this: zero accounts at `trusted`, zero at
 * `high_trust`, an eligible population of five internal accounts qualifying only
 * through `User.verified`, and twenty of twenty-one civic validation requests
 * expired with no vote ever cast. Every threshold below is chosen so that a real
 * person can actually cross it, and the tests say so in numbers rather than
 * leaving it to be discovered in production.
 */

const NOW = new Date('2026-07-01T12:00:00.000Z');

function profile(overrides: Partial<ReviewerProfileDocument> = {}): ReviewerProfileDocument {
  return {
    reviewerId: 'rvw_x',
    oxyUserId: 'oxy_x',
    state: 'community',
    accountActive: true,
    oxyAccountVerified: false,
    isAdult: true,
    suspectedSockPuppet: false,
    riskClusterId: null,
    languages: ['es'],
    categories: ['harassment'],
    specialistCategories: [],
    maxSensitivityRank: 0,
    consentedSensitiveCategories: [],
    declaredConflictApplications: [],
    rulesAcceptedAt: NOW,
    available: true,
    dailyReviewLimit: 20,
    trainingCompletedModules: TRAINING_MODULES.map((module) => module.moduleId),
    trainingCompletedAt: NOW,
    calibrationPassedAt: NOW,
    calibrationScore: 0.9,
    calibrationAttempts: 1,
    lastCalibrationAt: NOW,
    reliabilityByCategory: { harassment: 0.9 },
    completedReviewCount: 12,
    personhoodConfidence: 0.6,
    samplingKey: 0.5,
    principalLinks: [],
    suspendedUntil: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const CRITERIA: CaseEligibilityCriteria = {
  families: ['harassment'],
  language: 'es',
  sensitivity: 'standard',
  requiresAdult: false,
};

const IDLE: ExposureFacts = {
  openAssignments: 0,
  reviewsToday: 0,
  sensitiveReviewsInWindow: 0,
};

function reject(
  profileOverrides: Partial<ReviewerProfileDocument> = {},
  criteria: Partial<CaseEligibilityCriteria> = {},
  exposure: Partial<ExposureFacts> = {},
): EligibilityRejection | null {
  return eligibilityRejection(
    profile(profileOverrides),
    { ...CRITERIA, ...criteria },
    { ...IDLE, ...exposure },
    NOW,
  );
}

describe('personhood (§8.2)', () => {
  it('sums to exactly one across its signals', () => {
    const total = Object.values(PERSONHOOD_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  /**
   * The decision this phase exists to get right.
   *
   * Requiring Oxy verification would have produced a jury pool of six accounts —
   * the same closed door as the civic validator's empty `trusted` tier. So an
   * unverified person who trained and calibrated clears the default threshold,
   * and one who did neither does not and calibrates instead. That is §8.2's own
   * sentence, in numbers.
   */
  it('lets an UNVERIFIED person who trained and calibrated reach the threshold', () => {
    const score = personhoodConfidence({
      accountActive: true,
      oxyAccountVerified: false,
      trainingCompletedAt: NOW,
      calibrationPassedAt: NOW,
      suspectedSockPuppet: false,
    });

    expect(score).toBeCloseTo(0.6, 10);
    expect(score).toBeGreaterThanOrEqual(config.reviewer.minPersonhoodConfidence);
  });

  it('keeps a bare authenticated account below it', () => {
    const score = personhoodConfidence({
      accountActive: true,
      oxyAccountVerified: false,
      trainingCompletedAt: null,
      calibrationPassedAt: null,
      suspectedSockPuppet: false,
    });

    expect(score).toBeCloseTo(0.3, 10);
    expect(score).toBeLessThan(config.reviewer.minPersonhoodConfidence);
  });

  it('the configured default is one a real person can cross', () => {
    // A guard on the guard: if somebody raises the default past what training
    // plus calibration can reach, the product closes and this says so.
    expect(config.reviewer.minPersonhoodConfidence).toBeLessThanOrEqual(0.6);
  });

  it('zeroes a flagged or inactive account whatever else it carries', () => {
    const everything = {
      accountActive: true,
      oxyAccountVerified: true,
      trainingCompletedAt: NOW,
      calibrationPassedAt: NOW,
    };

    expect(personhoodConfidence({ ...everything, suspectedSockPuppet: true })).toBe(0);
    expect(
      personhoodConfidence({ ...everything, accountActive: false, suspectedSockPuppet: false }),
    ).toBe(0);
  });
});

describe('the onboarding ladder (§8.1)', () => {
  it('is the plan’s seven states', () => {
    expect([...REVIEWER_STATES]).toEqual([
      'applicant',
      'calibrating',
      'community',
      'trusted',
      'specialist',
      'appeals',
      'suspended',
    ]);
  });

  it('keeps applicants and calibrating reviewers off real cases', () => {
    expect([...DRAWABLE_STATES]).toEqual(['community', 'trusted', 'specialist', 'appeals']);
    expect(reject({ state: 'applicant' })).toBe('state_not_drawable');
    expect(reject({ state: 'calibrating' })).toBe('state_not_drawable');
    expect(reject({ state: 'suspended' })).toBe('state_not_drawable');
  });

  it('refuses to skip calibration on the way to deciding real cases', () => {
    expect(canTransition('applicant', 'community')).toBe(false);
    expect(canTransition('applicant', 'calibrating')).toBe(true);
    expect(canTransition('calibrating', 'community')).toBe(true);
  });

  it('lets a suspended reviewer return only through calibration (§9.7)', () => {
    expect(canTransition('suspended', 'community')).toBe(false);
    expect(canTransition('suspended', 'trusted')).toBe(false);
    expect(canTransition('suspended', 'calibrating')).toBe(true);
  });
});

describe('calibration (§8.2, §9.7)', () => {
  const correctAnswers = CALIBRATION_ITEMS.map((item) => ({
    itemId: item.itemId,
    violation: item.expectedViolation,
    ...(item.expectedCode === undefined ? {} : { code: item.expectedCode }),
  }));

  it('includes items that are NOT violations, so "yes" is not the answer', () => {
    const negatives = CALIBRATION_ITEMS.filter((item) => !item.expectedViolation);
    expect(negatives.length).toBeGreaterThanOrEqual(2);
    expect(negatives.length).toBeLessThan(CALIBRATION_ITEMS.length);
  });

  it('passes a reviewer who answered every item correctly', () => {
    const result = gradeCalibration(correctAnswers);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.incorrectItemIds).toEqual([]);
  });

  it('seeds per-family reliability only for families it actually tested', () => {
    const result = gradeCalibration(correctAnswers);
    expect(Object.keys(result.reliabilityByFamily).sort()).toEqual([
      'harassment',
      'hate',
      'integrity',
    ]);
    // No figure is invented for a family nobody measured.
    expect(result.reliabilityByFamily.child_safety).toBeUndefined();
  });

  it('counts an unanswered item as wrong rather than skipping it', () => {
    // Answering only the easy half would otherwise score 100%.
    const partial = correctAnswers.slice(0, 2);
    const result = gradeCalibration(partial);

    expect(result.score).toBeCloseTo(2 / CALIBRATION_ITEMS.length, 10);
    expect(result.passed).toBe(false);
    expect(result.incorrectItemIds).toHaveLength(CALIBRATION_ITEMS.length - 2);
  });

  it('marks the right classification with the wrong code as wrong (§9.2 step two)', () => {
    const violationItem = CALIBRATION_ITEMS.find((item) => item.expectedViolation);
    if (!violationItem) throw new Error('the set must contain a violation');

    const result = gradeCalibration(
      correctAnswers.map((answer) =>
        answer.itemId === violationItem.itemId
          ? { ...answer, code: 'other.unclassifiable' as const }
          : answer,
      ),
    );

    expect(result.incorrectItemIds).toContain(violationItem.itemId);
  });

  it('lets a reviewer be wrong twice and still pass', () => {
    const allowedWrong = Math.floor(CALIBRATION_ITEMS.length * (1 - CALIBRATION_PASS_SCORE));
    expect(allowedWrong).toBeGreaterThanOrEqual(2);
  });

  it('expires a calibration rather than dropping the reviewer', () => {
    const stale = new Date(NOW.getTime() - (CALIBRATION_VALID_DAYS + 1) * 86_400_000);
    expect(isCalibrationCurrent(stale, NOW)).toBe(false);
    expect(reject({ calibrationPassedAt: stale })).toBe('calibration_expired');
  });

  it('decays recency smoothly instead of falling off a cliff', () => {
    const day = 86_400_000;
    expect(calibrationRecency(NOW, NOW)).toBe(1);
    expect(calibrationRecency(new Date(NOW.getTime() - 20 * day), NOW)).toBe(1);

    const midway = calibrationRecency(new Date(NOW.getTime() - 105 * day), NOW);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(1);

    expect(calibrationRecency(new Date(NOW.getTime() - 400 * day), NOW)).toBe(0);
    expect(calibrationRecency(null, NOW)).toBe(0);
  });

  it('opens calibration only once every module is done', () => {
    expect(hasCompletedTraining([])).toBe(false);
    expect(hasCompletedTraining(TRAINING_MODULES.slice(0, 2).map((m) => m.moduleId))).toBe(false);
    expect(hasCompletedTraining(TRAINING_MODULES.map((m) => m.moduleId))).toBe(true);
  });
});

describe('the eligibility predicate (§8.2)', () => {
  it('accepts an ordinary calibrated community reviewer', () => {
    expect(reject()).toBeNull();
  });

  it('requires every alleged family, not merely one of them', () => {
    /**
     * A case with nine spam allegations and one child-safety allegation IS a
     * child-safety case (see `triage.ts`), and somebody who signed up for spam
     * has not agreed to see the rest of it.
     */
    expect(reject({ categories: ['integrity'] }, { families: ['integrity', 'child_safety'] })).toBe(
      'category_not_accepted',
    );
    expect(
      reject(
        { categories: ['integrity', 'child_safety'] },
        { families: ['integrity', 'child_safety'] },
      ),
    ).toBeNull();
  });

  it('requires the case language, and skips the check when none is declared', () => {
    expect(reject({ languages: ['en'] })).toBe('language_mismatch');
    // A resource with no language tag must not exclude the whole population.
    expect(reject({ languages: ['en'] }, { language: null })).toBeNull();
  });

  it('holds sensitive material behind BOTH a class ceiling and a per-family consent (§13.7)', () => {
    expect(reject({}, { sensitivity: 'sensitive' })).toBe('sensitivity_above_consent');

    expect(reject({ maxSensitivityRank: 1 }, { sensitivity: 'sensitive' })).toBe(
      'category_consent_missing',
    );

    expect(
      reject(
        { maxSensitivityRank: 1, consentedSensitiveCategories: ['harassment'] },
        { sensitivity: 'sensitive' },
      ),
    ).toBeNull();
  });

  it('requires an adult attestation for adult-only families (§7.5 row 5)', () => {
    expect(requiresAdultReviewer(['sexual_content'])).toBe(true);
    expect(requiresAdultReviewer(['harassment'])).toBe(false);
    expect(reject({ isAdult: false }, { requiresAdult: true })).toBe('adult_attestation_missing');
  });

  it('honours availability, suspension and sock-puppet signals', () => {
    expect(reject({ available: false })).toBe('unavailable');
    expect(reject({ accountActive: false })).toBe('account_inactive');
    expect(reject({ suspectedSockPuppet: true })).toBe('sock_puppet_signal');
    expect(reject({ suspendedUntil: new Date(NOW.getTime() + 86_400_000) })).toBe('suspended');
    // A suspension that has run out is not a suspension.
    expect(reject({ suspendedUntil: new Date(NOW.getTime() - 86_400_000) })).toBeNull();
  });

  it('respects §13.7’s exposure limits', () => {
    expect(reject({}, {}, { openAssignments: MAX_OPEN_ASSIGNMENTS })).toBe(
      'open_assignment_limit',
    );
    expect(reject({ dailyReviewLimit: 5 }, {}, { reviewsToday: 5 })).toBe('daily_limit_reached');
  });

  it('rests a reviewer from SENSITIVE work only, never from everything (§13.7)', () => {
    /**
     * A mandatory pause that removed somebody from all work would make looking
     * after yourself cost you your place in the pool — the incentive §13.7
     * exists to prevent.
     */
    const heavilyExposed = { sensitiveReviewsInWindow: SENSITIVE_EXPOSURE_MAX };

    expect(
      reject(
        { maxSensitivityRank: 1, consentedSensitiveCategories: ['harassment'] },
        { sensitivity: 'sensitive' },
        heavilyExposed,
      ),
    ).toBe('sensitive_exposure_rest');

    expect(reject({}, { sensitivity: 'standard' }, heavilyExposed)).toBeNull();
  });

  it('refuses below the personhood threshold', () => {
    expect(reject({ personhoodConfidence: 0.3 })).toBe('personhood_below_threshold');
  });

  it('every declared rejection reason is reachable', () => {
    /**
     * The vacuity floor. A reason nobody can produce is either dead vocabulary
     * or — worse — a check that silently never fires.
     */
    const produced = new Set<EligibilityRejection>(
      [
        reject({ accountActive: false }),
        reject({ state: 'applicant' }),
        reject({ suspendedUntil: new Date(NOW.getTime() + 86_400_000) }),
        reject({ available: false }),
        reject({ personhoodConfidence: 0 }),
        reject({ rulesAcceptedAt: null }),
        reject({ calibrationPassedAt: null }),
        reject({ categories: [] }),
        reject({ languages: ['de'] }),
        reject({}, { sensitivity: 'restricted' }),
        reject({ maxSensitivityRank: 2 }, { sensitivity: 'restricted' }),
        reject({ isAdult: false }, { requiresAdult: true }),
        reject({ suspectedSockPuppet: true }),
        reject({ dailyReviewLimit: 1 }, {}, { reviewsToday: 1 }),
        reject({}, {}, { openAssignments: MAX_OPEN_ASSIGNMENTS }),
        reject(
          { maxSensitivityRank: 1, consentedSensitiveCategories: ['harassment'] },
          { sensitivity: 'sensitive' },
          { sensitiveReviewsInWindow: SENSITIVE_EXPOSURE_MAX },
        ),
      ].filter((reason): reason is EligibilityRejection => reason !== null),
    );

    expect([...produced].sort()).toEqual([...ELIGIBILITY_REJECTIONS].sort());
  });
});

describe('availability (§8.4, §13.7)', () => {
  it('is the smaller of the daily and open-case headrooms', () => {
    expect(availabilityScore(profile({ dailyReviewLimit: 10 }), IDLE)).toBe(1);

    expect(
      availabilityScore(profile({ dailyReviewLimit: 10 }), { ...IDLE, reviewsToday: 5 }),
    ).toBe(0.5);

    // Two of three open cases caps it below the daily headroom.
    expect(
      availabilityScore(profile({ dailyReviewLimit: 10 }), { ...IDLE, openAssignments: 2 }),
    ).toBeCloseTo(1 / 3, 2);
  });

  it('never goes negative for somebody over their own limit', () => {
    expect(
      availabilityScore(profile({ dailyReviewLimit: 3 }), { ...IDLE, reviewsToday: 9 }),
    ).toBe(0);
  });
});
