import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import {
  authenticateServiceCredential,
  parseServiceToken,
} from '../modules/tenancy/credential.service';
import {
  createApplication,
  createOrganization,
  issueApplicationCredential,
  revokeCredential,
} from '../modules/tenancy/provisioning.service';
import { PRIVILEGED_SCOPES } from '../modules/tenancy/scopes';
import { applicationCredentials } from '../modules/tenancy/tenancy.collections';
import { provisionTenant, startDatabase, stopDatabase } from './support/tenants';

/**
 * Service-credential authentication (§10.1, §13.2).
 *
 * The property under test is not "a good token works" but "the tenant is a
 * function of the credential and of nothing else", plus the negatives that keep
 * a leaked or stale credential from remaining useful.
 */

const app = createApp();

beforeAll(async () => {
  await startDatabase();
});

afterAll(async () => {
  await stopDatabase();
});

/**
 * Every authentication failure carries the SAME message on purpose — telling a
 * caller which of "unknown id", "wrong secret", "revoked" or "expired" applied
 * hands it a search procedure. That makes a message regex a useless assertion
 * here (it matches every rejection), so these tests assert the error's code and
 * pair each negative with a positive control.
 */
async function expectUnauthorized(attempt: Promise<unknown>): Promise<void> {
  await expect(attempt).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
}

describe('authenticateServiceCredential', () => {
  it('derives the tenant from the credential', async () => {
    const tenant = await provisionTenant();

    const caller = await authenticateServiceCredential(tenant.token);

    expect(caller.tenant.organizationId).toBe(tenant.organizationId);
    expect(caller.tenant.applicationId).toBe(tenant.applicationId);
    expect(Object.isFrozen(caller.tenant)).toBe(true);
  });

  it('refuses a token whose secret is wrong while the id is right', async () => {
    const tenant = await provisionTenant();
    const credentialId = tenant.token.split('.')[0];

    await expect(authenticateServiceCredential(tenant.token)).resolves.toBeDefined();
    await expectUnauthorized(
      authenticateServiceCredential(`${credentialId}.not-the-right-secret-value-at-all-000000000`),
    );
  });

  it('refuses a revoked credential', async () => {
    const tenant = await provisionTenant();
    const credentialId = tenant.token.split('.')[0];

    // It works first, so the rejection below is revocation and not a bad fixture.
    await expect(authenticateServiceCredential(tenant.token)).resolves.toBeDefined();
    await revokeCredential(credentialId);

    await expectUnauthorized(authenticateServiceCredential(tenant.token));
  });

  it('honours the expiry instant in both directions', async () => {
    const organization = await createOrganization({
      name: 'Expiring',
      slug: `expiring-${randomUUID()}`,
    });
    const application = await createApplication({
      organizationId: organization.organizationId,
      name: 'Expiring App',
    });
    const issueWithExpiry = (expiresAt: Date) =>
      issueApplicationCredential({
        organizationId: organization.organizationId,
        applicationId: application.applicationId,
        scopes: ['crowdsource:reports:write'],
        expiresAt,
      });

    // Control: an expiry in the future does not, by itself, reject.
    const valid = await issueWithExpiry(new Date(Date.now() + 60_000));
    await expect(authenticateServiceCredential(valid.token)).resolves.toBeDefined();

    const expired = await issueWithExpiry(new Date(Date.now() - 1_000));
    await expectUnauthorized(authenticateServiceCredential(expired.token));
  });

  it('refuses tokens that are not CrowdSource service credentials', async () => {
    const notCredentials = [
      '',
      'not-a-token',
      'csk_short.secret',
      // An Oxy access token. The two caller classes are separate: an Oxy session
      // must never satisfy an application-API route (§13.2).
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJveHlfdXNlcl8xIn0.signature',
      // A well-formed but unissued credential id.
      `csk_${'0'.repeat(32)}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    ];

    for (const token of notCredentials) {
      await expectUnauthorized(authenticateServiceCredential(token));
    }
  });
});

describe('parseServiceToken', () => {
  it('accepts a well-formed token and splits it once', () => {
    const parsed = parseServiceToken(`csk_${'a'.repeat(32)}.secret-value`);

    expect(parsed).toEqual({ credentialId: `csk_${'a'.repeat(32)}`, secret: 'secret-value' });
  });

  it('rejects anything that is not exactly two parts', () => {
    expect(parseServiceToken(`csk_${'a'.repeat(32)}`)).toBeNull();
    expect(parseServiceToken(`csk_${'a'.repeat(32)}.a.b`)).toBeNull();
    expect(parseServiceToken(`csk_${'a'.repeat(32)}.`)).toBeNull();
    expect(parseServiceToken(`.secret`)).toBeNull();
  });
});

describe('scope issuance', () => {
  it('refuses to grant a privileged scope to an application credential', async () => {
    const tenant = await provisionTenant();

    for (const scope of PRIVILEGED_SCOPES) {
      await expect(
        issueApplicationCredential({
          organizationId: tenant.organizationId,
          applicationId: tenant.applicationId,
          scopes: [scope],
        }),
      ).rejects.toThrow(/internal and cannot be granted/);
    }
  });

  it('refuses an unknown scope rather than dropping it', async () => {
    const tenant = await provisionTenant();

    await expect(
      issueApplicationCredential({
        organizationId: tenant.organizationId,
        applicationId: tenant.applicationId,
        scopes: ['crowdsource:reports:write', 'crowdsource:everything'],
      }),
    ).rejects.toThrow(/Unknown scope/);
  });

  it('refuses a credential with no scopes', async () => {
    const tenant = await provisionTenant();

    await expect(
      issueApplicationCredential({
        organizationId: tenant.organizationId,
        applicationId: tenant.applicationId,
        scopes: [],
      }),
    ).rejects.toThrow(/at least one scope/);
  });

  it('refuses an application belonging to another organization', async () => {
    const [first, second] = await Promise.all([provisionTenant(), provisionTenant()]);

    await expect(
      issueApplicationCredential({
        organizationId: first.organizationId,
        applicationId: second.applicationId,
        scopes: ['crowdsource:reports:write'],
      }),
    ).rejects.toThrow(/No such application/);
  });

  it('returns the token exactly once and stores only its digest', async () => {
    const tenant = await provisionTenant();
    const caller = await authenticateServiceCredential(tenant.token);

    const stored = await applicationCredentials.findOne({ credentialId: caller.credentialId });

    expect(stored).not.toBeNull();
    expect(stored?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    // The secret half of the token appears nowhere in the stored record.
    expect(JSON.stringify(stored)).not.toContain(tenant.token.split('.')[1]);
  });
});

describe('provisioning validation', () => {
  it('refuses a duplicate organization slug', async () => {
    const slug = `dup-${randomUUID()}`;
    await createOrganization({ name: 'First', slug });

    await expect(createOrganization({ name: 'Second', slug })).rejects.toThrow(/already taken/);
  });

  it('refuses a malformed slug and an empty name', async () => {
    await expect(createOrganization({ name: 'X', slug: 'Not A Slug' })).rejects.toThrow(/slug/);
    await expect(createOrganization({ name: '  ', slug: `ok-${randomUUID()}` })).rejects.toThrow(
      /requires a name/,
    );
  });

  it('refuses an application under an organization that does not exist', async () => {
    await expect(
      createApplication({ organizationId: 'org_00000000000000000000000000000000', name: 'Ghost' }),
    ).rejects.toThrow(/No such organization/);
  });
});

describe('the application API refuses an unauthenticated caller', () => {
  it('answers 401 with a challenge and 403 for a missing scope', async () => {
    const tenant = await provisionTenant(['crowdsource:cases:read']);

    const anonymous = await request(app).get('/v1/reports/rpt_00000000000000000000000000000000');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['www-authenticate']).toContain('Bearer');

    const wrongScope = await request(app)
      .get('/v1/reports/rpt_00000000000000000000000000000000')
      .set('Authorization', `Bearer ${tenant.token}`);
    expect(wrongScope.status).toBe(403);
  });

  it('rejects a bearer header that is not a bearer header', async () => {
    const response = await request(app)
      .get('/v1/reports/rpt_00000000000000000000000000000000')
      .set('Authorization', 'Basic dXNlcjpwYXNz');

    expect(response.status).toBe(401);
  });
});
