import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { withTransaction } from '../db/transaction';
import { cases } from '../modules/cases/case.collection';
import { attachReportToCase } from '../modules/cases/case.service';
import { auditEvents } from '../modules/audit/audit.collection';
import { deliverReport, recordIngressRefusal } from '../modules/ingestion/report.service';
import { resolvePolicy } from '../modules/policy/policy.registry';
import { newPublicId } from '../utils/identifiers';
import {
  provisionTenant,
  sampleEnvelope,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * The signals a merge carries into triage, and how they combine.
 *
 * §7.4 counts DISTINCT reporters, which means the case has to be able to tell
 * two reporters apart and to recognise one reporter twice — and §9.1 forbids
 * storing anything about them that could be shown to a reviewer. The
 * fingerprint is what satisfies both, and this is where its behaviour is pinned:
 * one person filing twice is one signal, two people are two, and an
 * unidentifiable reporter is counted as its own rather than folded in with every
 * other anonymous one.
 */

let tenant: ProvisionedTenant;

beforeAll(async () => {
  await startDatabase();
  tenant = await provisionTenant();
});

afterAll(async () => {
  await stopDatabase();
});

interface AttachOptions {
  readonly subjectExternalId: string;
  readonly envelopeOverrides?: Record<string, unknown>;
  readonly allegations?: unknown[];
}

/**
 * Attaches one report directly, bypassing HTTP.
 *
 * The envelope shapes below are ones the fixture builder deliberately does not
 * produce — a reporter that resolves to nothing, an allegation with no reporter
 * at all — because those are the fallbacks, and a helper that made them easy to
 * write would make them easy to write by accident too.
 */
async function attach(options: AttachOptions): Promise<{ caseId: string; merged: boolean }> {
  const externalReportId = `signal-${Math.random().toString(16).slice(2)}`;
  const built = sampleEnvelope({
    applicationId: tenant.applicationId,
    externalReportId,
    subjectExternalId: options.subjectExternalId,
  });
  const envelope = {
    ...built,
    ...(options.allegations === undefined ? {} : { allegations: options.allegations }),
    ...options.envelopeOverrides,
  } as typeof built;

  const policy = await resolvePolicy(tenant.tenant, envelope.policy);

  return withTransaction(async (session) => {
    const attached = await attachReportToCase(tenant.tenant, session, {
      reportId: newPublicId('report'),
      envelope,
      policy,
      receivedAt: new Date(),
    });
    return { caseId: attached.caseId, merged: attached.merged };
  });
}

describe('counting distinct reporters', () => {
  it('counts one person filing twice as ONE reporter', async () => {
    const subjectExternalId = `post_same_reporter_${Date.now()}`;

    const first = await attach({ subjectExternalId });
    const second = await attach({ subjectExternalId });

    expect(second.caseId).toBe(first.caseId);
    const stored = await cases.findOne(tenant.tenant, { caseId: first.caseId });
    expect(stored?.reportCount).toBe(2);
    // §11.11: forty reports from one person is one opinion, and treating it as
    // forty is the manipulation the count exists to resist.
    expect(stored?.reporterFingerprints).toHaveLength(1);
  });

  it('counts an allegation with no reporter as its own reporter, per report', async () => {
    const subjectExternalId = `post_anon_${Date.now()}`;
    const anonymous = [{ code: 'integrity.spam' }];

    const first = await attach({ subjectExternalId, allegations: anonymous });
    const second = await attach({ subjectExternalId, allegations: anonymous });

    expect(second.caseId).toBe(first.caseId);
    const stored = await cases.findOne(tenant.tenant, { caseId: first.caseId });
    // Assuming two anonymous reports came from one person would understate the
    // signal; assuming they came from two is what actually happened as far as
    // anything here can tell.
    expect(stored?.reporterFingerprints).toHaveLength(2);
  });

  it('falls back to the report when a reporter reference resolves to nothing', async () => {
    const subjectExternalId = `post_unbound_${Date.now()}`;
    // `author_1` IS bound, but with no external id — so it names somebody the
    // application never identified, and it cannot be compared across reports.
    const unresolvable = [{ code: 'integrity.spam', reporterPrincipalRef: 'author_1' }];

    const first = await attach({
      subjectExternalId,
      allegations: unresolvable,
      envelopeOverrides: {
        principalBindings: [{ principalRef: 'author_1', type: 'local_user' }],
      },
    });
    const second = await attach({
      subjectExternalId,
      allegations: unresolvable,
      envelopeOverrides: {
        principalBindings: [{ principalRef: 'author_1', type: 'local_user' }],
      },
    });

    expect(second.caseId).toBe(first.caseId);
    expect(
      (await cases.findOne(tenant.tenant, { caseId: first.caseId }))?.reporterFingerprints,
    ).toHaveLength(2);
  });

  /**
   * The fingerprint is salted with the application id, so the same person under
   * two tenants produces two unrelated values and the case collection cannot
   * become a cross-tenant correlation table (§13.5).
   */
  it('produces a fingerprint that is neither the reporter id nor comparable across tenants', async () => {
    const other = await provisionTenant();
    const subjectExternalId = `post_salt_${Date.now()}`;

    const mine = await attach({ subjectExternalId });
    const theirs = await deliverReport(other.tenant, {
      externalReportId: `salt-${Date.now()}`,
      idempotencyKey: `salt-${Date.now()}`,
      envelope: sampleEnvelope({
        applicationId: other.applicationId,
        externalReportId: `salt-${Date.now()}`,
        subjectExternalId,
      }),
      credentialId: 'csk_00000000000000000000000000000009',
    });

    const mineStored = await cases.findOne(tenant.tenant, { caseId: mine.caseId });
    const theirsStored = await cases.findOne(other.tenant, { caseId: theirs.caseId });

    expect(mineStored?.reporterFingerprints[0]).not.toContain('reporter_1');
    expect(mineStored?.reporterFingerprints[0]).not.toBe(theirsStored?.reporterFingerprints[0]);
  });
});

describe('privacy and distribution signals merge strictest-wins', () => {
  it('keeps a case restricted once any reporter restricts it, and never re-opens it', async () => {
    const subjectExternalId = `post_sticky_${Date.now()}`;

    await attach({
      subjectExternalId,
      envelopeOverrides: {
        privacy: { retentionDays: 30, allowCommunityReview: false, containsPersonalData: true },
        urgency: { hint: 'high', reach: 100, activeDistribution: true },
      },
    });

    const permissive = await attach({
      subjectExternalId,
      envelopeOverrides: {
        privacy: { retentionDays: 30, allowCommunityReview: false, containsPersonalData: true },
        urgency: { hint: 'normal', reach: 50, activeDistribution: false },
      },
    });

    const stored = await cases.findOne(tenant.tenant, { caseId: permissive.caseId });
    expect(stored?.allowCommunityReview).toBe(false);
    expect(stored?.containsPersonalData).toBe(true);
    // Sticky true: a later report that is no longer spreading does not un-set it.
    expect(stored?.activeDistribution).toBe(true);
    // `$max`, so the widest reach any reporter saw.
    expect(stored?.reach).toBe(100);
  });
});

describe('recording a refusal must never break the refusal', () => {
  /**
   * A refusal has no transaction to join, and it must not be able to turn a
   * correct 409 into an opaque 500 — the integrator would then retry something
   * that can never succeed. Losing the trail is bad; losing the answer is worse.
   */
  it('logs and continues when the audit write itself fails', async () => {
    vi.spyOn(auditEvents, 'insertOne').mockRejectedValueOnce(new Error('audit collection down'));

    await expect(
      recordIngressRefusal(
        tenant.tenant,
        { externalReportId: 'refusal-audit-failure', credentialId: 'csk_x' },
        'payload_conflict',
      ),
    ).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });

  it('does not swallow a failure that is not an ordinary refusal', async () => {
    // Anything other than an ApiError from policy resolution is a defect, and a
    // defect must not be recorded as though the tenant sent something wrong.
    const module = await import('../modules/policy/policy.registry');
    vi.spyOn(module, 'resolvePolicy').mockRejectedValueOnce(new Error('registry unreachable'));

    await expect(
      deliverReport(tenant.tenant, {
        externalReportId: `defect-${Date.now()}`,
        idempotencyKey: `defect-${Date.now()}`,
        envelope: sampleEnvelope({
          applicationId: tenant.applicationId,
          externalReportId: `defect-${Date.now()}`,
        }),
        credentialId: 'csk_y',
      }),
    ).rejects.toThrow(/registry unreachable/);

    vi.restoreAllMocks();
  });
});
