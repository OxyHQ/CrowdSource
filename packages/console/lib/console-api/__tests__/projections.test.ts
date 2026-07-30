/**
 * The privacy boundary, exercised.
 *
 * Every projection is fed a payload that is CORRECT plus a set of probe fields the
 * console must never show — `reviewerId`, `agreeingReviewerIds`, `reporterFingerprints`,
 * `reviews`, `priorityScore`, `reviewPool`, `secretHash`, `contentSnapshot`, an
 * `oxyUserId` where none belongs, and a resource with a `data` payload. Each probe
 * carries the same sentinel VALUE, so the assertion is a single one that reads
 * correctly: nothing containing the sentinel survives into app state.
 *
 * Asserting the sentinel and not just the key name matters. A projection that renamed
 * a forbidden field while still copying its value would pass a key-name check and fail
 * this one.
 *
 * ## One field is deliberately not universally forbidden: `oxyUserId`
 *
 * It is a CONTRACT field of `GET /v1/console/session`, of an organization member, and
 * of the operator who last moved a standing — the viewer's own identity and the seats
 * they administer, which is the thing the console exists to manage. Where it is part of
 * the contract, the test supplies a REAL value and asserts it survives; everywhere else
 * it carries the sentinel and must not. A blanket ban would be a rule nobody could
 * keep, and a rule nobody can keep gets deleted.
 *
 * The exact-key-set assertions are the other half. They are what makes "a field the
 * backend starts sending cannot reach a screen" true by construction rather than by the
 * probe list happening to be complete.
 */

import { MalformedPayloadError } from '../errors';
import {
  projectApplicationDetail,
  projectApplications,
  projectAuditEvents,
  projectCaseDetail,
  projectCasePage,
  projectCredentials,
  projectDeadLetterQueue,
  projectDeliveries,
  projectIssuedCredential,
  projectMembers,
  projectOrganizations,
  projectPlatformMetrics,
  projectRotatedSecret,
  projectSession,
  projectTrustSafetyApplications,
  projectUsage,
  projectWebhookEndpoints,
  scanForForbiddenFields,
} from '../projections';

/** The value every probe field carries. Its presence anywhere is a failure. */
const LEAK = '__must_not_survive__';

/**
 * Fields the console must never show, all carrying the sentinel.
 *
 * Spread into every payload at every level the projections read, so a projection that
 * copies an object wholesale rather than field by field fails immediately.
 */
const PROBES = {
  reviewerId: LEAK,
  reviewerIds: [LEAK],
  agreeingReviewerIds: [LEAK],
  jurors: [{ reviewerId: LEAK }],
  reviews: [{ reviewerId: LEAK, outcome: LEAK }],
  votes: [LEAK],
  reporterFingerprints: [LEAK],
  reporterId: LEAK,
  contentSnapshot: { resources: [{ id: LEAK, data: LEAK }] },
  priorityScore: LEAK,
  reviewPool: LEAK,
  secretHash: LEAK,
  incidentId: LEAK,
  body: LEAK,
  oxyUserId: LEAK,
} as const;

/** Serializes a projected value so one assertion covers every nested field. */
function serialize(value: unknown): string {
  return JSON.stringify(value);
}

describe('scanForForbiddenFields', () => {
  it('reports the path of every forbidden field, and never a value', () => {
    const paths = scanForForbiddenFields({ decisions: [{ ...PROBES }] });

    // The alarm found the fields.
    expect(paths).toContain('decisions[0].reviewerId');
    expect(paths).toContain('decisions[0].agreeingReviewerIds');
    expect(paths).toContain('decisions[0].reporterFingerprints');
    expect(paths).toContain('decisions[0].contentSnapshot');
    expect(paths).toContain('decisions[0].priorityScore');
    expect(paths).toContain('decisions[0].reviewPool');
    expect(paths).toContain('decisions[0].secretHash');
    expect(paths).toContain('decisions[0].reviews');
    expect(paths).toContain('decisions[0].incidentId');

    // And reported none of their values. The paths are what a developer needs; the
    // values are the material that must not reach a log.
    expect(paths.join('|')).not.toContain(LEAK);
  });

  it('does not fire on the aggregate jury figures, which ARE published', () => {
    // A pattern too eager here gets disabled by whoever trips over it, which would
    // cost the alarm entirely. `jury`, `decisiveVotes` and `winningVotes` are served by
    // the application API and by §10.7's envelope.
    const paths = scanForForbiddenFields({
      jury: { size: 5, decisiveVotes: 5, winningVotes: 4, agreement: 0.8 },
      reportCount: 3,
      oxyUserId: 'oxy_1',
      token: 'shown-once',
    });
    expect(paths).toEqual([]);
  });

  it('reports truncation as its own path rather than stopping silently', () => {
    // A silent stop reads identically to a clean scan, which is the worst possible
    // failure mode for an alarm.
    let deep: Record<string, unknown> = { reviewerId: LEAK };
    for (let level = 0; level < 40; level += 1) {
      deep = { nested: deep };
    }
    expect(scanForForbiddenFields(deep)).toContain('<scan-truncated>');
  });
});

describe('projectSession', () => {
  const projected = projectSession({
    ...PROBES,
    // The viewer's OWN id: a contract field, and the one identity the console shows.
    oxyUserId: 'oxy_viewer',
    memberships: [
      {
        ...PROBES,
        oxyUserId: 'oxy_viewer',
        organizationId: 'org_1',
        name: 'Acme',
        slug: 'acme',
        status: 'active',
        role: 'admin',
      },
    ],
    staffRoles: ['security'],
  });

  it('keeps only the session contract', () => {
    expect(Object.keys(projected).sort()).toEqual(['memberships', 'oxyUserId', 'staffRoles']);
    expect(Object.keys(projected.memberships[0]).sort()).toEqual([
      'name',
      'organizationId',
      'role',
      'slug',
      'status',
    ]);
  });

  it('carries the viewer id and drops everything else', () => {
    expect(projected.oxyUserId).toBe('oxy_viewer');
    expect(projected.staffRoles).toEqual(['security']);
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('rejects a staff role it does not recognise', () => {
    // A string this app does not know would either hide a surface a staff member is
    // entitled to or show one they are not.
    expect(() => projectSession({ oxyUserId: 'oxy_1', memberships: [], staffRoles: ['root'] })).toThrow(
      MalformedPayloadError,
    );
  });
});

describe('projectOrganizations and projectMembers', () => {
  it('keeps only the organization contract', () => {
    const projected = projectOrganizations({
      ...PROBES,
      organizations: [
        {
          ...PROBES,
          organizationId: 'org_1',
          name: 'Acme',
          slug: 'acme',
          status: 'active',
          role: 'owner',
          applicationCount: 2,
        },
      ],
    });
    expect(Object.keys(projected[0]).sort()).toEqual([
      'applicationCount',
      'name',
      'organizationId',
      'role',
      'slug',
      'status',
    ]);
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('keeps a member seat, whose oxyUserId IS the contract', () => {
    const projected = projectMembers({
      ...PROBES,
      members: [
        {
          ...PROBES,
          oxyUserId: 'oxy_member',
          role: 'developer',
          status: 'active',
          invitedByOxyUserId: 'oxy_owner',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(Object.keys(projected[0]).sort()).toEqual([
      'createdAt',
      'invitedByOxyUserId',
      'oxyUserId',
      'role',
      'status',
    ]);
    expect(projected[0].oxyUserId).toBe('oxy_member');
    expect(serialize(projected)).not.toContain(LEAK);
  });
});

describe('projectApplications and projectApplicationDetail', () => {
  it('keeps only the summary contract', () => {
    const projected = projectApplications({
      ...PROBES,
      applications: [
        {
          ...PROBES,
          applicationId: 'app_1',
          name: 'Mention',
          status: 'active',
          standing: 'sandbox',
          globalReputationEffectsAllowed: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(Object.keys(projected[0]).sort()).toEqual([
      'applicationId',
      'createdAt',
      'globalReputationEffectsAllowed',
      'name',
      'standing',
      'status',
    ]);
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('renders an unmeasured trust signal as null, never as zero', () => {
    // The whole reason `readNullableNumber` exists: zero is the worst possible score
    // and absent is no score at all.
    const projected = projectApplicationDetail({
      ...PROBES,
      applicationId: 'app_1',
      organizationId: 'org_1',
      name: 'Mention',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      role: 'admin',
      trust: {
        ...PROBES,
        standing: 'trusted',
        globalReputationEffectsAllowed: true,
        evidenceIntegrity: null,
        identityBindingReliability: null,
        policyQuality: null,
        lastStandingReason: 'promotion_review_passed',
        standingChangedAt: null,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      quota: { ...PROBES, reportsPerDay: 100, webhookEndpoints: 2, globalReputationEffects: true },
    });

    expect(projected.trust.evidenceIntegrity).toBeNull();
    expect(projected.trust.identityBindingReliability).toBeNull();
    expect(projected.trust.policyQuality).toBeNull();
    expect(Object.keys(projected.trust).sort()).toEqual([
      'evidenceIntegrity',
      'globalReputationEffectsAllowed',
      'identityBindingReliability',
      'lastStandingReason',
      'policyQuality',
      'standing',
      'standingChangedAt',
      'updatedAt',
    ]);
    expect(serialize(projected)).not.toContain(LEAK);
  });
});

describe('projectCredentials and projectIssuedCredential', () => {
  it('never carries a stored digest', () => {
    const projected = projectCredentials({
      ...PROBES,
      credentials: [
        {
          ...PROBES,
          credentialId: 'cred_1',
          scopes: ['crowdsource:reports:write'],
          status: 'active',
          expiresAt: null,
          revokedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(Object.keys(projected[0]).sort()).toEqual([
      'createdAt',
      'credentialId',
      'expiresAt',
      'revokedAt',
      'scopes',
      'status',
    ]);
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('carries the one-time token, which is the point of that response', () => {
    const projected = projectIssuedCredential({
      ...PROBES,
      credentialId: 'cred_1',
      scopes: ['crowdsource:reports:write'],
      token: 'app_1:cred_1:secret',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(projected.token).toBe('app_1:cred_1:secret');
    expect(Object.keys(projected).sort()).toEqual([
      'createdAt',
      'credentialId',
      'scopes',
      'token',
    ]);
    expect(serialize(projected)).not.toContain(LEAK);
  });
});

describe('projectWebhookEndpoints, projectRotatedSecret and projectDeliveries', () => {
  it('keeps only the endpoint contract', () => {
    const projected = projectWebhookEndpoints({
      ...PROBES,
      endpoints: [
        {
          ...PROBES,
          webhookEndpointId: 'whe_1',
          url: 'https://example.test/hook',
          eventTypes: ['decision.published'],
          status: 'active',
          disabledReason: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          health: { ...PROBES, pending: 1, delivering: 0, succeeded: 9, deadLetter: 0 },
        },
      ],
    });
    expect(Object.keys(projected[0]).sort()).toEqual([
      'createdAt',
      'disabledReason',
      'eventTypes',
      'health',
      'status',
      'updatedAt',
      'url',
      'webhookEndpointId',
    ]);
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('carries the rotated secret and its signing instant', () => {
    const projected = projectRotatedSecret({
      ...PROBES,
      webhookEndpointId: 'whe_1',
      secret: { ...PROBES, version: 2, value: 'whsec_new', signingStartsAt: '2026-01-03T00:00:00.000Z' },
      previousSecret: { ...PROBES, version: 1, expiresAt: '2026-01-03T01:00:00.000Z' },
    });
    expect(projected.secret.value).toBe('whsec_new');
    expect(projected.secret.signingStartsAt).toBe('2026-01-03T00:00:00.000Z');
    expect(Object.keys(projected.secret).sort()).toEqual([
      'signingStartsAt',
      'value',
      'version',
    ]);
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('never carries a delivery body', () => {
    // The delivery row holds the exact signed bytes of the event. The server withholds
    // them; this is the second lock.
    const projected = projectDeliveries({
      ...PROBES,
      deliveries: [
        {
          ...PROBES,
          deliveryId: 'whd_1',
          webhookEndpointId: 'whe_1',
          eventId: 'evt_1',
          eventType: 'decision.published',
          status: 'dead_letter',
          attemptCount: 6,
          cycleAttemptCount: 6,
          lastResponseStatus: 500,
          deadLetterReason: 'max_attempts',
          nextAttemptAt: null,
          succeededAt: null,
          deadLetteredAt: '2026-01-02T00:00:00.000Z',
          replayCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    expect(Object.keys(projected[0])).not.toContain('body');
    expect(serialize(projected)).not.toContain(LEAK);
  });
});

describe('projectCasePage and projectCaseDetail', () => {
  const caseRow = {
    ...PROBES,
    caseId: 'case_1',
    status: 'decided',
    subject: { ...PROBES, externalId: 'post_1', type: 'post' },
    policyVersion: 'baseline@1.0.0',
    allegationCodes: ['harassment.targeted'],
    reportCount: 12,
    sensitivityClass: null,
    currentRevision: 1,
    decidedRevision: 1,
    outcome: 'inconclusive',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  it('keeps a report COUNT and no fingerprints', () => {
    const projected = projectCasePage({ ...PROBES, cases: [caseRow], nextCursor: 'cursor_2' });
    expect(projected.cases[0].reportCount).toBe(12);
    expect(projected.nextCursor).toBe('cursor_2');
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('keeps `inconclusive` as its own outcome', () => {
    const projected = projectCasePage({ cases: [caseRow], nextCursor: null });
    expect(projected.cases[0].outcome).toBe('inconclusive');
  });

  it('rejects an outcome it does not recognise rather than passing it through', () => {
    // An unknown outcome cannot be rendered truthfully, and passing one through is how
    // `inconclusive` eventually gets drawn as `no_violation`.
    expect(() =>
      projectCasePage({ cases: [{ ...caseRow, outcome: 'probably_fine' }], nextCursor: null }),
    ).toThrow(MalformedPayloadError);
  });

  it('keeps resource metadata and drops every payload', () => {
    const projected = projectCaseDetail({
      ...PROBES,
      caseId: 'case_1',
      status: 'decided',
      subject: { ...PROBES, externalId: 'post_1', type: 'post', primaryResourceId: 'res_1' },
      policy: { ...PROBES, policySetId: 'baseline', version: '1.0.0' },
      taxonomyVersion: '1.0.0',
      allegationCodes: ['harassment.targeted'],
      reportCount: 12,
      sensitivityClass: 'high',
      currentRevision: 2,
      resources: [
        {
          ...PROBES,
          id: 'res_1',
          type: 'text',
          role: 'primary',
          language: 'en',
          sha256: 'abc123',
          // The payload. This is the field that must never reach a screen.
          data: LEAK,
        },
      ],
      reports: [
        {
          ...PROBES,
          reportId: 'rep_1',
          externalReportId: 'ext_1',
          allegationCodes: ['harassment.targeted'],
          merged: true,
          linkedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      decisions: [
        {
          ...PROBES,
          id: 'dec_1',
          caseId: 'case_1',
          revision: 1,
          status: 'superseded',
          outcome: 'violation',
          contextSufficiency: 'sufficient',
          confidence: 0.8,
          findings: [
            {
              ...PROBES,
              code: 'harassment.targeted',
              resourceIds: ['res_1'],
              severity: 'high',
              scope: 'content',
              context: null,
              attribution: 'author',
              policyRuleIds: ['rule_1'],
            },
          ],
          recommendedActions: [{ ...PROBES, action: 'remove', targetResourceIds: ['res_1'] }],
          jury: {
            ...PROBES,
            size: 5,
            decisiveVotes: 5,
            winningVotes: 4,
            agreement: 0.8,
            specialistPresent: false,
          },
          policyVersions: { ...PROBES, taxonomy: '1.0.0', application: '1.0.0', oxyConduct: '1.0.0' },
          supersedesDecisionId: null,
          publishedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(Object.keys(projected.resources[0]).sort()).toEqual([
      'id',
      'language',
      'role',
      'sha256',
      'type',
    ]);
    // Aggregate jury figures survive; there is no field for a juror to survive into.
    expect(projected.decisions[0].jury).toEqual({
      size: 5,
      decisiveVotes: 5,
      winningVotes: 4,
      agreement: 0.8,
      specialistPresent: false,
    });
    expect(serialize(projected)).not.toContain(LEAK);
  });
});

describe('projectUsage and projectAuditEvents', () => {
  it('keeps only the usage contract', () => {
    const projected = projectUsage({
      ...PROBES,
      window: { ...PROBES, from: '2026-01-01', to: '2026-01-30', days: 30 },
      counts: { ...PROBES, reportsReceived: 5, casesCreated: 3, decisionsPublished: 2 },
      daily: [{ ...PROBES, day: '2026-01-30', reportsReceived: 1 }],
      quota: { ...PROBES, reportsPerDay: 100, webhookEndpoints: 2, globalReputationEffects: false },
      atDailyLimit: false,
    });
    expect(Object.keys(projected.daily[0]).sort()).toEqual(['day', 'reportsReceived']);
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('names only a credential as an actor', () => {
    const projected = projectAuditEvents({
      ...PROBES,
      events: [
        {
          ...PROBES,
          auditId: 'aud_1',
          action: 'report.ingested',
          actorCredentialId: 'cred_1',
          reportId: 'rep_1',
          caseId: 'case_1',
          externalReportId: 'ext_1',
          reason: null,
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(Object.keys(projected[0]).sort()).toEqual([
      'action',
      'actorCredentialId',
      'auditId',
      'caseId',
      'externalReportId',
      'occurredAt',
      'reason',
      'reportId',
    ]);
    expect(serialize(projected)).not.toContain(LEAK);
  });
});

describe('the Trust & Safety projections', () => {
  it('keeps the standing actor, which is a staff-visible contract field', () => {
    const projected = projectTrustSafetyApplications({
      ...PROBES,
      applications: [
        {
          ...PROBES,
          applicationId: 'app_1',
          organizationId: 'org_1',
          organizationName: 'Acme',
          applicationName: 'Mention',
          standing: 'restricted',
          globalReputationEffectsAllowed: false,
          evidenceIntegrity: null,
          identityBindingReliability: null,
          policyQuality: null,
          lastStandingReason: 'suspected_abuse',
          standingChangedAt: '2026-01-02T00:00:00.000Z',
          standingChangedByOxyUserId: 'oxy_operator',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    expect(projected[0].standingChangedByOxyUserId).toBe('oxy_operator');
    expect(projected[0].evidenceIntegrity).toBeNull();
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('keeps no event body on a cross-tenant delivery', () => {
    const projected = projectDeadLetterQueue({
      ...PROBES,
      deliveries: [
        {
          ...PROBES,
          deliveryId: 'whd_1',
          organizationId: 'org_1',
          applicationId: 'app_1',
          webhookEndpointId: 'whe_1',
          eventId: 'evt_1',
          eventType: 'decision.published',
          attemptCount: 6,
          lastResponseStatus: null,
          deadLetterReason: 'max_attempts',
          deadLetteredAt: '2026-01-02T00:00:00.000Z',
          replayCount: 0,
        },
      ],
    });
    expect(Object.keys(projected[0])).not.toContain('body');
    expect(projected[0].lastResponseStatus).toBeNull();
    expect(serialize(projected)).not.toContain(LEAK);
  });

  it('carries the unavailable-metrics list through verbatim', () => {
    // Dropping this list would turn six absent metrics into six metrics nobody knows
    // are missing — the exact failure the field exists to prevent.
    const projected = projectPlatformMetrics({
      ...PROBES,
      applicationsByStanding: { ...PROBES, sandbox: 3, trusted: 1, restricted: 0 },
      deliveries: { ...PROBES, pending: 0, delivering: 0, succeeded: 0, deadLetter: 0, successRate: null },
      unavailable: ['case_queue_age_seconds', 'inconclusive_rate'],
    });
    expect(projected.unavailable).toEqual(['case_queue_age_seconds', 'inconclusive_rate']);
    // Null and not zero: a 0% success rate on an empty deployment is the most alarming
    // possible way to say "no data".
    expect(projected.deliveries.successRate).toBeNull();
    expect(serialize(projected)).not.toContain(LEAK);
  });
});

describe('malformed payloads', () => {
  it('names the field path and never its value', () => {
    // A malformed case payload is still tenant data. The path is what a developer
    // needs; the value is what must not reach a log.
    expect.assertions(2);
    try {
      projectApplicationDetail({ applicationId: 42 });
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedPayloadError);
      expect((error as MalformedPayloadError).message).toContain('application.applicationId');
    }
  });
});
