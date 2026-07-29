import { principalReporterKey, reporterFingerprint } from '../cases/case.service';
import type { ReviewerProfileDocument } from '../reviewer/reviewer.collection';

/**
 * §8.5's exclusions — who must NOT be drawn, however eligible they otherwise
 * are.
 *
 * `eligibility.ts` answers "can this person judge cases like this one". This
 * file answers the different and more dangerous question: "is this person
 * entangled with THIS case". Every rule here is a conflict of interest, and an
 * exclusion that silently matches nothing is the worst defect this module could
 * ship — a reporter sitting on the jury of their own report, with a green test
 * suite either way. Two things guard against that:
 *
 *  - The reporter check computes a candidate's fingerprint with the SAME
 *    exported function the case wrote its fingerprints with, rather than a
 *    second copy of the format. Drift between two copies is invisible.
 *  - `sortitionExclusions.test.ts` mutation-tests each rule: it breaks the rule
 *    and asserts the test fails and names what it caught.
 *
 * Every function here is pure. The data it needs is gathered once per draw by
 * `sortition.service.ts` in a fixed number of queries — never one query per
 * candidate, which is the shape §8.8 warns produced ten sequential round trips
 * per candidate in the civic selector.
 */

/** Why a candidate was removed from the pool. Written into the draw record. */
export const EXCLUSION_REASONS = [
  /** The candidate is the author (or another principal) of the material. */
  'subject_principal',
  /** The candidate reported it. */
  'reporter',
  /** The candidate already judged this case, or another case of the incident. */
  'prior_juror',
  /** The candidate declared a relationship with somebody involved (§8.5). */
  'declared_relation',
  /** The candidate declared a conflict with the reporting application (§8.2). */
  'application_conflict',
  /** The candidate shares a coordination cluster with a party to the case. */
  'party_risk_cluster',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/**
 * Everything about a case that decides who is entangled with it.
 *
 * Assembled once per draw. Note what is NOT here and cannot be: the identities
 * of the reporters. The case stores salted fingerprints (§7.4, §9.1) precisely
 * so nothing downstream can enumerate them, so the reporter test runs in the
 * only direction available — fingerprint the candidate, look them up.
 */
export interface CaseParties {
  readonly applicationId: string;
  /** External principal ids the MATERIAL points at: authors, sellers, targets. */
  readonly subjectPrincipalIds: ReadonlySet<string>;
  /** The case's stored reporter fingerprints, verbatim. */
  readonly reporterFingerprints: ReadonlySet<string>;
  /** Reviewers who already served on this case or its incident (§8.5). */
  readonly priorJurorIds: ReadonlySet<string>;
  /**
   * Risk clusters of the case's own participants, when a participant is also a
   * reviewer with a known cluster.
   *
   * Only the SUBJECT side can be resolved: a reporter is a fingerprint and
   * cannot be looked up. That asymmetry is a consequence of the privacy model
   * rather than an oversight, and it is stated here so nobody later reads the
   * empty reporter half as a bug and "fixes" it by storing reporter identities
   * on the case.
   */
  readonly partyRiskClusterIds: ReadonlySet<string>;
  /** Reviewers with a declared or recusal-derived relation to a party. */
  readonly relatedReviewerIds: ReadonlySet<string>;
}

/**
 * The exclusion, or null when the candidate is free of this case.
 *
 * Ordered so the reason a draw records is the strongest one: being the subject
 * outranks being a reporter, which outranks having judged it before.
 */
export function exclusionFor(
  profile: ReviewerProfileDocument,
  parties: CaseParties,
): ExclusionReason | null {
  const links = profile.principalLinks.filter(
    (link) => link.applicationId === parties.applicationId,
  );

  for (const link of links) {
    if (parties.subjectPrincipalIds.has(link.externalPrincipalId)) return 'subject_principal';
  }

  for (const link of links) {
    const fingerprint = reporterFingerprint(
      parties.applicationId,
      principalReporterKey(link.externalPrincipalId),
    );
    if (parties.reporterFingerprints.has(fingerprint)) return 'reporter';
  }

  if (parties.priorJurorIds.has(profile.reviewerId)) return 'prior_juror';
  if (parties.relatedReviewerIds.has(profile.reviewerId)) return 'declared_relation';
  if (profile.declaredConflictApplications.includes(parties.applicationId)) {
    return 'application_conflict';
  }
  if (profile.riskClusterId !== null && parties.partyRiskClusterIds.has(profile.riskClusterId)) {
    return 'party_risk_cluster';
  }

  return null;
}

/**
 * How many panels two reviewers may have shared before they stop counting as
 * two independent judgements (§8.5's affinity throttle).
 *
 * Three is a judgement call the plan does not make. It is high enough that a
 * small deployment can still form panels — with fifty reviewers, pairs recur —
 * and low enough that a stable clique cannot form inside a large one.
 */
export const MAX_CO_SERVICE = 3;
