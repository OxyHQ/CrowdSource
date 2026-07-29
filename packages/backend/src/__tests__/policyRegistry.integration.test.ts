import {
  PolicySetVersionSchema,
  TAXONOMY_CODES_BY_FAMILY,
  UNIVERSAL_TAXONOMY_CODES,
} from '@oxyhq/crowdsource-contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isApiError } from '../http/apiError';
import {
  publishPolicyVersion,
  registerPolicyVersion,
  resolvePolicy,
} from '../modules/policy/policy.registry';
import {
  BASELINE_POLICY_SET,
  BASELINE_POLICY_SET_ID,
  BASELINE_POLICY_VERSION,
} from '../modules/policy/policyBaseline';
import {
  provisionTenant,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * The policy registry (§6.4).
 *
 * The rule it exists to keep is that a policy update never silently changes what
 * a past decision meant. Everything below is a way that could fail: a published
 * version being edited, a draft deciding a case, one tenant's rules reaching
 * another's, or a policy version simply not existing when a case is opened
 * against it.
 */

let tenant: ProvisionedTenant;
let other: ProvisionedTenant;

beforeAll(async () => {
  await startDatabase();
  [tenant, other] = await Promise.all([provisionTenant(), provisionTenant()]);
});

afterAll(async () => {
  await stopDatabase();
});

const draft = (policySetId: string, version: string) => ({
  policySetId,
  version,
  status: 'draft' as const,
  title: 'A tenant policy set',
  rules: [
    {
      id: `${policySetId}.harassment`,
      title: 'Harassment',
      taxonomyCodes: ['harassment.targeted_abuse'],
      defaultSeverity: 'medium' as const,
      recommendedActions: ['remove_or_restrict' as const],
    },
  ],
});

describe('the baseline policy set (§6.3)', () => {
  it('is valid against the published contract, parsed at import time', () => {
    expect(() => PolicySetVersionSchema.parse(BASELINE_POLICY_SET)).not.toThrow();
    expect(BASELINE_POLICY_SET.status).toBe('published');
    expect(BASELINE_POLICY_SET.publishedAt).toBeDefined();
  });

  /**
   * §6.3's initial taxonomy, in full. A family with no rule would be material
   * classified under a code that no policy in the deployment responds to — a
   * case a jury can classify and nobody can decide.
   */
  it('covers every taxonomy code of §6.3, exactly once', () => {
    const covered = BASELINE_POLICY_SET.rules.flatMap((rule) => rule.taxonomyCodes);

    expect([...covered].sort()).toEqual([...UNIVERSAL_TAXONOMY_CODES].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('has one rule per family, which is what makes §9.4 family agreement checkable', () => {
    expect(BASELINE_POLICY_SET.rules).toHaveLength(
      Object.keys(TAXONOMY_CODES_BY_FAMILY).length,
    );
  });

  it('resolves for any tenant without being stored per tenant', async () => {
    const resolved = await resolvePolicy(tenant.tenant, {
      policySetId: BASELINE_POLICY_SET_ID,
      version: BASELINE_POLICY_VERSION,
    });

    expect(resolved.token).toBe(`${BASELINE_POLICY_SET_ID}@${BASELINE_POLICY_VERSION}`);
    expect(resolved.taxonomyVersion).toBe('2026.1');
    expect(resolved.policySet.rules.length).toBeGreaterThan(0);
  });

  it('is reserved: a tenant cannot register a policy set under its id', async () => {
    await expect(
      registerPolicyVersion(tenant.tenant, draft(BASELINE_POLICY_SET_ID, '9999.01')),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('registering and publishing a tenant policy version', () => {
  it('refuses to decide a case under a DRAFT version', async () => {
    const policySetId = `tenant.draftonly${Date.now()}`;
    await registerPolicyVersion(tenant.tenant, draft(policySetId, '2026.09'));

    /**
     * §6.4 lets a draft be edited. A case decided under a document that can
     * still change cannot honour "a policy update never rewrites history", so
     * ingress must refuse it rather than pin a version that is not frozen.
     */
    await expect(
      resolvePolicy(tenant.tenant, { policySetId, version: '2026.09' }),
    ).rejects.toMatchObject({ code: 'unprocessable_envelope' });

    await publishPolicyVersion(tenant.tenant, policySetId, '2026.09');
    const resolved = await resolvePolicy(tenant.tenant, { policySetId, version: '2026.09' });
    expect(resolved.policySet.status).toBe('published');
    expect(resolved.policySet.publishedAt).toBeDefined();
  });

  it('will not publish a version twice, so a published one is frozen', async () => {
    const policySetId = `tenant.frozen${Date.now()}`;
    await registerPolicyVersion(tenant.tenant, draft(policySetId, '2026.09'));
    await publishPolicyVersion(tenant.tenant, policySetId, '2026.09');

    await expect(
      publishPolicyVersion(tenant.tenant, policySetId, '2026.09'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('will not let the same version be registered again with different rules', async () => {
    const policySetId = `tenant.rewrite${Date.now()}`;
    await registerPolicyVersion(tenant.tenant, draft(policySetId, '2026.09'));

    const rewritten = {
      ...draft(policySetId, '2026.09'),
      title: 'Quietly different rules under the same version',
    };

    // The unique index refuses it. A read-then-write check would race with a
    // concurrent registration of the same version.
    await expect(registerPolicyVersion(tenant.tenant, rewritten)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('rejects a policy set that does not satisfy the contract', async () => {
    await expect(
      registerPolicyVersion(tenant.tenant, {
        policySetId: 'tenant.invalid',
        version: '2026.09',
        status: 'draft',
        title: 'No rules at all',
        rules: [],
      }),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.code === 'invalid_request');
  });

  /**
   * §6.4's security boundary: rules are data, never code. The contract has no
   * field that could carry an expression, and a set carrying an unrecognised key
   * is rejected outright rather than accepted with the key silently dropped —
   * "dropped" and "never evaluated" look identical right up until something
   * decides to evaluate it.
   */
  it('rejects a rule carrying anything that is not data', async () => {
    await expect(
      registerPolicyVersion(tenant.tenant, {
        ...draft('tenant.executable', '2026.09'),
        rules: [
          {
            id: 'tenant.executable.rule',
            title: 'Evaluate this',
            taxonomyCodes: ['integrity.spam'],
            expression: 'context.reporterReputation > 0.8',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('the fields a policy version carries through storage', () => {
  it('round-trips the locale the reviewer sees the policy text in', async () => {
    const policySetId = `tenant.localised${Date.now()}`;
    await registerPolicyVersion(tenant.tenant, {
      ...draft(policySetId, '2026.09'),
      locale: 'es-ES',
    });
    await publishPolicyVersion(tenant.tenant, policySetId, '2026.09');

    const resolved = await resolvePolicy(tenant.tenant, { policySetId, version: '2026.09' });

    // Appendix A: `locale` is the language the POLICY is shown in, not the
    // language of the reported material. Losing it hands a reviewer rules in a
    // language they may not read.
    expect(resolved.policySet.locale).toBe('es-ES');
    expect(resolved.policySet.rules[0].recommendedActions).toEqual(['remove_or_restrict']);
  });

  it('accepts a version registered as already published', async () => {
    const policySetId = `tenant.preborn${Date.now()}`;
    await registerPolicyVersion(tenant.tenant, {
      ...draft(policySetId, '2026.09'),
      status: 'published',
      publishedAt: '2026-07-29T00:00:00.000Z',
    });

    const resolved = await resolvePolicy(tenant.tenant, { policySetId, version: '2026.09' });
    expect(resolved.policySet.publishedAt).toBe('2026-07-29T00:00:00.000Z');
  });

  it('does not mistake an unrelated write failure for a duplicate version', async () => {
    const { policySets } = await import('../modules/policy/policySet.collection');
    vi.spyOn(policySets, 'insertOne').mockRejectedValueOnce(new Error('the disk is full'));

    await expect(
      registerPolicyVersion(tenant.tenant, draft(`tenant.disk${Date.now()}`, '2026.09')),
    ).rejects.toThrow(/the disk is full/);

    vi.restoreAllMocks();
  });
});

describe('a policy set belongs to one application', () => {
  it('is invisible to another tenant, which cannot decide a case under it', async () => {
    const policySetId = `tenant.private${Date.now()}`;
    await registerPolicyVersion(tenant.tenant, draft(policySetId, '2026.09'));
    await publishPolicyVersion(tenant.tenant, policySetId, '2026.09');

    // The owner resolves it, so the rejection below is the tenant filter and not
    // a policy set that was never written.
    await expect(
      resolvePolicy(tenant.tenant, { policySetId, version: '2026.09' }),
    ).resolves.toMatchObject({ policySetId });

    await expect(
      resolvePolicy(other.tenant, { policySetId, version: '2026.09' }),
    ).rejects.toMatchObject({ code: 'unprocessable_envelope' });
  });

  it('lets two tenants use the same policy set id independently', async () => {
    const policySetId = `tenant.shared${Date.now()}`;
    await registerPolicyVersion(tenant.tenant, {
      ...draft(policySetId, '2026.09'),
      title: 'Mine',
    });
    await publishPolicyVersion(tenant.tenant, policySetId, '2026.09');

    await registerPolicyVersion(other.tenant, {
      ...draft(policySetId, '2026.09'),
      title: 'Theirs',
    });
    await publishPolicyVersion(other.tenant, policySetId, '2026.09');

    expect(
      (await resolvePolicy(tenant.tenant, { policySetId, version: '2026.09' })).policySet.title,
    ).toBe('Mine');
    expect(
      (await resolvePolicy(other.tenant, { policySetId, version: '2026.09' })).policySet.title,
    ).toBe('Theirs');
  });

  it('refuses a version nobody registered', async () => {
    await expect(
      resolvePolicy(tenant.tenant, { policySetId: 'tenant.absent', version: '2026.09' }),
    ).rejects.toMatchObject({ code: 'unprocessable_envelope' });
  });
});
