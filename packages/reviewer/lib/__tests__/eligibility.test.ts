/**
 * PLAN §8.1 / §8.2 — the reasons a reviewer is not in a draw right now.
 *
 * These blockers only explain the disabled button; the server decides. The tests
 * matter because a WRONG explanation is worse than none: telling someone they
 * are suspended when they have merely paused themselves is how a volunteer stops
 * volunteering.
 */

import { assignmentBlockers } from '@/lib/eligibility';
import type {
  ReviewerEligibilityRequirement,
  ReviewerProfileView,
} from '@oxyhq/crowdsource-contracts';

const NOW = new Date('2026-07-28T12:00:00.000Z');

const ALL_MET: ReviewerEligibilityRequirement[] = [
  { id: 'oxy_account', met: true },
  { id: 'personhood', met: true },
  { id: 'age', met: true },
  { id: 'rules_accepted', met: true },
  { id: 'languages_selected', met: true },
  { id: 'categories_selected', met: true },
  { id: 'training_current', met: true },
  { id: 'calibration_current', met: true },
];

function profile(overrides: Partial<ReviewerProfileView> = {}): ReviewerProfileView {
  return {
    reviewerId: 'rvw_1',
    // The short form. The app used to declare `community_reviewer`, which no
    // server has ever sent — the persisted vocabulary is §8.1's identifiers.
    state: 'community',
    eligibility: ALL_MET,
    standings: [],
    completedReviewCount: 4,
    preferences: {
      languages: ['en-US'],
      categories: ['harassment'],
      dailyLimit: 10,
      availableForAssignment: true,
    },
    consent: {
      rulesAcceptedAt: '2026-07-01T00:00:00.000Z',
      ageConfirmed: true,
      maxSensitivity: 'standard',
      sensitiveCategories: [],
    },
    exposure: {
      reviewedToday: 2,
      dailyLimit: 10,
      openAssignments: 0,
      maxOpenAssignments: 3,
      breakRequiredUntil: null,
    },
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
          consent: {
            rulesAcceptedAt: null,
            ageConfirmed: true,
            maxSensitivity: 'standard',
            sensitiveCategories: [],
          },
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
        profile({
          exposure: {
            reviewedToday: 10,
            dailyLimit: 10,
            openAssignments: 0,
            maxOpenAssignments: 3,
            breakRequiredUntil: null,
          },
        }),
        NOW,
      ),
    ).toContain('daily_limit_reached');
  });

  it('blocks at the open-assignment ceiling, which the reviewer did not set', () => {
    // A different limit from the daily one, and named differently on screen: this
    // one is the system's (MAX_OPEN_ASSIGNMENTS), and telling somebody they hit
    // "their" limit when they hit ours is the wrong explanation.
    const blockers = assignmentBlockers(
      profile({
        exposure: {
          reviewedToday: 1,
          dailyLimit: 10,
          openAssignments: 3,
          maxOpenAssignments: 3,
          breakRequiredUntil: null,
        },
      }),
      NOW,
    );
    expect(blockers).toContain('open_assignment_limit');
    expect(blockers).not.toContain('daily_limit_reached');
  });

  it('blocks during §13.7’s sensitive rest and stops once it has passed', () => {
    const during = profile({
      exposure: {
        reviewedToday: 1,
        dailyLimit: 10,
        openAssignments: 0,
        maxOpenAssignments: 3,
        breakRequiredUntil: '2026-07-28T12:30:00.000Z',
      },
    });
    // Named for the route it rests: §13.7 rests SENSITIVE material only, and the
    // server will still draw this reviewer for a spam report. Calling it a plain
    // "break" would tell them they are out of the pool when they are not.
    expect(assignmentBlockers(during, NOW)).toContain('sensitive_break_required');

    const after = profile({
      exposure: {
        reviewedToday: 1,
        dailyLimit: 10,
        openAssignments: 0,
        maxOpenAssignments: 3,
        breakRequiredUntil: '2026-07-28T11:30:00.000Z',
      },
    });
    expect(assignmentBlockers(after, NOW)).toEqual([]);
  });
});
