import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { authenticateServiceCredential } from '../modules/tenancy/credential.service';
import {
  createApplication,
  createOrganization,
  issueApplicationCredential,
  revokeCredential,
  setApplicationStatus,
  setOrganizationStatus,
} from '../modules/tenancy/provisioning.service';
import { applicationCredentials, organizations } from '../modules/tenancy/tenancy.collections';
import { provisionTenant, startDatabase, stopDatabase } from './support/tenants';

/**
 * Suspension and revocation — the controls §13.1 lists against a leaked
 * credential and a misbehaving application.
 *
 * Each is tested from both sides. A rejection is only evidence that a control
 * worked if the same call succeeded before the control was applied; otherwise a
 * broken fixture and a working kill switch look identical.
 */

beforeAll(async () => {
  await startDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await stopDatabase();
});

describe('application suspension', () => {
  it('stops every credential of the application at once', async () => {
    const tenant = await provisionTenant();
    const second = await issueApplicationCredential({
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      scopes: ['crowdsource:reports:read'],
    });

    await expect(authenticateServiceCredential(tenant.token)).resolves.toBeDefined();
    await expect(authenticateServiceCredential(second.token)).resolves.toBeDefined();

    await setApplicationStatus(tenant.applicationId, 'suspended');

    await expect(authenticateServiceCredential(tenant.token)).rejects.toMatchObject({ status: 401 });
    await expect(authenticateServiceCredential(second.token)).rejects.toMatchObject({ status: 401 });

    // Reversible: suspension is an operational state, not a deletion.
    await setApplicationStatus(tenant.applicationId, 'active');
    await expect(authenticateServiceCredential(tenant.token)).resolves.toBeDefined();
  });

  it('refuses to issue a credential for a suspended application', async () => {
    const tenant = await provisionTenant();
    await setApplicationStatus(tenant.applicationId, 'suspended');

    await expect(
      issueApplicationCredential({
        organizationId: tenant.organizationId,
        applicationId: tenant.applicationId,
        scopes: ['crowdsource:reports:write'],
      }),
    ).rejects.toThrow(/suspended/);
  });

  it('reports an unknown application rather than silently doing nothing', async () => {
    await expect(
      setApplicationStatus('app_00000000000000000000000000000000', 'suspended'),
    ).rejects.toThrow(/No such application/);
  });
});

describe('organization suspension', () => {
  it('blocks new applications under a suspended organization', async () => {
    const organization = await createOrganization({
      name: 'Suspendable',
      slug: `susp-${randomUUID()}`,
    });

    await expect(
      createApplication({ organizationId: organization.organizationId, name: 'First' }),
    ).resolves.toBeDefined();

    await setOrganizationStatus(organization.organizationId, 'suspended');

    await expect(
      createApplication({ organizationId: organization.organizationId, name: 'Second' }),
    ).rejects.toThrow(/suspended/);
  });

  it('reports an unknown organization rather than silently doing nothing', async () => {
    await expect(
      setOrganizationStatus('org_00000000000000000000000000000000', 'suspended'),
    ).rejects.toThrow(/No such organization/);
  });
});

describe('credential revocation', () => {
  it('reports an unknown or already-revoked credential', async () => {
    const tenant = await provisionTenant();
    const credentialId = tenant.token.split('.')[0];

    const owning = {
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
    };

    await revokeCredential({ ...owning, credentialId });
    // Revoking twice is not a silent success: an operator who believes they
    // revoked something must be told when they did not.
    await expect(revokeCredential({ ...owning, credentialId })).rejects.toThrow(
      /No active credential/,
    );
    await expect(
      revokeCredential({ ...owning, credentialId: 'csk_00000000000000000000000000000000' }),
    ).rejects.toThrow(/No active credential/);
  });

  /**
   * The tenant is part of the revoke's own filter, and this is what says so.
   *
   * `application_credentials` is exempt from the tenant filter, so a revoke matching
   * on `credentialId` alone would let anyone who could reach the function revoke any
   * credential in the deployment. That is survivable while the only caller is a
   * domain service and an IDOR the moment a console route calls one — which it now
   * does.
   */
  it('refuses to revoke a credential belonging to another application', async () => {
    const mine = await provisionTenant();
    const theirs = await provisionTenant();

    await expect(
      revokeCredential({
        organizationId: mine.organizationId,
        applicationId: mine.applicationId,
        credentialId: theirs.token.split('.')[0],
      }),
    ).rejects.toThrow(/No active credential/);

    // And the credential they own still authenticates, so the refusal above was the
    // filter refusing and not a revocation that happened anyway.
    await expect(authenticateServiceCredential(theirs.token)).resolves.toBeDefined();
  });
});

describe('a credential whose application moved organizations', () => {
  it('stops authenticating rather than carrying the old tenant forward', async () => {
    const tenant = await provisionTenant();
    const other = await provisionTenant();
    const credentialId = tenant.token.split('.')[0];

    await expect(authenticateServiceCredential(tenant.token)).resolves.toBeDefined();

    // Simulate the corruption directly: the credential now names an
    // organization its application does not belong to. Carrying on would build
    // a tenant context from two records that disagree about who the tenant is.
    await applicationCredentials.updateOne(
      { credentialId },
      { organizationId: other.organizationId },
    );

    await expect(authenticateServiceCredential(tenant.token)).rejects.toMatchObject({ status: 401 });
  });
});

describe('provisioning failures that are not conflicts', () => {
  it('re-raises a write failure that is not a duplicate key', async () => {
    vi.spyOn(organizations, 'insertOne').mockRejectedValueOnce(new Error('replica set stepped down'));

    await expect(
      createOrganization({ name: 'Unlucky', slug: `unlucky-${randomUUID()}` }),
    ).rejects.toThrow(/stepped down/);
  });
});
