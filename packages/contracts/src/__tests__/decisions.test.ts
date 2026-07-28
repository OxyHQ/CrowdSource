import { describe, expect, it } from 'vitest';

import { DECISION_OUTCOMES, DecisionSchema } from '../decisions';
import { accepted, rejectionPaths } from './support/assertions';
import { decisionExample } from './support/examples';

describe('DecisionSchema', () => {
  it('accepts Appendix B\'s shape', () => {
    const decision = accepted(DecisionSchema, decisionExample());
    expect(decision.status).toBe('final');
  });

  it('keeps a field a newer server added, rather than dropping it (§10.11)', () => {
    /**
     * The outbound half of the strictness rule. A tenant that stores
     * `event.data` for later processing keeps everything that arrived, and an
     * older client never fails on a field it does not know.
     */
    const decision = accepted(DecisionSchema, {
      ...decisionExample(),
      appealDeadline: '2026-08-28T18:30:00.000Z',
    });
    expect(decision).toHaveProperty('appealDeadline', '2026-08-28T18:30:00.000Z');
  });

  it('treats inconclusive as its own outcome, distinct from no_violation', () => {
    // The invariant is that these never collapse into one another. They are
    // separate members of the enum and nothing in this package maps between
    // them.
    expect(DECISION_OUTCOMES).toContain('inconclusive');
    expect(DECISION_OUTCOMES).toContain('no_violation');
    const decision = accepted(DecisionSchema, {
      ...decisionExample(),
      outcome: 'inconclusive',
      findings: [],
    });
    expect(decision.outcome).toBe('inconclusive');
  });
});

describe('supersession (§9.9)', () => {
  it('rejects a first revision that claims to supersede something', () => {
    expect(
      rejectionPaths(DecisionSchema, {
        ...decisionExample(),
        revision: 1,
        supersedesDecisionId: 'dec_00',
      }),
    ).toEqual(['supersedesDecisionId']);
  });

  it('rejects a later revision that supersedes nothing, because that is an edit', () => {
    expect(rejectionPaths(DecisionSchema, { ...decisionExample(), revision: 2 })).toEqual([
      'supersedesDecisionId',
    ]);
  });

  it('accepts the revision-2 chain §9.9 draws', () => {
    const corrected = accepted(DecisionSchema, {
      ...decisionExample(),
      id: 'dec_02HZ',
      revision: 2,
      status: 'final',
      outcome: 'no_violation',
      findings: [],
      supersedesDecisionId: 'dec_01HZ',
    });
    expect(corrected.supersedesDecisionId).toBe('dec_01HZ');
  });
});

describe('the jury arithmetic', () => {
  const withJury = (jury: Record<string, unknown>): Record<string, unknown> => ({
    ...decisionExample(),
    jury,
  });

  it('rejects an agreement that does not match the votes reported', () => {
    /**
     * `agreement = winningDecisiveVotes / decisiveVotes` (§9.5). Checking it is
     * how "one qualified person, one vote" stays auditable: if a weight ever
     * entered the count, the ratio would stop matching the number of people.
     */
    expect(
      rejectionPaths(
        DecisionSchema,
        withJury({
          size: 5,
          decisiveVotes: 5,
          winningVotes: 4,
          agreement: 0.95,
          specialistPresent: false,
        }),
      ),
    ).toEqual(['jury.agreement']);
  });

  it('rejects counts that do not nest', () => {
    expect(
      rejectionPaths(
        DecisionSchema,
        withJury({
          size: 5,
          decisiveVotes: 5,
          winningVotes: 6,
          agreement: 1,
          specialistPresent: false,
        }),
      ),
    ).toEqual(['jury.winningVotes']);

    expect(
      rejectionPaths(
        DecisionSchema,
        withJury({
          size: 3,
          decisiveVotes: 5,
          winningVotes: 3,
          agreement: 0.6,
          specialistPresent: false,
        }),
      ),
    ).toEqual(['jury.decisiveVotes']);
  });

  it('accepts a unanimous panel of three', () => {
    expect(
      accepted(
        DecisionSchema,
        withJury({
          size: 3,
          decisiveVotes: 3,
          winningVotes: 3,
          agreement: 1,
          specialistPresent: false,
        }),
      ).jury.agreement,
    ).toBe(1);
  });
});

describe('findings and actions', () => {
  it('rejects a violation with nothing found', () => {
    expect(rejectionPaths(DecisionSchema, { ...decisionExample(), findings: [] })).toEqual([
      'findings',
    ]);
  });

  it('rejects §10.7\'s bare-string recommended actions on a decision', () => {
    /**
     * §10.7 writes them as strings and Appendix B as objects. Appendix B is the
     * reference Decision and wins; see `reference-documents.test.ts` for the
     * full divergence.
     */
    expect(
      rejectionPaths(DecisionSchema, {
        ...decisionExample(),
        recommendedActions: ['remove_or_restrict'],
      }),
    ).toEqual(['recommendedActions.0']);
  });

  it('accepts an action with no target, since some actions have none', () => {
    expect(
      accepted(DecisionSchema, {
        ...decisionExample(),
        outcome: 'escalated',
        findings: [],
        recommendedActions: [{ action: 'specialist_queue' }],
      }).recommendedActions,
    ).toHaveLength(1);
  });

  it('rejects a finding scope outside the three the contract defines', () => {
    expect(
      rejectionPaths(DecisionSchema, {
        ...decisionExample(),
        findings: [
          {
            code: 'harassment.targeted_abuse',
            resourceIds: ['res_post'],
            severity: 'medium',
            scope: 'global',
          },
        ],
      }),
    ).toEqual(['findings.0.scope']);
  });
});
