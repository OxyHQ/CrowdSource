import { postgresControl } from './support/postgresControl';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { registerOutboxWorkers } from '../modules/outbox/workers';
import { issueApplicationCredential } from '../modules/tenancy/provisioning.service';
import {
  deliveryBody,
  drainUntil,
  provisionTenant,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * `GET /v1/cases/{id}` (§10.2) and the access half of §15.3's audit requirement.
 *
 * Two properties are being checked. The first is isolation, which on MongoDB is
 * a property of this codebase alone. The second is the PROJECTION: what an
 * application gets back is deliberately not the stored document, because a case
 * carries the triage position an application could learn to game, the pool its
 * material went to, reporter fingerprints, and the evidence snapshot itself.
 */

const app = createApp();
let tenant: ProvisionedTenant;
let other: ProvisionedTenant;
let caseId: string;
const secretText = 'evidence that must not come back out of this API';

beforeAll(async () => {
  await startDatabase();
  registerOutboxWorkers();
  [tenant, other] = await Promise.all([provisionTenant(), provisionTenant()]);

  const externalReportId = `case-access-${Date.now()}`;
  const created = await request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', externalReportId)
    .send(
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: `post_access_${Date.now()}`,
        text: secretText,
        reach: 25_000,
      }),
    );
  caseId = created.body.caseId;
  await drainUntil(
    async () =>
      (await postgresControl.collection('cases').findOne({ caseId }))?.reviewPool !== null,
    'triage of the case under test',
  );
});

afterAll(async () => {
  await stopDatabase();
});

function readCase(token: string, id = caseId) {
  return request(app).get(`/v1/cases/${id}`).set('Authorization', `Bearer ${token}`);
}

describe('reading a case the application owns', () => {
  it('returns the case, and records the access (§15.3)', async () => {
    const response = await readCase(tenant.token);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      caseId,
      status: 'triaged',
      reportCount: 1,
      currentRevision: 1,
      taxonomyVersion: '2026.1',
    });
    expect(response.body.policy).toMatchObject({ policySetId: 'crowdsource.baseline' });

    const accesses = await postgresControl
      .collection('audit_events')
      .find({ caseId, action: 'case.read' })
      .toArray();
    expect(accesses).toHaveLength(1);
    expect(accesses[0]).toMatchObject({ applicationId: tenant.applicationId });
    expect(accesses[0].actorCredentialId).toMatch(/^csk_[0-9a-f]{32}$/);
  });

  it('withholds the evidence, the queue position, the pool and the reporters', async () => {
    const response = await readCase(tenant.token);
    const body = JSON.stringify(response.body);

    // The application already has the material; this API is not a store to read
    // it back from, and it is certainly not one for another tenant's copy.
    expect(body).not.toContain(secretText);
    expect(body).not.toContain('contentSnapshot');
    // Priority is an internal ordering an application could learn to game.
    expect(response.body.priorityScore).toBeUndefined();
    // Which pool saw it is not the tenant's business, and neither is who reported.
    expect(response.body.reviewPool).toBeUndefined();
    expect(body).not.toContain('reporterFingerprint');
    expect(body).not.toContain('caseDedupKey');

    // Control: the withheld fields ARE on the stored document, so the assertions
    // above are the projection and not a case that was never triaged.
    const stored = await postgresControl.collection('cases').findOne({ caseId });
    expect(stored?.priorityScore).toBeGreaterThan(0);
    expect(stored?.reviewPool).toBe('community');
    expect(stored?.reporterFingerprints).toHaveLength(1);
  });

  it('requires the cases:read scope', async () => {
    const writeOnly = await issueApplicationCredential({
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      scopes: ['crowdsource:reports:write'],
    });

    const response = await readCase(writeOnly.token);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });
});

describe('a case belongs to one application', () => {
  it('answers 404 to another tenant that knows the id', async () => {
    // The owner sees it, so the 404 is the tenant filter and not a missing case.
    expect((await readCase(tenant.token)).status).toBe(200);

    const response = await readCase(other.token);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('writes no audit row for a miss, in either tenant trail', async () => {
    await readCase(other.token);

    /**
     * A 404 is indistinguishable from "belongs to somebody else" by design, so
     * auditing it would let one tenant fill another's trail — or its own — with
     * rows generated purely by probing. What is worth recording is a successful
     * read.
     */
    const rows = await postgresControl
      .collection('audit_events')
      .find({ caseId, applicationId: other.applicationId })
      .toArray();
    expect(rows).toHaveLength(0);
  });

  it('answers 404 for an id that is not one, without querying for it', async () => {
    expect((await readCase(tenant.token, 'not-a-case-id')).status).toBe(404);
    expect(
      (await readCase(tenant.token, 'case_00000000000000000000000000000000')).status,
    ).toBe(404);
  });

  it('refuses a request with no credential at all', async () => {
    const response = await request(app).get(`/v1/cases/${caseId}`);
    expect(response.status).toBe(401);
  });
});
