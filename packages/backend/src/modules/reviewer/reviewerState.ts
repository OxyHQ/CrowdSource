import { REVIEWER_STATES, type ReviewerState } from '@oxyhq/crowdsource-contracts';

/**
 * What the reviewer onboarding states MEAN (§8.1) — the ladder, the legal moves,
 * and who may decide a real case.
 *
 * The seven states themselves are declared in `@oxyhq/crowdsource-contracts`
 * (`reviewer-surface.ts`) because they cross the reviewer API boundary: the app
 * displays them, and when they were declared twice the two copies drifted into
 * `community` against `community_reviewer` with nothing to catch it. This file
 * owns the BEHAVIOUR, which no client needs and which is nobody's business but
 * the draw's.
 *
 * ## Why the vocabulary could not be borrowed from Oxy
 *
 * Oxy's civic validator selects on
 * `ReputationBalance.trustTier` and nothing else, and a production check of that
 * pool found: zero accounts at `trusted`, zero at `high_trust`, an eligible
 * population of five internal accounts qualifying only through `User.verified`,
 * and twenty of twenty-one civic validation requests expired having never
 * received a single vote. A tier nobody reaches is not a high bar, it is a
 * closed door, and inheriting it would reproduce that outcome exactly.
 *
 * So eligibility here is built from things CrowdSource itself observes and can
 * move a person through: training, calibration, category and language capability,
 * explicit consent, and exposure. Oxy contributes an authenticated account and a
 * personhood signal — see `personhood.ts` — and nothing else.
 *
 * The states are ORDERED, which §8.1's table implies rather than states: a
 * Trusted Reviewer can do everything a Community Reviewer can, and a Category
 * Specialist is not a person who lost the ability to sit on an ordinary panel.
 * What a specialist specialises IN is a separate, per-category field on the
 * profile, because "specialist" without a category is not a capability.
 */

/**
 * The ladder, as a number.
 *
 * `suspended` is -1 rather than 0 so every comparison against a capability
 * threshold fails for it, including a threshold of `applicant`. A suspended
 * reviewer is not "at the bottom of the ladder", they are off it (§8.1).
 */
export const REVIEWER_STATE_RANK: Readonly<Record<ReviewerState, number>> = Object.freeze({
  suspended: -1,
  applicant: 0,
  calibrating: 1,
  community: 2,
  trusted: 3,
  specialist: 4,
  appeals: 5,
});

/** The lowest state that may be drawn for a real case (§8.1, §8.2). */
const MIN_DRAWABLE_STATE: ReviewerState = 'community';

/**
 * True when this state may sit on a jury that decides a real case.
 *
 * `calibrating` is excluded by design and it is the whole point of the state:
 * §8.1 says a calibrating reviewer receives training and gold cases and that
 * "their answers do not resolve real cases".
 */
export function canDecideRealCases(state: ReviewerState): boolean {
  return REVIEWER_STATE_RANK[state] >= REVIEWER_STATE_RANK[MIN_DRAWABLE_STATE];
}

/** Every state that may be drawn, for the eligibility query's `$in` clause. */
export const DRAWABLE_STATES: readonly ReviewerState[] = REVIEWER_STATES.filter(canDecideRealCases);

/**
 * The states a reviewer may move between, and in which direction.
 *
 * Expressed as data rather than as conditionals scattered through the service,
 * because the illegal transitions are the interesting ones: nothing goes
 * straight from `applicant` to `community` without calibrating, and nothing
 * leaves `suspended` except back to `calibrating` — §9.7 is explicit that a
 * reviewer whose access was reduced is RE-CALIBRATED rather than restored, since
 * the evidence that reduced it was statistical and a restoration that skipped
 * calibration would be a guess.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ReviewerState, readonly ReviewerState[]>> =
  Object.freeze({
    applicant: ['calibrating', 'suspended'],
    calibrating: ['community', 'calibrating', 'suspended'],
    community: ['trusted', 'calibrating', 'suspended'],
    trusted: ['specialist', 'appeals', 'community', 'calibrating', 'suspended'],
    specialist: ['appeals', 'trusted', 'calibrating', 'suspended'],
    appeals: ['specialist', 'trusted', 'calibrating', 'suspended'],
    suspended: ['calibrating'],
  });

/** True when `to` is a legal next state from `from`. */
export function canTransition(from: ReviewerState, to: ReviewerState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
