import { describe, expect, it } from 'vitest';

import {
  MODERATION_DECISION_FINALIZED_EVENT_TYPE,
  ReputationEventSchema,
} from '../reputation-events.js';
import { accepted, rejectionIssues, rejectionPaths } from './support/assertions.js';
import { reputationEventExample } from './support/examples.js';

describe('ModerationDecisionFinalizedEvent (§11.6)', () => {
  it('accepts the reference event', () => {
    const event = accepted(ReputationEventSchema, reputationEventExample());
    expect(event.type).toBe(MODERATION_DECISION_FINALIZED_EVENT_TYPE);
    expect(event.incidentId).toBe('inc_01HZ');
  });

  it('carries no reputation figure of its own', () => {
    /**
     * "An application does not choose Oxy points." The event reports what was
     * decided; Oxy Trust's own rules turn that into an effect. If a field named
     * anything like points or a standing ever appears here, strict parsing is
     * what will refuse it.
     */
    const event = accepted(ReputationEventSchema, reputationEventExample());
    const keys = Object.keys(event);
    for (const forbidden of ['points', 'standing', 'strike', 'activeRisk', 'tier']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('§11.7 validations the contract makes structural', () => {
  it('rejects an event whose subject has no binding proof (§11.7.4)', () => {
    const { bindingProofId, ...unproven } = { ...reputationEventExample() }.subject as Record<
      string,
      unknown
    >;
    expect(bindingProofId).toBeDefined();
    expect(
      rejectionPaths(ReputationEventSchema, { ...reputationEventExample(), subject: unproven }),
    ).toEqual(['subject.bindingProofId']);
  });

  it('rejects a finding that only concerns the application (§11.7.5, §6.5)', () => {
    /**
     * A local restriction is not a global sanction. `application_local` is a
     * valid decision-finding scope and cannot be expressed on this event at
     * all, so a finding that never left the tenant cannot reach Oxy Trust even
     * by mistake.
     */
    expect(
      rejectionPaths(ReputationEventSchema, {
        ...reputationEventExample(),
        findings: [
          {
            code: 'commerce.misleading_listing',
            severity: 'low',
            scope: 'application_local',
            attribution: 'author',
          },
        ],
      }),
    ).toEqual(['findings.0.scope']);
  });

  it('accepts identity_integrity, the other scope §11.7.5 names', () => {
    expect(
      accepted(ReputationEventSchema, {
        ...reputationEventExample(),
        findings: [
          {
            code: 'integrity.impersonation',
            severity: 'high',
            scope: 'identity_integrity',
            attribution: 'author',
          },
        ],
      }).findings[0]?.scope,
    ).toBe('identity_integrity');
  });

  it('rejects a superseded or corrected decision (§11.7.8)', () => {
    for (const decisionStatus of ['superseded', 'corrected']) {
      expect(rejectionPaths(ReputationEventSchema, { ...reputationEventExample(), decisionStatus }))
        .toEqual(['decisionStatus']);
    }
  });

  it('accepts a provisional decision, which §11.7.3 allows', () => {
    expect(
      accepted(ReputationEventSchema, {
        ...reputationEventExample(),
        decisionStatus: 'provisional',
      }).decisionStatus,
    ).toBe('provisional');
  });
});

describe('privacy of the payload (§13.5)', () => {
  it('refuses to carry resource ids', () => {
    /**
     * Oxy Trust needs to know what was confirmed, how serious, how far it
     * reaches and whose conduct it was. It does not need to know which piece of
     * content it happened on, and the invariant that sensitive content stays
     * out of ledgers and attestations means it must not be told. This is the
     * one place the contract is strict OUTBOUND, and §10.11's safety exception
     * is exactly why.
     */
    const issues = rejectionIssues(ReputationEventSchema, {
      ...reputationEventExample(),
      findings: [
        {
          code: 'harassment.targeted_abuse',
          severity: 'medium',
          scope: 'oxy_network',
          attribution: 'author',
          resourceIds: ['res_post'],
        },
      ],
    });
    expect(issues).toEqual([
      { path: 'findings.0', message: 'Unrecognized key: "resourceIds"' },
    ]);
  });

  it('refuses to carry reviewer notes or any other free text', () => {
    const issues = rejectionIssues(ReputationEventSchema, {
      ...reputationEventExample(),
      notes: 'the post said …',
    });
    expect(issues).toEqual([{ path: '', message: 'Unrecognized key: "notes"' }]);
  });
});

describe('attribution and findings', () => {
  it('requires a finding to name whose conduct it was', () => {
    expect(
      rejectionPaths(ReputationEventSchema, {
        ...reputationEventExample(),
        findings: [{ code: 'harassment.targeted_abuse', severity: 'medium', scope: 'oxy_network' }],
      }),
    ).toEqual(['findings.0.attribution']);
  });

  it('rejects an event with no findings, which could produce no effect anyway', () => {
    expect(rejectionPaths(ReputationEventSchema, { ...reputationEventExample(), findings: [] }))
      .toEqual(['findings']);
  });

  it('carries the three policy versions §6.4 requires, under §11.6\'s own names', () => {
    const event = accepted(ReputationEventSchema, reputationEventExample());
    expect(Object.keys(event.policyVersions).sort()).toEqual([
      'application',
      'oxyConduct',
      'universal',
    ]);
  });
});
