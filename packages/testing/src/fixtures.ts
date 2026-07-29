/**
 * Fixtures.
 *
 * Every builder below runs its result through the published contract before
 * returning it. A fixture that does not validate is a failing test, not
 * something to loosen — it is how an integrator finds out a contract moved, and
 * it is the only mechanism that stops this package from teaching a shape
 * CrowdSource will refuse.
 *
 * Everything here is synthetic. No real reported material, no real evidence, no
 * real reviewer or reporter identity ever ships in a test package: §13.5
 * minimises what exists at all, and a fixture file is forever.
 */

import {
  CASE_ENVELOPE_SCHEMA_VERSION,
  CaseEnvelopeSchema,
  DecisionSchema,
  KnownWebhookEventSchema,
  UNIVERSAL_TAXONOMY_VERSION,
  type CaseEnvelope,
  type Decision,
  type KnownWebhookEvent,
  type TaxonomyCode,
} from '@oxyhq/crowdsource-contracts';
import { createHash } from 'node:crypto';

/** Deterministic, so a fixture used twice produces the same bytes. */
function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export interface CaseEnvelopeFixtureOptions {
  readonly applicationId?: string;
  readonly externalReportId?: string;
  readonly externalSubjectId?: string;
  readonly text?: string;
  readonly allegations?: readonly TaxonomyCode[];
  /** An `oxy_user` binding carries a proof; §11.14 admits no effect without one. */
  readonly authorOxyUserId?: string;
  readonly allowCommunityReview?: boolean;
}

/**
 * A minimal valid Case Envelope: one text resource, one allegation, one author.
 *
 * Deliberately the SMALLEST thing the contract accepts rather than a showcase of
 * every field. A fixture that exercises everything hides which field a test
 * actually depends on, and every optional field it carries is one more thing a
 * contract change can break for a reason unrelated to the test.
 */
export function caseEnvelopeFixture(options: CaseEnvelopeFixtureOptions = {}): CaseEnvelope {
  const text = options.text ?? 'Synthetic reported text for an integration test.';
  const authorOxyUserId = options.authorOxyUserId ?? 'oxy_test_author';

  return CaseEnvelopeSchema.parse({
    schemaVersion: CASE_ENVELOPE_SCHEMA_VERSION,
    applicationId: options.applicationId ?? 'app_test',
    externalReportId: options.externalReportId ?? 'report_test_1',
    source: { environment: 'sandbox', submittedAt: '2026-07-29T00:00:00.000Z' },
    subject: {
      externalId: options.externalSubjectId ?? 'post_test_1',
      type: 'social.post',
      primaryResourceId: 'res_subject',
    },
    principalBindings: [
      {
        principalRef: 'p_author',
        type: 'oxy_user',
        externalPrincipalId: authorOxyUserId,
        bindingProofId: authorOxyUserId,
      },
    ],
    resources: [
      {
        id: 'res_subject',
        type: 'text',
        role: 'subject',
        language: 'en',
        data: { text },
        sha256: digestOf({ type: 'text', data: { text } }),
        authorPrincipalRef: 'p_author',
      },
    ],
    relations: [],
    allegations: (options.allegations ?? ['harassment.targeted_abuse']).map((code) => ({ code })),
    policy: { policySetId: 'crowdsource.baseline', version: '2026.07' },
    privacy: {
      retentionDays: 30,
      allowCommunityReview: options.allowCommunityReview ?? true,
    },
  });
}

export interface DecisionFixtureOptions {
  readonly id?: string;
  readonly caseId?: string;
  readonly revision?: number;
  readonly outcome?: Decision['outcome'];
  readonly status?: Decision['status'];
  readonly findingCode?: TaxonomyCode;
  readonly supersedesDecisionId?: string;
}

/**
 * A published decision (Appendix B).
 *
 * The jury arithmetic is real, not decorative: `agreement` must equal
 * `winningVotes / decisiveVotes` or the contract refuses the document. That
 * check is the auditable trace of "one qualified person, one vote", so a fixture
 * that faked it would teach a shape the service will never emit.
 */
export function decisionFixture(options: DecisionFixtureOptions = {}): Decision {
  const outcome = options.outcome ?? 'violation';
  const revision = options.revision ?? 1;

  return DecisionSchema.parse({
    id: options.id ?? 'dec_test_1',
    caseId: options.caseId ?? 'case_test_1',
    revision,
    status: options.status ?? 'final',
    outcome,
    contextSufficiency: 'sufficient',
    confidence: 1,
    findings:
      outcome === 'violation'
        ? [
            {
              code: options.findingCode ?? 'harassment.targeted_abuse',
              resourceIds: ['res_subject'],
              severity: 'medium',
              scope: 'application_local',
              attribution: 'author',
            },
          ]
        : [],
    recommendedActions:
      outcome === 'violation'
        ? [{ action: 'remove_or_restrict', targetResourceIds: ['res_subject'] }]
        : [{ action: 'no_action' }],
    jury: {
      size: 3,
      decisiveVotes: 3,
      winningVotes: 3,
      agreement: 1,
      specialistPresent: false,
    },
    policyVersions: {
      taxonomy: UNIVERSAL_TAXONOMY_VERSION,
      application: '2026.07',
      oxyConduct: '2026.07',
    },
    ...(options.supersedesDecisionId === undefined
      ? {}
      : { supersedesDecisionId: options.supersedesDecisionId }),
    publishedAt: '2026-07-29T12:00:00.000Z',
  });
}

export interface WebhookEventFixtureOptions {
  readonly id?: string;
  readonly organizationId?: string;
  readonly applicationId?: string;
  readonly createdAt?: string;
  readonly caseId?: string;
  readonly decision?: Decision;
}

/** A `case.decided` delivery (§10.7) — the one event §10.7 specifies in full. */
export function caseDecidedEventFixture(
  options: WebhookEventFixtureOptions = {},
): KnownWebhookEvent {
  const decision = options.decision ?? decisionFixture({ caseId: options.caseId });

  return KnownWebhookEventSchema.parse({
    id: options.id ?? 'evt_test_1',
    type: 'case.decided',
    createdAt: options.createdAt ?? '2026-07-29T12:00:00.000Z',
    organizationId: options.organizationId ?? 'org_test',
    applicationId: options.applicationId ?? 'app_test',
    data: { caseId: options.caseId ?? decision.caseId, decision },
  });
}
