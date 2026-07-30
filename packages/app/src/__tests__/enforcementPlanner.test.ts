/**
 * The plan, as a table.
 *
 * Pure: no database, no clock. The whole reason this algorithm is shared rather
 * than copied into seven applications is the `no_violation` + `no_action` case
 * below — a bug that produces no error, no log line and no failing test
 * anywhere else, and leaves an object removed forever after the appeal that
 * cleared it succeeded.
 */


import { describe, expect, it } from 'vitest';
import { planEnforcement, primaryAction } from '../enforcement/planner';
import type { ModerationEnforcementConfig } from '../types';
import { decision } from './support/decisions';

type TestAction = 'restrict' | 'restore' | 'flag' | 'unflag' | 'review' | 'none';

const CONFIG: ModerationEnforcementConfig<TestAction> = {
  actions: ['restrict', 'restore', 'flag', 'unflag', 'review', 'none'],
  noneAction: 'none',
  reviewAction: 'review',
  restoreAction: 'restore',
  recommendationToAction: {
    remove: 'restrict',
    hide: 'restrict',
    label: 'flag',
    reduce_distribution: 'flag',
    allow: 'none',
    no_action: 'none',
    restore: 'restore',
    suspend_user: 'review',
  },
  severityFallback: {
    critical: 'review',
    high: 'restrict',
    medium: 'flag',
    low: 'review',
  },
  absorb: { restrict: ['flag', 'none', 'restore'] },
  precedence: ['restrict', 'restore', 'flag', 'unflag', 'review', 'none'],
  reversibleActions: ['restore', 'unflag'],
  reverses: { restore: 'restrict', unflag: 'flag' },
  apply: async () => ({ changed: false, reason: 'not exercised in a planner test' }),
};

describe('recommendations decide the plan', () => {
  it('maps each recommendation through the application table', () => {
    const plan = planEnforcement(
      decision({ recommendedActions: [{ action: 'label' }] }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['flag']);
    expect(plan[0].recommendedAction).toBe('label');
  });

  it('sends an unmapped recommendation to review rather than dropping it', () => {
    const plan = planEnforcement(
      decision({ recommendedActions: [{ action: 'legal_queue' }] }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['review']);
  });

  it('lets a strong action absorb the weaker ones it makes redundant', () => {
    const plan = planEnforcement(
      decision({ recommendedActions: [{ action: 'remove' }, { action: 'label' }] }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['restrict']);
  });

  it('keeps review alongside a state-changing action', () => {
    const plan = planEnforcement(
      decision({ recommendedActions: [{ action: 'remove' }, { action: 'suspend_user' }] }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action).sort()).toEqual(['restrict', 'review']);
  });

  it('drops the explicit nothing when something else is planned', () => {
    const plan = planEnforcement(
      decision({ recommendedActions: [{ action: 'label' }, { action: 'allow' }] }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['flag']);
  });
});

describe('a correction always plans the restore', () => {
  it('adds the restore when no_violation recommends no_action', () => {
    /**
     * The bug this whole shared algorithm exists to prevent. `no_action` means
     * "take no NEW action", not "leave what you already did in place". Mapping
     * it straight through plans `none`, and the object an earlier revision
     * removed stays removed forever — appeal succeeded, case says the content
     * was fine, nothing puts it back.
     */
    const plan = planEnforcement(
      decision({
        outcome: 'no_violation',
        status: 'corrected',
        revision: 2,
        findings: [],
        recommendedActions: [{ action: 'no_action' }],
      }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action)).toContain('restore');
  });

  it('adds the restore when no_violation recommends allow', () => {
    const plan = planEnforcement(
      decision({
        outcome: 'no_violation',
        findings: [],
        recommendedActions: [{ action: 'allow' }],
      }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action)).toContain('restore');
  });

  it('plans the restore for no_violation with no recommendation at all', () => {
    const plan = planEnforcement(
      decision({ outcome: 'no_violation', findings: [], recommendedActions: [] }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['restore']);
  });

  it('does not duplicate a restore that was already recommended', () => {
    const plan = planEnforcement(
      decision({
        outcome: 'no_violation',
        findings: [],
        recommendedActions: [{ action: 'restore' }],
      }),
      CONFIG,
    );
    expect(plan.filter((entry) => entry.action === 'restore')).toHaveLength(1);
  });

  it('plans an explicit nothing for an application that declares no restore', () => {
    const withoutRestore: ModerationEnforcementConfig<TestAction> = {
      ...CONFIG,
      // `null`, not absent: the type refuses an omission, so this is a
      // recorded decision rather than a field somebody forgot.
      restoreAction: null,
    };
    const plan = planEnforcement(
      decision({
        outcome: 'no_violation',
        findings: [],
        recommendedActions: [{ action: 'no_action' }],
      }),
      withoutRestore,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['none']);
  });
});

describe('severity is the fallback, never the primary path', () => {
  it.each([
    ['critical', 'review'],
    ['high', 'restrict'],
    ['medium', 'flag'],
    ['low', 'review'],
  ] as const)('a %s violation with no recommendation plans %s', (severity, action) => {
    const plan = planEnforcement(
      decision({
        recommendedActions: [],
        findings: [{ code: 'integrity.spam', severity }],
      }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action)).toEqual([action]);
  });

  it('takes the HIGHEST severity across findings', () => {
    const plan = planEnforcement(
      decision({
        recommendedActions: [],
        findings: [
          { code: 'integrity.spam', severity: 'low' },
          { code: 'harassment.targeted_abuse', severity: 'high' },
        ],
      }),
      CONFIG,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['restrict']);
  });

  it('asks a human when a violation carries no severity this version understands', () => {
    /**
     * The contract refuses a `violation` with no findings, so this shape cannot
     * be parsed into existence — which is the point. It is what a NEWER server
     * sending something this version cannot read looks like from here, and the
     * safe reading of it is a human rather than a default that removes an
     * object. Assembled by mutating a valid decision for exactly that reason.
     */
    const unreadable = decision({
      outcome: 'inconclusive',
      findings: [],
      recommendedActions: [],
    });
    Object.assign(unreadable, { outcome: 'violation' });

    const plan = planEnforcement(unreadable, CONFIG);
    expect(plan.map((entry) => entry.action)).toEqual(['review']);
    expect(plan[0].reason).toContain('severity');
  });
});

describe('an absence of consensus is neither guilt nor innocence', () => {
  it.each(['insufficient_context', 'inconclusive', 'escalated'] as const)(
    '%s asks a human and changes nothing',
    (outcome) => {
      const plan = planEnforcement(
        decision({ outcome, findings: [], recommendedActions: [] }),
        CONFIG,
      );
      expect(plan.map((entry) => entry.action)).toEqual(['review']);
    },
  );

  it.each(['content_unavailable', 'duplicate'] as const)(
    '%s plans an explicit nothing rather than an absent row',
    (outcome) => {
      const plan = planEnforcement(
        decision({ outcome, findings: [], recommendedActions: [] }),
        CONFIG,
      );
      expect(plan).toHaveLength(1);
      expect(plan[0].action).toBe('none');
      expect(plan[0].reason).toContain(outcome);
    },
  );

  it('sends an outcome this version does not know to a human', () => {
    const unknown = decision({
      outcome: 'inconclusive',
      findings: [],
      recommendedActions: [],
    });
    Object.assign(unknown, { outcome: 'something_a_newer_server_invented' });
    const plan = planEnforcement(unknown, CONFIG);
    expect(plan.map((entry) => entry.action)).toEqual(['review']);
  });
});

describe('the plan is never empty', () => {
  it('produces an explicit nothing rather than no row at all', () => {
    const plan = planEnforcement(
      decision({ outcome: 'duplicate', findings: [], recommendedActions: [] }),
      CONFIG,
    );
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0].reason).not.toHaveLength(0);
  });
});

const PRECEDENCE = CONFIG.precedence ?? CONFIG.actions;

describe('one action reaches the report', () => {
  it('picks the strongest by the application precedence', () => {
    expect(primaryAction(['review', 'restrict'], PRECEDENCE)).toBe('restrict');
    expect(primaryAction(['none', 'review'], PRECEDENCE)).toBe('review');
  });

  it('returns undefined for an empty plan', () => {
    expect(primaryAction([], PRECEDENCE)).toBeUndefined();
  });

  it('falls back to the first action when precedence names none of them', () => {
    expect(primaryAction(['flag'], ['restrict'])).toBe('flag');
  });
});
