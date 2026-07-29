import { CaseEnvelopeSchema, type CaseEnvelope } from '@oxyhq/crowdsource-contracts';
import { describe, expect, it } from 'vitest';

import { createTenantContext } from '../db/tenantScope';
import {
  assertEnvelopeBelongsToTenant,
  assertNoUnsafeUrls,
  parseDelivery,
} from '../modules/ingestion/envelopeValidation';

/**
 * Ingress validation (§7.2), for the checks this service performs itself.
 *
 * The schema half is exercised end to end in `reportIngestion.integration.test.ts`;
 * what is worth isolating here is the URL check, because it is the one place a
 * mistake is silent — a hostile URL that gets stored is evidence a reviewer may
 * later be handed, and the failure is invisible until then.
 */

const tenant = createTenantContext('org_1', 'app_mention');

function envelope(overrides: Record<string, unknown> = {}): CaseEnvelope {
  return CaseEnvelopeSchema.parse({
    schemaVersion: 'crowdsource.case.v1',
    applicationId: 'app_mention',
    externalReportId: 'mention_report_1',
    subject: { externalId: 'post_987', type: 'social.post', primaryResourceId: 'res_post' },
    principalBindings: [],
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
    allegations: [{ code: 'integrity.spam' }],
    policy: { policySetId: 'crowdsource.baseline', version: '2026.07' },
    privacy: { retentionDays: 30, allowCommunityReview: true },
    ...overrides,
  });
}

function withLink(url: string): CaseEnvelope {
  return envelope({
    resources: [
      ...envelope().resources,
      {
        id: 'res_link',
        type: 'link',
        role: 'context',
        data: { url },
        sha256: `sha256:${'c'.repeat(64)}`,
      },
    ],
  });
}

describe('parseDelivery', () => {
  it('accepts a delivery whose request and envelope agree', () => {
    const parsed = parseDelivery({
      externalReportId: 'mention_report_1',
      envelope: envelope(),
    });

    expect(parsed.externalReportId).toBe('mention_report_1');
  });

  it('refuses a delivery whose request and envelope name different reports', () => {
    // The idempotency key and the document would then disagree about which
    // report this is, and §12.7's uniqueness would be enforced on the wrong value.
    expect(() =>
      parseDelivery({ externalReportId: 'another_report', envelope: envelope() }),
    ).toThrow(/cannot be processed/);
  });

  it('refuses a body with anything the request contract does not declare', () => {
    expect(() =>
      parseDelivery({
        externalReportId: 'mention_report_1',
        envelope: envelope(),
        applicationId: 'app_somebody_else',
      }),
    ).toThrow(/cannot be processed/);
  });
});

describe('assertEnvelopeBelongsToTenant', () => {
  it('accepts an envelope naming the application its credential belongs to', () => {
    expect(() => assertEnvelopeBelongsToTenant(tenant, envelope())).not.toThrow();
  });

  /**
   * The envelope carries `applicationId` so a mismatch can be DETECTED. The
   * tenant still comes from the credential — the value of this check is that a
   * misconfigured integration writing into the wrong tenant's stream stops at
   * the door instead of being silently rewritten to the caller's own id.
   */
  it('refuses an envelope that names another application', () => {
    expect(() =>
      assertEnvelopeBelongsToTenant(tenant, envelope({ applicationId: 'app_other' })),
    ).toThrow(/different applicationId/);
  });
});

describe('assertNoUnsafeUrls', () => {
  it('allows an ordinary public URL', () => {
    expect(() => assertNoUnsafeUrls(withLink('https://example.com/post/1'))).not.toThrow();
  });

  /**
   * The addresses that matter, from `@oxyhq/core/server`'s own denylist rather
   * than a second copy of one maintained here.
   */
  it.each([
    ['the cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['an RFC1918 address', 'http://10.0.0.5/internal'],
    ['another RFC1918 range', 'https://192.168.1.1/admin'],
    ['loopback', 'http://127.0.0.1:3000/health'],
    ['loopback by name', 'http://localhost:3000/health'],
    ['IPv6 loopback', 'http://[::1]:3000/health'],
    ['the "this host" range', 'http://0.0.0.0/'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertNoUnsafeUrls(withLink(url))).toThrow(/private, loopback or reserved/);
  });

  it('checks an asset URL, not only a link resource', () => {
    const withAsset = envelope({
      resources: [
        ...envelope().resources,
        {
          id: 'res_image',
          type: 'image',
          role: 'attachment',
          asset: {
            url: 'http://169.254.169.254/latest/meta-data/',
            mimeType: 'image/jpeg',
            sha256: `sha256:${'b'.repeat(64)}`,
          },
        },
      ],
    });

    expect(() => assertNoUnsafeUrls(withAsset)).toThrow(/resources\.1\.asset\.url/);
  });

  it('checks the subject permalink', () => {
    expect(() =>
      assertNoUnsafeUrls(
        envelope({
          subject: {
            externalId: 'post_987',
            type: 'social.post',
            primaryResourceId: 'res_post',
            permalink: 'http://10.1.2.3/posts/987',
          },
        }),
      ),
    ).toThrow(/subject\.permalink/);
  });

  /**
   * The limit of a syntactic check, asserted so nobody mistakes it for more. A
   * hostname that RESOLVES into private space is not decidable from the string,
   * and DNS can change between here and any later fetch — which is why the check
   * that counts is `safeFetch`, taken at fetch time with the connection pinned
   * to the validated address.
   */
  it('does not claim to resolve hostnames; safeFetch does that at fetch time', () => {
    expect(() =>
      assertNoUnsafeUrls(withLink('https://internal.example.com/admin')),
    ).not.toThrow();
  });
});
