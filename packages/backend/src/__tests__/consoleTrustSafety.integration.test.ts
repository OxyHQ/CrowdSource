import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubOxySession } from './support/reviewers';

/**
 * The Trust & Safety surface (§4.3, §10.1, §13.2) and the standing gate it controls
 * (§11.13, §16.2).
 *
 * The property this suite exists for: **a valid Oxy session is not staff.** Every Oxy
 * account in existence authenticates; the cross-tenant surface is reachable only with a
 * role on a `trust_safety_staff` row, and there is no route in the service that grants
 * one. So the staff check is asserted from three sides — no row at all, a row with a
 * different role, and a row with the right role — because "403 for a stranger" is
 * equally consistent with a working check and a route that refuses everybody.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { grantMembership } = await import('../modules/console/membership.service');
const { grantStaffRoles, revokeStaff } = await import('../modules/console/staff.service');
const { applicationTrustFor } = await import('../modules/trust/applicationTrust.service');
const { usageCounters, utcDayKey } = await import('../modules/trust/usageCounter.collection');
const { quotaFor } = await import('../modules/trust/quota');
const { newPublicId } = await import('../utils/identifiers');
const { webhookEndpoints } = await import('../modules/webhooks/webhook.collections');
const { cases } = await import('../modules/cases/case.collection');
const { staffAuditEvents } = await import('../modules/console/staffAudit.collection');
const { deliveryBody, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);

const app = createApp();

function asUser(oxyUserId: string): Record<string, string> {
  return { 'x-test-oxy-user': oxyUserId };
}

function newOxyUserId(): string {
  return `oxy_staff_${randomUUID().replace(/-/g, '')}`;
}

async function staffWith(...roles: readonly ('policy' | 'appeals' | 'evidence' | 'security')[]) {
  const oxyUserId = newOxyUserId();
  await grantStaffRoles(oxyUserId, roles);
  return oxyUserId;
}

/** Every route on the Trust & Safety router, so the guard is asserted on all of them. */
const STAFF_READS = [
  '/v1/trust-safety/applications',
  '/v1/trust-safety/deliveries/dead-letter',
  '/v1/trust-safety/metrics',
  '/v1/trust-safety/escalated',
] as const;

beforeAll(async () => {
  await startDatabase();
}, 120_000);

afterAll(async () => {
  await stopDatabase();
});

describe('the staff check', () => {
  it('refuses a perfectly valid Oxy session with no staff row', async () => {
    const stranger = newOxyUserId();

    for (const path of STAFF_READS) {
      const refused = await request(app).get(path).set(asUser(stranger));
      expect(refused.status, path).toBe(403);
      expect(refused.body.error.code, path).toBe('forbidden');
    }
  });

  it('refuses with no session at all, before the role is even considered', async () => {
    for (const path of STAFF_READS) {
      const refused = await request(app).get(path);
      // 401, not 403: the session is what is missing, and answering 403 would tell an
      // anonymous caller that authentication succeeded.
      expect(refused.status, path).toBe(401);
    }
  });

  it('refuses a service credential, which is the wrong caller class entirely', async () => {
    const tenant = await provisionTenant();

    for (const path of STAFF_READS) {
      const refused = await request(app)
        .get(path)
        .set('authorization', `Bearer ${tenant.token}`);
      expect(refused.status, path).toBe(401);
    }
  });

  it('accepts a staff row, so the refusals above are about authority', async () => {
    const operator = await staffWith('security');

    for (const path of STAFF_READS) {
      const allowed = await request(app).get(path).set(asUser(operator));
      expect(allowed.status, path).toBe(200);
    }
  });

  it('distinguishes the four roles rather than treating any row as staff (§13.2)', async () => {
    const evidence = await staffWith('evidence');
    const security = await staffWith('security');
    const tenant = await provisionTenant();
    const path = `/v1/trust-safety/applications/${tenant.applicationId}/standing`;
    const body = { standing: 'trusted', reason: 'promotion_review_passed' };

    // An `evidence` operator is real staff and still cannot move a standing: §11.13
    // puts a technical review behind promotion, and the person who opens sensitive
    // material is not the person who signs that off.
    const refused = await request(app).post(path).set(asUser(evidence)).send(body);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain('security');

    const allowed = await request(app).post(path).set(asUser(security)).send(body);
    expect(allowed.status).toBe(200);
  });

  it('stops at revocation', async () => {
    const operator = await staffWith('security');
    expect(
      (await request(app).get('/v1/trust-safety/metrics').set(asUser(operator))).status,
    ).toBe(200);

    await revokeStaff(operator);

    expect(
      (await request(app).get('/v1/trust-safety/metrics').set(asUser(operator))).status,
    ).toBe(403);
  });

  it('is not reachable through the developer console, and vice versa', async () => {
    const tenant = await provisionTenant();
    const operator = await staffWith('security');

    /**
     * Staff authority is NOT tenant authority. An operator who can see every
     * application's standing still has no seat in this organization, so the developer
     * console answers 404 — the surfaces are separate on purpose, and an operator who
     * needs a tenant's own console has to be given a seat like anybody else.
     */
    const refused = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}`)
      .set(asUser(operator));
    expect(refused.status).toBe(404);

    // And the reverse: a member with the largest possible seat is not staff.
    const owner = newOxyUserId();
    await grantMembership({
      organizationId: tenant.organizationId,
      oxyUserId: owner,
      role: 'owner',
      invitedByOxyUserId: 'oxy_test_root',
    });
    // Every cross-tenant route, not a representative one: the escalated queue is the one
    // that returns other tenants' case metadata, so a developer reaching it would be the
    // audience split failing on the surface where it matters most.
    for (const path of STAFF_READS) {
      const alsoRefused = await request(app).get(path).set(asUser(owner));
      expect(alsoRefused.status, `${path} for an organization owner`).toBe(403);
    }
  });

  it('reports its own roles on the session, for navigation only', async () => {
    const operator = await staffWith('policy', 'appeals');

    const session = await request(app).get('/v1/console/session').set(asUser(operator));
    expect(session.status).toBe(200);
    expect([...session.body.staffRoles].sort()).toEqual(['appeals', 'policy']);

    // The list is a courtesy for the interface and never the boundary: this operator
    // holds neither `security` nor a seat, and the write route refuses anyway.
    const refused = await request(app)
      .post(`/v1/trust-safety/applications/app_${'0'.repeat(32)}/standing`)
      .set(asUser(operator))
      .send({ standing: 'trusted', reason: 'promotion_review_passed' });
    expect(refused.status).toBe(403);
  });
});

describe('standing changes', () => {
  it('promotes an application and grants global effects with the promotion', async () => {
    const tenant = await provisionTenant();
    const security = await staffWith('security');

    const before = await applicationTrustFor(tenant.tenant);
    expect(before.standing).toBe('sandbox');
    expect(before.globalReputationEffectsAllowed).toBe(false);

    const promoted = await request(app)
      .post(`/v1/trust-safety/applications/${tenant.applicationId}/standing`)
      .set(asUser(security))
      .send({ standing: 'trusted', reason: 'promotion_review_passed' });

    expect(promoted.status).toBe(200);
    expect(promoted.body.standing).toBe('trusted');
    expect(promoted.body.globalReputationEffectsAllowed).toBe(true);
    // Who did it, taken from the authenticated staff row rather than from the body.
    expect(promoted.body.standingChangedByOxyUserId).toBe(security);
    expect(promoted.body.lastStandingReason).toBe('promotion_review_passed');
  });

  it('lets an operator withhold global effects at a standing that permits them', async () => {
    const tenant = await provisionTenant();
    const security = await staffWith('security');

    const promoted = await request(app)
      .post(`/v1/trust-safety/applications/${tenant.applicationId}/standing`)
      .set(asUser(security))
      .send({
        standing: 'trusted',
        reason: 'promotion_review_passed',
        globalReputationEffectsAllowed: false,
      });

    expect(promoted.status).toBe(200);
    expect(promoted.body.standing).toBe('trusted');
    expect(promoted.body.globalReputationEffectsAllowed).toBe(false);
  });

  it('never grants global effects beyond what the standing allows (§16.2)', async () => {
    const tenant = await provisionTenant();
    const security = await staffWith('security');

    // Asking for the power at a sandbox standing. The request is accepted — the
    // standing change is legitimate — and the flag is not granted, because the table
    // and not the request decides.
    const attempted = await request(app)
      .post(`/v1/trust-safety/applications/${tenant.applicationId}/standing`)
      .set(asUser(security))
      .send({
        standing: 'sandbox',
        reason: 'investigation_closed',
        globalReputationEffectsAllowed: true,
      });

    expect(attempted.status).toBe(200);
    expect(attempted.body.globalReputationEffectsAllowed).toBe(false);
    expect((await applicationTrustFor(tenant.tenant)).globalReputationEffectsAllowed).toBe(
      false,
    );
  });

  it('refuses a reason outside the closed vocabulary', async () => {
    const tenant = await provisionTenant();
    const security = await staffWith('security');

    // Free text next to a case is where a fragment of reported material lands, and this
    // row is kept indefinitely.
    const refused = await request(app)
      .post(`/v1/trust-safety/applications/${tenant.applicationId}/standing`)
      .set(asUser(security))
      .send({ standing: 'restricted', reason: 'because the CEO said so' });

    expect(refused.status).toBe(400);
  });

  it('lists standing across tenants, which is the point of the surface', async () => {
    const first = await provisionTenant();
    const second = await provisionTenant();
    const security = await staffWith('security');

    await request(app)
      .post(`/v1/trust-safety/applications/${first.applicationId}/standing`)
      .set(asUser(security))
      .send({ standing: 'restricted', reason: 'suspected_abuse' });

    const restricted = await request(app)
      .get('/v1/trust-safety/applications?standing=restricted')
      .set(asUser(security));

    expect(restricted.status).toBe(200);
    const ids = restricted.body.applications.map((row: { applicationId: string }) =>
      row.applicationId,
    );
    expect(ids).toContain(first.applicationId);
    expect(ids).not.toContain(second.applicationId);

    // Quality signals nothing measures yet come back null rather than as a fabricated
    // score an operator would act on.
    const row = restricted.body.applications.find(
      (candidate: { applicationId: string }) => candidate.applicationId === first.applicationId,
    );
    expect(row.evidenceIntegrity).toBeNull();
    expect(row.identityBindingReliability).toBeNull();
    expect(row.policyQuality).toBeNull();
  });

  it('refuses a standing filter it does not recognise', async () => {
    const security = await staffWith('security');
    const refused = await request(app)
      .get('/v1/trust-safety/applications?standing=whatever')
      .set(asUser(security));
    expect(refused.status).toBe(400);
  });

  it('serves §16.4 as scalars, and still names what it cannot compute', async () => {
    const operator = await staffWith('policy');
    const metrics = await request(app).get('/v1/trust-safety/metrics').set(asUser(operator));

    expect(metrics.status).toBe(200);
    expect(metrics.body.applicationsByStanding.sandbox).toBeGreaterThanOrEqual(0);
    // Counts per lifecycle state and per outcome — scalars, so there is no document for
    // this response to leak however the deployment's data changes underneath it.
    expect(typeof metrics.body.casesByStatus.decided).toBe('number');
    expect(typeof metrics.body.decisionsByOutcome.inconclusive).toBe('number');
    expect(typeof metrics.body.decisionsByOutcome.no_violation).toBe('number');
    expect(typeof metrics.body.reviews.reviewsSubmitted).toBe('number');

    /**
     * `inconclusive` is counted on its own axis and never folded into `no_violation`.
     * Asserting both keys exist separately is what stops a future "simplification" of
     * this response from collapsing the two — which is the invariant the product refuses
     * to break, and a metric is exactly where it would erode first.
     */
    expect(Object.keys(metrics.body.decisionsByOutcome)).toContain('inconclusive');
    expect(Object.keys(metrics.body.decisionsByOutcome)).toContain('no_violation');

    // What remains genuinely uncomputable, named rather than served as zero. Appeals are
    // not built, so the rates derived from a second decision revision cannot exist yet.
    expect(metrics.body.unavailable).toContain('overturn_rate');
    expect(metrics.body.unavailable).toContain('appeal_rate');
    expect(metrics.body.unavailable).not.toContain('inconclusive_rate');
  });

  it('serves the escalated queue across tenants, with triage fields and nothing else', async () => {
    const first = await provisionTenant();
    const second = await provisionTenant();
    const operator = await staffWith('appeals');

    // An escalated case in each of two different tenants. The point of the surface is that
    // ONE read returns both, which no tenant-scoped query can do.
    for (const tenant of [first, second]) {
      const delivered = await request(app)
        .post('/v1/reports')
        .set('authorization', `Bearer ${tenant.token}`)
        .set('idempotency-key', `escalated-${randomUUID()}`)
        .send(
          deliveryBody(tenant, `escalated-report-${randomUUID()}`, {
            text: 'material that must never appear in a cross-tenant read',
            language: 'da',
          }),
        );
      expect(delivered.status).toBe(202);
      await cases.updateOne(
        tenant.tenant,
        { caseId: delivered.body.caseId },
        { set: { escalated: true, status: 'escalated', sensitivityClass: 'high', reviewPool: 'specialist' } },
      );
    }

    const queue = await request(app).get('/v1/trust-safety/escalated').set(asUser(operator));
    expect(queue.status).toBe(200);

    const applicationIds = queue.body.cases.map((row: { applicationId: string }) => row.applicationId);
    expect(applicationIds).toContain(first.applicationId);
    expect(applicationIds).toContain(second.applicationId);

    /**
     * The projection is baked into the named query, so this asserts what the QUERY returns
     * rather than what the handler remembered to strip. A cross-tenant read of `cases` is a
     * privacy boundary before it is a tenancy one: the documents carry reported material.
     */
    const serialised = JSON.stringify(queue.body);
    expect(serialised).not.toContain('material that must never appear');
    expect(serialised).not.toContain('contentSnapshot');
    expect(serialised).not.toContain('reporterFingerprints');
    expect(serialised).not.toContain('reviewerId');

    const row = queue.body.cases.find(
      (candidate: { applicationId: string }) => candidate.applicationId === first.applicationId,
    );
    // Triage fields, which a staff operator running the queue genuinely needs — and which
    // are withheld from every tenant-facing view for the opposite reason.
    expect(row.sensitivityClass).toBe('high');
    expect(row.reviewPool).toBe('specialist');
    expect(typeof row.priorityScore).toBe('number');
    expect(row.contentSnapshot).toBeUndefined();
  });

  it('records every staff read, so a cross-tenant look is attributable (§13.1)', async () => {
    const operator = await staffWith('security');

    await request(app).get('/v1/trust-safety/applications').set(asUser(operator));
    await request(app).get('/v1/trust-safety/metrics').set(asUser(operator));
    await request(app).get('/v1/trust-safety/deliveries/dead-letter').set(asUser(operator));

    const trail = await staffAuditEvents.find(
      { actorOxyUserId: operator },
      { sort: { occurredAt: 1 } },
    );
    const actions = trail.map((row) => row.action);
    expect(actions).toContain('staff.applications.read');
    expect(actions).toContain('staff.metrics.read');
    expect(actions).toContain('staff.deadletter.read');

    // The roles held AT THE TIME, copied rather than joined: the question during an
    // investigation is what they were entitled to then, not what they may do now.
    expect(trail[0].roles).toEqual(['security']);
    // Nothing about what was looked at beyond an application id — the trail of who looked
    // at what must not become a second copy of it.
    expect(JSON.stringify(trail)).not.toContain('caseId');
  });

  it('records a standing change against the application it moved', async () => {
    const tenant = await provisionTenant();
    const security = await staffWith('security');

    await request(app)
      .post(`/v1/trust-safety/applications/${tenant.applicationId}/standing`)
      .set(asUser(security))
      .send({ standing: 'restricted', reason: 'suspected_abuse' });

    const trail = await staffAuditEvents.find({
      actorOxyUserId: security,
      action: 'staff.standing.changed',
    });
    expect(trail).toHaveLength(1);
    expect(trail[0].applicationId).toBe(tenant.applicationId);
  });
});

describe('the standing gate on ingestion (§11.13, §13.1)', () => {
  it('stops a restricted application from delivering reports', async () => {
    const tenant = await provisionTenant();
    const security = await staffWith('security');

    // It works first, so the refusal below is the gate and not a broken fixture.
    const accepted = await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${tenant.token}`)
      .set('idempotency-key', `before-restriction-${randomUUID()}`)
      .send(deliveryBody(tenant, `before-restriction-${randomUUID()}`, { language: 'da' }));
    expect(accepted.status).toBe(202);

    await request(app)
      .post(`/v1/trust-safety/applications/${tenant.applicationId}/standing`)
      .set(asUser(security))
      .send({ standing: 'restricted', reason: 'suspected_abuse' });

    const refused = await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${tenant.token}`)
      .set('idempotency-key', `after-restriction-${randomUUID()}`)
      .send(deliveryBody(tenant, `after-restriction-${randomUUID()}`, { language: 'da' }));

    // 403 and not 429: retrying will not help, and §10.5 gives 403 to a capability that
    // is not authorised. An integrator told 429 would retry from its outbox forever.
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain('restricted');
  });

  it('answers 429 when the day\'s quota is spent, so the outbox retries tomorrow', async () => {
    const tenant = await provisionTenant();
    const limit = quotaFor('sandbox').reportsPerDay;

    // A day's traffic, written straight to the meter. Sending 5,000 real reports would
    // test the same branch and take minutes.
    await usageCounters.upsertOne(
      tenant.tenant,
      { day: utcDayKey(new Date()) },
      { inc: { reportsReceived: limit }, set: { updatedAt: new Date() } },
    );

    const refused = await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${tenant.token}`)
      .set('idempotency-key', `over-quota-${randomUUID()}`)
      .send(deliveryBody(tenant, `over-quota-${randomUUID()}`, { language: 'da' }));

    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
  });

  it('counts an accepted report against the day, and a replay only once', async () => {
    const tenant = await provisionTenant();
    const externalReportId = `metered-${randomUUID()}`;
    const body = deliveryBody(tenant, externalReportId, { language: 'da' });

    const first = await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${tenant.token}`)
      .set('idempotency-key', externalReportId)
      .send(body);
    expect(first.status).toBe(202);

    const replay = await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${tenant.token}`)
      .set('idempotency-key', externalReportId)
      .send(body);
    expect(replay.status).toBe(202);

    const counter = await usageCounters.findOne(tenant.tenant, { day: utcDayKey(new Date()) });
    // One, not two. The increment lives inside the transaction that stores the report,
    // and a replay aborts before reaching it — so a correctly-retrying integrator is
    // not billed twice for one report.
    expect(counter?.reportsReceived).toBe(1);
  });

  it('shows the tenant the same figures the gate uses', async () => {
    const tenant = await provisionTenant();
    const oxyUserId = newOxyUserId();
    await grantMembership({
      organizationId: tenant.organizationId,
      oxyUserId,
      role: 'viewer',
      invitedByOxyUserId: 'oxy_test_root',
    });

    await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${tenant.token}`)
      .set('idempotency-key', `usage-view-${randomUUID()}`)
      .send(deliveryBody(tenant, `usage-view-${randomUUID()}`, { language: 'da' }));

    const usage = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/usage`)
      .set(asUser(oxyUserId));

    expect(usage.status).toBe(200);
    expect(usage.body.counts.reportsReceived).toBe(1);
    expect(usage.body.counts.casesCreated).toBe(1);
    expect(usage.body.quota.reportsPerDay).toBe(quotaFor('sandbox').reportsPerDay);
    expect(usage.body.atDailyLimit).toBe(false);
    expect(usage.body.daily[0].reportsReceived).toBe(1);
  });

  /**
   * The endpoint guardrail (§13.1's "aplicación maliciosa" row).
   *
   * What it stops is fan-out amplification: every endpoint multiplies one decision into
   * another outbound request we make on the application's behalf. The limit therefore
   * sits far above ordinary use, and the test fills it by writing rows rather than by
   * registering twenty-five endpoints one transaction at a time.
   */
  it('refuses to register past the endpoint guardrail, and lets an update through', async () => {
    const tenant = await provisionTenant(['crowdsource:webhooks:manage']);
    const limit = quotaFor('sandbox').webhookEndpoints;
    const now = new Date();

    const existingUrl = `https://console-quota-${randomUUID()}.example.com/hooks`;
    for (let index = 0; index < limit; index += 1) {
      await webhookEndpoints.insertOne(tenant.tenant, {
        webhookEndpointId: newPublicId('webhookEndpoint'),
        url: index === 0 ? existingUrl : `https://console-quota-${randomUUID()}.example.com/h`,
        eventTypes: ['case.decided'],
        status: 'active',
        disabledReason: null,
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const refused = await request(app)
      .post('/v1/webhook-endpoints')
      .set('authorization', `Bearer ${tenant.token}`)
      .send({
        url: `https://console-quota-${randomUUID()}.example.com/one-too-many`,
        eventTypes: ['case.decided'],
      });
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain('webhook endpoints');

    /**
     * Re-registering a URL the application already has is exempt, and it has to be: an
     * application at its limit must still be able to change the event types of an
     * endpoint it owns, or the quota would leave a tenant unable to fix the very
     * configuration that filled it.
     */
    const updated = await request(app)
      .post('/v1/webhook-endpoints')
      .set('authorization', `Bearer ${tenant.token}`)
      .send({ url: existingUrl, eventTypes: ['case.closed'] });
    expect(updated.status).toBe(200);
  });

  it('refuses a usage window outside the supported range', async () => {
    const tenant = await provisionTenant();
    const oxyUserId = newOxyUserId();
    await grantMembership({
      organizationId: tenant.organizationId,
      oxyUserId,
      role: 'viewer',
      invitedByOxyUserId: 'oxy_test_root',
    });

    for (const windowDays of ['0', '500', 'ten']) {
      const refused = await request(app)
        .get(`/v1/console/applications/${tenant.applicationId}/usage?windowDays=${windowDays}`)
        .set(asUser(oxyUserId));
      expect(refused.status, windowDays).toBe(400);
    }
  });
});
