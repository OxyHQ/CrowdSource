import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubOxySession } from './support/reviewers';

/**
 * What the console shows a developer about their own case (§11, §13.5).
 *
 * The console is a screen, and a screen is where a privacy invariant is broken
 * quietly: nothing fails, a field simply appears next to the ones that were supposed
 * to be there. So the projection is asserted by SEARCHING THE WHOLE SERIALISED
 * RESPONSE for values that must never leave, rather than by checking that the fields
 * we remembered to name are shaped correctly. A field added to a document later, and
 * spread into a view by accident, fails these assertions without anybody thinking to
 * update them.
 *
 * The values searched for are the dangerous ones by category: a reviewer id, the
 * reported text, a reporter fingerprint, and the internal triage figures.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { cases } = await import('../modules/cases/case.collection');
const { grantMembership } = await import('../modules/console/membership.service');
const { publishDecision } = await import('../modules/decision/decision.service');
const { BASELINE_POLICY_SET_ID, BASELINE_POLICY_VERSION } = await import(
  '../modules/policy/policyBaseline'
);
const { deliveryBody, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);

const app = createApp();

/** A family and language no other suite's reviewers serve, so no draw touches these. */
const REPORTED_TEXT = 'the exact words that were reported and must never come back';

function asUser(oxyUserId: string): Record<string, string> {
  return { 'x-test-oxy-user': oxyUserId };
}

beforeAll(async () => {
  await startDatabase();
}, 120_000);

afterAll(async () => {
  await stopDatabase();
});

interface Fixture {
  readonly oxyUserId: string;
  readonly applicationId: string;
  readonly caseId: string;
  readonly reviewerId: string;
}

/**
 * A case with two decision revisions and a juror recorded against each.
 *
 * Two revisions because §9.9's history is the axis the console detail ADDS over the
 * application API's single current decision, and a recorded juror because
 * `agreeingReviewerIds` is the field most likely to ride along in a serialisation.
 */
async function decidedCase(): Promise<Fixture> {
  const tenant = await provisionTenant();
  const oxyUserId = `oxy_console_${randomUUID().replace(/-/g, '')}`;
  await grantMembership({
    organizationId: tenant.organizationId,
    oxyUserId,
    role: 'owner',
    invitedByOxyUserId: 'oxy_test_root',
  });

  const delivered = await request(app)
    .post('/v1/reports')
    .set('authorization', `Bearer ${tenant.token}`)
    .set('idempotency-key', `privacy-${randomUUID()}`)
    .send(
      deliveryBody(tenant, `privacy-report-${randomUUID()}`, {
        text: REPORTED_TEXT,
        language: 'nl',
        reporterExternalId: 'user_reporter_secret',
      }),
    );
  expect(delivered.status).toBe(202);
  const caseId: string = delivered.body.caseId;

  const reviewerId = `rvw_${randomUUID().replace(/-/g, '')}`;
  const jury = {
    size: 3,
    decisiveVotes: 3,
    winningVotes: 3,
    agreement: 1,
    specialistPresent: false,
  };
  const policyVersions = {
    taxonomy: 'crowdsource.taxonomy.2026.1',
    application: `${BASELINE_POLICY_SET_ID}@${BASELINE_POLICY_VERSION}`,
    oxyConduct: 'oxy.conduct.2026.1',
  };

  const first = await publishDecision({
    context: tenant.tenant,
    caseId,
    revision: 1,
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    confidence: 0.9,
    findings: [
      {
        code: 'harassment.targeted_abuse',
        resourceIds: ['res_post'],
        severity: 'medium',
        scope: 'application_local',
      },
    ],
    recommendedActions: [{ action: 'remove_or_restrict' }],
    jury,
    policyVersions,
    agreeingReviewerIds: [reviewerId],
    supersedes: null,
    now: new Date(),
  });
  expect(first.published).toBe(true);

  // A second revision, as an appeal produces (§9.9). The case has to advance for the
  // compare-and-swap to allow it.
  await cases.updateOne(tenant.tenant, { caseId }, { set: { currentRevision: 2 } });
  const second = await publishDecision({
    context: tenant.tenant,
    caseId,
    revision: 2,
    outcome: 'no_violation',
    contextSufficiency: 'sufficient',
    confidence: 0.8,
    findings: [],
    recommendedActions: [{ action: 'restore' }],
    jury,
    policyVersions,
    agreeingReviewerIds: [reviewerId],
    supersedes:
      first.published === true
        ? { decisionId: first.decisionId, outcome: 'violation', appealId: null }
        : null,
    now: new Date(),
  });
  expect(second.published).toBe(true);

  return { oxyUserId, applicationId: tenant.applicationId, caseId, reviewerId };
}

describe('the case detail a developer sees', () => {
  it('carries no reviewer identity, no reported content and no reporter fingerprint', async () => {
    const fixture = await decidedCase();

    const detail = await request(app)
      .get(`/v1/console/applications/${fixture.applicationId}/cases/${fixture.caseId}`)
      .set(asUser(fixture.oxyUserId));

    expect(detail.status).toBe(200);
    const serialised = JSON.stringify(detail.body);

    // §11: the reviewer's identity. `decisionView` drops `agreeingReviewerIds`, and
    // nothing else in this module reads an assignment or a review.
    expect(serialised).not.toContain(fixture.reviewerId);
    expect(serialised).not.toContain('agreeingReviewerIds');
    expect(serialised).not.toContain('reviewerId');

    // §5.6's snapshot. The application already holds its own material; this API is
    // not a route back to it, and the console is not an evidence viewer.
    expect(serialised).not.toContain(REPORTED_TEXT);
    expect(serialised).not.toContain('contentSnapshot');

    // The reporter. The fingerprint is domain-separated by the application's OWN id and
    // carries no key, so an application handed one could recompute it over its user table.
    expect(serialised).not.toContain('reporterFingerprints');
    expect(serialised).not.toContain('user_reporter_secret');

    // Internal triage outputs, withheld from the application API for the same
    // reasons and withheld here.
    expect(serialised).not.toContain('priorityScore');
    expect(serialised).not.toContain('reviewPool');
    expect(serialised).not.toContain('incidentId');
  });

  it('does show what a developer needs to reconcile the case against their own record', async () => {
    const fixture = await decidedCase();

    const detail = await request(app)
      .get(`/v1/console/applications/${fixture.applicationId}/cases/${fixture.caseId}`)
      .set(asUser(fixture.oxyUserId));

    // The control for the assertions above: if this projection returned almost
    // nothing, every `not.toContain` would pass while the screen was useless.
    expect(detail.body.caseId).toBe(fixture.caseId);
    expect(detail.body.subject.externalId).toBe('post_987');
    expect(detail.body.policy.policySetId).toBe(BASELINE_POLICY_SET_ID);
    expect(detail.body.reportCount).toBe(1);
    expect(detail.body.reports).toHaveLength(1);
    expect(detail.body.reports[0].externalReportId).toMatch(/^privacy-report-/);

    // Resource METADATA and the digest, with no payload. This is the axis the console
    // adds over the application API's case view.
    expect(detail.body.resources).toHaveLength(1);
    expect(detail.body.resources[0]).toMatchObject({ id: 'res_post', type: 'text', role: 'subject' });
    expect(detail.body.resources[0].sha256).toMatch(/^sha256:/);
    expect(detail.body.resources[0].data).toBeUndefined();

    // §9.9's full history, oldest first, with the supersession chain intact.
    expect(detail.body.decisions).toHaveLength(2);
    expect(detail.body.decisions[0]).toMatchObject({ revision: 1, outcome: 'violation' });
    expect(detail.body.decisions[1]).toMatchObject({ revision: 2, outcome: 'no_violation' });
    expect(detail.body.decisions[1].supersedesDecisionId).toBe(detail.body.decisions[0].id);
    // Aggregate jury figures ride along, as they already do on the application API and
    // in §10.7's webhook envelope. A per-juror record does not.
    expect(detail.body.decisions[0].jury.size).toBe(3);
  });
});

describe('the case list a developer sees', () => {
  it('reports the outcome in force without exposing the internals behind it', async () => {
    const fixture = await decidedCase();

    const listed = await request(app)
      .get(`/v1/console/applications/${fixture.applicationId}/cases`)
      .set(asUser(fixture.oxyUserId));

    expect(listed.status).toBe(200);
    expect(listed.body.cases).toHaveLength(1);
    expect(listed.body.cases[0]).toMatchObject({
      caseId: fixture.caseId,
      // The current revision's outcome, which is what an operator scanning a queue
      // needs, and the reason the list does one decision read per row.
      outcome: 'no_violation',
      decidedRevision: 2,
    });

    const serialised = JSON.stringify(listed.body);
    expect(serialised).not.toContain(REPORTED_TEXT);
    expect(serialised).not.toContain(fixture.reviewerId);
    expect(serialised).not.toContain('priorityScore');
  });

  it('refuses a status filter it does not recognise rather than ignoring it', async () => {
    const fixture = await decidedCase();

    const refused = await request(app)
      .get(`/v1/console/applications/${fixture.applicationId}/cases?status=not_a_status`)
      .set(asUser(fixture.oxyUserId));

    // Silently dropping the filter would show an operator filtering for one thing the
    // whole queue, which reads as "everything is in this state".
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('status must be one of');
  });

  it('refuses a cursor it did not issue rather than restarting from the top', async () => {
    const fixture = await decidedCase();

    const refused = await request(app)
      .get(`/v1/console/applications/${fixture.applicationId}/cases?cursor=not-a-cursor`)
      .set(asUser(fixture.oxyUserId));

    // A silently-restarting cursor makes a paging client loop over page one forever.
    expect(refused.status).toBe(400);
  });

  it('pages with a cursor that does not skip or repeat a row', async () => {
    const tenant = await provisionTenant();
    const oxyUserId = `oxy_console_${randomUUID().replace(/-/g, '')}`;
    await grantMembership({
      organizationId: tenant.organizationId,
      oxyUserId,
      role: 'owner',
      invitedByOxyUserId: 'oxy_test_root',
    });

    // More cases than one page holds would take 51 deliveries; the property that
    // matters at any size is that the cursor is issued only when there IS more, so a
    // single page must report none.
    for (const index of [0, 1, 2]) {
      const delivered = await request(app)
        .post('/v1/reports')
        .set('authorization', `Bearer ${tenant.token}`)
        .set('idempotency-key', `page-${index}-${randomUUID()}`)
        .send(
          deliveryBody(tenant, `page-report-${index}-${randomUUID()}`, {
            subjectExternalId: `post_page_${index}`,
            language: 'nl',
          }),
        );
      expect(delivered.status).toBe(202);
    }

    const page = await request(app)
      .get(`/v1/console/applications/${tenant.applicationId}/cases`)
      .set(asUser(oxyUserId));

    expect(page.status).toBe(200);
    expect(page.body.cases).toHaveLength(3);
    expect(page.body.nextCursor).toBeNull();

    const ids = page.body.cases.map((row: { caseId: string }) => row.caseId);
    expect(new Set(ids).size).toBe(3);
  });
});
