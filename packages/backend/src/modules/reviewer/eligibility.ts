import type { TaxonomyFamily } from '@oxyhq/crowdsource-contracts';

import type { SensitivityClass } from '../triage/triage';
import { isCalibrationCurrent } from './calibration';
import { meetsPersonhoodThreshold } from './personhood';
import { sensitivityRank, type ReviewerProfileDocument } from './reviewer.collection';
import { DRAWABLE_STATES, canDecideRealCases } from './reviewerState';

/**
 * §8.2's eligibility, as one authoritative predicate plus an index-shaped
 * approximation of it.
 *
 * The split matters and it is the whole scale story (§8.8). `eligibilityFilter`
 * is what the database can answer from an index cheaply; `eligibilityRejection`
 * is the truth. The filter never has to be complete — it only has to be a
 * SUPERSET of the truth, so nothing eligible is missed — and the predicate
 * re-checks every dimension the filter narrowed on, including the ones it
 * already handled. One authority, one place to read, and the index is an
 * optimisation that cannot become a second, divergent definition of who may
 * judge.
 *
 * §8.2's ten conditions map here as follows. Account, personhood, age, language,
 * category, calibration currency, consent and exposure are ALL in this file.
 * Relations, prior participation and coordination clusters are not: those are
 * properties of a candidate RELATIVE TO A CASE'S PARTIES, and they live in
 * `sortition/exclusions.ts` where the parties are known.
 */

/** How many cases a reviewer may hold open at once. */
export const MAX_OPEN_ASSIGNMENTS = 3;

/**
 * §13.7's mandatory pause: how much sensitive material one person may see in a
 * window before they stop being drawn for more of it.
 *
 * It rests only the SENSITIVE route. A reviewer who has just worked through
 * several distressing cases is still perfectly able to judge a spam report, and
 * a rest that removed them from everything would make looking after yourself
 * cost you your place in the pool — which is the incentive §13.7 exists to
 * prevent.
 */
export const SENSITIVE_EXPOSURE_WINDOW_HOURS = 4;
export const SENSITIVE_EXPOSURE_MAX = 5;

/**
 * Adult-only families (§7.5 row 5, §8.2's age compatibility).
 *
 * One family today. It is a set rather than a comparison so adding a second one
 * is an edit in a single place that both the preferences check and the draw
 * read.
 */
export const ADULT_ONLY_FAMILIES: ReadonlySet<TaxonomyFamily> = new Set<TaxonomyFamily>([
  'sexual_content',
]);

/** True when any of these families may only be shown to adults. */
export function requiresAdultReviewer(families: readonly TaxonomyFamily[]): boolean {
  return families.some((family) => ADULT_ONLY_FAMILIES.has(family));
}

/** What a case needs from a reviewer, computed from the case by the caller. */
export interface CaseEligibilityCriteria {
  /** Every taxonomy family alleged on the case. A reviewer must accept all. */
  readonly families: readonly TaxonomyFamily[];
  /**
   * The primary language of the material, or null when it declares none.
   *
   * Null is not "any language" as a convenience — it is the honest answer when
   * the envelope's resources carry no language tag. Requiring a match against a
   * language nobody stated would exclude every reviewer and refuse the case, so
   * the constraint applies only when there is something to match.
   */
  readonly language: string | null;
  readonly sensitivity: SensitivityClass;
  /** True when any alleged family is adult-only (§7.5 row 5). */
  readonly requiresAdult: boolean;
}

/** What the reviewer is currently carrying, counted from their assignments. */
export interface ExposureFacts {
  readonly openAssignments: number;
  readonly reviewsToday: number;
  readonly sensitiveReviewsInWindow: number;
}

/**
 * Why a candidate is not eligible. A closed vocabulary, because these are
 * written into a draw's audit record and a free-text reason is where a case
 * detail eventually ends up.
 */
export const ELIGIBILITY_REJECTIONS = [
  'account_inactive',
  'state_not_drawable',
  'suspended',
  'unavailable',
  'personhood_below_threshold',
  'rules_not_accepted',
  'calibration_expired',
  'category_not_accepted',
  'language_mismatch',
  'sensitivity_above_consent',
  'category_consent_missing',
  'adult_attestation_missing',
  'sock_puppet_signal',
  'daily_limit_reached',
  'open_assignment_limit',
  'sensitive_exposure_rest',
] as const;
export type EligibilityRejection = (typeof ELIGIBILITY_REJECTIONS)[number];

/**
 * The authoritative eligibility check. Returns the reason, or null when the
 * candidate is eligible.
 *
 * Ordered from cheapest and most decisive to most contextual, so a rejection
 * reason names the most fundamental thing that was wrong rather than whichever
 * check happened to run first.
 */
export function eligibilityRejection(
  profile: ReviewerProfileDocument,
  criteria: CaseEligibilityCriteria,
  exposure: ExposureFacts,
  now: Date,
): EligibilityRejection | null {
  if (!profile.accountActive) return 'account_inactive';
  if (profile.suspectedSockPuppet) return 'sock_puppet_signal';
  if (!canDecideRealCases(profile.state)) return 'state_not_drawable';
  if (profile.suspendedUntil !== null && profile.suspendedUntil.getTime() > now.getTime()) {
    return 'suspended';
  }
  if (!profile.available) return 'unavailable';

  if (!meetsPersonhoodThreshold(profile.personhoodConfidence)) {
    return 'personhood_below_threshold';
  }
  /**
   * §13.7's consent to the reviewing rules, checked HERE and not only at the
   * `applicant` → `calibrating` gate.
   *
   * The gate covers everybody who climbs the ladder, and this covers everybody who
   * did not: a profile written before acceptance existed, or moved by an operator,
   * would otherwise sit in `community` and be drawn for real cases having agreed
   * to nothing. The reviewer app advertises this as a blocker, and the two have to
   * be the same answer — a check that lives only on the device is not a gate, and
   * the app saying "accept the rules first" while the server hands out a case is
   * the worse of the two ways for them to disagree.
   */
  if (profile.rulesAcceptedAt === null) return 'rules_not_accepted';
  if (!isCalibrationCurrent(profile.calibrationPassedAt, now)) return 'calibration_expired';

  /**
   * Every alleged family, not one of them. A case carrying nine spam
   * allegations and one child-safety allegation is a child-safety case (see
   * `triage.ts`), and a reviewer who accepts only spam has not agreed to see
   * the rest of it.
   */
  const accepted = new Set(profile.categories);
  if (!criteria.families.every((family) => accepted.has(family))) return 'category_not_accepted';

  /**
   * Stricter than §8.3, deliberately. The plan's panel constraint is "at least
   * one member with a compatible primary language", which allows the other
   * members not to read the material. A reviewer who cannot read what they are
   * judging is not a safeguard; the panel constraint is satisfied trivially by
   * requiring the language of everybody.
   */
  if (criteria.language !== null && !profile.languages.includes(criteria.language)) {
    return 'language_mismatch';
  }

  if (profile.maxSensitivityRank < sensitivityRank(criteria.sensitivity)) {
    return 'sensitivity_above_consent';
  }
  if (criteria.sensitivity !== 'standard') {
    const consented = new Set(profile.consentedSensitiveCategories);
    if (!criteria.families.every((family) => consented.has(family))) {
      return 'category_consent_missing';
    }
  }
  if (criteria.requiresAdult && !profile.isAdult) return 'adult_attestation_missing';

  if (exposure.openAssignments >= MAX_OPEN_ASSIGNMENTS) return 'open_assignment_limit';
  if (exposure.reviewsToday >= profile.dailyReviewLimit) return 'daily_limit_reached';
  if (
    criteria.sensitivity !== 'standard' &&
    exposure.sensitiveReviewsInWindow >= SENSITIVE_EXPOSURE_MAX
  ) {
    return 'sensitive_exposure_rest';
  }

  return null;
}

/**
 * §8.4's `availabilityScore`, in [0, 1].
 *
 * The smaller of two headrooms: how much of today's self-chosen limit is left,
 * and how many of the open-case slots are free. A reviewer at the edge of either
 * is still eligible — the limits above decide that — but they are drawn less
 * often than somebody with a clear day, which spreads work rather than piling it
 * on whoever answered first.
 */
export function availabilityScore(
  profile: ReviewerProfileDocument,
  exposure: ExposureFacts,
): number {
  const dailyHeadroom =
    profile.dailyReviewLimit <= 0
      ? 0
      : Math.max(0, profile.dailyReviewLimit - exposure.reviewsToday) / profile.dailyReviewLimit;
  const openHeadroom =
    Math.max(0, MAX_OPEN_ASSIGNMENTS - exposure.openAssignments) / MAX_OPEN_ASSIGNMENTS;

  return Math.round(Math.min(dailyHeadroom, openHeadroom) * 100) / 100;
}

/**
 * The index-shaped narrowing of the predicate above.
 *
 * Everything here is answerable from `{ state, categories, samplingKey }` or
 * from the fetched document without a second round trip, and every clause is
 * also re-checked by `eligibilityRejection`. That redundancy is the point: if
 * this filter is ever wrong, the worst it can do is fetch a candidate who is
 * then rejected — never admit one who should not have been drawn.
 *
 * `languages` is a filter clause but not part of the index used for the scan,
 * because MongoDB refuses a compound index over two array fields and
 * `categories` is the more selective of the two. See `reviewer.collection.ts`.
 */
export function eligibilityFilter(
  criteria: CaseEligibilityCriteria,
  now: Date,
): Record<string, unknown> {
  return {
    state: { $in: DRAWABLE_STATES },
    accountActive: true,
    available: true,
    suspectedSockPuppet: false,
    // Narrows on exactly the population the predicate above rejects, so the
    // filter stays a SUPERSET of the truth while doing less work.
    rulesAcceptedAt: { $ne: null },
    $and: [
      { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
      ...(criteria.requiresAdult ? [{ isAdult: true }] : []),
    ],
    categories: { $all: criteria.families },
    ...(criteria.language === null ? {} : { languages: criteria.language }),
    maxSensitivityRank: { $gte: sensitivityRank(criteria.sensitivity) },
    ...(criteria.sensitivity === 'standard'
      ? {}
      : { consentedSensitiveCategories: { $all: criteria.families } }),
  };
}
