/**
 * §8.4's selection weight — and the boundary it is on the wrong side of.
 *
 * This number changes how OFTEN a reviewer is drawn. It must never change how
 * much their vote counts once they are on the panel. The plan states both halves
 * in one breath — "reliability may affect eligibility, the slot and the
 * aggregate confidence score, but it does not turn one vote into several" — and
 * `AGENTS.md` raises it to an invariant: one qualified person, one vote.
 *
 * The reason this file says so at length is that the system CrowdSource replaces
 * got it wrong in a way that is easy to reproduce. Oxy's civic validator has a
 * single `validatorWeight` function, and the same value feeds both the selection
 * reservoir and the stake attached to the resulting vote. Nothing about that is
 * visibly a mistake at the call site; it looks like reuse. So the separation is
 * kept structurally rather than by intention:
 *
 *  - This module is imported by the DRAW and by nothing else.
 *  - `weightSeparation.test.ts` asserts that import set and fails when it grows.
 *  - No weight is written onto an assignment or a review. The candidate snapshot
 *    on the draw record carries it — that is the audit trail — and the objects a
 *    vote is made of do not.
 *
 * The coefficients and the clamp are the plan's, unchanged — including one
 * quirk of §8.4 worth naming rather than quietly correcting. The terms sum to
 * 0.30 against a base of 0.70, so the formula's own range is [0.70, 1.00], while
 * the stated clamp is [0.75, 1.25]. **The upper bound is therefore unreachable.**
 * The effective range is [0.75, 1.00] and the most favoured eligible reviewer is
 * drawn about 1.33 times as often as the least favoured one.
 *
 * Implemented verbatim on purpose. Rescaling the terms to reach 1.25 would be
 * inventing a coefficient the plan does not give, and it would move the answer
 * in the WRONG direction: a wider spread means reputation influences selection
 * more, and §8.4's whole instruction is that the influence stays limited. The
 * dead upper bound is documented here and asserted in
 * `weightSeparation.test.ts`, so it is a known property rather than a surprise.
 */

/**
 * §8.4's clamp, verbatim. `MAX` is not reachable from the coefficients below —
 * see above; `SELECTION_WEIGHT_EFFECTIVE_MAX` is what a reviewer can actually
 * reach.
 */
export const SELECTION_WEIGHT_BOUNDS = Object.freeze({ MIN: 0.75, MAX: 1.25 });

/** What the formula can actually produce at the top: base plus every term. */
export const SELECTION_WEIGHT_EFFECTIVE_MAX = 1.0;

/** §8.4's terms, each in [0, 1]. */
export interface SelectionWeightInputs {
  /** Measured reliability in the case's family (§9.7), not a global score. */
  readonly categoryReliability: number;
  /** How recent the reviewer's calibration is (§8.2, §8.4). */
  readonly recentCalibration: number;
  /** §8.2's personhood, as a confidence rather than a flag. */
  readonly personhoodConfidence: number;
  /** Remaining capacity today, from §13.7's exposure limits. */
  readonly availabilityScore: number;
}

/** The plan's coefficients, verbatim. */
export const SELECTION_WEIGHT_COEFFICIENTS = Object.freeze({
  base: 0.7,
  categoryReliability: 0.15,
  recentCalibration: 0.05,
  personhoodConfidence: 0.05,
  availabilityScore: 0.05,
});

function unitClamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * §8.4's formula.
 *
 * Every input is clamped to [0, 1] here rather than trusted, because a stored
 * reliability of 3 would otherwise turn one reviewer into a near-certainty and
 * the draw would still look random from the outside.
 */
export function selectionWeight(inputs: SelectionWeightInputs): number {
  const raw =
    SELECTION_WEIGHT_COEFFICIENTS.base +
    SELECTION_WEIGHT_COEFFICIENTS.categoryReliability * unitClamp(inputs.categoryReliability) +
    SELECTION_WEIGHT_COEFFICIENTS.recentCalibration * unitClamp(inputs.recentCalibration) +
    SELECTION_WEIGHT_COEFFICIENTS.personhoodConfidence * unitClamp(inputs.personhoodConfidence) +
    SELECTION_WEIGHT_COEFFICIENTS.availabilityScore * unitClamp(inputs.availabilityScore);

  const clamped = Math.min(
    SELECTION_WEIGHT_BOUNDS.MAX,
    Math.max(SELECTION_WEIGHT_BOUNDS.MIN, raw),
  );

  // Four places: enough that two genuinely different reviewers keep different
  // weights, few enough that a persisted snapshot replays identically on a
  // machine whose last float bit differs.
  return Math.round(clamped * 10_000) / 10_000;
}
