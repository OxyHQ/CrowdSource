import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { reports } from '../modules/ingestion/report.collection';
import { issueApplicationCredential } from '../modules/tenancy/provisioning.service';
import {
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
 * around the report and its outbox row are the things actually being tested.
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
  it('stores a report and answers 202 with its id', async () => {
    const response = await deliver(tenant.token, `key-${Date.now()}-first`, {
      externalReportId: 'mention-report-1',
      envelope: sampleEnvelope(),
    });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('received');
    expect(response.body.reportId).toMatch(/^rpt_[0-9a-f]{32}$/);
  });

  /** The acceptance criterion itself. */
  it('returns the same reportId for a second delivery with the same Idempotency-Key', async () => {
    const key = `mention-report:${Date.now()}-idem`;
    const body = { externalReportId: 'mention-report-idem', envelope: sampleEnvelope() };

    const first = await deliver(tenant.token, key, body);
    const second = await deliver(tenant.token, key, body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.reportId).toBe(first.body.reportId);

    // Idempotent means ONE report, not two that happen to answer alike.
    expect(
      await reports.countDocuments(tenant.tenant, { externalReportId: 'mention-report-idem' }),
    ).toBe(1);
  });

  it('writes exactly one outbox event with the report, in the same transaction', async () => {
    const externalReportId = `outbox-${Date.now()}`;
    const first = await deliver(tenant.token, `key-${externalReportId}`, {
      externalReportId,
      envelope: sampleEnvelope(),
    });
    // A retry must not append a second event either: the queue is a hint, and a
    // duplicated hint means a duplicated case downstream.
    await deliver(tenant.token, `key-${externalReportId}`, {
      externalReportId,
      envelope: sampleEnvelope(),
    });

    const events = await mongoose.connection
      .collection('outbox_events')
      .find({ 'payload.reportId': first.body.reportId })
      .toArray();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'report.received',
      status: 'pending',
      attempts: 0,
      applicationId: tenant.applicationId,
      organizationId: tenant.organizationId,
    });
  });

  it('recognises the same content re-sent under a fresh Idempotency-Key', async () => {
    const externalReportId = `same-content-${Date.now()}`;
    const body = { externalReportId, envelope: sampleEnvelope() };

    const first = await deliver(tenant.token, `key-a-${externalReportId}`, body);
    const second = await deliver(tenant.token, `key-b-${externalReportId}`, body);

    expect(second.status).toBe(202);
    expect(second.body.reportId).toBe(first.body.reportId);
  });

  it('is insensitive to the key order the client happened to send', async () => {
    const externalReportId = `key-order-${Date.now()}`;
    const key = `key-order-${externalReportId}`;

    const first = await deliver(tenant.token, key, {
      externalReportId,
      envelope: { schemaVersion: 'crowdsource.case.v1', subject: { externalId: 'p1', type: 't' } },
    });
    const second = await deliver(tenant.token, key, {
      envelope: { subject: { type: 't', externalId: 'p1' }, schemaVersion: 'crowdsource.case.v1' },
      externalReportId,
    });

    expect(second.status).toBe(202);
    expect(second.body.reportId).toBe(first.body.reportId);
  });

  it('answers 409 when an externalReportId is reused with different content', async () => {
    const externalReportId = `conflict-${Date.now()}`;

    const first = await deliver(tenant.token, `key-1-${externalReportId}`, {
      externalReportId,
      envelope: sampleEnvelope('original text'),
    });
    const second = await deliver(tenant.token, `key-2-${externalReportId}`, {
      externalReportId,
      envelope: sampleEnvelope('quietly different text'),
    });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
    expect(second.body.error.message).toContain(externalReportId);

    // The stored evidence is the FIRST delivery's, unchanged.
    const stored = await reports.findOne(tenant.tenant, { externalReportId });
    expect(stored?.reportId).toBe(first.body.reportId);
    expect(stored?.envelope).toMatchObject(sampleEnvelope('original text'));
  });

  it('answers 409 when an Idempotency-Key is reused for a different payload', async () => {
    const key = `reused-key-${Date.now()}`;

    await deliver(tenant.token, key, {
      externalReportId: `reuse-a-${Date.now()}`,
      envelope: sampleEnvelope(),
    });
    const second = await deliver(tenant.token, key, {
      externalReportId: `reuse-b-${Date.now()}`,
      envelope: sampleEnvelope(),
    });

    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain('Idempotency-Key');
  });

  it('requires an Idempotency-Key', async () => {
    const response = await request(app)
      .post('/v1/reports')
      .set('Authorization', `Bearer ${tenant.token}`)
      .send({ externalReportId: 'no-key', envelope: sampleEnvelope() });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('rejects a malformed Idempotency-Key rather than storing under it', async () => {
    const response = await deliver(tenant.token, 'has spaces and ünicode', {
      externalReportId: 'bad-key',
      envelope: sampleEnvelope(),
    });

    expect(response.status).toBe(400);
  });

  it('rejects an envelope that is not a JSON object', async () => {
    const response = await deliver(tenant.token, `not-an-object-${Date.now()}`, {
      externalReportId: 'not-an-object',
      envelope: ['resources'],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('envelope');
  });

  it('rejects an envelope too deeply nested to fingerprint', async () => {
    let envelope: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 200; depth += 1) {
      envelope = { nested: envelope };
    }

    const response = await deliver(tenant.token, `deep-${Date.now()}`, {
      externalReportId: 'deep',
      envelope,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('unprocessable_envelope');
  });

  it('refuses a delivery with no credential', async () => {
    const response = await request(app)
      .post('/v1/reports')
      .set('Idempotency-Key', 'no-credential')
      .send({ externalReportId: 'anon', envelope: sampleEnvelope() });

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Bearer');
  });

  it('refuses a credential that was not granted the write scope', async () => {
    const readOnly = await issueApplicationCredential({
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      scopes: ['crowdsource:reports:read'],
    });

    const response = await deliver(readOnly.token, `read-only-${Date.now()}`, {
      externalReportId: 'read-only',
      envelope: sampleEnvelope(),
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });
});

describe('GET /v1/reports/:reportId', () => {
  it('returns a receipt without the stored evidence', async () => {
    const externalReportId = `receipt-${Date.now()}`;
    const created = await deliver(tenant.token, `key-${externalReportId}`, {
      externalReportId,
      envelope: sampleEnvelope('sensitive reported text'),
    });

    const response = await request(app)
      .get(`/v1/reports/${created.body.reportId}`)
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reportId: created.body.reportId,
      externalReportId,
      status: 'received',
    });
    // The application API is not a route back to the evidence it delivered.
    expect(JSON.stringify(response.body)).not.toContain('sensitive reported text');
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
    const body = { externalReportId, envelope: sampleEnvelope() };

    await deliver(tenant.token, `key-${externalReportId}`, body);

    // The insert collides, and the read that should find the original returns
    // nothing — the shape of a report removed between the two, or of a
    // collision against a row this tenant cannot see.
    vi.spyOn(reports, 'findOne').mockResolvedValueOnce(null);

    const response = await deliver(tenant.token, `key2-${externalReportId}`, body);

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

    const response = await deliver(tenant.token, `unknown-index-${Date.now()}`, {
      externalReportId: `unknown-index-${Date.now()}`,
      envelope: sampleEnvelope(),
    });

    // Not a 409 and not a 202: guessing which stored report the caller meant
    // would be inventing an answer. It surfaces as a defect instead.
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('internal_error');
  });
});
