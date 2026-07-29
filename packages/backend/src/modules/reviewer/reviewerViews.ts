import {
  REVIEWER_SENSITIVITY_CLASSES,
  type ReviewerCategoryStanding,
  type ReviewerEligibilityRequirement,
  type ReviewerProfileView,
  type ReviewerSensitivityClass,
  type ReviewerTrainingView,
  type TaxonomyFamily,
} from '@oxyhq/crowdsource-contracts';

import {
  CALIBRATION_PASS_SCORE,
  CALIBRATION_VALID_DAYS,
  hasCompletedTraining,
  isCalibrationCurrent,
  CALIBRATION_ITEMS,
  TRAINING_MODULES,
} from './calibration';
import { MAX_OPEN_ASSIGNMENTS } from './eligibility';
import { meetsPersonhoodThreshold } from './personhood';
import type { ReviewerProfileDocument } from './reviewer.collection';
import type { ReviewerExposure } from '../sortition/exposure';

/**
 * What a reviewer may see about themselves (§10.3, §4.1's Fiabilidad and
 * Bienestar screens).
 *
 * Pure functions over a document. That is deliberate and it is what lets the
 * §9.1 decisions in here be tested without a database, a request or a draw — the
 * interesting assertions are all about what is ABSENT, and an absence is only
 * worth asserting if the assertion is cheap enough to keep.
 *
 * ## The omissions, and why each one
 *
 * The projection is an allowlist, so every field of the document that is not
 * named below is withheld. Four of those are withheld on purpose rather than by
 * accident:
 *
 *  - `oxyUserId` — §8.7 keeps the Oxy identity and the reviewer id apart, and
 *    handing a screen both of them joins them back together.
 *  - `samplingKey` — this is the key `candidatePool.ts` scans a random window of.
 *    Publishing it would let somebody reason about when they are likely to be
 *    considered, and a draw whose timing can be predicted is a draw that can be
 *    waited for.
 *  - `riskClusterId` and `suspectedSockPuppet` — anti-abuse signals. Telling
 *    somebody they are flagged tells them what to change.
 *
 * `personhoodConfidence` is not published either, though it is not secret: what a
 * reviewer needs is whether they clear the threshold (`personhood` below), and a
 * bare number invites them to optimise a figure whose inputs they cannot see.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The consentable class this reviewer's stored rank names.
 *
 * The rank is what the eligibility query compares (a `$gte` on a number), and the
 * name is what a screen can show. `REVIEWER_SENSITIVITY_CLASSES` is indexed
 * rather than mapped through a second table so the two orderings cannot diverge;
 * an out-of-range rank falls back to `standard`, because the honest reading of a
 * corrupt consent field is the most restrictive one, never the most permissive.
 */
function sensitivityOfRank(rank: number): ReviewerSensitivityClass {
  return REVIEWER_SENSITIVITY_CLASSES[rank] ?? 'standard';
}

/**
 * §8.2's eligibility, restricted to what is both answerable and disclosable.
 *
 * Answerable: every entry is a property of the PERSON. §8.2's conflict, prior
 * participation and coordination-cluster conditions are properties of a candidate
 * against a specific case's parties — `sortition/exclusions.ts` owns those, and
 * outside a draw there is nothing to compare against.
 *
 * Disclosable: the sock-puppet suspicion is not here, for the same reason it is
 * not in the projection at all.
 *
 * Each `met` is computed from the same predicate the draw uses, never from a
 * parallel rule — `meetsPersonhoodThreshold`, `hasCompletedTraining` and
 * `isCalibrationCurrent` are the functions `eligibilityRejection` calls. A second
 * copy of "is this person eligible" that only the UI reads is a copy that will
 * eventually promise something the draw refuses.
 */
function eligibilityOf(
  profile: ReviewerProfileDocument,
  now: Date,
): ReviewerEligibilityRequirement[] {
  return [
    { id: 'oxy_account', met: profile.accountActive },
    { id: 'personhood', met: meetsPersonhoodThreshold(profile.personhoodConfidence) },
    { id: 'age', met: profile.isAdult },
    { id: 'rules_accepted', met: profile.rulesAcceptedAt !== null },
    { id: 'languages_selected', met: profile.languages.length > 0 },
    { id: 'categories_selected', met: profile.categories.length > 0 },
    { id: 'training_current', met: hasCompletedTraining(profile.trainingCompletedModules) },
    { id: 'calibration_current', met: isCalibrationCurrent(profile.calibrationPassedAt, now) },
  ];
}

/**
 * §4.1's per-category standings — the reviewer's OWN measured reliability.
 *
 * Drawn from the categories they accept rather than from the reliability map's
 * keys, so a category they have selected but never been calibrated in appears at
 * zero instead of vanishing. A missing row reads as "no data yet" only if you
 * already know the row should be there; an explicit zero says it.
 */
function standingsOf(profile: ReviewerProfileDocument): ReviewerCategoryStanding[] {
  const specialisms = new Set<TaxonomyFamily>(profile.specialistCategories);
  return profile.categories.map((category) => ({
    category,
    reliability: profile.reliabilityByCategory[category] ?? 0,
    specialist: specialisms.has(category),
  }));
}

/** §10.3's `GET /v1/reviewer/profile`. */
export function reviewerProfileView(
  profile: ReviewerProfileDocument,
  exposure: ReviewerExposure,
  now: Date,
): ReviewerProfileView {
  return {
    reviewerId: profile.reviewerId,
    state: profile.state,
    eligibility: eligibilityOf(profile, now),
    standings: standingsOf(profile),
    completedReviewCount: profile.completedReviewCount,
    preferences: {
      languages: [...profile.languages],
      categories: [...profile.categories],
      dailyLimit: profile.dailyReviewLimit,
      availableForAssignment: profile.available,
    },
    consent: {
      rulesAcceptedAt: profile.rulesAcceptedAt?.toISOString() ?? null,
      ageConfirmed: profile.isAdult,
      maxSensitivity: sensitivityOfRank(profile.maxSensitivityRank),
      sensitiveCategories: [...profile.consentedSensitiveCategories],
    },
    exposure: {
      reviewedToday: exposure.facts.reviewsToday,
      dailyLimit: profile.dailyReviewLimit,
      openAssignments: exposure.facts.openAssignments,
      maxOpenAssignments: MAX_OPEN_ASSIGNMENTS,
      breakRequiredUntil: exposure.breakRequiredUntil?.toISOString() ?? null,
    },
  };
}

/**
 * §10.3's `GET /v1/reviewer/training`.
 *
 * `calibrationItems` carries `itemId` and `text` and nothing else. Returning
 * `expectedViolation` or `expectedCode` would hand every reviewer the answer key,
 * and a calibration everybody passes measures nothing — which is the same failure
 * as a gate nobody passes, in the other direction.
 *
 * The items are withheld entirely until training is complete, because §9.7 asks
 * us to tell a reasonable error from random answering and a reviewer who was
 * never taught the taxonomy makes the first kind look like the second.
 */
export function reviewerTrainingView(
  profile: ReviewerProfileDocument,
): ReviewerTrainingView {
  const completed = new Set(profile.trainingCompletedModules);
  const trainingComplete = hasCompletedTraining(profile.trainingCompletedModules);
  const passedAt = profile.calibrationPassedAt;

  return {
    modules: TRAINING_MODULES.map((module) => ({
      moduleId: module.moduleId,
      title: module.title,
      families: [...module.families],
      completed: completed.has(module.moduleId),
    })),
    trainingComplete,
    calibrationItems: trainingComplete
      ? CALIBRATION_ITEMS.map((item) => ({ itemId: item.itemId, text: item.text }))
      : [],
    calibrationOpen: trainingComplete,
    calibrationPassedAt: passedAt?.toISOString() ?? null,
    /**
     * Derived from the pass instant rather than stored, so the validity window
     * cannot say one thing here and another in `isCalibrationCurrent`.
     */
    calibrationCurrentUntil:
      passedAt === null
        ? null
        : new Date(passedAt.getTime() + CALIBRATION_VALID_DAYS * DAY_MS).toISOString(),
    calibrationScore: profile.calibrationScore,
    calibrationAttempts: profile.calibrationAttempts,
    calibrationPassScore: CALIBRATION_PASS_SCORE,
  };
}
