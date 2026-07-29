/**
 * Personhood confidence (§8.2) — how sure CrowdSource is that a reviewer is one
 * real, distinct person.
 *
 * §8.2 asks for "personhood sufficient for real decisions" and adds that
 * unverified accounts may calibrate but should not decide global cases until
 * they meet the threshold. The obvious implementation — require Oxy's `verified`
 * flag — was measured against production before it was written: the verified
 * population is six accounts. A gate six people can pass is not a threshold, it
 * is a closed product, and it is the same failure mode as the civic validator's
 * empty `trusted` tier.
 *
 * So personhood here is a SCORE built from several independent signals, of which
 * Oxy verification is the strongest but not the only one. An unverified person
 * who completed training and passed calibration reaches the default threshold;
 * an unverified person who did neither does not, and calibrates instead —
 * exactly what §8.2 describes. The threshold itself is configuration
 * (`REVIEWER_MIN_PERSONHOOD_CONFIDENCE`), because the right value depends on how
 * many real reviewers exist, which changes.
 *
 * What this is NOT: a reputation. It never touches the weight of a vote, and it
 * enters selection only through `selectionWeight`'s 0.05 coefficient (§8.4).
 */

import { config } from '../../config';

/**
 * What the score is computed from. Every field is something CrowdSource either
 * observes directly or was told by the Oxy session — nothing is inferred.
 */
export interface PersonhoodSignals {
  /** The Oxy account is active and the session authenticated it. */
  readonly accountActive: boolean;
  /**
   * Oxy's own verification flag, as the session reported it.
   *
   * Read defensively and defaulted to false: the flag is absent from some
   * session payloads, and "absent" must mean "no evidence", never "verified".
   */
  readonly oxyAccountVerified: boolean;
  readonly trainingCompletedAt: Date | null;
  readonly calibrationPassedAt: Date | null;
  /**
   * §8.2's sock puppet, shared device and coordinated cluster signals. A single
   * boolean because the DETECTION of those patterns is not this module's job;
   * what belongs here is that a flagged account scores zero regardless of every
   * other signal.
   */
  readonly suspectedSockPuppet: boolean;
}

/**
 * The contribution of each signal, and the reason each is worth what it is.
 *
 * They sum to 1.0 exactly, so the score is a probability-shaped number rather
 * than an arbitrary scale somebody has to look up.
 */
export const PERSONHOOD_WEIGHTS = Object.freeze({
  /**
   * An authenticated, active Oxy account. Worth something — it is an account
   * somebody keeps and can lose — but never enough on its own, because creating
   * accounts is the cheapest attack on a jury there is.
   */
  authenticatedAccount: 0.3,
  /** Oxy's verification, the strongest single signal available. */
  oxyVerified: 0.4,
  /** Training completed: a person who spent the time on the material. */
  training: 0.1,
  /**
   * Calibration passed. Worth more than training because it cannot be clicked
   * through: it requires answering gold items correctly, which a bulk-created
   * account farm has to do once per account.
   */
  calibration: 0.2,
} as const);

/**
 * The score, in [0, 1].
 *
 * Pure, so the stored value on a profile can be re-derived and CHECKED rather
 * than trusted — `reviewer.service.ts` recomputes it on every write and the
 * suite asserts stored equals recomputed. A denormalised field nobody verifies
 * is a field that silently drifts, and this one decides who may judge.
 */
export function personhoodConfidence(signals: PersonhoodSignals): number {
  if (!signals.accountActive) return 0;
  // A flagged account scores zero however many other signals it carries: the
  // whole point of the flag is that the other signals may belong to somebody
  // else, or to the same person twice.
  if (signals.suspectedSockPuppet) return 0;

  const score =
    PERSONHOOD_WEIGHTS.authenticatedAccount +
    (signals.oxyAccountVerified ? PERSONHOOD_WEIGHTS.oxyVerified : 0) +
    (signals.trainingCompletedAt !== null ? PERSONHOOD_WEIGHTS.training : 0) +
    (signals.calibrationPassedAt !== null ? PERSONHOOD_WEIGHTS.calibration : 0);

  // Two places, so a stored value is stable across replays and a float's last
  // bit never decides eligibility.
  return Math.round(score * 100) / 100;
}

/** The configured threshold for deciding a real case (§8.2). */
export function minimumPersonhoodConfidence(): number {
  return config.reviewer.minPersonhoodConfidence;
}

/** True when this reviewer's personhood is sufficient to decide real cases. */
export function meetsPersonhoodThreshold(confidence: number): boolean {
  return confidence >= minimumPersonhoodConfidence();
}
