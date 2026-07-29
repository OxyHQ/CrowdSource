import { describe, expect, it } from 'vitest';

import { principalReporterKey, reporterFingerprint } from '../modules/cases/case.service';
import {
  EXCLUSION_REASONS,
  exclusionFor,
  type CaseParties,
  type ExclusionReason,
} from '../modules/sortition/exclusions';
import type { ReviewerProfileDocument } from '../modules/reviewer/reviewer.collection';

/**
 * §8.5's exclusions, and the mutation evidence that they are not no-ops.
 *
 * An exclusion that silently matches nothing is the worst defect this phase
 * could ship: the reporter of a case sitting on its own jury, with a green suite
 * either way. So every rule here is tested twice — once with the entangling fact
 * present, and once with THAT ONE FACT removed and everything else identical.
 * The second half is what makes the first mean something: if the rule were
 * deleted, the "present" case would return null and the test would fail naming
 * the reason it expected.
 */

const APPLICATION = 'app_1111111111111111111111111111';
const AUTHOR = 'user_author';
const REPORTER = 'user_reporter';

function profile(overrides: Partial<ReviewerProfileDocument> = {}): ReviewerProfileDocument {
  const now = new Date();
  return {
    reviewerId: 'rvw_candidate',
    oxyUserId: 'oxy_candidate',
    state: 'community',
    accountActive: true,
    oxyAccountVerified: true,
    isAdult: true,
    suspectedSockPuppet: false,
    riskClusterId: null,
    languages: ['es'],
    categories: ['harassment'],
    specialistCategories: [],
    maxSensitivityRank: 0,
    consentedSensitiveCategories: [],
    declaredConflictApplications: [],
    available: true,
    dailyReviewLimit: 20,
    trainingCompletedModules: [],
    trainingCompletedAt: now,
    calibrationPassedAt: now,
    calibrationScore: 0.9,
    calibrationAttempts: 1,
    lastCalibrationAt: now,
    reliabilityByCategory: { harassment: 0.9 },
    completedReviewCount: 20,
    personhoodConfidence: 1,
    samplingKey: 0.5,
    principalLinks: [],
    suspendedUntil: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function parties(overrides: Partial<CaseParties> = {}): CaseParties {
  return {
    applicationId: APPLICATION,
    subjectPrincipalIds: new Set<string>(),
    reporterFingerprints: new Set<string>(),
    priorJurorIds: new Set<string>(),
    partyRiskClusterIds: new Set<string>(),
    relatedReviewerIds: new Set<string>(),
    ...overrides,
  };
}

/**
 * One case per rule: the entangling fact, and the same situation without it.
 *
 * Written as data so a new exclusion reason cannot be added without a row here
 * — the completeness assertion at the bottom fails if one is missing.
 */
const CASES: readonly {
  readonly reason: ExclusionReason;
  readonly entangled: ReviewerProfileDocument;
  readonly parties: CaseParties;
  /** The same profile with only the entangling fact removed. */
  readonly free: ReviewerProfileDocument;
}[] = [
  {
    reason: 'subject_principal',
    entangled: profile({
      principalLinks: [{ applicationId: APPLICATION, externalPrincipalId: AUTHOR }],
    }),
    parties: parties({ subjectPrincipalIds: new Set([AUTHOR]) }),
    free: profile({
      principalLinks: [{ applicationId: APPLICATION, externalPrincipalId: 'user_stranger' }],
    }),
  },
  {
    reason: 'reporter',
    entangled: profile({
      principalLinks: [{ applicationId: APPLICATION, externalPrincipalId: REPORTER }],
    }),
    parties: parties({
      /**
       * Built with the case service's OWN functions, not a copy of the format.
       *
       * The fingerprint is one-way, so the only way to ask "is this candidate a
       * reporter" is to compute theirs the same way the case computed its. Two
       * copies of the string format would drift, and drift here produces an
       * exclusion that matches nothing — invisibly.
       */
      reporterFingerprints: new Set([
        reporterFingerprint(APPLICATION, principalReporterKey(REPORTER)),
      ]),
    }),
    free: profile({
      principalLinks: [{ applicationId: APPLICATION, externalPrincipalId: 'user_stranger' }],
    }),
  },
  {
    reason: 'prior_juror',
    entangled: profile(),
    parties: parties({ priorJurorIds: new Set(['rvw_candidate']) }),
    free: profile({ reviewerId: 'rvw_someone_else' }),
  },
  {
    reason: 'declared_relation',
    entangled: profile(),
    parties: parties({ relatedReviewerIds: new Set(['rvw_candidate']) }),
    free: profile({ reviewerId: 'rvw_someone_else' }),
  },
  {
    reason: 'application_conflict',
    entangled: profile({ declaredConflictApplications: [APPLICATION] }),
    parties: parties(),
    free: profile({ declaredConflictApplications: ['app_other'] }),
  },
  {
    reason: 'party_risk_cluster',
    entangled: profile({ riskClusterId: 'cluster_x' }),
    parties: parties({ partyRiskClusterIds: new Set(['cluster_x']) }),
    free: profile({ riskClusterId: 'cluster_y' }),
  },
];

describe('§8.5 exclusions', () => {
  for (const entry of CASES) {
    it(`excludes a candidate who is ${entry.reason.replace(/_/g, ' ')}`, () => {
      expect(exclusionFor(entry.entangled, entry.parties)).toBe(entry.reason);
    });

    /**
     * The mutation half. Same parties, same everything, minus the one fact that
     * entangles them — so a rule that had been deleted would show up as the test
     * above returning null while this one still passes, and a rule that excluded
     * EVERYBODY would show up here.
     */
    it(`admits an otherwise identical candidate who is not ${entry.reason.replace(/_/g, ' ')}`, () => {
      expect(exclusionFor(entry.free, entry.parties)).toBeNull();
    });
  }

  it('covers every declared reason, so a new one cannot be added untested', () => {
    expect([...CASES].map((entry) => entry.reason).sort()).toEqual([...EXCLUSION_REASONS].sort());
  });
});

describe('the reporter check is drift-proof by construction', () => {
  /**
   * The rule most likely to break, and the way it would break.
   *
   * `case.service.ts` writes `sha256(applicationId + ':' + 'principal:' + id)`.
   * If sortition ever computed a slightly different string — a different
   * separator, a missing prefix, the raw id — the set membership test would
   * simply never match and the exclusion would become a no-op with no error, no
   * log line and no failing test. This asserts BOTH directions: the shared
   * helpers match, and a plausible drifted format does not.
   */
  const candidate = profile({
    principalLinks: [{ applicationId: APPLICATION, externalPrincipalId: REPORTER }],
  });

  it('matches when the fingerprint came from the shared helpers', () => {
    const stored = parties({
      reporterFingerprints: new Set([
        reporterFingerprint(APPLICATION, principalReporterKey(REPORTER)),
      ]),
    });
    expect(exclusionFor(candidate, stored)).toBe('reporter');
  });

  it('would MISS a fingerprint built with a drifted format — which is why there is one helper', () => {
    for (const drifted of [
      reporterFingerprint(APPLICATION, REPORTER),
      reporterFingerprint(APPLICATION, `principal_${REPORTER}`),
      reporterFingerprint('app_other', principalReporterKey(REPORTER)),
    ]) {
      expect(exclusionFor(candidate, parties({ reporterFingerprints: new Set([drifted]) }))).toBeNull();
    }
  });
});

describe('exclusions are scoped to the application that owns the case', () => {
  it('does not exclude somebody whose link is to a different application', () => {
    /**
     * A `principalRef` and an external principal id are local to one
     * application: `user_author` at one tenant and `user_author` at another are
     * two different people. Comparing them across tenants would exclude
     * reviewers for no reason AND leak that the same string exists elsewhere.
     */
    const candidate = profile({
      principalLinks: [{ applicationId: 'app_other', externalPrincipalId: AUTHOR }],
    });

    expect(exclusionFor(candidate, parties({ subjectPrincipalIds: new Set([AUTHOR]) }))).toBeNull();
  });
});

describe('the order of reasons', () => {
  it('reports the strongest entanglement when several apply', () => {
    // Somebody who is the author, reported it, and served before: the answer
    // that matters is that they are the subject.
    const candidate = profile({
      principalLinks: [{ applicationId: APPLICATION, externalPrincipalId: AUTHOR }],
    });
    const everything = parties({
      subjectPrincipalIds: new Set([AUTHOR]),
      reporterFingerprints: new Set([
        reporterFingerprint(APPLICATION, principalReporterKey(AUTHOR)),
      ]),
      priorJurorIds: new Set(['rvw_candidate']),
    });

    expect(exclusionFor(candidate, everything)).toBe('subject_principal');
  });
});
