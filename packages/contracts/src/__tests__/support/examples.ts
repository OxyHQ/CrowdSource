/**
 * Valid payloads the suites start from.
 *
 * Every builder returns a fresh `Record<string, unknown>` so a test can compose
 * a defect by spreading — including defects the TypeScript types forbid, which
 * is most of what a contract test needs to do. Anything typed would only be
 * able to test the half of the contract TypeScript already enforces.
 */

export const DIGEST = Object.freeze({
  post: `sha256:${'1'.repeat(64)}`,
  image: `sha256:${'2'.repeat(64)}`,
  parent: `sha256:${'3'.repeat(64)}`,
  proof: `sha256:${'4'.repeat(64)}`,
});

export function textResourceExample(): Record<string, unknown> {
  return {
    id: 'res_post',
    type: 'text',
    role: 'subject',
    language: 'es-ES',
    data: { text: 'Contenido exacto reportado', formatting: 'plain' },
    sha256: DIGEST.post,
    createdAt: '2026-07-28T17:55:00.000Z',
    authorPrincipalRef: 'author_1',
  };
}

export function imageResourceExample(): Record<string, unknown> {
  return {
    id: 'res_image',
    type: 'image',
    role: 'attachment',
    asset: {
      uploadId: 'upload_01HZ',
      mimeType: 'image/jpeg',
      sizeBytes: 220144,
      width: 1200,
      height: 900,
      sha256: DIGEST.image,
    },
  };
}

export function principalBindingExample(): Record<string, unknown> {
  return {
    principalRef: 'author_1',
    type: 'oxy_user',
    externalPrincipalId: 'mention_user_55',
    bindingProofId: 'bind_01HZ',
    boundAt: '2026-07-20T11:00:00.000Z',
  };
}

export function caseEnvelopeExample(): Record<string, unknown> {
  return {
    schemaVersion: 'crowdsource.case.v1',
    applicationId: 'app_mention',
    externalReportId: 'mention_report_123',
    subject: {
      externalId: 'post_987',
      type: 'social.post',
      primaryResourceId: 'res_post',
    },
    principalBindings: [principalBindingExample()],
    resources: [textResourceExample(), imageResourceExample()],
    relations: [{ from: 'res_post', type: 'has_attachment', to: 'res_image' }],
    allegations: [{ code: 'harassment.targeted_abuse', resourceIds: ['res_post'] }],
    policy: { policySetId: 'mention.community', version: '2026.07' },
    privacy: { retentionDays: 30, allowCommunityReview: true },
  };
}

export function reviewSubmissionExample(): Record<string, unknown> {
  return {
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    findings: [
      {
        code: 'harassment.targeted_abuse',
        resourceIds: ['res_post'],
        severity: 'medium',
        confidence: 0.88,
        policyRuleIds: ['mention.harassment.2'],
      },
    ],
    recommendedActions: ['remove_or_restrict'],
  };
}

export function decisionExample(): Record<string, unknown> {
  return {
    id: 'dec_01HZ',
    caseId: 'case_01HZ',
    revision: 1,
    status: 'final',
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    confidence: 0.91,
    findings: [
      {
        code: 'harassment.targeted_abuse',
        resourceIds: ['res_post'],
        severity: 'medium',
        scope: 'oxy_network',
        attribution: 'author',
        policyRuleIds: ['mention.harassment.2'],
      },
    ],
    recommendedActions: [{ action: 'remove_or_restrict', targetResourceIds: ['res_post'] }],
    jury: {
      size: 5,
      decisiveVotes: 5,
      winningVotes: 4,
      agreement: 0.8,
      specialistPresent: true,
    },
    policyVersions: {
      taxonomy: '2026.1',
      application: 'mention.2026.07',
      oxyConduct: 'oxy.2026.1',
    },
    publishedAt: '2026-07-28T18:30:00.000Z',
  };
}

export function caseDecidedEventExample(): Record<string, unknown> {
  return {
    id: 'evt_01HZ',
    type: 'case.decided',
    createdAt: '2026-07-28T18:30:00.000Z',
    organizationId: 'org_01HZ',
    applicationId: 'app_mention',
    data: { caseId: 'case_01HZ', decision: decisionExample() },
  };
}

export function reputationEventExample(): Record<string, unknown> {
  return {
    eventId: 'evt_01HZ',
    type: 'moderation.decision.finalized.v1',
    caseId: 'case_01HZ',
    incidentId: 'inc_01HZ',
    decisionId: 'dec_01HZ',
    decisionRevision: 1,
    applicationId: 'app_mention',
    subject: {
      principalType: 'oxy_user',
      principalId: 'oxy_user_123',
      bindingProofId: 'binding_456',
    },
    findings: [
      {
        code: 'harassment.targeted_abuse',
        severity: 'medium',
        scope: 'oxy_network',
        attribution: 'author',
      },
    ],
    decisionStatus: 'final',
    policyVersions: {
      universal: '2026.1',
      application: 'mention.2026.07',
      oxyConduct: 'oxy.2026.1',
    },
    proofHash: DIGEST.proof,
  };
}

export function policySetVersionExample(): Record<string, unknown> {
  return {
    policySetId: 'mention.community',
    version: '2026.07',
    status: 'published',
    title: 'Mention community standards',
    locale: 'es-ES',
    publishedAt: '2026-07-01T00:00:00.000Z',
    rules: [
      {
        id: 'mention.harassment.2',
        title: 'Targeted abuse',
        taxonomyCodes: ['harassment.targeted_abuse'],
        defaultSeverity: 'medium',
        recommendedActions: ['remove_or_restrict'],
      },
    ],
  };
}
