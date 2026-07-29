import {
  taxonomyFamilyOf,
  type ContextSufficiency,
  type DecisionOutcome,
  type FindingContext,
  type RecommendedAction,
  type ReviewFinding,
  type ReviewOutcome,
  type Severity,
  type TaxonomyFamily,
} from '@oxyhq/crowdsource-contracts';

import type { SensitivityClass } from '../triage/triage';
import { REVIEWER_STATE_RANK, type ReviewerState } from '../reviewer/reviewerState';

/**
 * The consensus engine (§9.4, §8.6) — pure, and deliberately so.
 *
 * Nothing here reads the database, the clock or a reviewer's identity. It takes
 * the ballots and the shape of the panel and returns a verdict, which is what
 * makes every rule below testable at the level it is stated at rather than
 * through six collections of fixtures.
 *
 * ## Consensus is not a vote count
 *
 * §9.4 opens by saying so: "el consenso no se limita a violation contra
 * no_violation. Debe comprobar acuerdo en outcome, familia taxonómica, recurso
 * afectado, gravedad, suficiencia de contexto y excepción relevante." Six
 * dimensions. Four reviewers who all answer `violation` while disagreeing about
 * what they found have not agreed on anything a decision could state — one
 * thinks the post is harassment of medium severity, another thinks it is a
 * privacy breach on a different resource entirely, and publishing "violation,
 * 4 of 5" over that would be inventing a finding no juror made.
 *
 * So the six dimensions are not six separate checks that could be relaxed one at
 * a time. They are ONE key. A review's `position` is the tuple, reviews agree
 * exactly when their positions match, and the winner is the largest group of
 * identical positions. There is nowhere to add a "close enough" without deleting
 * a dimension, which is a visible edit.
 *
 * ## Where the plan contradicts itself, and what this does about it
 *
 * §8.6's ladder says a round-1 panel of three that agrees unanimously decides.
 * §9.4's table says the MINIMUM rule at medium risk is "4 de 5" and at high risk
 * "5 de 7" — thresholds a three-person panel cannot reach however unanimous it
 * is. The two are only consistent for low-risk cases.
 *
 * This implements the stricter of the two, which is what "regla mínima" means:
 * §9.4 states a floor, and a ladder rung that sits below the floor does not
 * decide. The consequence is real and is asserted rather than smoothed over — a
 * medium-risk case with three unanimous reviews EXPANDS instead of publishing,
 * and `consensusEngine.test.ts` pins that. Rescaling §9.4's thresholds down to
 * fit §8.6 would lower the bar on exactly the material the plan wanted a higher
 * bar for; rescaling §8.6's panel sizes up would make every case cost five
 * reviewers. Neither is a decision this phase gets to make silently.
 *
 * ## What this file may not do
 *
 * It never sees a reviewer's reliability, tier or selection weight, and it has
 * no parameter it could receive one through. §9.5's confidence is computed
 * AFTER a verdict, from the verdict, by `confidence.ts` — so a high-quality
 * panel and a low-quality one that cast identical ballots reach the identical
 * outcome and differ only in the number attached to it. That ordering is the
 * whole of "one qualified person, one vote" at this layer.
 */

/** One juror's ballot, as consensus needs to see it. Never who cast it. */
export interface Ballot {
  readonly reviewerId: string;
  readonly outcome: ReviewOutcome;
  readonly contextSufficiency: ContextSufficiency;
  readonly findings: readonly ReviewFinding[];
  readonly recommendedActions: readonly RecommendedAction[];
  /** §9.4's medium row needs to know a trusted reviewer sat; §9.5 does not. */
  readonly reviewerState: ReviewerState;
  /** §9.4's high row requires a specialist to have been present. */
  readonly isSpecialist: boolean;
}

/**
 * §9.4's six dimensions, as one comparable value.
 *
 * `family`, `severity` and `context` are derived from the PRIMARY finding —
 * §9.4's own "familia principal" — while `resourceIds` is the union across every
 * finding, because "el recurso afectado" asks which material is implicated and
 * a second finding on a second resource implicates it. The combination is what
 * makes the dimensions compose: a reviewer who spots an additional secondary
 * family has not disagreed about what the material is, but one who says a
 * different resource is affected has.
 */
export interface ReviewPosition {
  readonly outcome: ReviewOutcome;
  readonly family: TaxonomyFamily | null;
  readonly resourceIds: readonly string[];
  readonly severity: Severity | null;
  readonly contextSufficiency: ContextSufficiency;
  readonly context: FindingContext | null;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

/**
 * The finding a position is named after: the most severe one.
 *
 * Ties break on the taxonomy code, alphabetically. Not cosmetic — two jurors who
 * submitted the same two findings in a different order must produce the same
 * position, or the engine would report disagreement between two identical
 * opinions and expand a panel for nothing.
 */
function primaryFinding(findings: readonly ReviewFinding[]): ReviewFinding | null {
  return findings.reduce<ReviewFinding | null>((primary, finding) => {
    if (primary === null) return finding;
    const difference = SEVERITY_RANK[finding.severity] - SEVERITY_RANK[primary.severity];
    if (difference > 0) return finding;
    if (difference < 0) return primary;
    return finding.code < primary.code ? finding : primary;
  }, null);
}

/** §9.4's six dimensions, read off one ballot. */
export function positionOf(ballot: Ballot): ReviewPosition {
  const primary = primaryFinding(ballot.findings);

  return {
    outcome: ballot.outcome,
    family: primary === null ? null : taxonomyFamilyOf(primary.code),
    resourceIds: [
      ...new Set(ballot.findings.flatMap((finding) => [...finding.resourceIds])),
    ].sort(),
    severity: primary?.severity ?? null,
    contextSufficiency: ballot.contextSufficiency,
    context: primary?.context ?? null,
  };
}

/**
 * The comparison key.
 *
 * A string rather than a deep-equality helper because it is also what groups the
 * ballots, and because a key makes the dimensions enumerable: adding a seventh
 * dimension or deleting one of the six is a change to this line and to the
 * mutation test that breaks each of them in turn.
 */
export function positionKey(position: ReviewPosition): string {
  return JSON.stringify([
    position.outcome,
    position.family,
    position.resourceIds,
    position.severity,
    position.contextSufficiency,
    position.context,
  ]);
}

/**
 * §9.4's risk rows, derived from what triage already computed.
 *
 * §9.4 gives a risk column without saying what sets it, and inventing a second
 * classifier would mean two places in the service disagreeing about how
 * dangerous a case is. Triage's `sensitivityClass` (§7.4, §12.8) is already the
 * strictest route across every allegation, is server-computed, and maps one to
 * one onto the four rows: `prohibited` material is §7.5 row 1, which never
 * reaches a jury at all, and is `critical` here for the same reason §9.4 says
 * critical cases are not decided by a standard community jury.
 */
export const CONSENSUS_RISKS = ['low', 'medium', 'high', 'critical'] as const;
export type ConsensusRisk = (typeof CONSENSUS_RISKS)[number];

const RISK_BY_SENSITIVITY: Readonly<Record<SensitivityClass, ConsensusRisk>> = Object.freeze({
  standard: 'low',
  sensitive: 'medium',
  restricted: 'high',
  prohibited: 'critical',
});

export function riskOf(sensitivity: SensitivityClass): ConsensusRisk {
  return RISK_BY_SENSITIVITY[sensitivity];
}

/**
 * §9.4's minimum agreeing votes per risk, and the composition rule.
 *
 * The table is the plan's, transcribed: low decides from three, medium needs
 * four, high needs five. `Infinity` for critical is not a placeholder — §9.4
 * says a critical case "no se decide mediante jurado comunitario estándar", and
 * a threshold no panel can reach is that sentence in a form the code cannot
 * accidentally satisfy.
 */
export const MINIMUM_AGREEING_VOTES: Readonly<Record<ConsensusRisk, number>> = Object.freeze({
  low: 3,
  medium: 4,
  high: 5,
  critical: Number.POSITIVE_INFINITY,
});

/**
 * §8.6's ladder: agreeing votes required at each round.
 *
 * Round 1 is 3 of 3, round 2 is 4 of 5, round 3 is 5 of 7 — the plan's numbers,
 * unchanged.
 */
export const ROUND_AGREEING_VOTES: Readonly<Record<number, number>> = Object.freeze({
  1: 3,
  2: 4,
  3: 5,
});

/** The votes one position must carry at this round and risk to decide. */
export function requiredAgreeingVotes(round: number, risk: ConsensusRisk): number {
  const ladder = ROUND_AGREEING_VOTES[round];
  if (ladder === undefined) {
    throw new Error(`§8.6 defines no agreement threshold for round ${round}.`);
  }
  return Math.max(ladder, MINIMUM_AGREEING_VOTES[risk]);
}

/**
 * §9.4's structural requirements, which are not about counting.
 *
 * A medium-risk case needs "al menos un revisor de confianza" on the panel; a
 * high-risk one needs a specialist and no critical conflict between findings.
 * They gate the decision independently of the vote count, so a panel that
 * reaches five of seven but never had a specialist does not decide — which is
 * the difference between "the jury agreed" and "the jury the plan asked for
 * agreed".
 */
export const STRUCTURAL_REQUIREMENTS = [
  'trusted_reviewer_present',
  'specialist_present',
  'no_critical_conflict',
] as const;
export type StructuralRequirement = (typeof STRUCTURAL_REQUIREMENTS)[number];

const REQUIREMENTS_BY_RISK: Readonly<Record<ConsensusRisk, readonly StructuralRequirement[]>> =
  Object.freeze({
    low: [],
    medium: ['trusted_reviewer_present'],
    high: ['trusted_reviewer_present', 'specialist_present', 'no_critical_conflict'],
    critical: ['specialist_present', 'no_critical_conflict'],
  });

/** §8.1: `trusted` and everything above it. */
function isTrusted(state: ReviewerState): boolean {
  return REVIEWER_STATE_RANK[state] >= REVIEWER_STATE_RANK.trusted;
}

/**
 * §9.4's "conflicto crítico entre hallazgos".
 *
 * The plan names the condition and not its definition, so this is the narrowest
 * reading that still means something: a disagreement about WHAT WAS FOUND, at a
 * severity where being wrong is expensive. Two ballots whose primary families
 * differ, where at least one of them called the material `high` or `critical`,
 * is a panel that cannot agree whether it is looking at a credible threat or an
 * insult — and §9.4 refuses to let a bare majority resolve that on high-risk
 * material.
 *
 * Deliberately NOT "any disagreement": a split between `violation` and
 * `no_violation` on the same family at low severity is ordinary and is what the
 * vote count is for.
 */
export function hasCriticalConflict(ballots: readonly Ballot[]): boolean {
  const serious = new Set<TaxonomyFamily>();
  const families = new Set<TaxonomyFamily>();

  for (const ballot of ballots) {
    const position = positionOf(ballot);
    if (position.family === null) continue;
    families.add(position.family);
    if (position.severity !== null && SEVERITY_RANK[position.severity] >= SEVERITY_RANK.high) {
      serious.add(position.family);
    }
  }

  return families.size > 1 && serious.size > 0;
}

/** Which of §9.4's structural requirements this panel fails. */
export function unmetRequirements(
  risk: ConsensusRisk,
  ballots: readonly Ballot[],
): readonly StructuralRequirement[] {
  const satisfied: Readonly<Record<StructuralRequirement, boolean>> = {
    trusted_reviewer_present: ballots.some((ballot) => isTrusted(ballot.reviewerState)),
    specialist_present: ballots.some((ballot) => ballot.isSpecialist),
    no_critical_conflict: !hasCriticalConflict(ballots),
  };

  return REQUIREMENTS_BY_RISK[risk].filter((requirement) => !satisfied[requirement]);
}

/** The largest group of identical positions, and how the rest fell. */
export interface PositionTally {
  readonly position: ReviewPosition;
  readonly votes: number;
  readonly reviewerIds: readonly string[];
}

/**
 * Groups ballots by position, largest group first.
 *
 * Ties are ordered by the group's lowest reviewer id, so a tie is reported
 * deterministically. That ordering never DECIDES a tie — `evaluateConsensus`
 * refuses to publish one — it only makes the report of the tie reproducible.
 */
export function tallyPositions(ballots: readonly Ballot[]): readonly PositionTally[] {
  const groups = new Map<string, { position: ReviewPosition; reviewerIds: string[] }>();

  for (const ballot of ballots) {
    const position = positionOf(ballot);
    const key = positionKey(position);
    const group = groups.get(key) ?? { position, reviewerIds: [] };
    group.reviewerIds.push(ballot.reviewerId);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      position: group.position,
      votes: group.reviewerIds.length,
      reviewerIds: [...group.reviewerIds].sort(),
    }))
    .sort((left, right) => {
      if (right.votes !== left.votes) return right.votes - left.votes;
      return left.reviewerIds[0] < right.reviewerIds[0] ? -1 : 1;
    });
}

/** Why a panel that could not decide could not decide. */
export const NO_CONSENSUS_REASONS = [
  /** A position led but did not reach the round's threshold. */
  'below_threshold',
  /** Two or more positions led equally. Never resolved in either direction. */
  'tie',
  /** The count was met but §9.4's composition was not. */
  'requirements_unmet',
] as const;
export type NoConsensusReason = (typeof NO_CONSENSUS_REASONS)[number];

export type ConsensusVerdict =
  | {
      readonly status: 'consensus';
      readonly position: ReviewPosition;
      readonly winningVotes: number;
      readonly decisiveVotes: number;
      readonly agreeingReviewerIds: readonly string[];
    }
  | {
      readonly status: 'expand';
      readonly reason: NoConsensusReason;
      readonly unmet: readonly StructuralRequirement[];
      readonly leadingVotes: number;
      readonly decisiveVotes: number;
    }
  | {
      /**
       * The ladder is exhausted. §8.6: "sin consenso -> inconclusive o
       * escalated", and §9.6 is what decides which.
       */
      readonly status: 'exhausted';
      readonly outcome: Extract<DecisionOutcome, 'inconclusive' | 'escalated'>;
      readonly reason: NoConsensusReason;
      readonly unmet: readonly StructuralRequirement[];
      readonly leadingVotes: number;
      readonly decisiveVotes: number;
    };

export interface ConsensusInput {
  readonly ballots: readonly Ballot[];
  /** §8.6's round the panel is at, derived from its seats. */
  readonly round: number;
  readonly risk: ConsensusRisk;
  /** The last round the ladder defines. Past it there is nowhere to expand. */
  readonly finalRound: number;
}

/**
 * The verdict for one panel at one round.
 *
 * The order of the checks is the argument. The COUNT is evaluated first and the
 * composition second, so a decision requires both — and when the count is met
 * but the composition is not, the failure is reported as
 * `requirements_unmet` rather than being folded into "not enough votes", because
 * those two need different remedies: one wants more jurors, the other wants
 * different ones.
 *
 * A tie is its own reason and never resolves. §9.6 and Appendix F: "la ausencia
 * de consenso no se convierte en culpabilidad ni inocencia automática." The one
 * thing that must never happen is for the engine to reach for `no_violation`
 * because it is the outcome that changes nothing.
 *
 * ## The tie check is a net, not the gate, and it is worth being exact about
 *
 * On the ladder as §8.6 defines it, a tie can never also clear the threshold: a
 * tie needs two positions at the leading count `v`, so `2v ≤ decisiveVotes`,
 * and every rung asks for more than half its seats — 3 of 3, 4 of 5, 5 of 7.
 * The arithmetic is checked in `consensusEngine.test.ts` for every (round,
 * risk) pair rather than asserted here, so the claim cannot rot. What actually
 * refuses a tied panel today is therefore the COUNT, and this branch's live
 * contribution is the `reason` an operator reads: `tie` and `below_threshold`
 * are different situations and want different remedies.
 *
 * It stays because it is a net under a future ladder edit. Lower round 3 to
 * three of seven and a 3-3-1 split would suddenly clear the bar; without this
 * branch the engine would then publish `tallies[0]`, whose order is decided by
 * the lowest reviewer id in the group. That is a coin toss deciding a
 * moderation case, arriving as a side effect of a threshold change nobody
 * connected to tie-breaking.
 */
export function evaluateConsensus(input: ConsensusInput): ConsensusVerdict {
  const decisiveVotes = input.ballots.length;
  const tallies = tallyPositions(input.ballots);
  const leader = tallies[0];
  const leadingVotes = leader?.votes ?? 0;

  const required = requiredAgreeingVotes(input.round, input.risk);
  const tied = tallies.length > 1 && tallies[1].votes === leadingVotes;
  const unmet = unmetRequirements(input.risk, input.ballots);

  const reason: NoConsensusReason = tied
    ? 'tie'
    : leadingVotes < required
      ? 'below_threshold'
      : 'requirements_unmet';

  if (leader !== undefined && !tied && leadingVotes >= required && unmet.length === 0) {
    return {
      status: 'consensus',
      position: leader.position,
      winningVotes: leadingVotes,
      decisiveVotes,
      agreeingReviewerIds: leader.reviewerIds,
    };
  }

  if (input.round < input.finalRound) {
    return { status: 'expand', reason, unmet, leadingVotes, decisiveVotes };
  }

  /**
   * §8.6's last rung, and §9.6's two ways of failing to decide.
   *
   * `escalated` when the panel could never have satisfied §9.4's composition —
   * no specialist sat, no trusted reviewer sat, or the findings conflict at a
   * severity §9.4 will not let a majority settle. That is precisely §9.6's
   * "requiere especialistas, Trust and Safety o un proceso externo": more
   * community jurors would not have helped.
   *
   * `inconclusive` when the panel was the panel the plan asked for and still did
   * not agree. §9.6: "el jurado revisó el caso, pero no alcanzó consenso
   * suficiente." Nothing about that is `no_violation`, and the two outcomes
   * carry different consequences in §7.6 — `keep_restricted_temporarily` and
   * `escalate` against `allow` and `restore`.
   *
   * A `critical` case escalates whatever its ballots say, because §9.4's own
   * row says a standard community jury does not decide one. Triage routes that
   * material to the legal pool and sortition refuses to draw for it (§7.5 row
   * 1), so reaching here at all means something upstream changed; `escalated`
   * is the only answer that does not quietly let a jury resolve it.
   */
  return {
    status: 'exhausted',
    outcome: unmet.length > 0 || input.risk === 'critical' ? 'escalated' : 'inconclusive',
    reason,
    unmet,
    leadingVotes,
    decisiveVotes,
  };
}

/**
 * The outcome a decision publishes for an agreed position.
 *
 * A total mapping over `REVIEW_OUTCOMES`, and a narrow one: three of the four
 * review outcomes are also decision outcomes and pass through unchanged. There
 * is no arm that produces `inconclusive` — a panel that agreed is by definition
 * not inconclusive — and none that produces `no_violation` from anything except
 * jurors who voted for it. The absence of both is the point of writing this as a
 * table rather than as a cast.
 */
const DECISION_OUTCOME_BY_REVIEW: Readonly<Record<ReviewOutcome, DecisionOutcome>> = Object.freeze({
  violation: 'violation',
  no_violation: 'no_violation',
  insufficient_context: 'insufficient_context',
  content_unavailable: 'content_unavailable',
});

export function decisionOutcomeOf(outcome: ReviewOutcome): DecisionOutcome {
  return DECISION_OUTCOME_BY_REVIEW[outcome];
}
