/**
 * §9.5's confidence score.
 *
 * The plan writes it in five lines:
 *
 *     agreement    = winningDecisiveVotes / decisiveVotes
 *     panelQuality = average(reviewerQualityNormalized)
 *     contextFactor= 1.0 if sufficient else 0.5
 *     confidence   = clamp(0.60 * agreement + 0.30 * panelQuality
 *                          + 0.10 * contextFactor, 0, 1)
 *
 * and one sentence about what it is for: "el voto sigue siendo igualitario. El
 * confidence score sirve para comunicar calidad y activar escalados, no para
 * multiplicar votos ni para calcular puntos de reputación."
 *
 * That sentence is why this is a separate file rather than a term inside the
 * engine. `consensus.ts` decides WHO WON and cannot see a reviewer's quality —
 * it has no parameter to receive one through. This runs afterwards, on the
 * verdict, and its output is carried on the decision for a human to read and for
 * an operator to alert on. Two panels casting identical ballots reach the same
 * outcome and differ only here, which is the ordering that keeps reliability out
 * of the count.
 *
 * The three coefficients sum to exactly 1.00, so — unlike §8.4's selection
 * weight, whose clamp the coefficients cannot reach — the bounds here are
 * attainable at both ends and the clamp is genuinely defensive rather than
 * decorative. It is kept because the inputs come from stored numbers: a
 * corrupted reliability outside [0, 1] would otherwise produce a confidence
 * above 1, and a decision claiming 1.4 confidence is worse than one that clamps.
 */

export const CONFIDENCE_COEFFICIENTS = Object.freeze({
  agreement: 0.6,
  panelQuality: 0.3,
  contextFactor: 0.1,
});

/** §9.5: 1.0 when the panel had what it needed, 0.5 when it did not. */
export const CONTEXT_FACTOR = Object.freeze({ sufficient: 1.0, insufficient: 0.5 });

export interface ConfidenceInput {
  /** §9.5's numerator: the votes the winning position carried. */
  readonly winningDecisiveVotes: number;
  /** §9.5's denominator: every juror who expressed an opinion. */
  readonly decisiveVotes: number;
  /**
   * Each juror's reliability for this case's families, in [0, 1].
   *
   * The whole panel, not only the winners. §9.7 forbids punishing a minority,
   * and a panel quality computed from the majority alone would be a number that
   * silently rewards agreeing with the majority — the first step toward exactly
   * that.
   */
  readonly reviewerQuality: readonly number[];
  /** The agreed position's context sufficiency (§9.3, §9.5). */
  readonly contextSufficiency: 'sufficient' | 'insufficient';
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** §9.5, verbatim. */
export function confidenceScore(input: ConfidenceInput): number {
  const agreement =
    input.decisiveVotes === 0 ? 0 : clampUnit(input.winningDecisiveVotes / input.decisiveVotes);

  const panelQuality =
    input.reviewerQuality.length === 0
      ? 0
      : clampUnit(
          input.reviewerQuality.reduce((sum, quality) => sum + clampUnit(quality), 0) /
            input.reviewerQuality.length,
        );

  const confidence = clampUnit(
    CONFIDENCE_COEFFICIENTS.agreement * agreement +
      CONFIDENCE_COEFFICIENTS.panelQuality * panelQuality +
      CONFIDENCE_COEFFICIENTS.contextFactor * CONTEXT_FACTOR[input.contextSufficiency],
  );

  // Two places, so a stored confidence is stable across replays on machines that
  // disagree in the last bit of a float — the same rounding triage applies to a
  // priority score, and for the same reason: a decision is compared with its own
  // recomputation during an audit.
  return Math.round(confidence * 100) / 100;
}

/**
 * The confidence below which a decision is worth a human's attention (§9.5's
 * "activar escalados").
 *
 * Published on the decision so operations can alert on it; it does NOT change
 * the outcome, and nothing in this module reads it. A threshold that fed back
 * into the verdict would be confidence deciding a case, which §9.5 forbids in
 * the same sentence that creates confidence.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;
