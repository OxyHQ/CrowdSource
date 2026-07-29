import { describe, expect, it } from 'vitest';
import type {
  FindingContext,
  RecommendedAction,
  ReviewFinding,
  Severity,
} from '@oxyhq/crowdsource-contracts';

import {
  CONSENSUS_RISKS,
  MINIMUM_AGREEING_VOTES,
  ROUND_AGREEING_VOTES,
  decisionOutcomeOf,
  evaluateConsensus,
  hasCriticalConflict,
  positionKey,
  positionOf,
  requiredAgreeingVotes,
  riskOf,
  tallyPositions,
  type Ballot,
  type ConsensusRisk,
  type ReviewPosition,
} from '../modules/consensus/consensus';
import { SENSITIVITY_CLASSES } from '../modules/triage/triage';
import { MAX_PANEL_ROUND } from '../modules/sortition/panelSpec';
import { REVIEW_OUTCOMES } from '@oxyhq/crowdsource-contracts';

/**
 * §9.4's consensus engine, at the level §9.4 states it.
 *
 * No database. The engine is a pure function of the ballots and the shape of the
 * panel, which is what lets "consensus is not a vote count" be tested as the
 * claim it is rather than inferred from six collections of fixtures.
 *
 * Three guards here are load-bearing and each carries a mutation test that
 * breaks the thing it guards and confirms the check fails AND names what it
 * caught:
 *
 *   1. the agreement-across-dimensions key (§9.4's six dimensions),
 *   2. the tie handling (§9.6, Appendix F: absence of consensus is neither
 *      guilt nor innocence),
 *   3. the threshold composition of §9.4's risk table with §8.6's ladder.
 */

const CODE = 'harassment.targeted_abuse' as const;

interface BallotOptions {
  readonly reviewerId: string;
  readonly outcome?: Ballot['outcome'];
  readonly contextSufficiency?: Ballot['contextSufficiency'];
  readonly code?: ReviewFinding['code'];
  readonly resourceIds?: readonly string[];
  readonly severity?: Severity;
  readonly context?: FindingContext;
  readonly noFindings?: boolean;
  readonly recommendedActions?: readonly RecommendedAction[];
  readonly reviewerState?: Ballot['reviewerState'];
  readonly isSpecialist?: boolean;
}

function ballot(options: BallotOptions): Ballot {
  return {
    reviewerId: options.reviewerId,
    outcome: options.outcome ?? 'violation',
    contextSufficiency: options.contextSufficiency ?? 'sufficient',
    findings: options.noFindings
      ? []
      : [
          {
            code: options.code ?? CODE,
            resourceIds: [...(options.resourceIds ?? ['res_post'])],
            severity: options.severity ?? 'medium',
            ...(options.context === undefined ? {} : { context: options.context }),
            confidence: 0.9,
          },
        ],
    recommendedActions: [...(options.recommendedActions ?? [])],
    reviewerState: options.reviewerState ?? 'trusted',
    isSpecialist: options.isSpecialist ?? false,
  };
}

/** A unanimous panel of `size`, all holding the same position. */
function unanimous(size: number, options: Omit<BallotOptions, 'reviewerId'> = {}): Ballot[] {
  return Array.from({ length: size }, (_unused, index) =>
    ballot({ ...options, reviewerId: `rvw_${index}` }),
  );
}

describe('§9.4: the six dimensions are one agreement, not six checks', () => {
  const base = ballot({ reviewerId: 'rvw_a' });

  /**
   * Every dimension §9.4 names, each on its own line, each proved to MATTER by
   * changing only it. If a dimension were dropped from the key, exactly one of
   * these rows would start reporting agreement.
   */
  const dimensions: readonly { readonly name: string; readonly differing: Ballot }[] = [
    { name: 'outcome', differing: ballot({ reviewerId: 'rvw_b', outcome: 'no_violation' }) },
    {
      name: 'taxonomic family',
      differing: ballot({ reviewerId: 'rvw_b', code: 'privacy.personal_information' }),
    },
    {
      name: 'affected resource',
      differing: ballot({ reviewerId: 'rvw_b', resourceIds: ['res_image'] }),
    },
    { name: 'severity', differing: ballot({ reviewerId: 'rvw_b', severity: 'high' }) },
    {
      name: 'context sufficiency',
      differing: ballot({
        reviewerId: 'rvw_b',
        outcome: 'insufficient_context',
        contextSufficiency: 'insufficient',
      }),
    },
    { name: 'relevant exception', differing: ballot({ reviewerId: 'rvw_b', context: 'artistic' }) },
  ];

  it('names all six of §9.4’s dimensions', () => {
    // A vacuity floor: a table that lost a row would otherwise quietly stop
    // testing a dimension while every remaining row still passed.
    expect(dimensions).toHaveLength(6);
  });

  it.each(dimensions)('a difference in $name is a disagreement', ({ differing }) => {
    expect(positionKey(positionOf(base))).not.toBe(positionKey(positionOf(differing)));
  });

  it('two identical opinions agree, whatever order the findings were written in', () => {
    const one: Ballot = {
      ...base,
      findings: [
        { code: CODE, resourceIds: ['res_post'], severity: 'medium', confidence: 0.9 },
        { code: 'privacy.location_exposure', resourceIds: ['res_a'], severity: 'low', confidence: 0.4 },
      ],
    };
    const other: Ballot = {
      ...base,
      reviewerId: 'rvw_b',
      findings: [one.findings[1], one.findings[0]],
    };

    expect(positionKey(positionOf(one))).toBe(positionKey(positionOf(other)));
  });

  it('the primary finding is the most severe one, ties broken by code', () => {
    const mixed = positionOf({
      ...base,
      findings: [
        { code: 'privacy.location_exposure', resourceIds: ['res_a'], severity: 'low', confidence: 0.4 },
        { code: CODE, resourceIds: ['res_post'], severity: 'high', confidence: 0.9 },
      ],
    });

    expect(mixed.family).toBe('harassment');
    expect(mixed.severity).toBe('high');
    // The resource dimension is the UNION: both are affected.
    expect(mixed.resourceIds).toEqual(['res_a', 'res_post']);
  });

  /**
   * The mutation test §9.4 is actually about.
   *
   * A "majority on violation" engine — one that compares only the outcome — is
   * the specific wrong thing the plan opens the section by warning against. Here
   * it is, written out, agreeing with a panel the real key correctly refuses.
   */
  it('mutation: an engine that compared only the outcome would call this consensus', () => {
    const panel = [
      ballot({ reviewerId: 'rvw_a' }),
      ballot({ reviewerId: 'rvw_b', code: 'privacy.personal_information' }),
      ballot({ reviewerId: 'rvw_c', resourceIds: ['res_image'], severity: 'critical' }),
    ];

    const outcomeOnly = new Set(panel.map((entry) => entry.outcome));
    expect(outcomeOnly.size, 'the weakened key sees one agreed position').toBe(1);

    const real = tallyPositions(panel);
    expect(real, 'the real key sees three').toHaveLength(3);
    expect(real[0].votes).toBe(1);

    const verdict = evaluateConsensus({
      ballots: panel,
      round: 1,
      risk: 'low',
      finalRound: MAX_PANEL_ROUND,
    });
    expect(verdict.status).toBe('expand');
  });

  /**
   * And the same mutation from the other side: each dimension deleted in turn
   * from a weakened key, and the panel that only that deletion would wave
   * through.
   */
  it.each([
    { dropped: 'family', differing: ballot({ reviewerId: 'rvw_b', code: 'privacy.personal_information' }) },
    { dropped: 'resourceIds', differing: ballot({ reviewerId: 'rvw_b', resourceIds: ['res_image'] }) },
    { dropped: 'severity', differing: ballot({ reviewerId: 'rvw_b', severity: 'critical' }) },
    { dropped: 'context', differing: ballot({ reviewerId: 'rvw_b', context: 'satire' }) },
  ])('mutation: a key without $dropped would agree where the real one does not', ({ dropped, differing }) => {
    const weakened = (position: ReviewPosition): string =>
      JSON.stringify(
        Object.entries(position)
          .filter(([field]) => field !== dropped)
          .map(([, value]) => value),
      );

    expect(weakened(positionOf(base))).toBe(weakened(positionOf(differing)));
    expect(positionKey(positionOf(base))).not.toBe(positionKey(positionOf(differing)));
  });
});

describe('§8.6 and §9.4: the threshold is the stricter of the ladder and the risk row', () => {
  it('uses §8.6’s ladder verbatim', () => {
    expect(ROUND_AGREEING_VOTES).toEqual({ 1: 3, 2: 4, 3: 5 });
  });

  it('uses §9.4’s risk minimums verbatim', () => {
    expect(MINIMUM_AGREEING_VOTES.low).toBe(3);
    expect(MINIMUM_AGREEING_VOTES.medium).toBe(4);
    expect(MINIMUM_AGREEING_VOTES.high).toBe(5);
    // §9.4: a critical case "no se decide mediante jurado comunitario estándar".
    expect(MINIMUM_AGREEING_VOTES.critical).toBe(Number.POSITIVE_INFINITY);
  });

  it('maps every sensitivity class triage can compute onto a risk row', () => {
    for (const sensitivity of SENSITIVITY_CLASSES) {
      expect(CONSENSUS_RISKS).toContain(riskOf(sensitivity));
    }
    expect(riskOf('standard')).toBe('low');
    expect(riskOf('prohibited')).toBe('critical');
  });

  /**
   * THE CONTRADICTION IN THE PLAN, asserted rather than smoothed over.
   *
   * §8.6 says a unanimous round-1 panel of three decides. §9.4 says the minimum
   * at medium risk is four of five, which three jurors cannot reach however
   * unanimous they are. The two sections are only consistent for low risk.
   *
   * This is implemented as the stricter of the two — "regla mínima" states a
   * floor, and a ladder rung below the floor does not decide — and the
   * consequence is that a medium- or high-risk case ALWAYS expands past round
   * one. The alternative readings both change the plan: lowering §9.4's
   * thresholds weakens exactly the material the plan wanted a stronger bar for,
   * and raising §8.6's panel sizes makes every case cost five reviewers.
   */
  it('§9.4’s medium row makes §8.6’s round-1 decision unreachable', () => {
    expect(requiredAgreeingVotes(1, 'low')).toBe(3);
    expect(requiredAgreeingVotes(1, 'medium')).toBe(4);
    expect(requiredAgreeingVotes(1, 'high')).toBe(5);

    const seatsAtRoundOne = 3;
    expect(requiredAgreeingVotes(1, 'medium')).toBeGreaterThan(seatsAtRoundOne);
    expect(requiredAgreeingVotes(1, 'high')).toBeGreaterThan(seatsAtRoundOne);
  });

  it('so a unanimous medium-risk panel of three expands instead of deciding', () => {
    const verdict = evaluateConsensus({
      ballots: unanimous(3),
      round: 1,
      risk: 'medium',
      finalRound: MAX_PANEL_ROUND,
    });

    expect(verdict.status).toBe('expand');
    if (verdict.status !== 'expand') throw new Error('expected an expansion');
    expect(verdict.reason).toBe('below_threshold');
    expect(verdict.leadingVotes).toBe(3);
  });

  it('while the same panel at low risk decides (§15.5’s definition of done)', () => {
    const verdict = evaluateConsensus({
      ballots: unanimous(3),
      round: 1,
      risk: 'low',
      finalRound: MAX_PANEL_ROUND,
    });

    expect(verdict.status).toBe('consensus');
    if (verdict.status !== 'consensus') throw new Error('expected consensus');
    expect(verdict.winningVotes).toBe(3);
    expect(verdict.decisiveVotes).toBe(3);
    expect(verdict.position.outcome).toBe('violation');
  });

  it('refuses to invent a threshold for a round §8.6 never defined', () => {
    expect(() => requiredAgreeingVotes(4, 'low')).toThrow(/round 4/);
  });

  it('mutation: taking the ladder alone would decide a medium-risk case at round 1', () => {
    const ladderOnly = ROUND_AGREEING_VOTES[1];
    const composed = requiredAgreeingVotes(1, 'medium');

    expect(ladderOnly, 'the weakened rule').toBe(3);
    expect(composed, 'the composed rule').toBe(4);
    expect(unanimous(3)).toHaveLength(ladderOnly);
  });
});

describe('§8.6: a disagreement expands, and the ladder ends', () => {
  const split = [
    ballot({ reviewerId: 'rvw_a' }),
    ballot({ reviewerId: 'rvw_b' }),
    ballot({ reviewerId: 'rvw_c', outcome: 'no_violation', noFindings: true }),
  ];

  it('expands at round 1 on any disagreement', () => {
    const verdict = evaluateConsensus({
      ballots: split,
      round: 1,
      risk: 'low',
      finalRound: MAX_PANEL_ROUND,
    });
    expect(verdict.status).toBe('expand');
  });

  it('expands at round 2 when four of five do not agree', () => {
    const verdict = evaluateConsensus({
      ballots: [
        ...split,
        ballot({ reviewerId: 'rvw_d' }),
        ballot({ reviewerId: 'rvw_e', outcome: 'no_violation', noFindings: true }),
      ],
      round: 2,
      risk: 'low',
      finalRound: MAX_PANEL_ROUND,
    });
    expect(verdict.status).toBe('expand');
  });

  it('decides at round 2 when four of five do agree', () => {
    const verdict = evaluateConsensus({
      ballots: [...unanimous(4), ballot({ reviewerId: 'rvw_z', outcome: 'no_violation', noFindings: true })],
      round: 2,
      risk: 'low',
      finalRound: MAX_PANEL_ROUND,
    });

    expect(verdict.status).toBe('consensus');
    if (verdict.status !== 'consensus') throw new Error('expected consensus');
    expect(verdict.winningVotes).toBe(4);
    expect(verdict.decisiveVotes).toBe(5);
  });

  it('there is nowhere past round 3', () => {
    expect(MAX_PANEL_ROUND).toBe(3);
    const verdict = evaluateConsensus({
      ballots: unanimous(4).concat(
        Array.from({ length: 3 }, (_unused, index) =>
          ballot({ reviewerId: `rvw_x${index}`, outcome: 'no_violation', noFindings: true }),
        ),
      ),
      round: 3,
      risk: 'low',
      finalRound: MAX_PANEL_ROUND,
    });

    expect(verdict.status).toBe('exhausted');
  });
});

describe('Appendix F: the absence of consensus is neither guilt nor innocence', () => {
  /**
   * §15.5's definition of done, third clause: "un empate final NO se convierte
   * en no_violation". The tie below is deliberately built so that
   * `no_violation` is one of the two tied positions and carries as many votes as
   * `violation` — which is the exact shape an engine that "defaults to the safe
   * answer" would resolve the wrong way.
   */
  const tied = [
    ballot({ reviewerId: 'rvw_a' }),
    ballot({ reviewerId: 'rvw_b' }),
    ballot({ reviewerId: 'rvw_c' }),
    ballot({ reviewerId: 'rvw_d', outcome: 'no_violation', noFindings: true }),
    ballot({ reviewerId: 'rvw_e', outcome: 'no_violation', noFindings: true }),
    ballot({ reviewerId: 'rvw_f', outcome: 'no_violation', noFindings: true }),
    ballot({ reviewerId: 'rvw_g', outcome: 'content_unavailable', noFindings: true }),
  ];

  const verdict = evaluateConsensus({
    ballots: tied,
    round: 3,
    risk: 'low',
    finalRound: MAX_PANEL_ROUND,
  });

  it('reports a tie as a tie', () => {
    expect(verdict.status).toBe('exhausted');
    if (verdict.status !== 'exhausted') throw new Error('expected an exhausted ladder');
    expect(verdict.reason).toBe('tie');
    expect(verdict.leadingVotes).toBe(3);
    expect(verdict.decisiveVotes).toBe(7);
  });

  it('produces inconclusive, and specifically NOT no_violation', () => {
    if (verdict.status !== 'exhausted') throw new Error('expected an exhausted ladder');
    expect(verdict.outcome).toBe('inconclusive');
    expect(verdict.outcome).not.toBe('no_violation');
    expect(verdict.outcome).not.toBe('violation');
  });

  it('mutation: a "largest group wins" engine would have published no_violation here', () => {
    /**
     * The specific broken engine this guards against: take the tally's first
     * entry and publish it. The tally IS ordered, deterministically, and that
     * ordering must never be mistaken for a resolution — so here is what
     * mistaking it would have produced.
     */
    const largestGroupWins = tallyPositions(tied)[0];
    expect(largestGroupWins.votes).toBe(3);
    expect(
      ['violation', 'no_violation'],
      'the leading position is one of the two tied ones',
    ).toContain(largestGroupWins.position.outcome);

    // And the real engine refuses it.
    if (verdict.status !== 'exhausted') throw new Error('expected an exhausted ladder');
    expect(verdict.outcome).toBe('inconclusive');
  });

  /**
   * WHICH GUARD IS DOING THE WORK, stated rather than assumed.
   *
   * Breaking the tie check does NOT change the outcome of the panel above, and
   * pretending otherwise would be the kind of test that cannot distinguish
   * success from failure. On §8.6's ladder a tie can never also clear the
   * threshold — every rung asks for more than half its seats, and a tie needs
   * two positions at the leading count — so the COUNT is what refuses a tied
   * panel today and the tie branch contributes the `reason` an operator reads.
   *
   * Checked for every (round, risk) the ladder defines, so the claim cannot rot
   * quietly if a threshold moves.
   */
  it('on §8.6’s ladder, a tie can never also clear the threshold', () => {
    const seatsAtRound: Readonly<Record<number, number>> = { 1: 3, 2: 5, 3: 7 };

    for (const risk of CONSENSUS_RISKS) {
      for (const round of [1, 2, 3]) {
        const seats = seatsAtRound[round];
        const required = requiredAgreeingVotes(round, risk);
        // The largest count a tie permits on a full panel.
        const largestTiedCount = Math.floor(seats / 2);

        expect(
          largestTiedCount,
          `a tie could clear the threshold at round ${round}, risk ${risk}`,
        ).toBeLessThan(required);
      }
    }
  });

  it('mutation: the tie check is the net under a future ladder edit', () => {
    /**
     * The configuration the branch exists for: a panel where a tied position
     * DOES clear the threshold. It cannot arise from the current ladder — which
     * is the previous test — so it is constructed here, and it is exactly what a
     * lowered round-3 threshold would produce.
     */
    const tiedAtFour = [
      ...Array.from({ length: 4 }, (_unused, index) => ballot({ reviewerId: `rvw_v${index}` })),
      ...Array.from({ length: 4 }, (_unused, index) =>
        ballot({ reviewerId: `rvw_n${index}`, outcome: 'no_violation', noFindings: true }),
      ),
    ];

    const withoutTieCheck = tallyPositions(tiedAtFour)[0];
    expect(withoutTieCheck.votes).toBe(4);
    expect(withoutTieCheck.votes).toBeGreaterThanOrEqual(requiredAgreeingVotes(2, 'low'));

    const real = evaluateConsensus({
      ballots: tiedAtFour,
      round: 2,
      risk: 'low',
      finalRound: MAX_PANEL_ROUND,
    });

    // Without the branch this would publish `tallies[0]` — whose order is
    // decided by the lowest reviewer id in the group. A coin toss deciding a
    // moderation case.
    expect(real.status).toBe('expand');
    if (real.status !== 'expand') throw new Error('expected an expansion');
    expect(real.reason).toBe('tie');
  });

  it('never maps a review outcome onto inconclusive', () => {
    // §9.6's `inconclusive` is produced by the ENGINE and never voted for: a
    // single reviewer cannot fail to agree with themselves.
    for (const outcome of REVIEW_OUTCOMES) {
      expect(decisionOutcomeOf(outcome)).not.toBe('inconclusive');
      expect(decisionOutcomeOf(outcome)).not.toBe('escalated');
    }
    expect(decisionOutcomeOf('no_violation')).toBe('no_violation');
  });
});

describe('§9.4: the structural requirements are not about counting', () => {
  it('a medium-risk panel with no trusted reviewer does not decide', () => {
    const verdict = evaluateConsensus({
      ballots: unanimous(5, { reviewerState: 'community' }),
      round: 2,
      risk: 'medium',
      finalRound: MAX_PANEL_ROUND,
    });

    expect(verdict.status).toBe('expand');
    if (verdict.status !== 'expand') throw new Error('expected an expansion');
    expect(verdict.reason).toBe('requirements_unmet');
    expect(verdict.unmet).toEqual(['trusted_reviewer_present']);
    // The votes were there; the panel was not.
    expect(verdict.leadingVotes).toBe(5);
  });

  it('the same panel with one trusted reviewer decides', () => {
    const verdict = evaluateConsensus({
      ballots: [
        ...unanimous(4, { reviewerState: 'community' }),
        ballot({ reviewerId: 'rvw_t', reviewerState: 'trusted' }),
      ],
      round: 2,
      risk: 'medium',
      finalRound: MAX_PANEL_ROUND,
    });

    expect(verdict.status).toBe('consensus');
  });

  it('a high-risk panel with no specialist escalates rather than concluding', () => {
    const verdict = evaluateConsensus({
      ballots: unanimous(7, { reviewerState: 'trusted' }),
      round: 3,
      risk: 'high',
      finalRound: MAX_PANEL_ROUND,
    });

    expect(verdict.status).toBe('exhausted');
    if (verdict.status !== 'exhausted') throw new Error('expected an exhausted ladder');
    // §9.6: "requiere especialistas, Trust and Safety o un proceso externo."
    // More community jurors would not have helped, so it is not inconclusive.
    expect(verdict.outcome).toBe('escalated');
    expect(verdict.unmet).toEqual(['specialist_present']);
  });

  it('a high-risk panel with a specialist and no conflict decides at five of seven', () => {
    const verdict = evaluateConsensus({
      ballots: [
        ...unanimous(5, { reviewerState: 'trusted' }),
        ballot({ reviewerId: 'rvw_s', isSpecialist: true, reviewerState: 'specialist' }),
        ballot({ reviewerId: 'rvw_o', outcome: 'no_violation', noFindings: true }),
      ],
      round: 3,
      risk: 'high',
      finalRound: MAX_PANEL_ROUND,
    });

    expect(verdict.status).toBe('consensus');
    if (verdict.status !== 'consensus') throw new Error('expected consensus');
    expect(verdict.winningVotes).toBe(6);
  });

  describe('§9.4’s "conflicto crítico entre hallazgos"', () => {
    it('is a disagreement about the family at a severity that matters', () => {
      expect(
        hasCriticalConflict([
          ballot({ reviewerId: 'rvw_a', code: 'harassment.credible_threat', severity: 'critical' }),
          ballot({ reviewerId: 'rvw_b', code: 'integrity.spam', severity: 'low' }),
        ]),
      ).toBe(true);
    });

    it('is not every disagreement', () => {
      // Same family, opposite verdicts, ordinary severity: that is what the vote
      // count is for.
      expect(
        hasCriticalConflict([
          ballot({ reviewerId: 'rvw_a', severity: 'low' }),
          ballot({ reviewerId: 'rvw_b', outcome: 'no_violation', noFindings: true }),
        ]),
      ).toBe(false);
    });

    it('stops a high-risk panel deciding even at five of seven', () => {
      const verdict = evaluateConsensus({
        ballots: [
          ...Array.from({ length: 5 }, (_unused, index) =>
            ballot({ reviewerId: `rvw_m${index}`, severity: 'high', isSpecialist: index === 0 }),
          ),
          ballot({ reviewerId: 'rvw_c1', code: 'child_safety.grooming', severity: 'critical' }),
          ballot({ reviewerId: 'rvw_c2', code: 'child_safety.grooming', severity: 'critical' }),
        ],
        round: 3,
        risk: 'high',
        finalRound: MAX_PANEL_ROUND,
      });

      expect(verdict.status).toBe('exhausted');
      if (verdict.status !== 'exhausted') throw new Error('expected an exhausted ladder');
      expect(verdict.outcome).toBe('escalated');
      expect(verdict.unmet).toContain('no_critical_conflict');
    });
  });

  it('a critical-risk case is never decided by a community jury', () => {
    const verdict = evaluateConsensus({
      ballots: unanimous(7, { isSpecialist: true, reviewerState: 'specialist' }),
      round: 3,
      risk: 'critical',
      finalRound: MAX_PANEL_ROUND,
    });

    expect(verdict.status).toBe('exhausted');
    if (verdict.status !== 'exhausted') throw new Error('expected an exhausted ladder');
    expect(verdict.outcome).toBe('escalated');
  });
});

describe('the engine cannot see a reviewer’s standing when it counts', () => {
  /**
   * §8.4 and §9.5 both say reliability never multiplies a vote.
   * `weightSeparation.test.ts` holds the structural half — the selection weight
   * never leaves the draw. This holds the behavioural half: the same ballots
   * cast by a panel of specialists and by a panel of newcomers reach the
   * identical verdict.
   */
  it('reaches the identical verdict whoever cast the ballots', () => {
    const ballots = [
      ballot({ reviewerId: 'rvw_a' }),
      ballot({ reviewerId: 'rvw_b' }),
      ballot({ reviewerId: 'rvw_c', outcome: 'no_violation', noFindings: true }),
    ];
    const promoted = ballots.map((entry) => ({
      ...entry,
      reviewerState: 'specialist' as const,
      isSpecialist: true,
    }));

    const forEveryRisk = (panel: readonly Ballot[]): string[] =>
      CONSENSUS_RISKS.map((risk: ConsensusRisk) =>
        JSON.stringify(
          evaluateConsensus({ ballots: panel, round: 3, risk, finalRound: MAX_PANEL_ROUND }),
        ),
      );

    // The two panels differ ONLY in standing, and at low risk — where §9.4 asks
    // nothing of the composition — the verdicts are byte-identical.
    expect(forEveryRisk(ballots)[0]).toBe(forEveryRisk(promoted)[0]);
  });
});
