import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { reports } from '../modules/ingestion/report.collection';
import { deliverReport, findReportReceipt } from '../modules/ingestion/report.service';
import {
  provisionApplication,
  provisionTenant,
  sampleEnvelope,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * Tenant isolation.
 *
 * PostgreSQL would have made this a property of the database. On MongoDB it is a
 * property of this codebase and of nothing else, so these are the tests standing
 * where Row Level Security would have — and a test that passes against broken
 * isolation would be worse than no test at all, because it would license the
 * belief that the boundary is being checked.
 *
 * Every assertion below is therefore paired with a control that fails if the
 * data it is asserting about was never there. A 404 is only evidence of
 * isolation when the document exists and is reachable without the filter; if the
 * fixture silently stopped being written, the naive test would go on passing.
 */

const app = createApp();
/** Two applications under DIFFERENT organizations. */
let alpha: ProvisionedTenant;
let beta: ProvisionedTenant;
/**
 * A second application under ALPHA'S OWN organization.
 *
 * This is the fixture that makes the file mean anything. With only alpha and
 * beta, a filter that scoped by `organizationId` and forgot `applicationId`
 * passed every assertion here — verified by mutation, not assumed — because two
 * separate customers are isolated by their organization alone. One customer's
 * two products are not, and that is the realistic shape: a staging application
 * and a production one, or a private product and a public one, under one
 * account.
 */
let alphaSibling: ProvisionedTenant;
let alphaReportId: string;

beforeAll(async () => {
  await startDatabase();
  [alpha, beta] = await Promise.all([provisionTenant(), provisionTenant()]);
  alphaSibling = await provisionApplication(alpha.organizationId);

  const delivered = await deliverReport(alpha.tenant, {
    externalReportId: 'shared-external-id',
    idempotencyKey: `alpha-${Date.now()}`,
    envelope: sampleEnvelope('alpha private material'),
  });
  alphaReportId = delivered.reportId;
});

afterAll(async () => {
  await stopDatabase();
});

describe('a credential from one tenant cannot reach another tenant', () => {
  /**
   * The control for every assertion in this file.
   *
   * It reads the same document straight off the driver, with no tenant filter —
   * which is precisely what a forgotten filter looks like. If this ever stops
   * finding the document, the 404s below have stopped proving anything and this
   * test says so instead of letting them pass quietly.
   */
  it('control: the document exists and is reachable when the tenant filter is absent', async () => {
    const unfiltered = await mongoose.connection
      .collection('reports')
      .findOne({ reportId: alphaReportId });

    expect(unfiltered).not.toBeNull();
    expect(unfiltered?.applicationId).toBe(alpha.applicationId);
  });

  it('answers 404 across organizations over HTTP', async () => {
    const asAlpha = await request(app)
      .get(`/v1/reports/${alphaReportId}`)
      .set('Authorization', `Bearer ${alpha.token}`);
    const asBeta = await request(app)
      .get(`/v1/reports/${alphaReportId}`)
      .set('Authorization', `Bearer ${beta.token}`);

    // Owner sees it, so the 404 below is the filter and not a missing document.
    expect(asAlpha.status).toBe(200);
    expect(asBeta.status).toBe(404);
    expect(asBeta.body.error.code).toBe('not_found');
  });

  it('answers 404 between two applications of the SAME organization', async () => {
    const asSibling = await request(app)
      .get(`/v1/reports/${alphaReportId}`)
      .set('Authorization', `Bearer ${alphaSibling.token}`);

    expect(alphaSibling.organizationId).toBe(alpha.organizationId);
    expect(alphaSibling.applicationId).not.toBe(alpha.applicationId);
    expect(asSibling.status).toBe(404);
  });

  it('returns null from the service layer for another tenant id', async () => {
    expect(await findReportReceipt(alpha.tenant, alphaReportId)).not.toBeNull();
    expect(await findReportReceipt(beta.tenant, alphaReportId)).toBeNull();
    expect(await findReportReceipt(alphaSibling.tenant, alphaReportId)).toBeNull();
  });

  it('scopes a collection read to the calling application, not merely its organization', async () => {
    expect(await reports.findOne(alpha.tenant, { reportId: alphaReportId })).not.toBeNull();
    expect(await reports.findOne(beta.tenant, { reportId: alphaReportId })).toBeNull();
    expect(await reports.findOne(alphaSibling.tenant, { reportId: alphaReportId })).toBeNull();
    expect(await reports.countDocuments(beta.tenant, { reportId: alphaReportId })).toBe(0);
    expect(await reports.countDocuments(alphaSibling.tenant, { reportId: alphaReportId })).toBe(0);
  });
});

describe('applicationId comes from the credential', () => {
  /**
   * §12.9 and §13.2: a tenant id the caller can choose is not isolation. The
   * request below names another tenant every way a body can, and every one of
   * them is ignored.
   */
  it('ignores a tenant named in the request body', async () => {
    const externalReportId = `body-spoof-${Date.now()}`;
    const response = await request(app)
      .post('/v1/reports')
      .set('Authorization', `Bearer ${beta.token}`)
      .set('Idempotency-Key', externalReportId)
      .send({
        externalReportId,
        applicationId: alpha.applicationId,
        organizationId: alpha.organizationId,
        envelope: { ...sampleEnvelope(), applicationId: alpha.applicationId },
      });

    expect(response.status).toBe(202);

    const stored = await mongoose.connection
      .collection('reports')
      .findOne({ reportId: response.body.reportId });

    expect(stored?.applicationId).toBe(beta.applicationId);
    expect(stored?.organizationId).toBe(beta.organizationId);
    // And alpha cannot see it, which is the same statement from the other side.
    expect(await findReportReceipt(alpha.tenant, response.body.reportId)).toBeNull();
  });

  it('rejects a write that tries to supply the tenant keys itself', async () => {
    await expect(
      // The tenant keys are not a parameter a caller may pass. Supplying them is
      // rejected loudly rather than silently corrected, so the belief that a
      // caller picks its tenant surfaces here instead of in production.
      reports.insertOne(beta.tenant, {
        applicationId: alpha.applicationId,
        reportId: 'rpt_00000000000000000000000000000001',
        externalReportId: 'forged',
        idempotencyKey: 'forged',
        payloadHash: 'sha256:0',
        envelope: {},
        status: 'received',
        receivedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(/must not set 'applicationId'/);
  });
});

describe('the idempotency indexes are per application, not global', () => {
  it('lets two tenants use the same externalReportId independently', async () => {
    // Alpha already stored 'shared-external-id' in beforeAll. Beta storing the
    // same value must succeed and must be a different report: a unique index
    // that forgot its tenant prefix would leak one tenant's id space into
    // another's and reject this.
    const betaDelivery = await deliverReport(beta.tenant, {
      externalReportId: 'shared-external-id',
      idempotencyKey: `beta-${Date.now()}`,
      envelope: sampleEnvelope('beta material'),
    });

    expect(betaDelivery.reportId).not.toBe(alphaReportId);
    expect(betaDelivery.replayed).toBe(false);

    const alphaStored = await reports.findOne(alpha.tenant, {
      externalReportId: 'shared-external-id',
    });
    expect(alphaStored?.reportId).toBe(alphaReportId);
  });
});
