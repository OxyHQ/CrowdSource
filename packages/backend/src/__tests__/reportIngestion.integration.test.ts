import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { reports } from '../modules/ingestion/report.collection';
import { issueApplicationCredential } from '../modules/tenancy/provisioning.service';
import {
  deliveryBody,
  provisionTenant,
  sampleEnvelope,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * Phase 1's definition of done (§15.2), and the negatives that make it mean
 * something:
 *
 *   "An integration test creates an organization, an application, a credential
 *    and an idempotent universal report. A second delivery with the same
 *    Idempotency-Key returns the same reportId."
 *
 * Against a real replica set, so the unique indexes of §12.7 and the transaction
 * around the report, its case and their outbox rows are the things actually
 * being tested.
 *
 * Phase 2's own definition of done — two reports, one case, one dedup key — is
 * `caseDeduplication.integration.test.ts`.
 */

const app = createApp();
let tenant: ProvisionedTenant;

beforeAll(async () => {
  await startDatabase();
  tenant = await provisionTenant();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await stopDatabase();
});

function deliver(token: string, idempotencyKey: string, body: unknown) {
  return request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', idempotencyKey)
    .send(body);
}

describe('POST /v1/reports', () => {
  it('stores a report and answers 202 with its id and its case', async () => {
    const response = await deliver(
      tenant.token,
      `key-${Date.now()}-first`,
      deliveryBody(tenant, `mention-report-1-${Date.now()}`, {
        subjectExternalId: `post_first_${Date.now()}`,
      }),
    );

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('received');
    expect(response.body.merged).toBe(false);
    expect(response.body.reportId).toMatch(/^rpt_[0-9a-f]{32}$/);
    // §10.4's response body: the case exists by the time the 202 is written.
    expect(response.body.caseId).toMatch(/^case_[0-9a-f]{32}$/);
  });

  /** The acceptance criterion itself. */
  it('returns the same reportId for a second delivery with the same Idempotency-Key', async () => {
    const externalReportId = `mention-report-idem-${Date.now()}`;
    const key = `mention-report:${externalReportId}`;
    const body = deliveryBody(tenant, externalReportId);

    const first = await deliver(tenant.token, key, body);
    const second = await deliver(tenant.token, key, body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.reportId).toBe(first.body.reportId);
    expect(second.body.caseId).toBe(first.body.caseId);

    // Idempotent means ONE report, not two that happen to answer alike.
    expect(await reports.countDocuments(tenant.tenant, { externalReportId })).toBe(1);
  });

  it('writes the report, triage and audit rows in the same transaction, once', async () => {
    const externalReportId = `outbox-${Date.now()}`;
    const first = await deliver(
      tenant.token,
      `key-${externalReportId}`,
      deliveryBody(tenant, externalReportId, { subjectExternalId: `post_${externalReportId}` }),
    );
    // A retry must not append a second event either: the queue is a hint, and a
    // duplicated hint means a duplicated case downstream.
    await deliver(
      tenant.token,
      `key-${externalReportId}`,
      deliveryBody(tenant, externalReportId, { subjectExternalId: `post_${externalReportId}` }),
    );

    const events = await mongoose.connection
      .collection('outbox_events')
      .find({ 'payload.reportId': first.body.reportId })
      .toArray();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'report.received',
      applicationId: tenant.applicationId,
      organizationId: tenant.organizationId,
    });

    // The case's own trigger, written in the same transaction as the report.
    const triageEvents = await mongoose.connection
      .collection('outbox_events')
      .find({ type: 'case.ready_for_triage', 'payload.caseId': first.body.caseId })
      .toArray();
    expect(triageEvents).toHaveLength(1);

    // §15.3 asks for an audit trail of ingress. One accepted report, one row.
    const audits = await mongoose.connection
      .collection('audit_events')
      .find({ reportId: first.body.reportId, action: 'report.ingress.accepted' })
      .toArray();
    expect(audits).toHaveLength(1);
  });

  it('recognises the same content re-sent under a fresh Idempotency-Key', async () => {
    const externalReportId = `same-content-${Date.now()}`;
    const body = deliveryBody(tenant, externalReportId);

    const first = await deliver(tenant.token, `key-a-${externalReportId}`, body);
    const second = await deliver(tenant.token, `key-b-${externalReportId}`, body);

    expect(second.status).toBe(202);
    expect(second.body.reportId).toBe(first.body.reportId);
  });

  it('is insensitive to the key order the client happened to send', async () => {
    const externalReportId = `key-order-${Date.now()}`;
    const key = `key-order-${externalReportId}`;
    const { envelope } = deliveryBody(tenant, externalReportId);

    const first = await deliver(tenant.token, key, { externalReportId, envelope });
    const second = await deliver(tenant.token, key, {
      envelope: Object.fromEntries(Object.entries(envelope).reverse()),
      externalReportId,
    });

    expect(second.status).toBe(202);
    expect(second.body.reportId).toBe(first.body.reportId);
  });

  it('answers 409 when an externalReportId is reused with different content', async () => {
    const externalReportId = `conflict-${Date.now()}`;
    const original = deliveryBody(tenant, externalReportId, { text: 'original text' });

    const first = await deliver(tenant.token, `key-1-${externalReportId}`, original);
    const second = await deliver(
      tenant.token,
      `key-2-${externalReportId}`,
      deliveryBody(tenant, externalReportId, { text: 'quietly different text' }),
    );

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
    expect(second.body.error.message).toContain(externalReportId);

    // The stored evidence is the FIRST delivery's, unchanged.
    const stored = await reports.findOne(tenant.tenant, { externalReportId });
    expect(stored?.reportId).toBe(first.body.reportId);
    expect(stored?.envelope).toMatchObject(original.envelope);

    // And the refusal is on the record (§15.3).
    const refusals = await mongoose.connection
      .collection('audit_events')
      .find({ externalReportId, action: 'report.ingress.rejected' })
      .toArray();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ reason: 'payload_conflict' });
  });

  it('answers 409 when an Idempotency-Key is reused for a different payload', async () => {
    const key = `reused-key-${Date.now()}`;

    await deliver(tenant.token, key, deliveryBody(tenant, `reuse-a-${Date.now()}`));
    const second = await deliver(tenant.token, key, deliveryBody(tenant, `reuse-b-${Date.now()}`));

    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain('Idempotency-Key');
  });

  it('requires an Idempotency-Key', async () => {
    const response = await request(app)
      .post('/v1/reports')
      .set('Authorization', `Bearer ${tenant.token}`)
      .send(deliveryBody(tenant, 'no-key'));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('rejects a malformed Idempotency-Key rather than storing under it', async () => {
    const response = await deliver(
      tenant.token,
      'has spaces and ünicode',
      deliveryBody(tenant, 'bad-key'),
    );

    expect(response.status).toBe(400);
  });

  it('rejects an envelope that is not a JSON object', async () => {
    const response = await deliver(tenant.token, `not-an-object-${Date.now()}`, {
      externalReportId: 'not-an-object',
      envelope: ['resources'],
    });

    // §7.2 step 2 now parses the envelope against the published contract, so a
    // malformed one is unprocessable (422) rather than merely malformed JSON.
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('unprocessable_envelope');
    expect(response.body.error.message).toContain('envelope');
  });

  it('rejects an envelope missing the fields the contract requires', async () => {
    const response = await deliver(tenant.token, `partial-${Date.now()}`, {
      externalReportId: 'partial',
      envelope: {
        schemaVersion: 'crowdsource.case.v1',
        applicationId: tenant.applicationId,
        externalReportId: 'partial',
        subject: { externalId: 'post_1', type: 'social.post', primaryResourceId: 'res_post' },
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('unprocessable_envelope');
  });

  it('rejects an envelope too deeply nested to process', async () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 200; depth += 1) {
      nested = { nested };
    }

    const response = await deliver(tenant.token, `deep-${Date.now()}`, {
      externalReportId: 'deep',
      envelope: nested,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('unprocessable_envelope');
  });

  /**
   * §7.2 step 7. The scheme is the contract's business; the HOST is this
   * service's, and a literal internal address is decidable without DNS.
   */
  it('rejects a resource URL pointing at an internal address', async () => {
    const externalReportId = `ssrf-${Date.now()}`;
    const response = await deliver(
      tenant.token,
      `key-${externalReportId}`,
      deliveryBody(tenant, externalReportId, {
        resourceUrl: 'http://169.254.169.254/latest/meta-data/',
      }),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain('reserved');
    expect(await reports.countDocuments(tenant.tenant, { externalReportId })).toBe(0);

    const refusals = await mongoose.connection
      .collection('audit_events')
      .find({ externalReportId, action: 'report.ingress.rejected' })
      .toArray();
    expect(refusals[0]).toMatchObject({ reason: 'unsafe_resource_url' });
  });

  /**
   * The envelope carries `applicationId` so a mismatch can be DETECTED. The
   * tenant still comes from the credential — this asserts the disagreement is
   * refused rather than silently rewritten to the caller's own id.
   */
  it('refuses an envelope that names another application', async () => {
    const externalReportId = `impersonation-${Date.now()}`;
    const response = await deliver(tenant.token, `key-${externalReportId}`, {
      externalReportId,
      envelope: sampleEnvelope({
        applicationId: 'app_00000000000000000000000000000000',
        externalReportId,
      }),
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
    expect(await reports.countDocuments(tenant.tenant, { externalReportId })).toBe(0);

    const refusals = await mongoose.connection
      .collection('audit_events')
      .find({ externalReportId, action: 'report.ingress.rejected' })
      .toArray();
    expect(refusals[0]).toMatchObject({ reason: 'application_mismatch' });
  });

  it('refuses an envelope naming a policy version nobody registered', async () => {
    const externalReportId = `no-policy-${Date.now()}`;
    const response = await deliver(
      tenant.token,
      `key-${externalReportId}`,
      deliveryBody(tenant, externalReportId, {
        policy: { policySetId: 'mention.community', version: '2026.07' },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain('mention.community');
    expect(await reports.countDocuments(tenant.tenant, { externalReportId })).toBe(0);
  });

  it('refuses a delivery with no credential', async () => {
    const response = await request(app)
      .post('/v1/reports')
      .set('Idempotency-Key', 'no-credential')
      .send(deliveryBody(tenant, 'anon'));

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Bearer');
  });

  it('refuses a credential that was not granted the write scope', async () => {
    const readOnly = await issueApplicationCredential({
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      scopes: ['crowdsource:reports:read'],
    });

    const response = await deliver(
      readOnly.token,
      `read-only-${Date.now()}`,
      deliveryBody(tenant, 'read-only'),
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });
});

describe('GET /v1/reports/:reportId', () => {
  it('returns a receipt without the stored evidence, and audits the access', async () => {
    const externalReportId = `receipt-${Date.now()}`;
    const created = await deliver(
      tenant.token,
      `key-${externalReportId}`,
      deliveryBody(tenant, externalReportId, {
        text: 'sensitive reported text',
        subjectExternalId: `post_${externalReportId}`,
      }),
    );

    const response = await request(app)
      .get(`/v1/reports/${created.body.reportId}`)
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reportId: created.body.reportId,
      externalReportId,
      caseId: created.body.caseId,
      status: 'received',
    });
    // The application API is not a route back to the evidence it delivered.
    expect(JSON.stringify(response.body)).not.toContain('sensitive reported text');

    const accesses = await mongoose.connection
      .collection('audit_events')
      .find({ reportId: created.body.reportId, action: 'report.receipt.read' })
      .toArray();
    expect(accesses).toHaveLength(1);
  });

  it('answers 404 for an id that does not exist', async () => {
    const response = await request(app)
      .get('/v1/reports/rpt_00000000000000000000000000000000')
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(response.status).toBe(404);
  });

  it('answers 404 for an id that is not one, without querying for it', async () => {
    const response = await request(app)
      .get('/v1/reports/not-a-report-id')
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});

/**
 * The paths a duplicate key can take that are NOT "this is a retry".
 *
 * These are reachable in production but not from a well-behaved client, so they
 * are driven by making the collection behave the way a race would. Left
 * untested, the first time either runs would be the first time anyone finds out
 * whether it answers 503 (retry me) or 500 (something is broken) — and an
 * application's outbox behaves very differently depending on which.
 */
describe('duplicate deliveries that cannot be resolved', () => {
  it('answers 503 when the colliding report cannot be read back', async () => {
    const externalReportId = `vanished-${Date.now()}`;
    const body = deliveryBody(tenant, externalReportId);

    await deliver(tenant.token, `key-${externalReportId}`, body);

    // The insert collides, and the read that should find the original returns
    // nothing — the shape of a report removed between the two, or of a
    // collision against a row this tenant cannot see.
    vi.spyOn(reports, 'findOne').mockResolvedValueOnce(null);

    const response = await deliver(tenant.token, `key2-${externalReportId}`, body);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('service_unavailable');
  });

  /**
   * Two people reporting the same brand-new post in the same instant: both
   * upserts try to insert and one loses. The retry finds the case the winner
   * created — but if every attempt loses, the answer must be "retry", not
   * "something is broken", or the integrator stops retrying a delivery that
   * would succeed.
   */
  it('answers 503 when the case dedup index keeps rejecting the delivery', async () => {
    const { cases } = await import('../modules/cases/case.collection');
    vi.spyOn(cases, 'upsertOne').mockRejectedValue(
      Object.assign(new Error('E11000 duplicate key error'), {
        code: 11000,
        keyPattern: {
          applicationId: 1,
          externalSubjectId: 1,
          contentHash: 1,
          policyVersion: 1,
        },
      }),
    );

    const externalReportId = `contended-${Date.now()}`;
    const response = await deliver(
      tenant.token,
      externalReportId,
      deliveryBody(tenant, externalReportId),
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('service_unavailable');
  });

  it('re-raises a collision on an index it cannot interpret', async () => {
    vi.spyOn(reports, 'insertOne').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error'), {
        code: 11000,
        keyPattern: { someFutureIndex: 1 },
      }),
    );

    const externalReportId = `unknown-index-${Date.now()}`;
    const response = await deliver(
      tenant.token,
      externalReportId,
      deliveryBody(tenant, externalReportId),
    );

    // Not a 409 and not a 202: guessing which stored report the caller meant
    // would be inventing an answer. It surfaces as a defect instead.
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('internal_error');
  });
});
