/**
 * PLAN §9.2 — the two-step order, tested as behaviour rather than layout.
 *
 * The reducer is where the order lives, so this is where it can be proved: step
 * 2 cannot be reached before step 1 is answered, step 2 cannot be seeded from
 * the allegation, and a half-filled form has no wire representation.
 */

import {
  buildReviewSubmission,
  createInitialReviewFormState,
  FINDING_CONFIDENCE,
  isDescriptiveComplete,
  isPolicyComplete,
  reviewFormReducer,
  type ReviewFormAction,
  type ReviewFormState,
} from '@/lib/review-form';
import type { PolicyRule } from '@/lib/reviewer-api/types';

const RULES: PolicyRule[] = [
  {
    id: 'rule_1',
    title: 'Targeted abuse',
    text: 'Do not target a person with abuse.',
    taxonomyCode: 'harassment.targeted_abuse',
  },
  {
    id: 'rule_2',
    title: 'Slurs',
    text: 'Do not use slurs.',
    taxonomyCode: 'hate.slur',
  },
];

function apply(state: ReviewFormState, ...actions: ReviewFormAction[]): ReviewFormState {
  return actions.reduce(reviewFormReducer, state);
}

function describedState(): ReviewFormState {
  return apply(
    createInitialReviewFormState(),
    { type: 'toggleDescriptor', descriptor: 'insults_or_slurs' },
    { type: 'toggleResource', resourceId: 'res_1' },
    { type: 'toggleMissingContext', code: 'none' },
    { type: 'setCertainty', certainty: 'high' },
  );
}

describe('createInitialReviewFormState', () => {
  it('takes no arguments, so step 2 cannot be seeded from the allegation', () => {
    // The signature is the guarantee. If this ever grows a parameter, the
    // anti-anchoring property of §9.2 needs re-arguing, not just re-testing.
    expect(createInitialReviewFormState).toHaveLength(0);
  });

  it('starts on step 1 with every step-2 answer empty', () => {
    const state = createInitialReviewFormState();
    expect(state.step).toBe('descriptive');
    expect(state.outcome).toBeNull();
    expect(state.contextSufficiency).toBeNull();
    expect(state.findings).toEqual([]);
    expect(state.appliedExceptionIds).toEqual([]);
    expect(state.recommendedActions).toEqual([]);
    expect(state.notes).toBe('');
  });
});

describe('step order', () => {
  it('refuses to advance while the description is incomplete', () => {
    const state = apply(createInitialReviewFormState(), { type: 'advance' });
    expect(state.step).toBe('descriptive');

    const partial = apply(createInitialReviewFormState(), {
      type: 'toggleDescriptor',
      descriptor: 'nudity',
    });
    expect(isDescriptiveComplete(partial)).toBe(false);
    expect(apply(partial, { type: 'advance' }).step).toBe('descriptive');
  });

  it('advances once the material has been described', () => {
    const state = describedState();
    expect(isDescriptiveComplete(state)).toBe(true);
    expect(apply(state, { type: 'advance' }).step).toBe('policy');
  });

  it('keeps step 2 answers when the reviewer goes back to re-read the material', () => {
    const state = apply(
      describedState(),
      { type: 'advance' },
      { type: 'setOutcome', outcome: 'violation' },
      { type: 'back' },
    );
    expect(state.step).toBe('descriptive');
    expect(state.outcome).toBe('violation');
  });
});

describe('descriptive step', () => {
  it('treats "nothing of note" as exclusive of every other descriptor', () => {
    const state = apply(
      createInitialReviewFormState(),
      { type: 'toggleDescriptor', descriptor: 'nudity' },
      { type: 'toggleDescriptor', descriptor: 'nothing_notable' },
    );
    expect(state.contentDescriptors).toEqual(['nothing_notable']);

    const reversed = apply(state, { type: 'toggleDescriptor', descriptor: 'nudity' });
    expect(reversed.contentDescriptors).toEqual(['nudity']);
  });

  it('treats "nothing missing" as exclusive of every other gap', () => {
    const state = apply(
      createInitialReviewFormState(),
      { type: 'toggleMissingContext', code: 'translation' },
      { type: 'toggleMissingContext', code: 'none' },
    );
    expect(state.missingContext).toEqual(['none']);
  });
});

describe('policy step completeness', () => {
  it('will not accept a violation that names no rule', () => {
    const state = apply(
      describedState(),
      { type: 'advance' },
      { type: 'setOutcome', outcome: 'violation' },
      { type: 'setContextSufficiency', sufficiency: 'sufficient' },
      { type: 'toggleAction', action: 'remove_or_restrict' },
    );
    expect(isPolicyComplete(state)).toBe(false);
    expect(buildReviewSubmission(state, RULES)).toBeNull();
  });

  it('accepts a non-violation outcome without any finding', () => {
    const state = apply(
      describedState(),
      { type: 'advance' },
      { type: 'setOutcome', outcome: 'no_violation' },
      { type: 'setContextSufficiency', sufficiency: 'sufficient' },
      { type: 'toggleAction', action: 'no_action' },
    );
    expect(isPolicyComplete(state)).toBe(true);
  });

  it('does not collapse "cannot tell" into "no violation"', () => {
    // PLAN §9.6 / Appendix F: absence of a decision is its own answer.
    const state = apply(
      describedState(),
      { type: 'advance' },
      { type: 'setOutcome', outcome: 'insufficient_context' },
      { type: 'setContextSufficiency', sufficiency: 'insufficient' },
      { type: 'toggleAction', action: 'no_action' },
    );
    const submission = buildReviewSubmission(state, RULES);
    expect(submission?.outcome).toBe('insufficient_context');
  });
});

describe('buildReviewSubmission', () => {
  it('takes each finding’s taxonomy code from the server’s policy, not the allegation', () => {
    const state = apply(
      describedState(),
      { type: 'advance' },
      { type: 'setOutcome', outcome: 'violation' },
      { type: 'setContextSufficiency', sufficiency: 'sufficient' },
      { type: 'toggleFinding', ruleId: 'rule_2' },
      { type: 'setFindingSeverity', ruleId: 'rule_2', severity: 'high' },
      { type: 'setFindingConfidence', ruleId: 'rule_2', confidence: 'high' },
      { type: 'toggleException', exceptionId: 'exc_1' },
      { type: 'toggleAction', action: 'remove_or_restrict' },
      { type: 'setNotes', notes: '  a note  ' },
    );

    const submission = buildReviewSubmission(state, RULES);
    expect(submission).not.toBeNull();
    expect(submission?.findings).toEqual([
      {
        code: 'hate.slur',
        resourceIds: ['res_1'],
        severity: 'high',
        confidence: FINDING_CONFIDENCE.high,
        policyRuleIds: ['rule_2'],
      },
    ]);
    expect(submission?.descriptive).toEqual({
      contentDescriptors: ['insults_or_slurs'],
      affectedResourceIds: ['res_1'],
      missingContext: ['none'],
      certainty: 'high',
    });
    expect(submission?.appliedExceptionIds).toEqual(['exc_1']);
    expect(submission?.notes).toBe('a note');
  });

  it('drops a finding whose rule is no longer in the policy rather than inventing a code', () => {
    const state = apply(
      describedState(),
      { type: 'advance' },
      { type: 'setOutcome', outcome: 'violation' },
      { type: 'setContextSufficiency', sufficiency: 'sufficient' },
      { type: 'toggleFinding', ruleId: 'rule_1' },
      { type: 'toggleFinding', ruleId: 'rule_2' },
      { type: 'toggleAction', action: 'remove_or_restrict' },
    );
    const submission = buildReviewSubmission(state, [RULES[0]]);
    expect(submission?.findings.map((finding) => finding.code)).toEqual([
      'harassment.targeted_abuse',
    ]);
  });

  it('omits an empty note instead of sending a blank string', () => {
    const state = apply(
      describedState(),
      { type: 'advance' },
      { type: 'setOutcome', outcome: 'no_violation' },
      { type: 'setContextSufficiency', sufficiency: 'sufficient' },
      { type: 'toggleAction', action: 'no_action' },
      { type: 'setNotes', notes: '   ' },
    );
    expect(buildReviewSubmission(state, RULES)).not.toHaveProperty('notes');
  });

  it('returns null while the description is still incomplete', () => {
    const state = apply(
      createInitialReviewFormState(),
      { type: 'setOutcome', outcome: 'no_violation' },
      { type: 'setContextSufficiency', sufficiency: 'sufficient' },
      { type: 'toggleAction', action: 'no_action' },
    );
    expect(buildReviewSubmission(state, RULES)).toBeNull();
  });
});
