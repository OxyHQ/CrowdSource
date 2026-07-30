import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { cases, caseReports } from '../modules/cases/case.collection';
import { reports } from '../modules/ingestion/report.collection';
import { registerOutboxWorkers } from '../modules/outbox/workers';
import {
  deliveryBody,
  drainUntil,
  provisionTenant,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * Phase 2's definition of done (§15.3), stated verbatim:
 *
 *   "Two users report the same version of a post. CrowdSource creates two
 *    reports, one case and a single deduplication key, preserves the snapshot,
 *    and publishes `case.ready_for_review`."
 *
 * Every clause of that sentence is a separate assertion below, and each is
 * paired with the negative that gives it meaning. "One case" only means
 * something next to "a changed version makes a NEW case"; without the second,
 * a service that merged everything into one case would pass the first.
 *
 * Against the real replica set, because the thing being tested IS the unique
 * compound index of §12.7 and the transaction around it. A mocked driver would
 * agree with any claim made here.
 */

const app = createApp();
let tenant: ProvisionedTenant;

beforeAll(async () => {
  await startDatabase();
  registerOutboxWorkers();
  tenant = await provisionTenant();
});

afterAll(async () => {
  await stopDatabase();
});

function deliver(externalReportId: string, body: object) {
  return request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', `key-${externalReportId}`)
    .send(body);
}

describe('two people report the same version of a post', () => {
  const subjectExternalId = `post_dod_${Date.now()}`;
  const text = 'The exact text that was reported';
  let first: request.Response;
  let second: request.Response;

  beforeAll(async () => {
    /**
     * Two DIFFERENT reports by two DIFFERENT reporters about the same material:
     * different `externalReportId`, different reporter identity, and — because
     * every report carries its own submission — everything else the two would
     * differ in. What they share is the content, which is the only thing the
     * dedup key may be derived from.
     */
    first = await deliver(
      `dod-a-${Date.now()}`,
      deliveryBody(tenant, `dod-a-${Date.now()}`, {
        subjectExternalId,
        text,
        reporterExternalId: 'reporter_alice',
      }),
    );
    second = await deliver(
      `dod-b-${Date.now()}`,
      deliveryBody(tenant, `dod-b-${Date.now()}`, {
        subjectExternalId,
        text,
        reporterExternalId: 'reporter_bob',
        allegationCode: 'integrity.spam',
      }),
    );
  });

  it('creates two reports', async () => {
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.reportId).not.toBe(first.body.reportId);

    const stored = await caseReports.find(tenant.tenant, { caseId: first.body.caseId });
    expect(stored.map((link) => link.reportId).sort()).toEqual(
      [first.body.reportId, second.body.reportId].sort(),
    );
  });

  it('creates ONE case, and the second report is marked merged', async () => {
    expect(second.body.caseId).toBe(first.body.caseId);
    expect(first.body.merged).toBe(false);
    expect(second.body.merged).toBe(true);
    expect(first.body.status).toBe('received');
    expect(second.body.status).toBe('merged');

    expect(await cases.countDocuments(tenant.tenant, { externalSubjectId: subjectExternalId })).toBe(
      1,
    );
  });

  it('keeps a single deduplication key, and counts two distinct reporters', async () => {
    const stored = await cases.findOne(tenant.tenant, { caseId: first.body.caseId });

    expect(stored?.caseDedupKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stored?.reportCount).toBe(2);
    // Two reporters, two fingerprints. One person filing twice would be one.
    expect(stored?.reporterFingerprints).toHaveLength(2);
    // Both allegations are on the case, as claims — never as findings (§6.2).
    expect(stored?.allegationCodes.sort()).toEqual(
      ['harassment.targeted_abuse', 'integrity.spam'].sort(),
    );

    // The key is unique for this tuple across the whole collection, read
    // straight off the driver so the tenant filter is not what is producing the
    // "one".
    const withKey = await mongoose.connection
      .collection('cases')
      .countDocuments({ caseDedupKey: stored?.caseDedupKey });
    expect(withKey).toBe(1);
  });

  it('preserves the snapshot of the exact material that was reported (§5.6)', async () => {
    const stored = await cases.findOne(tenant.tenant, { caseId: first.body.caseId });
    const snapshot = stored?.contentSnapshot;

    expect(snapshot?.subject.externalId).toBe(subjectExternalId);
    expect(snapshot?.resources).toHaveLength(1);
    const resource = snapshot?.resources[0];
    expect(resource?.type === 'text' ? resource.data.text : null).toBe(text);

    /**
     * And the snapshot carries nothing about who reported it or what they
     * alleged. If it did, the two reporters' envelopes would hash differently
     * and this case would be two cases.
     */
    expect(JSON.stringify(snapshot)).not.toContain('reporter_alice');
    expect(JSON.stringify(snapshot)).not.toContain('integrity.spam');
  });

  it('publishes case.ready_for_review — exactly once', async () => {
    await drainUntil(
      async () =>
        (await mongoose.connection
          .collection('outbox_events')
          .countDocuments({
            type: 'case.ready_for_review',
            'payload.caseId': first.body.caseId,
            status: 'dispatched',
          })) === 1,
      'sortition consuming case.ready_for_review',
    );

    const published = await mongoose.connection
      .collection('outbox_events')
      .find({ type: 'case.ready_for_review', 'payload.caseId': first.body.caseId })
      .toArray();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      applicationId: tenant.applicationId,
      organizationId: tenant.organizationId,
    });
    /**
     * Dispatched, because sortition now consumes it (§15.4). The row was pending
     * until that consumer existed, and the property that mattered then still
     * matters: nothing marks a row done without a handler having run. What
     * changed is that one has.
     *
     * It does NOT follow that a panel opened. This tenant's case alleges
     * `integrity.spam` and no reviewer in the suite accepts that family, so the
     * draw refused and recorded why — see `sortitionPanel.integration.test.ts`.
     * That is exactly the intended behaviour for an empty pool, and it is why
     * the case below is still `triaged`.
     */
    expect(published[0]).toMatchObject({ status: 'dispatched' });

    // Triage ran, and put a priority and a route on the case. Sortition then
    // found nobody eligible and refused, which leaves the status where triage
    // put it rather than opening a panel that could only expire.
    const stored = await cases.findOne(tenant.tenant, { caseId: first.body.caseId });
    expect(stored?.status).toBe('triaged');
    expect(stored?.reviewPool).toBe('community');
    expect(stored?.priorityScore).toBeGreaterThan(0);
    expect(stored?.triagedAt).not.toBeNull();
  });
});

/**
 * The negatives. Each one is a way the merge above could be wrong, and each
 * would still let the acceptance test pass on its own.
 */
describe('what must NOT merge', () => {
  it('opens a NEW case when the content changes (§5.6: an edit changes the hash)', async () => {
    const subjectExternalId = `post_edited_${Date.now()}`;

    const before = await deliver(
      `edit-a-${Date.now()}`,
      deliveryBody(tenant, `edit-a-${Date.now()}`, { subjectExternalId, text: 'the original' }),
    );
    const after = await deliver(
      `edit-b-${Date.now()}`,
      deliveryBody(tenant, `edit-b-${Date.now()}`, { subjectExternalId, text: 'edited since' }),
    );

    expect(after.body.caseId).not.toBe(before.body.caseId);
    expect(after.body.merged).toBe(false);
    expect(await cases.countDocuments(tenant.tenant, { externalSubjectId: subjectExternalId })).toBe(
      2,
    );

    const [one, two] = await cases.find(tenant.tenant, { externalSubjectId: subjectExternalId });
    expect(one.contentHash).not.toBe(two.contentHash);
    expect(one.caseDedupKey).not.toBe(two.caseDedupKey);
  });

  it('opens a NEW case under a different policy version (§6.4)', async () => {
    const subjectExternalId = `post_policy_${Date.now()}`;
    const { registerPolicyVersion } = await import('../modules/policy/policy.registry');

    await registerPolicyVersion(tenant.tenant, {
      policySetId: 'tenant.community',
      version: '2026.08',
      status: 'published',
      title: 'A tenant policy set',
      publishedAt: new Date().toISOString(),
      rules: [
        {
          id: 'tenant.community.harassment',
          title: 'Harassment',
          taxonomyCodes: ['harassment.targeted_abuse'],
        },
      ],
    });

    const underBaseline = await deliver(
      `pol-a-${Date.now()}`,
      deliveryBody(tenant, `pol-a-${Date.now()}`, { subjectExternalId }),
    );
    const underTenantPolicy = await deliver(
      `pol-b-${Date.now()}`,
      deliveryBody(tenant, `pol-b-${Date.now()}`, {
        subjectExternalId,
        policy: { policySetId: 'tenant.community', version: '2026.08' },
      }),
    );

    // Same material, same subject, different rules to judge it by. Merging them
    // would decide one case under a policy the other report never invoked.
    expect(underTenantPolicy.body.caseId).not.toBe(underBaseline.body.caseId);

    const stored = await cases.find(tenant.tenant, { externalSubjectId: subjectExternalId });
    expect(stored.map((entry) => entry.contentHash)).toEqual([
      stored[0].contentHash,
      stored[0].contentHash,
    ]);
    expect(stored[0].caseDedupKey).not.toBe(stored[1].caseDedupKey);
  });

  it('never merges across applications, even for byte-identical material', async () => {
    const subjectExternalId = `post_cross_${Date.now()}`;
    const other = await provisionTenant();

    const mine = await deliver(
      `cross-a-${Date.now()}`,
      deliveryBody(tenant, `cross-a-${Date.now()}`, { subjectExternalId }),
    );
    const theirs = await request(app)
      .post('/v1/reports')
      .set('Authorization', `Bearer ${other.token}`)
      .set('Idempotency-Key', `cross-b-${Date.now()}`)
      .send(deliveryBody(other, `cross-b-${Date.now()}`, { subjectExternalId }));

    expect(theirs.status).toBe(202);
    expect(theirs.body.caseId).not.toBe(mine.body.caseId);

    /**
     * §7.3 puts cross-application correlation behind `Incident`, in a privileged
     * path — never as an automatic merge, which would put one tenant's material
     * in front of a jury drawn for another's case.
     */
    const mineStored = await cases.findOne(tenant.tenant, { caseId: mine.body.caseId });
    const theirsStored = await cases.findOne(other.tenant, { caseId: theirs.body.caseId });
    expect(mineStored?.caseDedupKey).not.toBe(theirsStored?.caseDedupKey);
    expect(mineStored?.incidentId).toBeNull();
    expect(theirsStored?.incidentId).toBeNull();
  });

  it('does not duplicate a case when the SAME report is delivered twice', async () => {
    const externalReportId = `replay-${Date.now()}`;
    const subjectExternalId = `post_replay_${Date.now()}`;
    const body = deliveryBody(tenant, externalReportId, { subjectExternalId });

    const first = await deliver(externalReportId, body);
    const replay = await deliver(externalReportId, body);

    expect(replay.body.reportId).toBe(first.body.reportId);
    expect(replay.body.caseId).toBe(first.body.caseId);

    // And the retry did not inflate the counters, which is what would give a
    // single reporter the queue position of a crowd.
    const stored = await cases.findOne(tenant.tenant, { caseId: first.body.caseId });
    expect(stored?.reportCount).toBe(1);
    expect(await reports.countDocuments(tenant.tenant, { externalReportId })).toBe(1);
  });
});

describe('merging a report into a case that already exists', () => {
  it('withdraws community review for the whole case when any reporter does', async () => {
    const subjectExternalId = `post_privacy_${Date.now()}`;

    const permissive = await deliver(
      `priv-a-${Date.now()}`,
      deliveryBody(tenant, `priv-a-${Date.now()}`, {
        subjectExternalId,
        allowCommunityReview: true,
      }),
    );
    await drainUntil(
      async () =>
        (await cases.findOne(tenant.tenant, { caseId: permissive.body.caseId }))?.reviewPool !==
        null,
      'triage of the permissive report',
    );
    expect(
      (await cases.findOne(tenant.tenant, { caseId: permissive.body.caseId }))?.reviewPool,
    ).toBe('community');

    const restrictive = await deliver(
      `priv-b-${Date.now()}`,
      deliveryBody(tenant, `priv-b-${Date.now()}`, {
        subjectExternalId,
        allowCommunityReview: false,
        reporterExternalId: 'reporter_carol',
      }),
    );
    expect(restrictive.body.caseId).toBe(permissive.body.caseId);
    await drainUntil(
      async () =>
        (await cases.findOne(tenant.tenant, { caseId: permissive.body.caseId }))?.reviewPool ===
        'specialist',
      're-triage of the merged, restrictive report',
    );

    /**
     * The second reporter's privacy terms bind the case. If the first reporter's
     * permissive value survived, one person's choice would silently expose
     * material another person delivered under a narrower one.
     */
    const stored = await cases.findOne(tenant.tenant, { caseId: permissive.body.caseId });
    expect(stored?.allowCommunityReview).toBe(false);
    expect(stored?.reviewPool).toBe('specialist');
    expect(stored?.reportCount).toBe(2);
  });

  it('keeps the longest retention any reporter asked for', async () => {
    const subjectExternalId = `post_retention_${Date.now()}`;

    const short = await deliver(
      `ret-a-${Date.now()}`,
      deliveryBody(tenant, `ret-a-${Date.now()}`, { subjectExternalId, retentionDays: 30 }),
    );
    await deliver(
      `ret-b-${Date.now()}`,
      deliveryBody(tenant, `ret-b-${Date.now()}`, {
        subjectExternalId,
        retentionDays: 90,
        reporterExternalId: 'reporter_dave',
      }),
    );
    await deliver(
      `ret-c-${Date.now()}`,
      deliveryBody(tenant, `ret-c-${Date.now()}`, {
        subjectExternalId,
        retentionDays: 45,
        reporterExternalId: 'reporter_erin',
      }),
    );

    const stored = await cases.findOne(tenant.tenant, { caseId: short.body.caseId });
    // The shortest would delete the evidence of a case still under review.
    expect(stored?.retentionDays).toBe(90);
  });

  it('does not publish a second case.ready_for_review for a case already triaged', async () => {
    const subjectExternalId = `post_second_${Date.now()}`;

    const opened = await deliver(
      `sec-a-${Date.now()}`,
      deliveryBody(tenant, `sec-a-${Date.now()}`, { subjectExternalId }),
    );
    await drainUntil(
      async () => (await cases.findOne(tenant.tenant, { caseId: opened.body.caseId }))?.triagedAt !== null,
      'the first triage',
    );
    await deliver(
      `sec-b-${Date.now()}`,
      deliveryBody(tenant, `sec-b-${Date.now()}`, {
        subjectExternalId,
        reporterExternalId: 'reporter_frank',
      }),
    );
    await drainUntil(
      async () => (await cases.findOne(tenant.tenant, { caseId: opened.body.caseId }))?.reportCount === 2,
      're-triage after the merge',
    );

    const published = await mongoose.connection
      .collection('outbox_events')
      .find({ type: 'case.ready_for_review', 'payload.caseId': opened.body.caseId })
      .toArray();

    // A second one would ask sortition to seat a second jury on one case.
    expect(published).toHaveLength(1);

    // The numbers were still refreshed, which is the point of re-triaging.
    const stored = await cases.findOne(tenant.tenant, { caseId: opened.body.caseId });
    expect(stored?.reportCount).toBe(2);
    expect(stored?.reporterFingerprints).toHaveLength(2);
  });
});
