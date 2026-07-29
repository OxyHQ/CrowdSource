/**
 * Envelope composition.
 *
 * The property this file spends most of its assertions on is the one whose
 * failure is invisible: two people reporting the same post must produce
 * envelopes whose CONTENT is byte-identical, because the server's dedup key
 * (§7.3) is a hash of that content. Get it wrong and nothing throws, nothing
 * 4xxs, and nothing fails in CI — the same post simply gets two cases, two
 * juries and, eventually, two penalties for one incident.
 */

import { CaseEnvelopeSchema } from '@oxyhq/crowdsource-contracts';
import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256Digest } from '../digest';
import {
  composeCaseEnvelope,
  CrowdSourceReportInputError,
  defaultIdempotencyKey,
  type ReportInput,
} from '../envelope';

const COMPOSITION = { applicationId: 'app_test', environment: 'production' } as const;

function report(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    externalReportId: 'report_1',
    subject: {
      externalId: 'post_987',
      type: 'social.post',
      author: { oxyUserId: 'oxy_author_1' },
    },
    content: 'Texto exacto reportado',
    allegations: ['harassment.targeted_abuse'],
    reportedBy: { oxyUserId: 'oxy_reporter_1' },
    ...overrides,
  };
}

/** The projection the backend hashes: content, never the report about it. */
function contentOf(envelope: ReturnType<typeof composeCaseEnvelope>): string {
  return canonicalJson({
    schemaVersion: envelope.schemaVersion,
    subject: envelope.subject,
    resources: envelope.resources,
    relations: envelope.relations,
  });
}

describe('composeCaseEnvelope', () => {
  it('produces an envelope the published contract accepts', () => {
    expect(() => CaseEnvelopeSchema.parse(composeCaseEnvelope(report(), COMPOSITION))).not.toThrow();
  });

  it('takes applicationId from the composition, never from the input', () => {
    expect(composeCaseEnvelope(report(), COMPOSITION).applicationId).toBe('app_test');
  });

  /**
   * The invariant, stated as the scenario that breaks it: two DIFFERENT people
   * report the same post through the same integration, minutes apart, with
   * different report ids and different allegations. Everything the server hashes
   * must be identical.
   */
  it('composes identical content for two different reporters of the same post', () => {
    const first = composeCaseEnvelope(
      report({
        externalReportId: 'report_from_alice',
        reportedBy: { oxyUserId: 'oxy_alice' },
        allegations: ['harassment.targeted_abuse'],
        submittedAt: new Date('2026-07-29T10:00:00.000Z'),
      }),
      COMPOSITION,
    );
    const second = composeCaseEnvelope(
      report({
        externalReportId: 'report_from_bob',
        reportedBy: { oxyUserId: 'oxy_bob' },
        allegations: ['hate.slur'],
        submittedAt: new Date('2026-07-29T11:30:00.000Z'),
      }),
      COMPOSITION,
    );

    expect(contentOf(first)).toBe(contentOf(second));
    expect(first.externalReportId).not.toBe(second.externalReportId);
  });

  /**
   * The regression test for a bug that only appears in production, days late.
   *
   * The ingress fingerprints the WHOLE `{ externalReportId, envelope }` —
   * `report.service.ts` calls it `payloadHash` — to detect §10.5's "external id
   * reused with different content". So anything this client invents per attempt,
   * a `submittedAt` of `now` above all, turns a legitimate retry from an outbox
   * into a permanent 409. The symptom is not a failing test: it is moderation
   * work stuck in a delivery queue that nobody is watching.
   *
   * The assertion is therefore over the exact bytes the backend hashes, not over
   * "the envelopes look the same".
   */
  it('composes byte-identical payloads for the same report delivered twice', () => {
    const payload = (): string =>
      canonicalJson({
        externalReportId: report().externalReportId,
        envelope: JSON.parse(
          JSON.stringify(composeCaseEnvelope(report(), COMPOSITION)),
        ) as Record<string, never>,
      });

    const first = payload();
    const second = payload();

    expect(second).toBe(first);
    expect(first).not.toContain('submittedAt');
  });

  it('carries source only when the application says when the user reported it', () => {
    expect(composeCaseEnvelope(report(), COMPOSITION).source).toBeUndefined();
    expect(
      composeCaseEnvelope(report({ submittedAt: new Date('2026-07-29T10:00:00.000Z') }), COMPOSITION)
        .source,
    ).toEqual({ environment: 'production', submittedAt: '2026-07-29T10:00:00.000Z' });
  });

  it('refuses a sandbox report that would need an invented submission time', () => {
    expect(() =>
      composeCaseEnvelope(report(), { applicationId: 'app_test', environment: 'sandbox' }),
    ).toThrow(/submittedAt/);
  });

  it('composes different content when the post itself was edited', () => {
    const original = composeCaseEnvelope(report(), COMPOSITION);
    const edited = composeCaseEnvelope(report({ content: 'Texto editado' }), COMPOSITION);

    expect(contentOf(original)).not.toBe(contentOf(edited));
  });

  it('derives principal refs from the identity, so they are stable across reporters', () => {
    const first = composeCaseEnvelope(report(), COMPOSITION);
    const second = composeCaseEnvelope(report({ externalReportId: 'report_2' }), COMPOSITION);
    const authorRef = first.resources[0]?.authorPrincipalRef;

    expect(authorRef).toBe(second.resources[0]?.authorPrincipalRef);
    // Opaque: a jury must never be handed an identity (§9.1).
    expect(authorRef).toMatch(/^p_[0-9a-f]{32}$/);
    expect(authorRef).not.toContain('oxy_author_1');
  });

  /**
   * §11.14 asks for proof that a pseudonymous ref is a real identity. Sign in
   * with Oxy already produced it, so there is no separate binding step — the
   * subject issued for this application IS the proof.
   */
  it('uses the Oxy subject as the binding proof, with no separate binding step', () => {
    const envelope = composeCaseEnvelope(report(), COMPOSITION);
    const author = envelope.principalBindings.find(
      (binding) => binding.externalPrincipalId === 'oxy_author_1',
    );

    expect(author).toMatchObject({ type: 'oxy_user', bindingProofId: 'oxy_author_1' });
  });

  it('carries no binding proof for an actor that has no Oxy identity', () => {
    const envelope = composeCaseEnvelope(
      report({ subject: { externalId: 'post_1', type: 'social.post', author: { id: 'local_42' } } }),
      COMPOSITION,
    );

    expect(envelope.principalBindings[0]).toEqual({
      principalRef: expect.stringMatching(/^p_[0-9a-f]{32}$/) as unknown as string,
      type: 'local_user',
      externalPrincipalId: 'local_42',
    });
  });

  it('refuses an oxy_user declared without the subject that proves it', () => {
    expect(() =>
      composeCaseEnvelope(
        report({
          subject: {
            externalId: 'post_1',
            type: 'social.post',
            author: { id: 'local_42', type: 'oxy_user' },
          },
        }),
        COMPOSITION,
      ),
    ).toThrow(CrowdSourceReportInputError);
  });

  it('computes the digest of the reviewed representation', () => {
    const envelope = composeCaseEnvelope(report({ content: 'hola' }), COMPOSITION);

    expect(envelope.resources[0]?.sha256).toBe(
      sha256Digest(canonicalJson({ type: 'text', data: { text: 'hola' } })),
    );
  });

  it('leaves an asset-backed resource to its own asset digest', () => {
    const envelope = composeCaseEnvelope(
      report({
        attachments: [
          {
            type: 'image',
            asset: {
              fileId: 'oxyfile_abc',
              mimeType: 'image/jpeg',
              sha256: `sha256:${'a'.repeat(64)}`,
            },
          },
        ],
      }),
      COMPOSITION,
    );

    const attachment = envelope.resources[1];
    expect(attachment?.sha256).toBeUndefined();
    expect(attachment).toMatchObject({ id: 'res_attachment_1', role: 'attachment' });
    expect(envelope.relations).toContainEqual({
      from: 'res_subject',
      type: 'has_attachment',
      to: 'res_attachment_1',
    });
  });

  it('derives the relation from the role a context resource was given', () => {
    const envelope = composeCaseEnvelope(
      report({
        context: [
          { role: 'parent', type: 'text', data: { text: 'the message replied to' } },
          { role: 'quoted', type: 'text', data: { text: 'the quoted post' } },
          { role: 'context', type: 'text', data: { text: 'surrounding conversation' } },
        ],
      }),
      COMPOSITION,
    );

    expect(envelope.relations).toEqual([
      { from: 'res_subject', type: 'replies_to', to: 'res_context_1' },
      { from: 'res_subject', type: 'quotes', to: 'res_context_2' },
      { from: 'res_context_3', type: 'contextualizes', to: 'res_subject' },
    ]);
  });

  it('defaults the policy to a pinned version and the retention to thirty days', () => {
    const envelope = composeCaseEnvelope(report(), COMPOSITION);

    expect(envelope.policy).toEqual({ policySetId: 'crowdsource.baseline', version: '2026.07' });
    expect(envelope.privacy).toEqual({ retentionDays: 30, allowCommunityReview: true });
  });

  it('lets an application declare its own policy version instead', () => {
    const envelope = composeCaseEnvelope(
      report({ policy: { policySetId: 'mention.community', version: '2026.07' } }),
      COMPOSITION,
    );

    expect(envelope.policy).toEqual({ policySetId: 'mention.community', version: '2026.07' });
  });

  it('keeps §7.5 material away from a community jury without being asked', () => {
    const envelope = composeCaseEnvelope(
      report({ allegations: ['child_safety.exploitation'] }),
      COMPOSITION,
    );

    expect(envelope.privacy.allowCommunityReview).toBe(false);
  });

  /**
   * Refused, not silently corrected. An application that believes it asked for
   * community review and did not get it will build the next thing on that
   * belief too.
   */
  it('refuses an explicit request to community-review §7.5 material', () => {
    expect(() =>
      composeCaseEnvelope(
        report({
          allegations: ['sexual_content.non_consensual'],
          privacy: { allowCommunityReview: true },
        }),
        COMPOSITION,
      ),
    ).toThrow(/§7.5/);
  });

  it('attributes every allegation to the reporter when there is one', () => {
    const envelope = composeCaseEnvelope(
      report({ allegations: ['integrity.spam', { code: 'hate.slur', details: 'in the third line' }] }),
      COMPOSITION,
    );
    const reporterRef = envelope.principalBindings.find(
      (binding) => binding.externalPrincipalId === 'oxy_reporter_1',
    )?.principalRef;

    expect(envelope.allegations).toEqual([
      { code: 'integrity.spam', reporterPrincipalRef: reporterRef },
      { code: 'hate.slur', details: 'in the third line', reporterPrincipalRef: reporterRef },
    ]);
  });

  it('reports the field and the reason when an input cannot become an envelope', () => {
    expect(() =>
      composeCaseEnvelope(report({ subject: { externalId: 'not a valid id!', type: 'social.post' } }), COMPOSITION),
    ).toThrow(/subject.externalId/);
  });

  it('derives an idempotency key that is the same report every time', () => {
    expect(defaultIdempotencyKey('report_1')).toBe('report.report_1');
    expect(defaultIdempotencyKey('report_1')).toBe(defaultIdempotencyKey('report_1'));
  });
});

describe('canonicalJson', () => {
  it('orders keys so a serialiser cannot change a digest', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('preserves array order, where order is the meaning', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined members rather than emitting them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('refuses a non-finite number instead of emitting null for it', () => {
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });
});
