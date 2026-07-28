/**
 * Whether this reviewer may be entered into a draw right now (PLAN §8.1, §8.2).
 *
 * The server is the authority — it runs the same checks plus the ones a device
 * cannot see (conflict graphs, coordination clusters, prior participation), and
 * it decides. This computes the same answer locally for ONE reason: so the app
 * can say WHY the button is unavailable instead of letting a reviewer press it
 * and receive a refusal with no explanation.
 *
 * It is never the gate. A request that gets through anyway is still refused
 * server-side, which is the only place that matters.
 */

import type { ReviewerProfile } from '@/lib/reviewer-api/types';

export type AssignmentBlocker =
  | 'onboarding_incomplete'
  | 'suspended'
  | 'eligibility_unmet'
  | 'paused_by_reviewer'
  | 'daily_limit_reached'
  | 'break_required';

/**
 * Every reason this reviewer cannot be assigned a case right now, in the order
 * they should be addressed. Empty means they can ask for one.
 */
export function assignmentBlockers(profile: ReviewerProfile, now: Date): AssignmentBlocker[] {
  const blockers: AssignmentBlocker[] = [];

  if (profile.state === 'applicant' || profile.consent.rulesAcceptedAt === null) {
    blockers.push('onboarding_incomplete');
  }
  if (profile.state === 'suspended') {
    blockers.push('suspended');
  }
  if (profile.eligibility.some((requirement) => !requirement.met)) {
    blockers.push('eligibility_unmet');
  }
  if (!profile.preferences.availableForAssignment) {
    blockers.push('paused_by_reviewer');
  }
  if (profile.exposure.reviewedToday >= profile.exposure.dailyLimit) {
    blockers.push('daily_limit_reached');
  }
  const breakUntil = profile.exposure.breakRequiredUntil;
  if (breakUntil !== null && new Date(breakUntil).getTime() > now.getTime()) {
    blockers.push('break_required');
  }

  return blockers;
}
