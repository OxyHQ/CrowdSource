import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import { describe, expect, it } from 'vitest';

import { triageCase, TRIAGE_WEIGHTS, type TriageInput } from '../modules/triage/triage';

/**
 * Triage (§7.4, §7.5).
 *
 * Two things are being checked and they pull in different directions. One is
 * that the ordering is USEFUL — urgent material outranks ordinary material,
 * distinct reporters count for more than repeat ones, an old case eventually
 * surfaces. The other is that it stays inside its remit: it decides order, pool
 * and exposure, never guilt, and the reporter's standing may nudge the first
 * only within a stated bound and may never touch the second or third.
 */

const now = new Date('2026-07-29T12:00:00.000Z');

function input(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    allegationCodes: ['integrity.spam'],
    reportCount: 1,
    uniqueReporterCount: 1,
    reach: 0,
    activeDistribution: false,
    allowCommunityReview: true,
    containsPersonalData: false,
    firstReportedAt: now,
    now,
    ...overrides,
  };
}

describe('it is deterministic', () => {
  it('produces the same result for the same case state, every time', () => {
    const state = input({ allegationCodes: ['harassment.targeted_abuse'], reportCount: 4 });
    expect(triageCase(state)).toEqual(triageCase(state));
  });

  it('replays safely: a worker that runs twice writes the same numbers', () => {
    const state = input({ reach: 12_000, reportCount: 9, uniqueReporterCount: 7 });
    const once = triageCase(state);
    const twice = triageCase(state);

    expect(twice.priorityScore).toBe(once.priorityScore);
    expect(twice.reviewPool).toBe(once.reviewPool);
    expect(twice.sensitivityClass).toBe(once.sensitivityClass);
  });
});

describe('order of review', () => {
  it('puts more urgent material ahead of less urgent material', () => {
    const spam = triageCase(input({ allegationCodes: ['integrity.spam'] }));
    const threat = triageCase(input({ allegationCodes: ['harassment.credible_threat'] }));

    expect(threat.priorityScore).toBeGreaterThan(spam.priorityScore);
  });

  it('counts distinct reporters for more than repeat reports from one person', () => {
    const crowd = triageCase(input({ reportCount: 8, uniqueReporterCount: 8 }));
    const oneVoice = triageCase(input({ reportCount: 8, uniqueReporterCount: 1 }));

    // §11.11 treats one person filing eight reports as possible report abuse,
    // not as eight times the urgency.
    expect(crowd.priorityScore).toBeGreaterThan(oneVoice.priorityScore);
    expect(oneVoice.components.duplicateNoisePenalty).toBeGreaterThan(0);
  });

  it('raises a case that has been waiting, so a quiet one is not starved forever', () => {
    const fresh = triageCase(input());
    const old = triageCase(
      input({ firstReportedAt: new Date('2026-07-25T12:00:00.000Z'), now }),
    );

    expect(old.components.staleCaseBoost).toBeGreaterThan(fresh.components.staleCaseBoost);
  });

  it('weighs reach, but never enough to outrank what the material is', () => {
    const viral = triageCase(input({ reach: 5_000_000, activeDistribution: true }));
    expect(viral.components.reachOrVirality).toBeLessThanOrEqual(TRIAGE_WEIGHTS.REACH_MAX);
  });

  it('stays inside its declared bounds', () => {
    const loudest = triageCase(
      input({
        allegationCodes: ['child_safety.exploitation'],
        reportCount: 10_000,
        uniqueReporterCount: 10_000,
        reach: 50_000_000,
        activeDistribution: true,
        containsPersonalData: true,
        firstReportedAt: new Date('2020-01-01T00:00:00.000Z'),
        reporterPriorityBoost: 5,
      }),
    );

    expect(loudest.priorityScore).toBeLessThanOrEqual(TRIAGE_WEIGHTS.SCORE_MAX);
    expect(loudest.priorityScore).toBeGreaterThan(0);
  });
});

/**
 * §7.4: "the reporter's reputation may influence priority only in a limited way,
 * is never shown to the jury and is never used as evidence that the allegation
 * is true".
 */
describe('the reporter reputation boost', () => {
  it('is clamped to its stated cap however large the caller says it is', () => {
    const absurd = triageCase(input({ reporterPriorityBoost: 10_000 }));

    expect(absurd.components.trustedReporterPriorityBoost).toBe(
      TRIAGE_WEIGHTS.REPORTER_PRIORITY_BOOST_MAX,
    );
  });

  it('is refused as a negative, so it can only ever promote and never punish', () => {
    const negative = triageCase(input({ reporterPriorityBoost: -50 }));
    expect(negative.components.trustedReporterPriorityBoost).toBe(0);
  });

  it('cannot change the pool, the exposure or the route', () => {
    const withoutBoost = triageCase(input({ allegationCodes: ['sexual_content.nudity'] }));
    const withBoost = triageCase(
      input({ allegationCodes: ['sexual_content.nudity'], reporterPriorityBoost: 5 }),
    );

    expect(withBoost.reviewPool).toBe(withoutBoost.reviewPool);
    expect(withBoost.sensitivityClass).toBe(withoutBoost.sensitivityClass);
    expect(withBoost.requiresRedaction).toBe(withoutBoost.requiresRedaction);
    expect(withBoost.escalate).toBe(withoutBoost.escalate);
  });

  it('is a small fraction of the score, not the deciding term', () => {
    const cap = TRIAGE_WEIGHTS.REPORTER_PRIORITY_BOOST_MAX;
    const everythingElse =
      TRIAGE_WEIGHTS.SEVERITY_MAX +
      TRIAGE_WEIGHTS.REPORT_VELOCITY_MAX +
      TRIAGE_WEIGHTS.UNIQUE_REPORTER_MAX +
      TRIAGE_WEIGHTS.REACH_MAX +
      TRIAGE_WEIGHTS.VULNERABLE_TARGET_MAX +
      TRIAGE_WEIGHTS.STALE_CASE_MAX;

    expect(cap / (cap + everythingElse)).toBeLessThan(0.05);
  });
});

/** §7.5's table. Each row is a route, and the strictest allegation wins. */
describe('sensitive routes', () => {
  it('never sends child-safety material to a community jury', () => {
    const result = triageCase(input({ allegationCodes: ['child_safety.sexualization'] }));

    expect(result.reviewPool).toBe('legal');
    expect(result.sensitivityClass).toBe('prohibited');
    expect(result.escalate).toBe(true);
  });

  it('will not let a permissive tenant pull child-safety material back into the community', () => {
    // `allowCommunityReview` may only ever tighten. The restriction here comes
    // from what the material is alleged to be, not from what the tenant asked.
    const result = triageCase(
      input({ allegationCodes: ['child_safety.grooming'], allowCommunityReview: true }),
    );

    expect(result.reviewPool).toBe('legal');
  });

  it('escalates imminent risk and credible threats to a specialist pool', () => {
    for (const code of [
      'self_harm.imminent_risk',
      'harassment.credible_threat',
      'violence.threat',
    ] as TaxonomyCode[]) {
      const result = triageCase(input({ allegationCodes: [code] }));
      expect(result.reviewPool, code).toBe('specialist');
      expect(result.escalate, code).toBe(true);
    }
  });

  it('marks personal data for redaction before anyone reviews it', () => {
    expect(triageCase(input({ allegationCodes: ['privacy.personal_information'] })).requiresRedaction).toBe(
      true,
    );
    expect(triageCase(input({ allegationCodes: ['harassment.doxxing'] })).requiresRedaction).toBe(
      true,
    );
    // And the tenant's own declaration is enough on its own.
    expect(triageCase(input({ containsPersonalData: true })).requiresRedaction).toBe(true);
  });

  it('keeps ordinary adult material in the community pool, but marks it sensitive', () => {
    const result = triageCase(input({ allegationCodes: ['sexual_content.nudity'] }));

    // §7.5's last row: adults with explicit consent for the category. That is a
    // reviewer ELIGIBILITY property gated on this class, not a separate pool.
    expect(result.reviewPool).toBe('community');
    expect(result.sensitivityClass).toBe('sensitive');
  });

  it('takes the STRICTEST allegation in a case, not the first or the commonest', () => {
    const mostlySpam = triageCase(
      input({
        allegationCodes: [
          'integrity.spam',
          'integrity.spam',
          'integrity.spam',
          'child_safety.exploitation',
        ],
      }),
    );

    expect(mostlySpam.reviewPool).toBe('legal');
    expect(mostlySpam.sensitivityClass).toBe('prohibited');
  });

  it('downgrades a community route when a reporter withheld community review', () => {
    const withheld = triageCase(input({ allowCommunityReview: false }));

    expect(withheld.reviewPool).toBe('specialist');
    expect(triageCase(input({ allowCommunityReview: true })).reviewPool).toBe('community');
  });
});
