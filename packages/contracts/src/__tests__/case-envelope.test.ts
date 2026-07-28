import { describe, expect, it } from 'vitest';

import {
  CASE_ENVELOPE_SCHEMA_VERSION,
  CaseEnvelopeSchema,
  CreateReportRequestSchema,
} from '../case-envelope';
import { accepted, rejectionIssues, rejectionPaths } from './support/assertions';
import {
  DIGEST,
  caseEnvelopeExample,
  imageResourceExample,
  principalBindingExample,
  textResourceExample,
} from './support/examples';

describe('the envelope root', () => {
  it('accepts a minimal envelope with none of the optional blocks', () => {
    const envelope = accepted(CaseEnvelopeSchema, caseEnvelopeExample());
    expect(envelope.schemaVersion).toBe(CASE_ENVELOPE_SCHEMA_VERSION);
  });

  it('rejects a schemaVersion this contract does not implement', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        schemaVersion: 'crowdsource.case.v2',
      }),
    ).toEqual(['schemaVersion']);
  });

  it('rejects an unknown root key', () => {
    const issues = rejectionIssues(CaseEnvelopeSchema, {
      ...caseEnvelopeExample(),
      reporterReputation: 0.9,
    });
    expect(issues).toEqual([{ path: '', message: 'Unrecognized key: "reporterReputation"' }]);
  });

  it('rejects an envelope with nothing to review and one with nothing alleged', () => {
    expect(rejectionPaths(CaseEnvelopeSchema, { ...caseEnvelopeExample(), resources: [] }).length)
      .toBeGreaterThan(0);
    expect(rejectionPaths(CaseEnvelopeSchema, { ...caseEnvelopeExample(), allegations: [] }))
      .toEqual(['allegations']);
  });

  it('rejects a source environment the ecosystem does not run', () => {
    /**
     * §12.4 proposes sandbox + staging + production. CrowdSource deploys once,
     * and sandbox is an application-trust state inside it, so `staging` is not
     * a value a report can claim to come from.
     */
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        source: { environment: 'staging', submittedAt: '2026-07-28T18:00:00.000Z' },
      }),
    ).toEqual(['source.environment']);
  });
});

describe('subject', () => {
  it('accepts a namespaced custom subject type', () => {
    const envelope = caseEnvelopeExample();
    expect(
      accepted(CaseEnvelopeSchema, {
        ...envelope,
        subject: { externalId: 'offer_1', type: 'custom.mercaria.offer', primaryResourceId: 'res_post' },
      }).subject.type,
    ).toBe('custom.mercaria.offer');
  });

  it('rejects a custom subject type that is not namespaced by organization', () => {
    expect(
      rejectionIssues(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        subject: { externalId: 'offer_1', type: 'custom.offer', primaryResourceId: 'res_post' },
      }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a primary resource that is not in the envelope', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        subject: { externalId: 'post_987', type: 'social.post', primaryResourceId: 'res_missing' },
      }),
    ).toEqual(['subject.primaryResourceId']);
  });

  it('rejects a primary resource that is not the subject of the case', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        subject: { externalId: 'post_987', type: 'social.post', primaryResourceId: 'res_image' },
      }),
    ).toEqual(['subject.primaryResourceId']);
  });
});

describe('principal bindings', () => {
  it('requires a binding proof for an Oxy identity', () => {
    /**
     * "No binding proof, no Oxy Trust effect." Making the field required for
     * `oxy_user` means the unprovable claim cannot be expressed at all, rather
     * than being caught later by whoever remembers to check.
     */
    const { bindingProofId, ...unproven } = principalBindingExample();
    expect(bindingProofId).toBeDefined();
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        principalBindings: [unproven],
      }),
    ).toEqual(['principalBindings.0.bindingProofId']);
  });

  it('does not require one from a principal type that has no Oxy identity', () => {
    const envelope = accepted(CaseEnvelopeSchema, {
      ...caseEnvelopeExample(),
      principalBindings: [{ principalRef: 'author_1', type: 'local_user' }],
    });
    expect(envelope.principalBindings[0]?.bindingProofId).toBeUndefined();
  });

  it('rejects two bindings claiming the same principalRef', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        principalBindings: [principalBindingExample(), principalBindingExample()],
      }),
    ).toEqual(['principalBindings.1.principalRef']);
  });
});

describe('reference resolution (§5.5)', () => {
  it('rejects a relation pointing at a resource that does not exist', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        relations: [{ from: 'res_post', type: 'has_attachment', to: 'res_ghost' }],
      }),
    ).toEqual(['relations.0.to']);
  });

  it('resolves authored_by against principals, not resources', () => {
    /**
     * §5.5 defines `authored_by` as "a resource was created by a principal", so
     * its target lives in a different id space from every other relation. No
     * example in the plan exercises it, which is exactly why it is pinned by a
     * test.
     */
    const envelope = caseEnvelopeExample();
    expect(
      accepted(CaseEnvelopeSchema, {
        ...envelope,
        relations: [{ from: 'res_post', type: 'authored_by', to: 'author_1' }],
      }).relations,
    ).toHaveLength(1);

    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...envelope,
        relations: [{ from: 'res_post', type: 'authored_by', to: 'res_image' }],
      }),
    ).toEqual(['relations.0.to']);
  });

  it('rejects a self-relation and a duplicated relation', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        relations: [{ from: 'res_post', type: 'quotes', to: 'res_post' }],
      }),
    ).toEqual(['relations.0.to']);

    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        relations: [
          { from: 'res_post', type: 'has_attachment', to: 'res_image' },
          { from: 'res_post', type: 'has_attachment', to: 'res_image' },
        ],
      }),
    ).toEqual(['relations.1']);
  });

  it('rejects two resources sharing an id', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        resources: [textResourceExample(), { ...imageResourceExample(), id: 'res_post' }],
        relations: [],
      }),
    ).toEqual(['resources.1.id']);
  });

  it('rejects an allegation about a resource that is not in the envelope', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        allegations: [{ code: 'harassment.targeted_abuse', resourceIds: ['res_ghost'] }],
      }),
    ).toEqual(['allegations.0.resourceIds.0']);
  });

  it('rejects an allegation from a reporter with no binding', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        allegations: [{ code: 'harassment.targeted_abuse', reporterPrincipalRef: 'reporter_ghost' }],
      }),
    ).toEqual(['allegations.0.reporterPrincipalRef']);
  });

  it('rejects an author reference no binding declares', () => {
    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...caseEnvelopeExample(),
        resources: [
          { ...textResourceExample(), authorPrincipalRef: 'author_ghost' },
          imageResourceExample(),
        ],
      }),
    ).toEqual(['resources.0.authorPrincipalRef']);
  });

  it('resolves conversation members, listing refs and profile avatars too', () => {
    const base = caseEnvelopeExample();

    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...base,
        resources: [
          textResourceExample(),
          {
            id: 'res_thread',
            type: 'conversation',
            role: 'context',
            sha256: DIGEST.parent,
            data: { messageResourceIds: ['res_ghost'] },
          },
        ],
        relations: [],
      }),
    ).toEqual(['resources.1.data.messageResourceIds.0']);

    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...base,
        resources: [
          textResourceExample(),
          {
            id: 'res_listing',
            type: 'listing',
            role: 'context',
            sha256: DIGEST.parent,
            data: { title: 'Bike', sellerRef: 'seller_ghost', mediaRefs: ['res_ghost'] },
          },
        ],
        relations: [],
      }),
    ).toEqual(['resources.1.data.sellerRef', 'resources.1.data.mediaRefs.0']);

    expect(
      rejectionPaths(CaseEnvelopeSchema, {
        ...base,
        resources: [
          textResourceExample(),
          {
            id: 'res_profile',
            type: 'profile',
            role: 'context',
            sha256: DIGEST.parent,
            data: { displayName: 'Someone', avatarRef: 'res_ghost' },
          },
        ],
        relations: [],
      }),
    ).toEqual(['resources.1.data.avatarRef']);
  });
});

describe('POST /v1/reports (§10.4)', () => {
  it('accepts a request whose external id matches its envelope', () => {
    const request = accepted(CreateReportRequestSchema, {
      externalReportId: 'mention_report_123',
      envelope: caseEnvelopeExample(),
    });
    expect(request.envelope.externalReportId).toBe('mention_report_123');
  });

  it('rejects a request whose external id disagrees with its envelope', () => {
    /**
     * The two are the idempotency identity of the report (§12.7:
     * `application_id + external_report_id`). If they disagree, the uniqueness
     * constraint is enforced against a value the document does not carry.
     */
    expect(
      rejectionPaths(CreateReportRequestSchema, {
        externalReportId: 'mention_report_999',
        envelope: caseEnvelopeExample(),
      }),
    ).toEqual(['envelope.externalReportId']);
  });
});
