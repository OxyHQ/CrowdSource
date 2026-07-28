/**
 * PLAN §8.1 / §8.2 — the reasons a reviewer is not in a draw right now.
 *
 * These blockers only explain the disabled button; the server decides. The tests
 * matter because a WRONG explanation is worse than none: telling someone they
 * are suspended when they have merely paused themselves is how a volunteer stops
 * volunteering.
 */

import { assignmentBlockers } from '@/lib/eligibility';
import type { EligibilityRequirement, ReviewerProfile } from '@/lib/reviewer-api/types';

const NOW = new Date('2026-07-28T12:00:00.000Z');

const ALL_MET: EligibilityRequirement[] = [
  { id: 'oxy_account', met: true },
  { id: 'personhood', met: true },
  { id: 'training_current', met: true },
];

function profile(overrides: Partial<ReviewerProfile> = {}): ReviewerProfile {
  return {
    state: 'community_reviewer',
    eligibility: ALL_MET,
    standings: [],
    preferences: {
      languages: ['en-US'],
      categories: ['harassment'],
      sensitiveCategories: [],
      dailyLimit: 10,
      availableForAssignment: true,
    },
    consent: {
      rulesAcceptedAt: '2026-07-01T00:00:00.000Z',
      ageConfirmed: true,
      sensitiveCategories: [],
    },
    exposure: { reviewedToday: 2, dailyLimit: 10, breakRequiredUntil: null },
    ...overrides,
  };
}

describe('assignmentBlockers', () => {
  it('is empty for a reviewer who can be drawn', () => {
    expect(assignmentBlockers(profile(), NOW)).toEqual([]);
  });

  it('blocks an applicant who has not accepted the rules', () => {
    expect(assignmentBlockers(profile({ state: 'applicant' }), NOW)).toContain(
      'onboarding_incomplete',
    );
    expect(
      assignmentBlockers(
        profile({
          consent: { rulesAcceptedAt: null, ageConfirmed: true, sensitiveCategories: [] },
        }),
        NOW,
      ),
    ).toContain('onboarding_incomplete');
  });

  it('lets a calibrating reviewer ask for a case', () => {
    // §8.1: calibrating reviewers receive training and gold cases. Blocking them
    // would leave no way to become calibrated.
    expect(assignmentBlockers(profile({ state: 'calibrating' }), NOW)).toEqual([]);
  });

  it('blocks a suspended reviewer', () => {
    expect(assignmentBlockers(profile({ state: 'suspended' }), NOW)).toContain('suspended');
  });

  it('blocks on any unmet eligibility requirement', () => {
    expect(
      assignmentBlockers(
        profile({ eligibility: [...ALL_MET, { id: 'personhood', met: false }] }),
        NOW,
      ),
    ).toContain('eligibility_unmet');
  });

  it('distinguishes a self-imposed pause from a suspension', () => {
    const blockers = assignmentBlockers(
      profile({
        preferences: {
          languages: ['en-US'],
          categories: ['harassment'],
          sensitiveCategories: [],
          dailyLimit: 10,
          availableForAssignment: false,
        },
      }),
      NOW,
    );
    expect(blockers).toContain('paused_by_reviewer');
    expect(blockers).not.toContain('suspended');
  });

  it('blocks at the daily limit the reviewer set', () => {
    expect(
      assignmentBlockers(
        profile({ exposure: { reviewedToday: 10, dailyLimit: 10, breakRequiredUntil: null } }),
        NOW,
      ),
    ).toContain('daily_limit_reached');
  });

  it('blocks during a break and stops blocking once it has passed', () => {
    const during = profile({
      exposure: {
        reviewedToday: 1,
        dailyLimit: 10,
        breakRequiredUntil: '2026-07-28T12:30:00.000Z',
      },
    });
    expect(assignmentBlockers(during, NOW)).toContain('break_required');

    const after = profile({
      exposure: {
        reviewedToday: 1,
        dailyLimit: 10,
        breakRequiredUntil: '2026-07-28T11:30:00.000Z',
      },
    });
    expect(assignmentBlockers(after, NOW)).toEqual([]);
  });
});
