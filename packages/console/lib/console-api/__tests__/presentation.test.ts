/**
 * The product invariants that live in a colour and a dash.
 *
 * Both assertions below guard a decision that would otherwise be invisible to review:
 * a palette tidy-up that merged two tones, or a formatter that treated `null` as `0`,
 * changes what the console SAYS while changing nothing that looks like meaning.
 */

import {
  ABSENT,
  caseStatusTone,
  formatOptionalNumber,
  formatOptionalText,
  formatRatio,
  outcomeTone,
  standingTone,
} from '../presentation';
import { CASE_STATUSES, DECISION_OUTCOMES, APPLICATION_STANDINGS } from '../types';

describe('outcome tones', () => {
  it('never draws `inconclusive` as `no_violation`', () => {
    // Absence of consensus is neither guilt nor innocence. A jury that reviewed the
    // case and did not reach the threshold has said something different from a jury
    // that agreed nothing was wrong.
    expect(outcomeTone('inconclusive')).not.toBe(outcomeTone('no_violation'));
  });

  it('gives `inconclusive` a tone it shares with no other outcome', () => {
    // Not merely different from `no_violation`: distinct from every outcome, because
    // any tone it borrowed would claim the jury said that instead.
    const others = DECISION_OUTCOMES.filter((outcome) => outcome !== 'inconclusive');
    for (const outcome of others) {
      expect(outcomeTone(outcome)).not.toBe(outcomeTone('inconclusive'));
    }
  });

  it('keeps `insufficient_context` distinct from both', () => {
    // Three different things: the jury found a violation, found none, could not reach a
    // threshold, or did not have enough to judge on.
    expect(outcomeTone('insufficient_context')).not.toBe(outcomeTone('no_violation'));
    expect(outcomeTone('insufficient_context')).not.toBe(outcomeTone('inconclusive'));
  });

  it('assigns a tone to every outcome the API can send', () => {
    // Vacuity floor plus exhaustiveness: a switch missing a case would return
    // undefined and `StatusPill` would index its style table with it.
    for (const outcome of DECISION_OUTCOMES) {
      expect(typeof outcomeTone(outcome)).toBe('string');
    }
    expect(DECISION_OUTCOMES.length).toBe(7);
  });
});

describe('standing and status tones', () => {
  it('does not colour `sandbox` as a fault', () => {
    // Every application starts in sandbox and plenty stay there happily; colouring it
    // as a problem would make a normal state look like an incident on every row.
    expect(standingTone('sandbox')).not.toBe(standingTone('restricted'));
    expect(standingTone('sandbox')).not.toBe('danger');
  });

  it('assigns a tone to every standing and every case status', () => {
    for (const standing of APPLICATION_STANDINGS) {
      expect(typeof standingTone(standing)).toBe('string');
    }
    for (const status of CASE_STATUSES) {
      expect(typeof caseStatusTone(status)).toBe('string');
    }
    expect(CASE_STATUSES.length).toBe(10);
  });
});

describe('absent values', () => {
  it('renders an unmeasured figure as absent, never as zero', () => {
    // `evidenceIntegrity` and its siblings are null because nothing measures them.
    // Zero is the worst possible score for a signal that has never been taken.
    expect(formatOptionalNumber(null, formatRatio)).toBe(ABSENT);
    expect(formatOptionalNumber(null, formatRatio)).not.toBe('0%');
    expect(formatOptionalNumber(0, formatRatio)).toBe('0%');
  });

  it('renders an absent string as absent, never as an empty cell', () => {
    expect(formatOptionalText(null)).toBe(ABSENT);
    expect(formatOptionalText('')).toBe(ABSENT);
    expect(formatOptionalText('max_attempts')).toBe('max_attempts');
  });

  it('formats a ratio as a whole percentage', () => {
    expect(formatRatio(0.8)).toBe('80%');
    expect(formatRatio(2 / 3)).toBe('67%');
    expect(formatRatio(1)).toBe('100%');
  });
});
