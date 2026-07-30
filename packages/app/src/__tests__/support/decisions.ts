import { DecisionSchema, type Decision } from '@oxyhq/crowdsource-contracts';

/**
 * A published decision, built through the real `DecisionSchema`.
 *
 * Parsed rather than cast into shape, deliberately. A decision the contract
 * would refuse can never reach a planner in production, so a planner test using
 * one would be answering a question nobody asks — and parsing here means the
 * jury arithmetic and the revision/supersedes rules are enforced on every
 * fixture that uses this.
 *
 * `@oxyhq/crowdsource-testing`'s `decisionFixture` covers the common shapes but
 * fixes `findings` and `recommendedActions` to the outcome; the planner is
 * exactly the thing that has to be exercised across arbitrary combinations of
 * those two, which is why this exists alongside it.
 */
export function decision(
  overrides: {
    outcome?: Decision['outcome'];
    status?: Decision['status'];
    revision?: number;
    findings?: readonly { code: string; severity: string }[];
    recommendedActions?: readonly { action: string }[];
  } = {},
): Decision {
  const revision = overrides.revision ?? 1;
  const outcome = overrides.outcome ?? 'violation';
  return DecisionSchema.parse({
    id: 'dec_test_1',
    caseId: 'case_test_1',
    revision,
    status: overrides.status ?? 'final',
    outcome,
    contextSufficiency: 'sufficient',
    confidence: 1,
    findings: (
      overrides.findings ?? [{ code: 'integrity.spam', severity: 'medium' }]
    ).map((finding) => ({
      code: finding.code,
      resourceIds: ['res_subject'],
      severity: finding.severity,
      scope: 'application_local',
      attribution: 'author',
    })),
    recommendedActions: overrides.recommendedActions ?? [],
    jury: {
      size: 3,
      decisiveVotes: 3,
      winningVotes: 3,
      agreement: 1,
      specialistPresent: false,
    },
    policyVersions: {
      taxonomy: '2026.07',
      application: '2026.07',
      oxyConduct: '2026.07',
    },
    ...(revision > 1 ? { supersedesDecisionId: 'dec_test_0' } : {}),
    publishedAt: '2026-07-29T12:00:00.000Z',
  });
}
