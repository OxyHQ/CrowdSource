import { describe, expect, it } from 'vitest';
import type { DecisionFinding, DecisionRecommendedAction } from '@oxyhq/crowdsource-contracts';

import {
  appealRequiredVotes,
  appealStandardFor,
  severeConsequence,
} from '../modules/appeals/appeal.service';
import {
  authorTextRedactionRules,
  redactAuthorContext,
  redactAuthorText,
} from '../modules/appeals/appealContext';
import { evaluateConsensus, requiredAgreeingVotes, type Ballot } from '../modules/consensus/consensus';
import type { CaseDocument } from '../modules/cases/case.collection';
import type { DecisionDocument } from '../modules/decision/decision.collection';
import {
  APPEAL_MIN_ROUND,
  panelRoundFor,
  panelSpecFor,
  SLOT_FALLBACKS,
  satisfiesSlot,
} from '../modules/sortition/panelSpec';
import { drawPanel } from '../modules/sortition/weightedSampling';
import { SEED_BYTES } from '../modules/sortition/seededRandom';

/**
 * §9.4's appeal row and §7.5's specialist route, at the level they are stated at.
 *
 * Everything here is pure: the ladder is data, the threshold is arithmetic, the
 * redaction is a string function and the draw is deterministic given a seed. A
 * rule that can be checked without a database should be, because that is the
 * version of the check that says which SENTENCE of the plan broke rather than
 * which end-to-end flow stopped working.
 */

/**
 * The two fields `severeConsequence` reads, and no cast anywhere.
 *
 * Its parameter is `Pick<DecisionDocument, 'recommendedActions' | 'findings'>`
 * precisely so this is possible: a fixture that had to invent a jury, a confidence
 * and a policy version would hide which fields the judgement depends on, and this
 * file exists to pin exactly that.
 */
function decisionWith(
  recommendedActions: DecisionRecommendedAction[],
  findings: DecisionFinding[],
): Pick<DecisionDocument, 'recommendedActions' | 'findings'> {
  return { recommendedActions, findings };
}

const localFinding: DecisionFinding = {
  /**
   * A code that is NOT in `findingScope.ts`'s table, so its scope stays
   * `application_local` — which is what makes the "not severe" assertions below
   * mean something rather than passing by accident.
   */
  code: 'platform_abuse.automation_abuse',
  resourceIds: ['res_post'],
  severity: 'medium',
  scope: 'application_local',
};

describe('§9.4: what counts as a severe action', () => {
  it('is severe when the application was asked to remove, hide, throttle or suspend', () => {
    for (const action of [
      'remove',
      'remove_or_restrict',
      'hide',
      'reduce_distribution',
      'freeze_transaction',
      'suspend_user',
      'keep_restricted_temporarily',
    ] as const) {
      expect(severeConsequence(decisionWith([{ action }], [localFinding])), action).toBe(true);
    }
  });

  it('is NOT severe when the recommendation only annotates or narrows an audience', () => {
    /**
     * The condition has to be able to be FALSE, or §9.4's "cuando la acción sea
     * grave" describes nothing and every appeal silently carries the raised
     * threshold.
     */
    for (const action of ['label', 'allow_with_label', 'age_gate', 'no_action', 'allow'] as const) {
      expect(severeConsequence(decisionWith([{ action }], [localFinding])), action).toBe(false);
    }
  });

  it('is severe when a finding is high or critical, whatever was recommended', () => {
    for (const severity of ['high', 'critical'] as const) {
      expect(
        severeConsequence(
          decisionWith([{ action: 'label' }], [{ ...localFinding, severity }]),
        ),
        severity,
      ).toBe(true);
    }
  });

  it('is severe when a finding may reach Oxy Trust (§11.7.5)', () => {
    /**
     * A decision that asked only for a label while making an `oxy_network` finding
     * has still moved something that follows the person across every Oxy
     * application — which is precisely what §9.8's correction has to reverse.
     */
    for (const scope of ['oxy_network', 'identity_integrity'] as const) {
      expect(
        severeConsequence(decisionWith([{ action: 'label' }], [{ ...localFinding, scope }])),
        scope,
      ).toBe(true);
    }

    expect(
      severeConsequence(decisionWith([{ action: 'label' }], [localFinding])),
    ).toBe(false);
  });

  it('is not severe for a decision that recommended nothing at all', () => {
    expect(severeConsequence(decisionWith([], []))).toBe(false);
  });
});

describe('§9.4: the appeal threshold', () => {
  const risk = 'low' as const;

  it('is the ladder’s when the action was not severe', () => {
    expect(
      appealRequiredVotes({
        round: APPEAL_MIN_ROUND,
        panelSeats: 5,
        risk,
        previousRequiredVotes: 3,
        severeAction: false,
      }),
    ).toBe(requiredAgreeingVotes(APPEAL_MIN_ROUND, risk));
  });

  it('is one MORE than the first decision’s when the action was severe', () => {
    /**
     * The first decision was a unanimous panel of three, which needed 3. §9.4:
     * "umbral superior al de la primera decisión cuando la acción sea grave", so
     * the appeal needs 4 — which on the appeal ladder's five seats is also what the
     * ladder asks, and the two agreeing is the ordinary case.
     */
    expect(
      appealRequiredVotes({
        round: APPEAL_MIN_ROUND,
        panelSeats: 5,
        risk,
        previousRequiredVotes: 3,
        severeAction: true,
      }),
    ).toBe(4);
  });

  it('rises above the ladder when the first decision itself cleared a high bar', () => {
    // A first decision at 5 of 7 (round 3) appealed onto a five-seat panel: the
    // ladder would ask 4, §9.4 asks 6, and the cap holds it at unanimity of five.
    expect(
      appealRequiredVotes({
        round: APPEAL_MIN_ROUND,
        panelSeats: 5,
        risk,
        previousRequiredVotes: 5,
        severeAction: true,
      }),
    ).toBe(5);

    // On seven seats there is room for the whole increment.
    expect(
      appealRequiredVotes({
        round: 3,
        panelSeats: 7,
        risk,
        previousRequiredVotes: 5,
        severeAction: true,
      }),
    ).toBe(6);
  });

  it('never asks for more votes than the panel has seats', () => {
    /**
     * Without the cap a chain of appeals asks for eight of seven, which is a
     * threshold no panel can reach — every such case would end `inconclusive`
     * forever while the code reported that it was applying a rule.
     */
    for (const previous of [5, 6, 7, 8, 99]) {
      const required = appealRequiredVotes({
        round: 3,
        panelSeats: 7,
        risk,
        previousRequiredVotes: previous,
        severeAction: true,
      });
      expect(required, `previous ${previous}`).toBeLessThanOrEqual(7);
    }
  });

  it('never drops below the risk minimum §9.4 already set', () => {
    // A medium-risk case needs 4 whatever an appeal says; a high-risk one needs 5.
    expect(
      appealRequiredVotes({
        round: APPEAL_MIN_ROUND,
        panelSeats: 5,
        risk: 'high',
        previousRequiredVotes: 1,
        severeAction: true,
      }),
    ).toBe(5);
  });
});

describe('§9.4: the standard recorded on an appeal when it is filed', () => {
  function caseWith(
    overrides: Partial<
      Pick<CaseDocument, 'reviewPool' | 'sensitivityClass' | 'currentRevision'>
    > = {},
  ): Pick<CaseDocument, 'caseId' | 'reviewPool' | 'sensitivityClass' | 'currentRevision'> {
    return {
      caseId: 'case_standard',
      reviewPool: 'community',
      sensitivityClass: 'standard',
      currentRevision: 1,
      ...overrides,
    };
  }

  function juryOf(size: number): DecisionDocument['jury'] {
    return { size, decisiveVotes: size, winningVotes: size, agreement: 1, specialistPresent: false };
  }

  it('derives the previous bar from the jury that decided, and raises it', () => {
    const standard = appealStandardFor(caseWith(), {
      ...decisionWith([{ action: 'remove_or_restrict' }], [localFinding]),
      jury: juryOf(3),
    });

    expect(standard.previousRequiredVotes).toBe(3);
    expect(standard.severeAction).toBe(true);
    expect(standard.requiredAgreeingVotes).toBe(4);
  });

  it('leaves the bar at the ladder’s when the decision was not severe', () => {
    const standard = appealStandardFor(caseWith(), {
      ...decisionWith([{ action: 'label' }], [localFinding]),
      jury: juryOf(3),
    });

    expect(standard.severeAction).toBe(false);
    expect(standard.requiredAgreeingVotes).toBe(requiredAgreeingVotes(APPEAL_MIN_ROUND, 'low'));
  });

  it('reads an appeal OF an appeal off the appeal ladder', () => {
    /**
     * A five-seat panel is round 2 on both ladders, but only the appeal ladder HAS
     * a five-seat first rung — and a case at revision 2 was decided on it. Reading
     * that panel off the first-instance ladder is the mistake this pins: it gives
     * the same answer today by coincidence and a different one the moment either
     * ladder changes.
     */
    const standard = appealStandardFor(caseWith({ currentRevision: 2 }), {
      ...decisionWith([{ action: 'suspend_user' }], [localFinding]),
      jury: juryOf(5),
    });

    expect(standard.previousRequiredVotes).toBe(4);
    // One more than the appeal it followed, capped at unanimity of five seats.
    expect(standard.requiredAgreeingVotes).toBe(5);
  });

  it('carries §9.4’s risk row through unchanged', () => {
    const standard = appealStandardFor(caseWith({ sensitivityClass: 'restricted' }), {
      ...decisionWith([{ action: 'label' }], [localFinding]),
      jury: juryOf(7),
    });

    // High risk needs five whatever the panel size, and the appeal cannot go below.
    expect(standard.previousRequiredVotes).toBe(5);
    expect(standard.requiredAgreeingVotes).toBe(5);
  });

  it('refuses to invent a standard for material no jury decides', () => {
    /**
     * §7.5 row 1's legal pool, and an untriaged case. Neither can reach the appeal
     * route — one is never drawn a jury and the other has no decision — and a
     * DEFAULT here would be a threshold invented for exactly the material the plan
     * routed away from juries.
     */
    for (const reviewPool of ['legal', null] as const) {
      expect(() =>
        appealStandardFor(caseWith({ reviewPool }), {
          ...decisionWith([], []),
          jury: juryOf(3),
        }),
      ).toThrow(/no community or specialist jury pool/);
    }
  });

  it('refuses to derive a risk row for a case triage never classified', () => {
    expect(() =>
      appealStandardFor(caseWith({ sensitivityClass: null }), {
        ...decisionWith([], []),
        jury: juryOf(3),
      }),
    ).toThrow(/no sensitivity class/);
  });
});

describe('the engine applies the appeal standard and only ever upward', () => {
  function ballot(reviewerId: string, outcome: 'violation' | 'no_violation'): Ballot {
    return {
      reviewerId,
      outcome,
      contextSufficiency: 'sufficient',
      findings:
        outcome === 'violation'
          ? [
              {
                code: 'harassment.targeted_abuse',
                resourceIds: ['res_post'],
                severity: 'medium',
                confidence: 0.9,
              },
            ]
          : [],
      recommendedActions: outcome === 'violation' ? ['remove_or_restrict'] : ['restore'],
      reviewerState: 'trusted',
      isSpecialist: false,
    };
  }

  /** Four of five agreeing: exactly the round-2 ladder, nothing to spare. */
  const fourOfFive: readonly Ballot[] = [
    ballot('rvw_1', 'no_violation'),
    ballot('rvw_2', 'no_violation'),
    ballot('rvw_3', 'no_violation'),
    ballot('rvw_4', 'no_violation'),
    ballot('rvw_5', 'violation'),
  ];

  it('publishes four of five when no appeal standard applies', () => {
    const verdict = evaluateConsensus({
      ballots: fourOfFive,
      round: 2,
      risk: 'low',
      finalRound: 3,
      appeal: null,
    });
    expect(verdict.status).toBe('consensus');
  });

  it('expands the same panel when the appeal demands five', () => {
    const verdict = evaluateConsensus({
      ballots: fourOfFive,
      round: 2,
      risk: 'low',
      finalRound: 3,
      appeal: { requiredAgreeingVotes: 5 },
    });

    expect(verdict.status).toBe('expand');
    if (verdict.status !== 'expand') throw new Error('expected an expansion');
    expect(verdict.reason).toBe('below_threshold');
    expect(verdict.leadingVotes).toBe(4);
  });

  it('refuses to LOWER the bar, whatever an appeal carries', () => {
    /**
     * The mutation this guards against is a `Math.max` becoming an assignment: an
     * appeal is a higher standard by definition, and a stored number that somehow
     * came out below the ladder's must not become the threshold.
     */
    const threeOfFive: readonly Ballot[] = [
      ballot('rvw_1', 'no_violation'),
      ballot('rvw_2', 'no_violation'),
      ballot('rvw_3', 'no_violation'),
      ballot('rvw_4', 'violation'),
      ballot('rvw_5', 'violation'),
    ];

    const verdict = evaluateConsensus({
      ballots: threeOfFive,
      round: 2,
      risk: 'low',
      finalRound: 3,
      appeal: { requiredAgreeingVotes: 1 },
    });

    expect(verdict.status).toBe('expand');
  });
});

describe('§9.4: the appeal ladder starts at five seats', () => {
  it('has no rung below §9.4’s minimum, in either pool', () => {
    for (const pool of ['community', 'specialist'] as const) {
      expect(() => panelSpecFor(pool, 1, true)).toThrow(/appeal panel specification/);
      expect(panelSpecFor(pool, APPEAL_MIN_ROUND, true).slots).toHaveLength(5);
      expect(panelSpecFor(pool, 3, true).slots).toHaveLength(7);
    }
  });

  it('reads an empty appeal panel as round 2, so the first draw is five seats', () => {
    expect(panelRoundFor('community', 0, true)).toBe(APPEAL_MIN_ROUND);
    expect(panelRoundFor('community', 3, true)).toBe(APPEAL_MIN_ROUND);
    expect(panelRoundFor('community', 5, true)).toBe(2);
    expect(panelRoundFor('community', 7, true)).toBe(3);

    // And the first-instance ladder is untouched: three seats is still round 1.
    expect(panelRoundFor('community', 3, false)).toBe(1);
  });

  it('seats an appeals reviewer, and no newcomer, on a community appeal', () => {
    const slots = panelSpecFor('community', APPEAL_MIN_ROUND, true).slots;

    expect(slots).toContain('appeals_reviewer');
    /**
     * §8.3's renewal argument is about first-instance panels. A panel whose job is
     * to weigh a decision another panel reached is not where a reviewer with fewer
     * than ten reviews belongs, and §9.4 raises the bar for appeals rather than
     * lowering it.
     */
    expect(slots).not.toContain('calibrated_newcomer');
  });

  it('keeps §7.5’s restricted material with specialists, even on appeal', () => {
    /**
     * An appeals reviewer who is not a specialist in the family would be exactly
     * the general reviewer §7.5 says must never see this material. Experience does
     * not substitute for competence and consent in a restricted category.
     */
    expect([...new Set(panelSpecFor('specialist', APPEAL_MIN_ROUND, true).slots)]).toEqual([
      'category_specialist',
    ]);
    expect(panelSpecFor('specialist', 3, true).slots).not.toContain('appeals_reviewer');
  });

  it('the appeals seat requires the state, and falls back without lowering reliability', () => {
    const facts = {
      reliability: 0.9,
      completedReviewCount: 500,
      specialistCategories: [],
    } as const;

    expect(satisfiesSlot('appeals_reviewer', { ...facts, state: 'appeals' }, null)).toBe(true);
    expect(satisfiesSlot('appeals_reviewer', { ...facts, state: 'specialist' }, null)).toBe(false);
    expect(satisfiesSlot('appeals_reviewer', { ...facts, state: 'trusted' }, null)).toBe(false);
    // The fallback keeps the reliability floor: an unreliable reviewer fills
    // neither class.
    expect(
      satisfiesSlot('reliable_general', { ...facts, reliability: 0.5, state: 'appeals' }, null),
    ).toBe(false);
    expect(SLOT_FALLBACKS.appeals_reviewer).toEqual(['appeals_reviewer', 'reliable_general']);
  });
});

describe('§7.5: the specialist pool has no fallback, on appeal or otherwise', () => {
  const seed = Buffer.alloc(SEED_BYTES, 7);

  /**
   * Seven candidates who are reliable generalists and specialists in nothing.
   *
   * Seven and not five so the pool-size guard cannot answer for the rule under
   * test: a round-3 spec asks for seven seats, and `candidate_pool_too_small`
   * would refuse before any slot was considered — which would pass this test while
   * proving nothing about §7.5.
   */
  const generalists = Array.from({ length: 7 }, (_, index) => ({
    reviewerId: `rvw_general_${index}`,
    selectionWeight: 1,
    reliability: 0.9,
    riskClusterId: null,
    eligibleSlots: ['reliable_general' as const],
  }));

  it('refuses a specialist panel rather than seating a general reviewer', () => {
    for (const round of [APPEAL_MIN_ROUND, 3]) {
      for (const appeal of [true, false]) {
        const spec = panelSpecFor('specialist', round, appeal);
        const outcome = drawPanel({
          spec,
          candidates: generalists,
          seed,
          slots: spec.slots,
          incumbents: [],
          affinityBlocked: new Map(),
        });

        expect(outcome.ok, `round ${round}, appeal ${String(appeal)}`).toBe(false);
        if (outcome.ok) throw new Error('expected a refusal');
        expect(outcome.reason).toBe('slot_unfillable');
        expect(outcome.slot).toBe('category_specialist');
      }
    }
  });

  it('would seat those same reviewers on a COMMUNITY panel, which is the contrast', () => {
    /**
     * The mutation guard for the test above: if `drawPanel` stopped filling
     * anything at all, the refusal would pass for the wrong reason. The community
     * appeal spec's specialist slot DOES fall back, so the same candidates seat a
     * full panel there — and the difference between the two is exactly the pool
     * rule §7.5 asks for.
     */
    const spec = panelSpecFor('community', APPEAL_MIN_ROUND, true);
    const outcome = drawPanel({
      spec,
      candidates: [
        ...generalists,
        {
          reviewerId: 'rvw_intermediate',
          selectionWeight: 1,
          reliability: 0.6,
          riskClusterId: null,
          eligibleSlots: ['intermediate' as const],
        },
      ],
      seed,
      slots: spec.slots,
      incumbents: [],
      affinityBlocked: new Map(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected a panel');
    expect(outcome.seats).toHaveLength(5);
    // The appeals seat was filled by its fallback, and the record says so.
    const appealsSeat = outcome.seats.find((seat) => seat.slotType === 'appeals_reviewer');
    expect(appealsSeat?.filledAs).toBe('reliable_general');
  });
});

describe('§9.8: the author’s context is validated and redacted', () => {
  it('every rule can fire', () => {
    // A rule nobody exercises is a rule that turns out to be a crash, or worse a
    // no-op, on the day it first matters.
    expect(authorTextRedactionRules()).toEqual([
      'authorization header value',
      'assignment of a secret-looking key',
      'json web token',
      'email address',
      'url',
      'telephone number',
      'identifier-shaped number',
      'high-entropy token',
    ]);
  });

  it('removes the link that would deanonymise a juror', () => {
    /**
     * The one that matters most: a juror who opens an author-supplied URL tells the
     * person under review their IP and that their case is being looked at right
     * now. §9.1 and §13.8 both forbid that, and no care in the client fixes it.
     */
    expect(redactAuthorText('proof at https://track.invalid/p?j=1')).toBe(
      'proof at [link removed]',
    );
    expect(redactAuthorText('see track.invalid/p?j=1 please')).toBe('see [link removed] please');
    expect(redactAuthorText('data:text/html;base64,PHNjcmlwdD4=')).toBe('[link removed]');
    const script = redactAuthorText('javascript:fetch("//x.invalid")');
    expect(script).toContain('[link removed]');
    expect(script).not.toContain('javascript:');
    expect(script).not.toContain('x.invalid');
  });

  it('masks a credential, however it was written down', () => {
    /**
     * Four rules that fire on nothing else in this file, and each has to be shown
     * to fire: a rule that never matches is a rule that reads as protection while
     * providing none. This value is stored for as long as the case is (§13.4).
     */
    expect(redactAuthorText('the app sent Bearer abcdef1234567890')).toBe('the app sent [redacted]');
    expect(redactAuthorText('password="hunter2hunter2"')).toBe('[redacted]');
    expect(
      redactAuthorText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP'),
    ).toBe('[redacted]');
    expect(redactAuthorText(`opaque ${'A'.repeat(48)}`)).toBe('opaque [redacted]');
  });

  it('masks contact details and identifier-shaped numbers', () => {
    expect(redactAuthorText('write to me at author@example.com')).toBe(
      'write to me at [redacted]',
    );
    expect(redactAuthorText('call +34 600 123 456')).toBe('call [redacted]');
    expect(redactAuthorText('my id is 12345678Z and my card 4111 1111 1111 1111')).toContain(
      '[redacted]',
    );
  });

  it('leaves the dates and small numbers a defence is made of', () => {
    /**
     * A length-based rule redacts `2026-07-01`, which is ten characters and eight
     * digits. The rule counts DIGITS for exactly this reason: an author citing when
     * something was published is making their case, not leaking an identity.
     */
    expect(redactAuthorText('published on 2026-07-01, rule 2 of 5')).toBe(
      'published on 2026-07-01, rule 2 of 5',
    );
  });

  it('strips what rewrites the reader’s screen', () => {
    const spoofed = `I said ‮my account is fine‬​`;
    const redacted = redactAuthorText(spoofed);

    expect(redacted).not.toMatch(/[‪-‮​-‏⁦-⁩]/);
    expect(redacted).toContain('I said');
  });

  it('keeps the hostile text the appeal is ABOUT', () => {
    /**
     * The mirror of every rule above. An author defending a post that quoted a
     * threat has to be able to quote it back, and a filter that refused the
     * sentence would refuse the defence itself.
     */
    const quoted = 'The post quoted "I will find you" to report it, that is the whole point';
    expect(redactAuthorText(quoted)).toBe(quoted);
    expect(redactAuthorText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  it('collapses padding that would push the case off a reviewer’s screen', () => {
    expect(redactAuthorText(`first${'\n'.repeat(40)}second   \t  word`)).toBe(
      'first\n\nsecond word',
    );
  });

  it('never stores an empty statement', () => {
    // A statement that was ENTIRELY a phone number redacts to nothing; an empty box
    // labelled "the author explained" is worse than a marker.
    const context = redactAuthorContext({ statement: '+34 600 123 456' });
    expect(context.statement).toBe('[redacted]');
  });

  it('redacts structured values and keeps structured keys', () => {
    const context = redactAuthorContext({
      statement: 'context',
      resourceIds: ['res_post'],
      fields: { source: 'https://elpais.invalid/a', pages: 12, verified: false, note: null },
    });

    expect(context.fields).toEqual({
      source: '[link removed]',
      pages: 12,
      verified: false,
      note: null,
    });
    expect(context.resourceIds).toEqual(['res_post']);
  });
});
