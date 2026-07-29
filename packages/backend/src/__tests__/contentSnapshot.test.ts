import { CaseEnvelopeSchema, type CaseEnvelope } from '@oxyhq/crowdsource-contracts';
import { describe, expect, it } from 'vitest';

import {
  contentHashOf,
  contentSnapshotOf,
  OMITTED_FROM_CONTENT_HASH,
} from '../modules/evidence/contentSnapshot';

/**
 * The canonical envelope hash, tested as the property everything downstream
 * rests on: **two reports about the same material hash the same, and two
 * reports about different material do not.**
 *
 * Get the first wrong and §15.3's acceptance case becomes two cases, two juries
 * and — through the reputation bridge — two consequences for one incident. Get
 * the second wrong and an edited post is judged on the version it used to be.
 * Neither failure is visible from the outside until a case has already been
 * decided, which is why the exclusions are asserted here field by field rather
 * than only through the integration test that consumes them.
 */

function envelope(overrides: Record<string, unknown> = {}): CaseEnvelope {
  return CaseEnvelopeSchema.parse({
    schemaVersion: 'crowdsource.case.v1',
    applicationId: 'app_mention',
    externalReportId: 'mention_report_1',
    subject: { externalId: 'post_987', type: 'social.post', primaryResourceId: 'res_post' },
    principalBindings: [
      { principalRef: 'author_1', type: 'local_user', externalPrincipalId: 'user_author' },
      { principalRef: 'reporter_1', type: 'local_user', externalPrincipalId: 'user_reporter' },
    ],
    resources: [
      {
        id: 'res_post',
        type: 'text',
        role: 'subject',
        data: { text: 'Reported text' },
        sha256: `sha256:${'a'.repeat(64)}`,
        authorPrincipalRef: 'author_1',
      },
      {
        id: 'res_image',
        type: 'image',
        role: 'attachment',
        asset: {
          uploadId: 'upload_abc',
          mimeType: 'image/jpeg',
          sha256: `sha256:${'b'.repeat(64)}`,
        },
      },
    ],
    relations: [{ from: 'res_post', type: 'has_attachment', to: 'res_image' }],
    allegations: [{ code: 'harassment.targeted_abuse', reporterPrincipalRef: 'reporter_1' }],
    policy: { policySetId: 'crowdsource.baseline', version: '2026.07' },
    privacy: { retentionDays: 30, allowCommunityReview: true },
    ...overrides,
  });
}

const hash = (value: CaseEnvelope): string => contentHashOf(contentSnapshotOf(value));

describe('what does NOT change the content hash', () => {
  it('the report that delivered it', () => {
    expect(hash(envelope({ externalReportId: 'other_report' }))).toBe(hash(envelope()));
  });

  it('who reported it', () => {
    const bob = envelope({
      principalBindings: [
        { principalRef: 'author_1', type: 'local_user', externalPrincipalId: 'user_author' },
        { principalRef: 'reporter_1', type: 'local_user', externalPrincipalId: 'somebody_else' },
      ],
    });

    // The single most important line in this file: it is what makes §15.3's
    // "two users report the same post" produce one case.
    expect(hash(bob)).toBe(hash(envelope()));
  });

  it('what they alleged', () => {
    const spam = envelope({
      allegations: [{ code: 'integrity.spam', reporterPrincipalRef: 'reporter_1' }],
    });
    expect(hash(spam)).toBe(hash(envelope()));
  });

  it('when it was submitted, or from which environment', () => {
    const withSource = envelope({
      source: { environment: 'production', submittedAt: '2026-07-29T10:00:00.000Z' },
    });
    expect(hash(withSource)).toBe(hash(envelope()));
  });

  it('the privacy terms and urgency hints of one delivery', () => {
    const other = envelope({
      privacy: { retentionDays: 90, allowCommunityReview: false },
      urgency: { hint: 'high', reach: 40_000, activeDistribution: true },
    });
    expect(hash(other)).toBe(hash(envelope()));
  });

  it('the tenant metadata bag', () => {
    expect(hash(envelope({ metadata: { campaign: 'q3' } }))).toBe(hash(envelope()));
  });

  it('the order the application happened to list resources and relations in', () => {
    const base = envelope();
    const reordered = envelope({
      resources: [...base.resources].reverse(),
    });
    expect(hash(reordered)).toBe(hash(base));
  });

  it('a binding proof minted for one particular report', () => {
    const proved = envelope({
      principalBindings: [
        {
          principalRef: 'author_1',
          type: 'local_user',
          externalPrincipalId: 'user_author',
          bindingProofId: 'binding_456',
          boundAt: '2026-07-29T10:00:00.000Z',
        },
        { principalRef: 'reporter_1', type: 'local_user', externalPrincipalId: 'user_reporter' },
      ],
    });
    expect(hash(proved)).toBe(hash(envelope()));
  });

  /**
   * The list is documentation that the tests read, so a field added to the hash
   * without being removed from the list would leave a lie in place. Every entry
   * has a test above.
   */
  it('documents each exclusion with a reason', () => {
    for (const [field, why] of Object.entries(OMITTED_FROM_CONTENT_HASH)) {
      expect(why.trim().length, `${field} must state why it is excluded`).toBeGreaterThan(20);
    }
    expect(Object.keys(OMITTED_FROM_CONTENT_HASH)).toContain('allegations');
    expect(Object.keys(OMITTED_FROM_CONTENT_HASH)).toContain('principalBindings.reporters');
  });
});

describe('what DOES change the content hash', () => {
  it('the text that was published', () => {
    const edited = envelope({
      resources: [
        {
          id: 'res_post',
          type: 'text',
          role: 'subject',
          data: { text: 'Edited since' },
          sha256: `sha256:${'a'.repeat(64)}`,
          authorPrincipalRef: 'author_1',
        },
        ...envelope().resources.slice(1),
      ],
    });
    expect(hash(edited)).not.toBe(hash(envelope()));
  });

  it('who wrote it', () => {
    const otherAuthor = envelope({
      principalBindings: [
        { principalRef: 'author_1', type: 'local_user', externalPrincipalId: 'someone_else' },
        { principalRef: 'reporter_1', type: 'local_user', externalPrincipalId: 'user_reporter' },
      ],
    });
    expect(hash(otherAuthor)).not.toBe(hash(envelope()));
  });

  it('which object it is', () => {
    expect(
      hash(
        envelope({
          subject: { externalId: 'post_988', type: 'social.post', primaryResourceId: 'res_post' },
        }),
      ),
    ).not.toBe(hash(envelope()));
  });

  it('dropping an attachment', () => {
    expect(
      hash(envelope({ resources: envelope().resources.slice(0, 1), relations: [] })),
    ).not.toBe(hash(envelope()));
  });
});

describe('the snapshot itself', () => {
  it('carries the material and nothing about the reporter', () => {
    const snapshot = contentSnapshotOf(envelope());

    expect(snapshot.principals.map((principal) => principal.principalRef)).toEqual(['author_1']);
    expect(JSON.stringify(snapshot)).not.toContain('user_reporter');
    expect(JSON.stringify(snapshot)).not.toContain('harassment.targeted_abuse');
  });

  it('is a "sha256:<hex>" digest, the only form the contract accepts', () => {
    expect(hash(envelope())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

/**
 * The other two ways the material names a principal. §5.5 defines `authored_by`
 * as pointing at a principal rather than a resource, and a listing names its
 * seller — both are the author of the material in every sense that matters, so
 * both belong in the hash. A reporter never does.
 */
describe('which principals the material points at', () => {
  it('includes the target of an authored_by relation', () => {
    const authored = envelope({
      resources: [
        {
          id: 'res_post',
          type: 'text',
          role: 'subject',
          data: { text: 'Reported text' },
          sha256: `sha256:${'a'.repeat(64)}`,
        },
      ],
      relations: [{ from: 'res_post', type: 'authored_by', to: 'author_1' }],
    });

    expect(contentSnapshotOf(authored).principals.map((p) => p.principalRef)).toEqual([
      'author_1',
    ]);
  });

  it('includes a listing seller, and still excludes the reporter', () => {
    const listing = envelope({
      subject: { externalId: 'listing_1', type: 'commerce.listing', primaryResourceId: 'res_listing' },
      resources: [
        {
          id: 'res_listing',
          type: 'listing',
          role: 'subject',
          data: { title: 'A thing', sellerRef: 'author_1' },
          sha256: `sha256:${'a'.repeat(64)}`,
        },
      ],
      relations: [],
    });

    expect(contentSnapshotOf(listing).principals.map((p) => p.principalRef)).toEqual(['author_1']);
  });

  it('lists none when the material names nobody', () => {
    const anonymous = envelope({
      resources: [
        {
          id: 'res_post',
          type: 'text',
          role: 'subject',
          data: { text: 'Reported text' },
          sha256: `sha256:${'a'.repeat(64)}`,
        },
      ],
      relations: [],
    });

    expect(contentSnapshotOf(anonymous).principals).toEqual([]);
  });

  it('orders principals and relations deterministically, whatever order they arrive in', () => {
    const twoRelations = {
      resources: [
        {
          id: 'res_post',
          type: 'text',
          role: 'subject',
          data: { text: 'Reported text' },
          sha256: `sha256:${'a'.repeat(64)}`,
        },
        {
          id: 'res_image',
          type: 'image',
          role: 'attachment',
          asset: {
            uploadId: 'upload_abc',
            mimeType: 'image/jpeg',
            sha256: `sha256:${'b'.repeat(64)}`,
          },
        },
      ],
    };
    const forwards = envelope({
      ...twoRelations,
      relations: [
        { from: 'res_post', type: 'has_attachment', to: 'res_image' },
        { from: 'res_post', type: 'authored_by', to: 'author_1' },
      ],
    });
    const backwards = envelope({
      ...twoRelations,
      relations: [
        { from: 'res_post', type: 'authored_by', to: 'author_1' },
        { from: 'res_post', type: 'has_attachment', to: 'res_image' },
      ],
    });

    expect(hash(backwards)).toBe(hash(forwards));
  });
});
