import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubOxySession } from './support/reviewers';

/**
 * The console's operational surfaces (§4.2: webhooks, deliveries, replay, usage, audit)
 * and the edges of the services behind them.
 *
 * Separated from `consoleMembership.integration.test.ts` because the questions are
 * different: that suite asks who may reach a tenant, this one asks whether what they
 * reach is correct — including the refusals, which are the half most likely to be
 * written once and never exercised.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { requestStaff, requireStaffRole, consoleUser } = await import(
  '../modules/console/consoleAuth'
);
const {
  atLeast,
  grantMembership,
  membershipsWithOrganizations,
  requireMembership,
  resolveApplicationForMember,
  revokeMembership,
} = await import('../modules/console/membership.service');
const { grantStaffRoles, revokeStaff } = await import('../modules/console/staff.service');
const { organizationMembers } = await import('../modules/console/console.collections');
const { createApplicationTrust, setApplicationStanding } = await import(
  '../modules/trust/applicationTrust.service'
);
const { webhookDeliveries, webhookEndpoints } = await import(
  '../modules/webhooks/webhook.collections'
);
const { newPublicId } = await import('../utils/identifiers');
const { deliveryBody, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();

function asUser(oxyUserId: string): Record<string, string> {
  return { 'x-test-oxy-user': oxyUserId };
}

function newOxyUserId(): string {
  return `oxy_console_${randomUUID().replace(/-/g, '')}`;
}

async function adminOf(tenant: ProvisionedTenant): Promise<string> {
  const oxyUserId = newOxyUserId();
  await grantMembership({
    organizationId: tenant.organizationId,
    oxyUserId,
    role: 'admin',
    invitedByOxyUserId: 'oxy_test_root',
  });
  return oxyUserId;
}

/** An endpoint written straight to the collection — the list route needs no secret. */
async function seedEndpoint(tenant: ProvisionedTenant): Promise<string> {
  const webhookEndpointId = newPublicId('webhookEndpoint');
  const now = new Date();
  await webhookEndpoints.insertOne(tenant.tenant, {
    webhookEndpointId,
    url: `https://console-ops-${randomUUID()}.example.com/hooks`,
    eventTypes: ['case.decided'],
    status: 'active',
    disabledReason: null,
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return webhookEndpointId;
}

/**
 * A dead-lettered delivery, written directly.
 *
 * The path that produces one for real is the retry ladder running out, which takes six
 * scheduled attempts; what the console cares about is the row, and driving the ladder
 * is `webhookDelivery.integration.test.ts`' job.
 */
async function seedDeadLetter(
  tenant: ProvisionedTenant,
  webhookEndpointId: string,
): Promise<string> {
  const deliveryId = newPublicId('webhookDelivery');
  const now = new Date();
  await webhookDeliveries.insertOne({
    organizationId: tenant.organizationId,
    applicationId: tenant.applicationId,
    deliveryId,
    webhookEndpointId,
    eventId: newPublicId('outboxEvent'),
    eventType: 'case.decided',
    body: '{"secret":"the exact signed bytes"}',
    status: 'dead_letter',
    attemptCount: 6,
    cycleAttemptCount: 6,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastResponseStatus: 500,
    deadLetterReason: 'attempts_exhausted',
    succeededAt: null,
    deadLetteredAt: now,
    replayCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return deliveryId;
}

beforeAll(async () => {
  await startDatabase();
}, 120_000);

afterAll(async () => {
  await stopDatabase();
});

describe('webhook endpoints and their delivery health', () => {
  it('lists what the application has registered, which §10.2 has no route for', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);
    const webhookEndpointId = await seedEndpoint(tenant);
    await seedDeadLetter(tenant, webhookEndpointId);

    const listed = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/webhook-endpoints`)
      .set(asUser(admin));

    expect(listed.status).toBe(200);
    expect(listed.body.endpoints).toHaveLength(1);
    expect(listed.body.endpoints[0].webhookEndpointId).toBe(webhookEndpointId);
    // Four counts rather than a rate: a healthy success rate next to a growing dead
    // letter queue is exactly the situation a single number hides.
    expect(listed.body.endpoints[0].health).toEqual({
      pending: 0,
      delivering: 0,
      succeeded: 0,
      deadLetter: 1,
    });
  });

  it('rotates a secret through the same service the application API uses', async () => {
    const tenant = await provisionTenant(['crowdsource:webhooks:manage']);
    const admin = await adminOf(tenant);

    // Registered through the real route, because a rotation needs a version 1 secret
    // that was actually encrypted.
    const registered = await request(app)
      .post('/v1/webhook-endpoints')
      .set('authorization', `Bearer ${tenant.token}`)
      .send({
        url: `https://console-rotate-${randomUUID()}.example.com/hooks`,
        eventTypes: ['case.decided'],
      });
    expect(registered.status).toBe(201);

    const rotated = await request(app)
      .post(
        `/v1/console/applications/${tenant.applicationId}/webhook-endpoints/${registered.body.webhookEndpointId}/rotate-secret`,
      )
      .set(asUser(admin))
      .send({ overlapSeconds: 0 });

    expect(rotated.status).toBe(200);
    expect(rotated.body.secret.version).toBe(2);
    expect(typeof rotated.body.secret.value).toBe('string');
    // The field that makes the overlap a procedure an integrator can follow rather than
    // a guess about when signatures change.
    expect(typeof rotated.body.secret.signingStartsAt).toBe('string');
    expect(rotated.body.previousSecret.version).toBe(1);
  });

  it('refuses a rotation a viewer asks for, and an endpoint that is not this tenant\'s', async () => {
    const mine = await provisionTenant();
    const theirs = await provisionTenant();
    const viewerId = newOxyUserId();
    await grantMembership({
      organizationId: mine.organizationId,
      oxyUserId: viewerId,
      role: 'viewer',
      invitedByOxyUserId: 'oxy_test_root',
    });
    const admin = await adminOf(mine);
    const theirEndpoint = await seedEndpoint(theirs);

    const byViewer = await request(app)
      .post(
        `/v1/console/applications/${mine.applicationId}/webhook-endpoints/${theirEndpoint}/rotate-secret`,
      )
      .set(asUser(viewerId))
      .send({});
    expect(byViewer.status).toBe(403);

    const crossTenant = await request(app)
      .post(
        `/v1/console/applications/${mine.applicationId}/webhook-endpoints/${theirEndpoint}/rotate-secret`,
      )
      .set(asUser(admin))
      .send({});
    expect(crossTenant.status).toBe(404);
  });

  it('refuses a malformed endpoint id and an unusable overlap window', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);
    const endpointId = await seedEndpoint(tenant);

    const malformed = await request(app)
      .post(
        `/v1/console/applications/${tenant.applicationId}/webhook-endpoints/not-an-id/rotate-secret`,
      )
      .set(asUser(admin))
      .send({});
    expect(malformed.status).toBe(404);

    const badOverlap = await request(app)
      .post(
        `/v1/console/applications/${tenant.applicationId}/webhook-endpoints/${endpointId}/rotate-secret`,
      )
      .set(asUser(admin))
      .send({ overlapSeconds: -1 });
    expect(badOverlap.status).toBe(400);
  });
});

describe('deliveries and manual replay (§10.9)', () => {
  it('lists them, filters by status, and never returns the signed body', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);
    const endpointId = await seedEndpoint(tenant);
    const deliveryId = await seedDeadLetter(tenant, endpointId);

    const all = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/deliveries`)
      .set(asUser(admin));
    expect(all.status).toBe(200);
    expect(all.body.deliveries).toHaveLength(1);
    // The delivery row holds the exact bytes that were signed and sent. The console has
    // no use for them and serving them would make it a reader of event payloads.
    expect(JSON.stringify(all.body)).not.toContain('the exact signed bytes');
    expect(all.body.deliveries[0].body).toBeUndefined();
    expect(all.body.deliveries[0].deadLetterReason).toBe('attempts_exhausted');

    const filtered = await request(app)
      .get(
        `/v1/console/applications/${tenant.applicationId}/deliveries?status=dead_letter&webhookEndpointId=${endpointId}`,
      )
      .set(asUser(admin));
    expect(filtered.body.deliveries).toHaveLength(1);

    const empty = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/deliveries?status=succeeded`)
      .set(asUser(admin));
    expect(empty.body.deliveries).toEqual([]);

    const one = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/deliveries/${deliveryId}`)
      .set(asUser(admin));
    expect(one.status).toBe(200);
    expect(one.body.deliveryId).toBe(deliveryId);
  });

  it('refuses a status filter it does not recognise rather than ignoring it', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    const refused = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/deliveries?status=exploded`)
      .set(asUser(admin));

    // An operator filtering for `dead_letter` who received everything would read the
    // result as "all of these are failing".
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('status must be one of');
  });

  it('replays a dead letter and refuses one that is not dead-lettered', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);
    const endpointId = await seedEndpoint(tenant);
    const deliveryId = await seedDeadLetter(tenant, endpointId);

    const replayed = await request(app)
      .post(`/v1/console/applications/${tenant.applicationId}/deliveries/${deliveryId}/replay`)
      .set(asUser(admin));

    expect(replayed.status).toBe(200);
    expect(replayed.body.status).toBe('pending');
    expect(replayed.body.replayCount).toBe(1);
    // The ladder starts again while the attempt NUMBERS keep climbing, so the history
    // stays readable and a replay gets the same patience the first delivery had.
    expect(replayed.body.cycleAttemptCount).toBe(0);
    expect(replayed.body.attemptCount).toBe(6);

    const again = await request(app)
      .post(`/v1/console/applications/${tenant.applicationId}/deliveries/${deliveryId}/replay`)
      .set(asUser(admin));
    expect(again.status).toBe(409);
  });

  it('refuses a malformed or absent delivery id on both routes', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    for (const id of ['not-an-id', `whd_${'0'.repeat(32)}`]) {
      const read = await request(app)
        .get(`/v1/console/applications/${tenant.applicationId}/deliveries/${id}`)
        .set(asUser(admin));
      expect(read.status, `GET ${id}`).toBe(404);

      const replay = await request(app)
        .post(`/v1/console/applications/${tenant.applicationId}/deliveries/${id}/replay`)
        .set(asUser(admin));
      expect(replay.status, `POST ${id}`).toBe(404);
    }
  });
});

describe("the tenant's own audit trail", () => {
  it('shows which credential read which case, and filters by case', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    const delivered = await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${tenant.token}`)
      .set('idempotency-key', `audit-${randomUUID()}`)
      .send(deliveryBody(tenant, `audit-report-${randomUUID()}`, { language: 'fi' }));
    expect(delivered.status).toBe(202);

    const events = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/audit`)
      .set(asUser(admin));

    expect(events.status).toBe(200);
    expect(events.body.events.length).toBeGreaterThan(0);
    const ingress = events.body.events.find(
      (event: { action: string }) => event.action === 'report.ingress.accepted',
    );
    // "Somebody at this tenant did it" and "the leaked key did it" are different
    // answers, and only the second is useful during a credential incident.
    expect(ingress.actorCredentialId).toBe(tenant.token.split('.')[0]);

    const scoped = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/audit?caseId=${delivered.body.caseId}`)
      .set(asUser(admin));
    expect(scoped.status).toBe(200);
    expect(scoped.body.events.every((event: { caseId: string }) =>
      event.caseId === delivered.body.caseId)).toBe(true);

    // A malformed case filter is IGNORED rather than refused here: the parameter narrows
    // a list that is already tenant-scoped, so the worst a bad value can do is show the
    // whole trail, which is what the unfiltered route shows anyway.
    const unfiltered = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/audit?caseId=nonsense`)
      .set(asUser(admin));
    expect(unfiltered.status).toBe(200);
  });
});

describe('console writes leave a trail (§13.2)', () => {
  it('records who issued and who revoked a credential, as a person and not a key', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    const issued = await request(app)
      .post(`/v1/console/applications/${tenant.applicationId}/credentials`)
      .set(asUser(admin))
      .send({ scopes: ['crowdsource:reports:write'] });
    expect(issued.status).toBe(201);

    await request(app)
      .post(
        `/v1/console/applications/${tenant.applicationId}/credentials/${issued.body.credentialId}/revoke`,
      )
      .set(asUser(admin));

    const trail = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/audit`)
      .set(asUser(admin));

    const actions = trail.body.events.map((event: { action: string }) => event.action);
    expect(actions).toContain('console.credential.issued');
    expect(actions).toContain('console.credential.revoked');

    const revocation = trail.body.events.find(
      (event: { action: string }) => event.action === 'console.credential.revoked',
    );
    // "The leaked key did it" and "this member of your team did it" are different
    // incidents, so the actor fields are separate and only one of them is set.
    expect(revocation.actorOxyUserId).toBe(admin);
    expect(revocation.actorCredentialId).toBeNull();
    expect(revocation.subjectId).toBe(issued.body.credentialId);
  });

  it('records a replayed delivery and a rotated secret, without the secret', async () => {
    const tenant = await provisionTenant(['crowdsource:webhooks:manage']);
    const admin = await adminOf(tenant);

    const registered = await request(app)
      .post('/v1/webhook-endpoints')
      .set('authorization', `Bearer ${tenant.token}`)
      .send({
        url: `https://console-audit-${randomUUID()}.example.com/hooks`,
        eventTypes: ['case.decided'],
      });
    expect(registered.status).toBe(201);

    const rotated = await request(app)
      .post(
        `/v1/console/applications/${tenant.applicationId}/webhook-endpoints/${registered.body.webhookEndpointId}/rotate-secret`,
      )
      .set(asUser(admin))
      .send({ overlapSeconds: 0 });
    expect(rotated.status).toBe(200);

    const deliveryId = await seedDeadLetter(tenant, registered.body.webhookEndpointId);
    await request(app)
      .post(`/v1/console/applications/${tenant.applicationId}/deliveries/${deliveryId}/replay`)
      .set(asUser(admin));

    const trail = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/audit`)
      .set(asUser(admin));

    const actions = trail.body.events.map((event: { action: string }) => event.action);
    expect(actions).toContain('console.webhook.secret.rotated');
    expect(actions).toContain('console.delivery.replayed');

    /**
     * The trail is the longest-retained data in the system (§13.6), so a field that
     * occasionally holds a secret keeps it long after the endpoint it signed for is gone.
     */
    const serialised = JSON.stringify(trail.body);
    expect(serialised).not.toContain(rotated.body.secret.value);
    expect(serialised).not.toContain('example.com');
  });

  it('records a created application against the application it created', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    const created = await request(app)
      .post(`/v1/console/organizations/${tenant.organizationId}/applications`)
      .set(asUser(admin))
      .send({ name: 'Audited Application' });
    expect(created.status).toBe(201);

    const trail = await request(app)
      .get(`/v1/console/applications/${created.body.applicationId}/audit`)
      .set(asUser(admin));

    expect(trail.status).toBe(200);
    expect(trail.body.events).toHaveLength(1);
    expect(trail.body.events[0]).toMatchObject({
      action: 'console.application.created',
      actorOxyUserId: admin,
      subjectId: created.body.applicationId,
    });
  });
});

describe('the case explorer pages past one screen', () => {
  it('issues a cursor only when there is more, and the next page neither skips nor repeats', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    // One over a page, so the cursor is issued and the second page holds exactly the
    // remainder. Fifty-one deliveries is the smallest number that exercises both.
    for (let index = 0; index < 51; index += 1) {
      const delivered = await request(app)
        .post('/v1/reports')
        .set('authorization', `Bearer ${tenant.token}`)
        .set('idempotency-key', `cursor-${index}-${randomUUID()}`)
        .send(
          deliveryBody(tenant, `cursor-report-${index}-${randomUUID()}`, {
            subjectExternalId: `post_cursor_${index}`,
            language: 'fi',
          }),
        );
      expect(delivered.status).toBe(202);
    }

    const first = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/cases`)
      .set(asUser(admin));
    expect(first.status).toBe(200);
    expect(first.body.cases).toHaveLength(50);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(app)
      .get(
        `/v1/console/applications/${tenant.applicationId}/cases?cursor=${encodeURIComponent(first.body.nextCursor)}`,
      )
      .set(asUser(admin));
    expect(second.status).toBe(200);
    expect(second.body.cases).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();

    const firstIds: string[] = first.body.cases.map((row: { caseId: string }) => row.caseId);
    const secondIds: string[] = second.body.cases.map((row: { caseId: string }) => row.caseId);
    // Fifty-one distinct cases across two pages: nothing skipped, nothing repeated.
    expect(new Set([...firstIds, ...secondIds]).size).toBe(51);
  });
});

describe('the organization screens', () => {
  it('reports the caller\'s own seats on the session, with the organizations they are in', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    const session = await request(app).get('/v1/console/session').set(asUser(admin));

    expect(session.status).toBe(200);
    expect(session.body.oxyUserId).toBe(admin);
    expect(session.body.memberships).toHaveLength(1);
    expect(session.body.memberships[0]).toMatchObject({
      organizationId: tenant.organizationId,
      role: 'admin',
      status: 'active',
    });
    expect(typeof session.body.memberships[0].slug).toBe('string');
  });

  it('lists the seats in one organization, revoked ones included', async () => {
    const tenant = await provisionTenant();
    const owner = newOxyUserId();
    await grantMembership({
      organizationId: tenant.organizationId,
      oxyUserId: owner,
      role: 'owner',
      invitedByOxyUserId: 'oxy_test_root',
    });
    const leaving = await adminOf(tenant);
    await revokeMembership(tenant.organizationId, leaving);

    const members = await request(app)
      .get(`/v1/console/organizations/${tenant.organizationId}/members`)
      .set(asUser(owner));

    expect(members.status).toBe(200);
    // A revoked seat stays visible: "who used to have access" is the question an operator
    // asks after an incident, and a row that vanished cannot answer it.
    const revoked = members.body.members.find(
      (member: { oxyUserId: string }) => member.oxyUserId === leaving,
    );
    expect(revoked.status).toBe('revoked');
    expect(revoked.invitedByOxyUserId).toBe('oxy_test_root');
  });

  it('lists the applications of one organization with their standing', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);
    await setApplicationStanding({
      applicationId: tenant.applicationId,
      standing: 'trusted',
      reason: 'promotion_review_passed',
      byOxyUserId: newOxyUserId(),
    });

    const listed = await request(app)
      .get(`/v1/console/organizations/${tenant.organizationId}/applications`)
      .set(asUser(admin));

    expect(listed.status).toBe(200);
    const row = listed.body.applications.find(
      (candidate: { applicationId: string }) => candidate.applicationId === tenant.applicationId,
    );
    expect(row.standing).toBe('trusted');
    expect(row.globalReputationEffectsAllowed).toBe(true);
  });

  it('refuses a create-organization body that is not one', async () => {
    for (const body of [{}, { name: 'No Slug' }, { name: '', slug: 'ok-slug' }]) {
      const refused = await request(app)
        .post('/v1/console/organizations')
        .set(asUser(newOxyUserId()))
        .send(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses an invitation body that is not one', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    for (const body of [{}, { oxyUserId: newOxyUserId() }, { oxyUserId: newOxyUserId(), role: 'god' }]) {
      const refused = await request(app)
        .post(`/v1/console/organizations/${tenant.organizationId}/members`)
        .set(asUser(admin))
        .send(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses a create-application body that is not one', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    const refused = await request(app)
      .post(`/v1/console/organizations/${tenant.organizationId}/applications`)
      .set(asUser(admin))
      .send({});
    expect(refused.status).toBe(400);
  });

  it('refuses a malformed credential id and a malformed case id', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    const credential = await request(app)
      .post(
        `/v1/console/applications/${tenant.applicationId}/credentials/not-a-credential/revoke`,
      )
      .set(asUser(admin));
    expect(credential.status).toBe(404);

    const singleCase = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/cases/not-a-case`)
      .set(asUser(admin));
    expect(singleCase.status).toBe(404);
  });

  it('accepts the filters it documents', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    // The refusal paths are asserted elsewhere; these are the accepting ones, so a
    // parser that rejected everything could not pass both halves.
    const byStatus = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/cases?status=received`)
      .set(asUser(admin));
    expect(byStatus.status).toBe(200);

    const window = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/usage?windowDays=7`)
      .set(asUser(admin));
    expect(window.status).toBe(200);
    expect(window.body.window.days).toBe(7);
  });
});

describe('the membership service at its edges', () => {
  it('orders the roles so a capability check is one comparison', () => {
    expect(atLeast('owner', 'admin')).toBe(true);
    expect(atLeast('admin', 'admin')).toBe(true);
    expect(atLeast('developer', 'admin')).toBe(false);
    expect(atLeast('viewer', 'developer')).toBe(false);
  });

  it('answers 404 for an organization the caller is not in', async () => {
    await expect(
      requireMembership(newOxyUserId(), 'org_00000000000000000000000000000000'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('skips a seat whose organization is gone rather than failing the whole list', async () => {
    const oxyUserId = newOxyUserId();
    const tenant = await provisionTenant();
    await grantMembership({
      organizationId: tenant.organizationId,
      oxyUserId,
      role: 'viewer',
      invitedByOxyUserId: 'oxy_test_root',
    });
    // A seat pointing at an organization that does not exist. There is nothing the
    // member can do about it, and it must not take their other seats down with it.
    await organizationMembers.insertOne({
      organizationId: 'org_00000000000000000000000000000000',
      oxyUserId,
      role: 'viewer',
      status: 'active',
      invitedByOxyUserId: 'oxy_test_root',
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const memberships = await membershipsWithOrganizations(oxyUserId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].organizationId).toBe(tenant.organizationId);
  });

  it('refuses to grant a seat in an organization that does not exist', async () => {
    await expect(
      grantMembership({
        organizationId: 'org_00000000000000000000000000000000',
        oxyUserId: newOxyUserId(),
        role: 'admin',
        invitedByOxyUserId: 'oxy_test_root',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses to revoke a seat that is not held', async () => {
    const tenant = await provisionTenant();
    await expect(
      revokeMembership(tenant.organizationId, newOxyUserId()),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a malformed organization id on the members route', async () => {
    const response = await request(app)
      .get('/v1/console/organizations/not-an-org/members')
      .set(asUser(newOxyUserId()));
    expect(response.status).toBe(404);
  });

  it('refuses a member id that is not a string on the revoke route', async () => {
    const tenant = await provisionTenant();
    const admin = await adminOf(tenant);

    // An empty segment collapses the path, so the route does not match at all — which is
    // the same 404 a caller gets for a member who is not there.
    const response = await request(app)
      .post(`/v1/console/organizations/${tenant.organizationId}/members//revoke`)
      .set(asUser(admin));
    expect(response.status).toBe(404);
  });

  it('refuses a malformed application id before spending a query', async () => {
    const response = await request(app)
      .get('/v1/console/applications/not-an-app/cases')
      .set(asUser(newOxyUserId()));
    expect(response.status).toBe(404);
  });

  it('refuses a malformed application id in the service too, not only at the route', async () => {
    /**
     * Two guards for the same thing, and the duplication is deliberate: the route's saves
     * a query, and THIS one is the load-bearing half, because it holds for every caller
     * rather than only for the ones that came through a URL.
     */
    await expect(
      resolveApplicationForMember(newOxyUserId(), 'not-an-application-id'),
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(
      resolveApplicationForMember(newOxyUserId(), 'app_00000000000000000000000000000000'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the staff service at its edges', () => {
  it('requires at least one role', async () => {
    await expect(grantStaffRoles(newOxyUserId(), [])).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('refuses a role outside the four of §13.2', async () => {
    await expect(
      // The cast is the point of the test: the compiler stops this, and the runtime must
      // stop it too, because the value can arrive from a database row nobody typechecked.
      grantStaffRoles(newOxyUserId(), ['superuser' as 'policy']),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('replaces the whole role set rather than adding to it', async () => {
    const oxyUserId = newOxyUserId();
    await grantStaffRoles(oxyUserId, ['policy', 'appeals']);
    const replaced = await grantStaffRoles(oxyUserId, ['evidence']);

    // Removing one role has to be expressible, or the only way to drop a role is to
    // revoke the person and start again.
    expect(replaced.roles).toEqual(['evidence']);
  });

  it('refuses to revoke an account that holds nothing', async () => {
    await expect(revokeStaff(newOxyUserId())).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the guards refuse to be mounted wrongly', () => {
  it('will not build a staff guard that requires no role', () => {
    // A guard that requires nothing is worse than no guard: it reads as protection.
    expect(() => requireStaffRole()).toThrow(/at least one role/);
  });

  it('throws rather than returning a default when a route is not behind the middleware', () => {
    /**
     * The failure has to be loud and immediate. A console route that resolved
     * memberships for an empty user id would find none and answer an ordinary-looking
     * 404, so a mounting mistake would present as a permissions puzzle instead of a bug.
     */
    expect(() => consoleUser({} as never)).toThrow(/not mounted behind requireConsoleSession/);
    expect(() => requestStaff({} as never)).toThrow(/not mounted behind requireStaffRole/);
  });
});

describe('application trust at its edges', () => {
  it('is idempotent when the row already exists', async () => {
    const tenant = await provisionTenant();
    // Provisioning already created it, so this call must find it and change nothing.
    await expect(
      createApplicationTrust(tenant.organizationId, tenant.applicationId),
    ).resolves.toBeUndefined();
  });

  it('refuses to move the standing of an application that does not exist', async () => {
    await expect(
      setApplicationStanding({
        applicationId: 'app_00000000000000000000000000000000',
        standing: 'trusted',
        reason: 'promotion_review_passed',
        byOxyUserId: newOxyUserId(),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a standing change from a session with no staff row at all', async () => {
    const tenant = await provisionTenant();
    const response = await request(app)
      .post(`/v1/trust-safety/applications/${tenant.applicationId}/standing`)
      .set(asUser(newOxyUserId()))
      .send({ standing: 'trusted', reason: 'promotion_review_passed' });
    expect(response.status).toBe(403);
  });

  it('refuses a malformed application id on the standing route', async () => {
    const security = newOxyUserId();
    await grantStaffRoles(security, ['security']);

    const response = await request(app)
      .post('/v1/trust-safety/applications/not-an-app/standing')
      .set(asUser(security))
      .send({ standing: 'trusted', reason: 'promotion_review_passed' });
    expect(response.status).toBe(404);
  });
});
