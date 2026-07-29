import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_COEFFICIENTS,
  CONTEXT_FACTOR,
  LOW_CONFIDENCE_THRESHOLD,
  confidenceScore,
} from '../modules/consensus/confidence';
import { findingAttributionOf, findingScopeOf } from '../modules/consensus/findingScope';
import { categoryReliability } from '../modules/reviewer/reliability';
import type { ReviewerProfileDocument } from '../modules/reviewer/reviewer.collection';

/**
 * §9.5's confidence score and §6.5's finding scope — the two numbers a decision
 * carries that are ABOUT the decision rather than part of it.
 *
 * §9.5 is one sentence away from being dangerous: a score computed from
 * reviewer quality is exactly the shape of a weighted vote, and the sentence
 * that separates them — "sirve para comunicar calidad y activar escalados, no
 * para multiplicar votos ni para calcular puntos de reputación" — is only true
 * if the ordering holds. So the assertions here are as much about what
 * confidence CANNOT do as about the arithmetic.
 */

describe('§9.5: the formula, verbatim', () => {
  it('uses the plan’s coefficients unchanged', () => {
    expect(CONFIDENCE_COEFFICIENTS).toEqual({
      agreement: 0.6,
      panelQuality: 0.3,
      contextFactor: 0.1,
    });
  });

  it('uses the plan’s context factor: 1.0 if sufficient else 0.5', () => {
    expect(CONTEXT_FACTOR).toEqual({ sufficient: 1.0, insufficient: 0.5 });
  });

  it('computes 0.60·agreement + 0.30·panelQuality + 0.10·contextFactor', () => {
    // 0.6·(4/5) + 0.3·0.8 + 0.1·1.0 = 0.48 + 0.24 + 0.10 = 0.82
    expect(
      confidenceScore({
        winningDecisiveVotes: 4,
        decisiveVotes: 5,
        reviewerQuality: [0.8, 0.8, 0.8, 0.8, 0.8],
        contextSufficiency: 'sufficient',
      }),
    ).toBe(0.82);
  });

  /**
   * APPENDIX B'S OWN NUMBERS DO NOT SATISFY §9.5'S FORMULA, and this is the
   * assertion that says so rather than the code quietly bending to fit.
   *
   * The reference Decision states `agreement: 0.8` (four winning votes of five
   * decisive) and `confidence: 0.91`. Under §9.5 the agreement term is fixed at
   * 0.6 × 0.8 = 0.48, and the two remaining terms are bounded by 0.30 and 0.10,
   * so the highest confidence that panel can carry is 0.88 — reached only by a
   * panel of perfectly reliable reviewers who had sufficient context. 0.91 is
   * unreachable by 0.03.
   *
   * Implemented as the plan's formula says, with the discrepancy asserted, on
   * the same reasoning as §8.4's unreachable upper clamp: rescaling the
   * coefficients to make one appendix value come out right would change what
   * confidence MEANS for every decision, to match a number the appendix does
   * not show its working for.
   */
  it('documents that Appendix B’s confidence is above what §9.5 can produce', () => {
    const bestPossibleForAppendixB = confidenceScore({
      winningDecisiveVotes: 4,
      decisiveVotes: 5,
      reviewerQuality: [1, 1, 1, 1, 1],
      contextSufficiency: 'sufficient',
    });

    expect(bestPossibleForAppendixB).toBe(0.88);
    expect(bestPossibleForAppendixB).toBeLessThan(0.91);

    // And the realistic panel the appendix describes lands lower still.
    expect(
      confidenceScore({
        winningDecisiveVotes: 4,
        decisiveVotes: 5,
        reviewerQuality: [0.9, 0.9, 0.9, 0.9, 0.9],
        contextSufficiency: 'sufficient',
      }),
    ).toBe(0.85);
  });

  it('halves the context term when the panel said context was insufficient', () => {
    const sufficient = confidenceScore({
      winningDecisiveVotes: 3,
      decisiveVotes: 3,
      reviewerQuality: [0.5, 0.5, 0.5],
      contextSufficiency: 'sufficient',
    });
    const insufficient = confidenceScore({
      winningDecisiveVotes: 3,
      decisiveVotes: 3,
      reviewerQuality: [0.5, 0.5, 0.5],
      contextSufficiency: 'insufficient',
    });

    expect(sufficient - insufficient).toBeCloseTo(0.05, 10);
  });

  it('averages the WHOLE panel, not the winners (§9.7 forbids punishing a minority)', () => {
    const wholePanel = confidenceScore({
      winningDecisiveVotes: 3,
      decisiveVotes: 4,
      reviewerQuality: [1, 1, 1, 0],
      contextSufficiency: 'sufficient',
    });
    const winnersOnly = confidenceScore({
      winningDecisiveVotes: 3,
      decisiveVotes: 4,
      reviewerQuality: [1, 1, 1],
      contextSufficiency: 'sufficient',
    });

    // A confidence computed from the majority alone silently rewards agreeing
    // with the majority. The two must differ, and the real one is the lower.
    expect(wholePanel).toBeLessThan(winnersOnly);
  });

  it('clamps a corrupted stored reliability instead of trusting it', () => {
    const corrupted = confidenceScore({
      winningDecisiveVotes: 3,
      decisiveVotes: 3,
      reviewerQuality: [7, 7, 7],
      contextSufficiency: 'sufficient',
    });

    expect(corrupted).toBeLessThanOrEqual(1);
    expect(corrupted).toBe(
      confidenceScore({
        winningDecisiveVotes: 3,
        decisiveVotes: 3,
        reviewerQuality: [1, 1, 1],
        contextSufficiency: 'sufficient',
      }),
    );
  });

  it('survives a panel that reached no consensus at all', () => {
    // The non-consensus path publishes with zero winning votes; a division that
    // produced NaN here would store NaN on a decision.
    const inconclusive = confidenceScore({
      winningDecisiveVotes: 0,
      decisiveVotes: 7,
      reviewerQuality: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      contextSufficiency: 'insufficient',
    });

    expect(Number.isFinite(inconclusive)).toBe(true);
    expect(inconclusive).toBe(0.2);
  });

  it('is bounded, unlike §8.4’s selection weight whose upper clamp is unreachable', () => {
    /**
     * Worth stating because the two formulas look alike and behave differently.
     * §8.4's coefficients sum to 1.00 against a stated clamp of 1.25, so its
     * upper bound cannot be reached — `weightSeparation.test.ts` asserts that
     * dead bound. §9.5's coefficients also sum to 1.00, but its clamp IS [0, 1],
     * so both ends are attainable and the clamp is genuinely defensive.
     */
    const coefficientSum = Object.values(CONFIDENCE_COEFFICIENTS).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(coefficientSum).toBeCloseTo(1, 10);

    expect(
      confidenceScore({
        winningDecisiveVotes: 3,
        decisiveVotes: 3,
        reviewerQuality: [1, 1, 1],
        contextSufficiency: 'sufficient',
      }),
    ).toBe(1);
    expect(
      confidenceScore({
        winningDecisiveVotes: 0,
        decisiveVotes: 3,
        reviewerQuality: [0, 0, 0],
        contextSufficiency: 'insufficient',
      }),
    ).toBe(0.05);
  });
});

/**
 * The structural half of "confidence never decides anything".
 *
 * A source scan, because the behavioural tests can only show that confidence
 * does not currently change an outcome — they cannot show that nothing WILL.
 * The engine importing the confidence module would be the change, and this is
 * what fails when somebody makes it.
 */
describe('confidence is computed after the verdict and never feeds back', () => {
  const engineSource = readFileSync(
    path.resolve(__dirname, '..', 'modules', 'consensus', 'consensus.ts'),
    'utf8',
  );

  it('read the engine', () => {
    // Vacuity floor: an empty read would make every assertion below pass.
    expect(engineSource).toContain('export function evaluateConsensus');
    expect(engineSource.length).toBeGreaterThan(2000);
  });

  it('the engine imports neither confidence nor reviewer reliability', () => {
    const imports = engineSource
      .split('\n')
      .filter((line) => /^\s*(import|}\s*from)\b/.test(line) || /from\s+'\.\.?\//.test(line));
    const joined = imports.join('\n');

    expect(joined).not.toMatch(/from\s+'\.\/confidence'/);
    expect(joined).not.toMatch(/reliability/);
    expect(joined).not.toMatch(/selectionWeight/);
  });

  it('mutation: an engine that imported confidence would be caught, by name', () => {
    const offender = `${engineSource}\nimport { confidenceScore } from './confidence';\n`;
    const found = offender.match(/from\s+'\.\/confidence'/);

    expect(found).not.toBeNull();
    expect(engineSource.match(/from\s+'\.\/confidence'/)).toBeNull();
  });

  it('the low-confidence threshold is published but read by nothing that decides', () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.6);
    expect(engineSource).not.toContain('LOW_CONFIDENCE_THRESHOLD');
  });
});

describe('§6.5: how far a confirmed finding reaches', () => {
  it('defaults to the application, which is §6.5’s opening sentence', () => {
    expect(findingScopeOf('integrity.spam', 'high')).toBe('application_local');
    expect(findingScopeOf('commerce.misleading_listing', 'critical')).toBe('application_local');
  });

  it('lets confirmed targeted harassment reach conduct standing', () => {
    expect(findingScopeOf('harassment.targeted_abuse', 'medium')).toBe('oxy_network');
  });

  it('lets deliberate deception reach identity integrity', () => {
    expect(findingScopeOf('integrity.scam', 'high')).toBe('identity_integrity');
  });

  it('keeps low-severity findings local whatever their code (§6.5’s spam row)', () => {
    expect(findingScopeOf('harassment.targeted_abuse', 'low')).toBe('application_local');
    expect(findingScopeOf('integrity.scam', 'low')).toBe('application_local');
  });

  it('attributes conduct only to a violation', () => {
    expect(findingAttributionOf('violation')).toBe('author');
    expect(findingAttributionOf('no_violation')).toBeUndefined();
    expect(findingAttributionOf('inconclusive')).toBeUndefined();
    expect(findingAttributionOf('escalated')).toBeUndefined();
  });
});

describe('reviewer reliability is the minimum across the families, never the mean', () => {
  const profile = {
    reliabilityByCategory: { harassment: 0.2, integrity: 0.95 },
  } as unknown as ReviewerProfileDocument;

  it('takes the worst family a case alleges', () => {
    expect(categoryReliability(profile, ['harassment', 'integrity'])).toBe(0.2);
  });

  it('counts an unmeasured family as zero rather than as absent', () => {
    expect(categoryReliability(profile, ['integrity', 'hate'])).toBe(0);
  });

  it('mutation: a mean would carry a weak reviewer onto a case they are not ready for', () => {
    const mean = (0.2 + 0.95) / 2;
    expect(mean).toBeGreaterThan(0.5);
    expect(categoryReliability(profile, ['harassment', 'integrity'])).toBeLessThan(mean);
  });

  it('a case that alleges nothing measurable scores zero, not one', () => {
    expect(categoryReliability(profile, [])).toBe(0);
  });
});
