import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubOxySession } from './support/reviewers';

/**
 * The developer console's authorization boundary (§4.2, §12.9, §13.2).
 *
 * This suite exists for one property above all others: **a console session can only
 * ever reach the tenants its Oxy identity is a member of.** The console is where a
 * broken authorization check is least visible — every screen looks the same whether
 * the data behind it was scoped correctly or not — so the boundary is asserted from
 * both sides throughout. A 404 is only evidence that isolation held if the same call
 * succeeds for somebody who IS a member; otherwise a broken fixture and a working
 * filter are indistinguishable.
 *
 * Only the network call that asks Oxy whether a bearer token is a real session is
 * stubbed. Everything downstream is the real code: the membership lookup, the tenant
 * construction from the stored application row, the role comparison, and this
 * service's own 401.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { grantMembership } = await import('../modules/console/membership.service');
const { organizationMembers } = await import('../modules/console/console.collections');
const { authenticateServiceCredential } = await import('../modules/tenancy/credential.service');
const { setOrganizationStatus } = await import('../modules/tenancy/provisioning.service');
const { applications } = await import('../modules/tenancy/tenancy.collections');
const { newPublicId } = await import('../utils/identifiers');
const { deliveryBody, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;
type ConsoleRole = Parameters<typeof grantMembership>[0]['role'];

const app = createApp();

function asUser(oxyUserId: string): Record<string, string> {
  return { 'x-test-oxy-user': oxyUserId };
}

function newOxyUserId(): string {
  return `oxy_console_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Someone with a seat in a tenant's organization.
 *
 * The seat is written straight through the membership service rather than driven
 * through the invitation route, because the tests that USE this are about what a seat
 * lets you reach. The invitation route is exercised on its own below.
 */
async function memberOf(
  tenant: ProvisionedTenant,
  role: ConsoleRole = 'admin',
): Promise<string> {
  const oxyUserId = newOxyUserId();
  await grantMembership({
    organizationId: tenant.organizationId,
    oxyUserId,
    role,
    invitedByOxyUserId: 'oxy_test_root',
  });
  return oxyUserId;
}

/**
 * A seat written straight to the collection, bypassing `grantMembership`.
 *
 * Needed for exactly one case: a membership naming an organization that does not exist,
 * which the service refuses to create — correctly. Reaching the state any other way would
 * mean weakening the very guard under test.
 */
async function grantMembershipDirectly(organizationId: string, oxyUserId: string): Promise<void> {
  const now = new Date();
  await organizationMembers.insertOne({
    organizationId,
    oxyUserId,
    role: 'owner',
    status: 'active',
    invitedByOxyUserId: 'oxy_test_root',
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

beforeAll(async () => {
  await startDatabase();
}, 120_000);

afterAll(async () => {
  await stopDatabase();
});

describe('a verified Oxy session, by itself', () => {
  it('is a valid console session with nothing in it', async () => {
    const response = await request(app)
      .get('/v1/console/session')
      .set(asUser(newOxyUserId()));

    expect(response.status).toBe(200);
    // The session is real; the authority is empty. Those are different things, and
    // conflating them is how every Oxy account ends up with a tenant.
    expect(response.body.memberships).toEqual([]);
    expect(response.body.staffRoles).toEqual([]);
  });

  it('refuses without a session at all', async () => {
    const response = await request(app).get('/v1/console/session');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('is refused by a service credential, which is the other caller class', async () => {
    const tenant = await provisionTenant();

    // The service token is a valid credential for the application API and means
    // nothing here: the shared SDK does not recognise it as an Oxy session, so it
    // never reaches a handler. That is §10.1's separation as a property of the
    // middleware rather than a rule each route remembers.
    const response = await request(app)
      .get('/v1/console/session')
      .set('authorization', `Bearer ${tenant.token}`);

    expect(response.status).toBe(401);
  });
});

describe('self-service tenant creation (§15.10)', () => {
  it('makes the creator the owner, in the same request', async () => {
    const oxyUserId = newOxyUserId();
    const slug = `console-${randomUUID()}`;

    const created = await request(app)
      .post('/v1/console/organizations')
      .set(asUser(oxyUserId))
      .send({ name: 'Console Test Org', slug });

    expect(created.status).toBe(201);
    expect(created.body.role).toBe('owner');

    // An organization created without a seat would be unreachable through every
    // other route in the router, because they all start with a membership check.
    const listed = await request(app).get('/v1/console/organizations').set(asUser(oxyUserId));
    expect(listed.status).toBe(200);
    expect(listed.body.organizations).toHaveLength(1);
    expect(listed.body.organizations[0]).toMatchObject({
      organizationId: created.body.organizationId,
      role: 'owner',
      applicationCount: 0,
    });
  });

  it('refuses a slug somebody already took', async () => {
    const slug = `taken-${randomUUID()}`;
    await request(app)
      .post('/v1/console/organizations')
      .set(asUser(newOxyUserId()))
      .send({ name: 'First', slug });

    const second = await request(app)
      .post('/v1/console/organizations')
      .set(asUser(newOxyUserId()))
      .send({ name: 'Second', slug });

    expect(second.status).toBe(409);
  });

  it('creates applications in the sandbox standing, and says so (§11.13)', async () => {
    const oxyUserId = newOxyUserId();
    const organization = await request(app)
      .post('/v1/console/organizations')
      .set(asUser(oxyUserId))
      .send({ name: 'Sandbox Org', slug: `sandbox-${randomUUID()}` });

    const created = await request(app)
      .post(`/v1/console/organizations/${organization.body.organizationId}/applications`)
      .set(asUser(oxyUserId))
      .send({ name: 'New Application' });

    expect(created.status).toBe(201);
    expect(created.body.standing).toBe('sandbox');

    const detail = await request(app)
      .get(`/v1/console/applications/${created.body.applicationId}`)
      .set(asUser(oxyUserId));

    expect(detail.status).toBe(200);
    expect(detail.body.trust.standing).toBe('sandbox');
    // The quota an integrator will actually hit, visible before they hit it.
    expect(detail.body.quota.globalReputationEffects).toBe(false);
    expect(detail.body.quota.reportsPerDay).toBeGreaterThan(0);
  });
});

describe('the tenant boundary', () => {
  /**
   * The central assertion of this suite, run against every tenant-scoped route on the
   * router rather than a representative one. A boundary that holds on the case
   * explorer and leaks on the usage summary is not a boundary, and the only way to
   * know is to ask each of them.
   */
  it('answers 404 on every route of an application the session is not a member of', async () => {
    const mine = await provisionTenant();
    const theirs = await provisionTenant();
    const oxyUserId = await memberOf(mine, 'owner');

    const paths = [
      '',
      '/credentials',
      '/webhook-endpoints',
      '/deliveries',
      '/cases',
      '/usage',
      '/audit',
    ];

    for (const path of paths) {
      const refused = await request(app)
        .get(`/v1/console/applications/${theirs.applicationId}${path}`)
        .set(asUser(oxyUserId));

      expect(refused.status, `GET ...${path} on another tenant`).toBe(404);

      // The control. The same route on the caller's OWN application must answer 200,
      // or the 404 above proves nothing about isolation.
      const allowed = await request(app)
        .get(`/v1/console/applications/${mine.applicationId}${path}`)
        .set(asUser(oxyUserId));

      expect(allowed.status, `GET ...${path} on the caller's own tenant`).toBe(200);
    }
  });

  it('404s rather than 403s, so the route is not an existence oracle', async () => {
    const theirs = await provisionTenant();
    const stranger = newOxyUserId();

    const known = await request(app)
      .get(`/v1/console/applications/${theirs.applicationId}`)
      .set(asUser(stranger));
    const invented = await request(app)
      .get(`/v1/console/applications/app_${'0'.repeat(32)}`)
      .set(asUser(stranger));

    // An application that exists and one that never did answer identically. A 403 on
    // the first would turn this route into a way to enumerate Oxy's customers.
    expect(known.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(known.body.error.message).toBe(invented.body.error.message);
  });

  it('never shows another tenant a case, even under the same query', async () => {
    const mine = await provisionTenant();
    const theirs = await provisionTenant();
    const oxyUserId = await memberOf(mine, 'owner');

    const theirReport = await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${theirs.token}`)
      .set('idempotency-key', `their-case-${randomUUID()}`)
      .send(deliveryBody(theirs, `their-report-${randomUUID()}`, { language: 'pt' }));
    expect(theirReport.status).toBe(202);

    const listed = await request(app)
      .get(`/v1/console/applications/${mine.applicationId}/cases`)
      .set(asUser(oxyUserId));

    expect(listed.status).toBe(200);
    expect(listed.body.cases).toEqual([]);

    // And naming their case id directly does not reach it either: the case detail is
    // read through the tenant filter, not looked up by id and then checked.
    const direct = await request(app)
      .get(`/v1/console/applications/${mine.applicationId}/cases/${theirReport.body.caseId}`)
      .set(asUser(oxyUserId));
    expect(direct.status).toBe(404);
  });

  it('stops at the seat being revoked, not at the row being deleted', async () => {
    const tenant = await provisionTenant();
    const oxyUserId = await memberOf(tenant, 'owner');
    const secondOwner = await memberOf(tenant, 'owner');

    const before = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}`)
      .set(asUser(oxyUserId));
    expect(before.status).toBe(200);

    const revoked = await request(app)
      .post(
        `/v1/console/organizations/${tenant.organizationId}/members/${oxyUserId}/revoke`,
      )
      .set(asUser(secondOwner));
    expect(revoked.status).toBe(200);

    const after = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}`)
      .set(asUser(oxyUserId));
    expect(after.status).toBe(404);
  });

  /**
   * The four ways resolving a membership can fail, each asserted on its own.
   *
   * Resolving a membership is an AUTHORIZATION decision, so every unknown has to be a
   * refusal rather than an empty tenant or a default — and each of these is a different
   * guard, so a suite that only covered "not a member" would leave three of them unproven.
   */
  it('refuses a session with no membership at all', async () => {
    const theirs = await provisionTenant();
    const response = await request(app)
      .get(`/v1/console/applications/${theirs.applicationId}`)
      .set(asUser(newOxyUserId()));
    expect(response.status).toBe(404);
  });

  it('refuses an application that does not exist', async () => {
    const mine = await provisionTenant();
    // A real member of a real organization, naming an application that was never created.
    const response = await request(app)
      .get(`/v1/console/applications/app_${'1'.repeat(32)}`)
      .set(asUser(await memberOf(mine, 'owner')));
    expect(response.status).toBe(404);
  });

  it('refuses a membership held in a different organization than the application belongs to', async () => {
    const mine = await provisionTenant();
    const theirs = await provisionTenant();
    const oxyUserId = await memberOf(mine, 'owner');

    // The seat is real and so is the application; they simply belong to different
    // organizations. This is the case a filter that scoped by application alone would miss.
    const response = await request(app)
      .get(`/v1/console/applications/${theirs.applicationId}`)
      .set(asUser(oxyUserId));
    expect(response.status).toBe(404);
  });

  it('refuses a seat whose organization no longer exists', async () => {
    /**
     * The orphaned state, built directly rather than by deleting an organization: the
     * access layer exposes no delete, deliberately, so the way to reach this state in
     * production is an out-of-band removal or a partially-applied migration — and either
     * leaves exactly this shape, an application and a membership naming an organization
     * that is not there.
     */
    const orphanedOrganizationId = `org_${'2'.repeat(32)}`;
    const applicationId = newPublicId('application');
    const oxyUserId = newOxyUserId();
    const now = new Date();

    await applications.insertOne({
      organizationId: orphanedOrganizationId,
      applicationId,
      name: 'Orphaned Application',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await grantMembershipDirectly(orphanedOrganizationId, oxyUserId);

    const response = await request(app)
      .get(`/v1/console/applications/${applicationId}`)
      .set(asUser(oxyUserId));

    // Nothing cascades a delete, so a membership row outlives its organization. The seat
    // must stop granting access rather than keep working against an ownerless application.
    expect(response.status).toBe(404);
  });

  it('refuses a seat in a suspended organization, with the capability withdrawn', async () => {
    const tenant = await provisionTenant();
    const oxyUserId = await memberOf(tenant, 'owner');
    await setOrganizationStatus(tenant.organizationId, 'suspended');

    const response = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}`)
      .set(asUser(oxyUserId));

    // 403 and not 404: membership is established, the caller already knows the organization
    // exists, and what changed is the capability. `setOrganizationStatus` would otherwise be
    // half a kill switch — provisioning refuses new applications while the console kept
    // issuing credentials for the existing ones.
    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain('suspended');
  });

  it('has no route that accepts an organizationId in a body', async () => {
    const tenant = await provisionTenant();
    const oxyUserId = await memberOf(tenant, 'owner');

    /**
     * The shape of the attack this closes: a caller who knows another tenant's ids
     * tries to smuggle one into a write. Every body schema is a `strictObject`, so an
     * unexpected key is a 400 rather than a field that reaches a document — and even
     * if one did, `tenantScopedDocument` throws on a tenant key.
     */
    const smuggled = await request(app)
      .post(`/v1/console/organizations/${tenant.organizationId}/applications`)
      .set(asUser(oxyUserId))
      .send({ name: 'Sneaky', organizationId: 'org_00000000000000000000000000000000' });

    expect(smuggled.status).toBe(400);
  });
});

describe('roles', () => {
  it('lets a viewer read and refuses every write', async () => {
    const tenant = await provisionTenant();
    const viewer = await memberOf(tenant, 'viewer');

    const read = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/credentials`)
      .set(asUser(viewer));
    expect(read.status).toBe(200);

    const issue = await request(app)
      .post(`/v1/console/applications/${tenant.applicationId}/credentials`)
      .set(asUser(viewer))
      .send({ scopes: ['crowdsource:reports:write'] });
    // 403 and not 404: membership IS established, so the caller already knows the
    // application exists and the refusal gives away nothing new. An integrator
    // debugging this has to be able to tell it from "I am not in this organization".
    expect(issue.status).toBe(403);
    expect(issue.body.error.message).toContain('admin');

    const invite = await request(app)
      .post(`/v1/console/organizations/${tenant.organizationId}/members`)
      .set(asUser(viewer))
      .send({ oxyUserId: newOxyUserId(), role: 'viewer' });
    expect(invite.status).toBe(403);
  });

  it('refuses a developer the writes that touch production traffic', async () => {
    const tenant = await provisionTenant();
    const developer = await memberOf(tenant, 'developer');

    const issue = await request(app)
      .post(`/v1/console/applications/${tenant.applicationId}/credentials`)
      .set(asUser(developer))
      .send({ scopes: ['crowdsource:reports:write'] });
    expect(issue.status).toBe(403);
  });

  it('accepts an admin, so the refusals above are about the role', async () => {
    const tenant = await provisionTenant();
    const admin = await memberOf(tenant, 'admin');

    const issue = await request(app)
      .post(`/v1/console/applications/${tenant.applicationId}/credentials`)
      .set(asUser(admin))
      .send({ scopes: ['crowdsource:reports:write'] });
    expect(issue.status).toBe(201);
  });

  it('refuses to revoke the last owner', async () => {
    const tenant = await provisionTenant();
    const owner = await memberOf(tenant, 'owner');

    const refused = await request(app)
      .post(`/v1/console/organizations/${tenant.organizationId}/members/${owner}/revoke`)
      .set(asUser(owner));

    // An organization with no owner is unrecoverable through the console: every path
    // back requires a seat somebody with authority has to grant.
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('last owner');
  });

  it('lets an owner hand over, then step down', async () => {
    const tenant = await provisionTenant();
    const first = await memberOf(tenant, 'owner');
    const second = newOxyUserId();

    const granted = await request(app)
      .post(`/v1/console/organizations/${tenant.organizationId}/members`)
      .set(asUser(first))
      .send({ oxyUserId: second, role: 'owner' });
    expect(granted.status).toBe(201);

    const steppedDown = await request(app)
      .post(`/v1/console/organizations/${tenant.organizationId}/members/${first}/revoke`)
      .set(asUser(first));
    expect(steppedDown.status).toBe(200);
  });

  it('changes a role by re-granting rather than by a second write path', async () => {
    const tenant = await provisionTenant();
    const owner = await memberOf(tenant, 'owner');
    const member = await memberOf(tenant, 'viewer');

    const promoted = await request(app)
      .post(`/v1/console/organizations/${tenant.organizationId}/members`)
      .set(asUser(owner))
      .send({ oxyUserId: member, role: 'admin' });

    expect(promoted.status).toBe(201);
    expect(promoted.body.role).toBe('admin');

    const nowAllowed = await request(app)
      .post(`/v1/console/applications/${tenant.applicationId}/credentials`)
      .set(asUser(member))
      .send({ scopes: ['crowdsource:cases:read'] });
    expect(nowAllowed.status).toBe(201);
  });
});

describe('credentials through the console', () => {
  it('shows the token once and never again (§13.4)', async () => {
    const tenant = await provisionTenant();
    const admin = await memberOf(tenant, 'admin');

    const issued = await request(app)
      .post(`/v1/console/applications/${tenant.applicationId}/credentials`)
      .set(asUser(admin))
      .send({ scopes: ['crowdsource:reports:write', 'crowdsource:cases:read'] });

    expect(issued.status).toBe(201);
    expect(typeof issued.body.token).toBe('string');
    // It is a real credential, so "shown once" is a statement about a working key.
    await expect(authenticateServiceCredential(issued.body.token)).resolves.toBeDefined();

    const listed = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/credentials`)
      .set(asUser(admin));

    expect(listed.status).toBe(200);
    const serialised = JSON.stringify(listed.body);
    expect(serialised).not.toContain(issued.body.token);
    // Not even the digest. A console that re-served it would hand every admin seat an
    // offline target.
    expect(serialised).not.toContain('secretHash');
    expect(listed.body.credentials.some((row: { credentialId: string }) =>
      row.credentialId === issued.body.credentialId)).toBe(true);
  });

  it('cannot mint a privileged scope (§13.2)', async () => {
    const tenant = await provisionTenant();
    const admin = await memberOf(tenant, 'admin');

    for (const scope of [
      'reputation:moderation:apply',
      'crowdsource:decisions:emit',
      'crowdsource:trust-safety:operate',
    ]) {
      const refused = await request(app)
        .post(`/v1/console/applications/${tenant.applicationId}/credentials`)
        .set(asUser(admin))
        .send({ scopes: [scope] });

      // Refused by the request schema, before the domain service is reached — and the
      // service refuses them too. Neither one being wrong on its own is enough.
      expect(refused.status, scope).toBe(400);
    }
  });

  it('revokes its own credentials and no others', async () => {
    const mine = await provisionTenant();
    const theirs = await provisionTenant();
    const admin = await memberOf(mine, 'admin');

    const issued = await request(app)
      .post(`/v1/console/applications/${mine.applicationId}/credentials`)
      .set(asUser(admin))
      .send({ scopes: ['crowdsource:reports:write'] });

    const revoked = await request(app)
      .post(
        `/v1/console/applications/${mine.applicationId}/credentials/${issued.body.credentialId}/revoke`,
      )
      .set(asUser(admin));
    expect(revoked.status).toBe(200);
    await expect(authenticateServiceCredential(issued.body.token)).rejects.toMatchObject({
      code: 'unauthorized',
    });

    // Another application's credential id, named through a path this caller IS
    // allowed to use. The tenant is part of the revoke's own filter, so it misses.
    const crossTenant = await request(app)
      .post(
        `/v1/console/applications/${mine.applicationId}/credentials/${theirs.token.split('.')[0]}/revoke`,
      )
      .set(asUser(admin));
    expect(crossTenant.status).toBe(404);
    await expect(authenticateServiceCredential(theirs.token)).resolves.toBeDefined();
  });
});
