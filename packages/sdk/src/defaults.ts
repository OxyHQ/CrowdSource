/**
 * What an integrator does not have to declare, and why each default is safe to
 * apply without being asked.
 *
 * The product requirement is near-zero configuration: an application should be
 * able to report a piece of content with a credential and the object itself. The
 * plan's requirement pulling the other way is §6.4 — every decision records the
 * policy version it was decided under, and a policy update must never silently
 * change what a past decision meant.
 *
 * Both hold only if the default is a PINNED VERSION rather than "whatever is
 * current". `DEFAULT_POLICY` below names a specific immutable published version.
 * When CrowdSource publishes a newer baseline, this constant changes in a
 * release of this package and integrators adopt it by upgrading — which is
 * visible in a lockfile, reviewable in a diff, and dated. The alternative
 * (resolving "latest" server-side) would move the policy version under an
 * application that never changed a line, and would silently split
 * `caseDedupKey` — §7.3 makes the policy version part of that key, so the day it
 * moved, two reports about one post would open two cases.
 */

import type { CasePolicyRef, CasePrivacy, TaxonomyCode } from '@oxyhq/crowdsource-contracts';

/** Where the service lives. One deployment; there is no sandbox host. */
export const DEFAULT_BASE_URL = 'https://api.crowdsource.oxy.so';

/**
 * The policy set a report is evaluated under when the application declares
 * none: the baseline CrowdSource ships over its own universal taxonomy (§6.3).
 *
 * Must stay equal to `BASELINE_POLICY_SET_ID` / `BASELINE_POLICY_VERSION` in the
 * backend's `modules/policy/policyBaseline.ts`, which is the registry that
 * resolves it. A drift is not a type error and not a test failure anywhere else:
 * it is a 422 on every zero-config report, in production, at the moment of
 * upgrade. `__tests__/defaults.test.ts` reads that file and asserts the pair.
 */
export const DEFAULT_POLICY: CasePolicyRef = Object.freeze({
  policySetId: 'crowdsource.baseline',
  version: '2026.07',
});

/**
 * §13.6's default retention: 30 days after a final decision, configurable by
 * policy.
 */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Allegation codes that must never reach a community jury (§7.5).
 *
 * §7.5 routes child sexual abuse and potentially illegal material to a
 * specialist team under legal protocol, and non-consensual intimate material to
 * specialist review. An integrator who never read §7.5 still gets that: an
 * envelope alleging one of these is composed with `allowCommunityReview: false`,
 * and an application that explicitly asks for `true` alongside one of them is
 * REFUSED rather than quietly corrected — the belief that this material can be
 * community-reviewed is the defect, and silently fixing the field would leave
 * the belief in place.
 *
 * This is a floor, never a ceiling. Triage may route a case away from the
 * community for reasons this list cannot see; nothing here can route one
 * towards it.
 */
export const COMMUNITY_REVIEW_FORBIDDEN_ALLEGATIONS: readonly TaxonomyCode[] = Object.freeze([
  'child_safety.sexualization',
  'child_safety.grooming',
  'child_safety.exploitation',
  'sexual_content.non_consensual',
  'sexual_content.exploitation',
]);

const FORBIDDEN_SET: ReadonlySet<string> = new Set(COMMUNITY_REVIEW_FORBIDDEN_ALLEGATIONS);

/** The allegations in `codes` that §7.5 keeps away from a community jury. */
export function allegationsForbiddingCommunityReview(
  codes: readonly TaxonomyCode[],
): readonly TaxonomyCode[] {
  return codes.filter((code) => FORBIDDEN_SET.has(code));
}

/** The privacy terms of a report that declares none. */
export function defaultPrivacy(allegationCodes: readonly TaxonomyCode[]): CasePrivacy {
  return {
    retentionDays: DEFAULT_RETENTION_DAYS,
    allowCommunityReview: allegationsForbiddingCommunityReview(allegationCodes).length === 0,
  };
}
