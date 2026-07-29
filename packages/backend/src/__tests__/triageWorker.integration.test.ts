import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { cases } from '../modules/cases/case.collection';
import { OUTBOX_EVENT_TYPES, type OutboxEventDocument } from '../modules/outbox/outbox.collection';
import { handleCaseReadyForTriage } from '../modules/triage/triage.worker';
import {
  deliveryBody,
  provisionTenant,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * The triage worker, driven directly.
 *
 * The dispatcher is not tenant-scoped — it publishes across every tenant — so
 * feeding this handler through it would couple these assertions to whatever else
 * happens to be on the queue. What is being checked here is the handler's own
 * contract: it is replay-safe, it refuses a row it cannot act on rather than
 * absorbing it, and it never drags a case backwards through its lifecycle.
 */

const app = createApp();
let tenant: ProvisionedTenant;

beforeAll(async () => {
  await startDatabase();
  tenant = await provisionTenant();
});

afterAll(async () => {
  await stopDatabase();
});

function triageEvent(caseId?: string): OutboxEventDocument {
  const now = new Date();
  return {
    eventId: `evt_${Math.random().toString(16).slice(2)}`,
    organizationId: tenant.organizationId,
    applicationId: tenant.applicationId,
    type: OUTBOX_EVENT_TYPES.caseReadyForTriage,
    payload: caseId === undefined ? {} : { caseId },
    status: 'dispatching',
    attempts: 1,
    availableAt: now,
    dispatchedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function openCase(overrides: Parameters<typeof deliveryBody>[2] = {}): Promise<string> {
  const externalReportId = `worker-${Math.random().toString(16).slice(2)}`;
  const response = await request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', externalReportId)
    .send(
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: `post_${externalReportId}`,
        ...overrides,
      }),
    );
  expect(response.status).toBe(202);
  return response.body.caseId;
}

describe('handleCaseReadyForTriage', () => {
  it('triages a new case and moves it out of received', async () => {
    const caseId = await openCase();
    expect((await cases.findOne(tenant.tenant, { caseId }))?.status).toBe('received');

    await handleCaseReadyForTriage(triageEvent(caseId));

    const stored = await cases.findOne(tenant.tenant, { caseId });
    expect(stored?.status).toBe('triaged');
    expect(stored?.reviewPool).toBe('community');
    expect(stored?.sensitivityClass).toBe('standard');
    expect(stored?.triagedAt).not.toBeNull();
  });

  /**
   * At-least-once is the contract of every outbox consumer, so a replay has to
   * be harmless. Triage is a pure function of case state, which is what makes
   * that cheap; what must NOT repeat is the publication.
   */
  it('is safe to replay: the second run changes no lifecycle state', async () => {
    const caseId = await openCase();

    await handleCaseReadyForTriage(triageEvent(caseId));
    const afterFirst = await cases.findOne(tenant.tenant, { caseId });

    await handleCaseReadyForTriage(triageEvent(caseId));
    const afterSecond = await cases.findOne(tenant.tenant, { caseId });

    expect(afterSecond?.status).toBe(afterFirst?.status);
    expect(afterSecond?.priorityScore).toBe(afterFirst?.priorityScore);
    expect(afterSecond?.reviewPool).toBe(afterFirst?.reviewPool);
  });

  it('routes a sensitive case out of the community pool and marks it escalated', async () => {
    const caseId = await openCase({ allegationCode: 'child_safety.exploitation' });

    await handleCaseReadyForTriage(triageEvent(caseId));

    const stored = await cases.findOne(tenant.tenant, { caseId });
    expect(stored?.reviewPool).toBe('legal');
    expect(stored?.sensitivityClass).toBe('prohibited');
    expect(stored?.escalated).toBe(true);
    // §7.5's urgent path leaves the ordinary queue. This is a case STATE, not
    // §9.6's decision outcome of the same name — no jury has seen it.
    expect(stored?.status).toBe('escalated');
  });

  /**
   * A case past triage keeps its lifecycle. A late report merging in still
   * updates the counters, but re-opening the case would invite a second jury on
   * one that already has one — and §9.9 makes a published decision immutable.
   */
  it('refreshes the numbers of an escalated case without regressing its status', async () => {
    const caseId = await openCase({ allegationCode: 'violence.threat' });
    await handleCaseReadyForTriage(triageEvent(caseId));
    expect((await cases.findOne(tenant.tenant, { caseId }))?.status).toBe('escalated');

    await cases.updateOne(tenant.tenant, { caseId }, { set: { priorityScore: 0 } });
    await handleCaseReadyForTriage(triageEvent(caseId));

    const stored = await cases.findOne(tenant.tenant, { caseId });
    expect(stored?.status).toBe('escalated');
    expect(stored?.priorityScore).toBeGreaterThan(0);
  });

  it('leaves a case that has moved past triage entirely alone', async () => {
    const caseId = await openCase();
    await handleCaseReadyForTriage(triageEvent(caseId));
    await cases.updateOne(tenant.tenant, { caseId }, { set: { status: 'under_review' } });

    await handleCaseReadyForTriage(triageEvent(caseId));

    expect((await cases.findOne(tenant.tenant, { caseId }))?.status).toBe('under_review');
  });

  /**
   * Both of these mean a row exists that its domain object does not match, which
   * can only happen if something wrote a row outside a transaction. Absorbing
   * them would hide exactly the failure the outbox exists to make impossible, so
   * they throw and the dispatcher records them.
   */
  it('refuses a row that names no case', async () => {
    await expect(handleCaseReadyForTriage(triageEvent())).rejects.toThrow(/no caseId/);
  });

  it('refuses a row naming a case this tenant does not have', async () => {
    await expect(
      handleCaseReadyForTriage(triageEvent('case_00000000000000000000000000000000')),
    ).rejects.toThrow(/does not exist/);
  });
});
