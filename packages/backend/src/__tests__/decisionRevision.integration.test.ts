import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';

import { stubOxySession } from './support/reviewers';

/**
 * §9.9 — immutability and revisions, end to end.
 *
 * The plan's worked example, run for real:
 *
 *     Case case_123
 *       Decision revision 1  status = superseded  outcome = violation
 *     Appeal appeal_456
 *       Decision revision 2  status = final       outcome = no_violation
 *                            supersedes = decision_revision_1
 *
 * ## What is under test and what is not
 *
 * The supersession MECHANISM, driven directly through `openCaseRevision` with NO
 * appeal object behind it. §9.8's appeal — a requester, a reason, the author's
 * structured context, the raised threshold — has its own suite in
 * `appeals.integration.test.ts`; this file is what proves the mechanism holds on
 * its own, which is the path an audit or a Trust & Safety correction takes.
 *
 * Three properties of that path are asserted here because they are easy to break
 * from the appeals side and would be invisible if only the appeal suite existed:
 * the second jury contains nobody from the first, the panel is still five seats
 * (§9.4's minimum follows the REVISION, not the presence of an appeal row), and
 * nothing emits `appeal.decided` for a revision no appeal opened.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { registerOutboxWorkers } = await import('../modules/outbox/workers');
const { openCaseRevision } = await import('../modules/decision/revision.service');
const { decisions } = await import('../modules/decision/decision.collection');
const { cases } = await import('../modules/cases/case.collection');
const { assignments } = await import('../modules/sortition/assignment.collection');
const { sortitionDraws } = await import('../modules/sortition/draw.collection');
const { reviews } = await import('../modules/review/review.collection');
const { reviewerProfiles } = await import('../modules/reviewer/reviewer.collection');
const { outboxEvents, OUTBOX_EVENT_TYPES } = await import('../modules/outbox/outbox.collection');
const { webhookDeliveries } = await import('../modules/webhooks/webhook.collections');
const { registerWebhookEndpoint } = await import('../modules/webhooks/endpoint.service');
const { createReviewer } = await import('./support/reviewers');
const { deliveryBody, drainUntil, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();

/**
 * Two isolation axes at once: a family and a LANGUAGE.
 *
 * §8.2 requires a reviewer to accept every family a case alleges AND to have its
 * language. There are eleven families and more blocks wanting an exclusive pool
 * than that, so this file takes `integrity` — shared with
 * `consensusDecision.integration.test.ts` — and separates itself by language
 * instead. Its reviewers speak `eu` and that file's speak `es`, so neither pool
 * is eligible for the other's cases. The isolation is the product's own rule
 * rather than a fixture trick, which is the same property the family axis has.
 */
const FAMILY = 'integrity' as const;
const CODE: TaxonomyCode = 'integrity.impersonation';
const LANGUAGE = 'eu';

let tenant: ProvisionedTenant;
let caseId: string;
let firstDecisionId: string;
let firstJury: string[];
let webhookEndpointId: string;

function asReviewer(oxyUserId: string) {
  return { 'x-test-oxy-user': oxyUserId };
}

async function seatsOf(revision: number): Promise<string[]> {
  const panel = await assignments.find({ caseId, caseRevision: revision });
  return panel
    .filter((seat) => seat.status !== 'recused' && seat.status !== 'expired')
    .map((seat) => seat.reviewerId);
}

async function vote(reviewerId: string, outcome: 'violation' | 'no_violation'): Promise<void> {
  const profile = await reviewerProfiles.findOne({ reviewerId });
  if (!profile) throw new Error(`no profile for ${reviewerId}`);

  const opened = await request(app)
    .post('/v1/reviewer/assignments/next')
    .set(asReviewer(profile.oxyUserId));
  expect(opened.status).toBe(200);

  const submitted = await request(app)
    .post(`/v1/reviewer/assignments/${String(opened.body.assignmentId)}/reviews`)
    .set(asReviewer(profile.oxyUserId))
    .set('x-assignment-token', opened.body.token)
    .send({
      outcome,
      contextSufficiency: 'sufficient',
      findings:
        outcome === 'violation'
          ? [{ code: CODE, resourceIds: ['res_post'], severity: 'medium', confidence: 0.9 }]
          : [],
      recommendedActions: outcome === 'violation' ? ['remove_or_restrict'] : ['restore'],
    });
  expect(submitted.status).toBe(201);
}

beforeAll(async () => {
  await startDatabase();
  registerOutboxWorkers();
  tenant = await provisionTenant();

  /**
   * Twelve, because the second jury may contain nobody from the first (§9.8)
   * and §8.3's slots still have to be fillable from what is left.
   */
  for (let index = 0; index < 12; index += 1) {
    await createReviewer({
      family: FAMILY,
      languages: [LANGUAGE],
      reliability: index % 3 === 2 ? 0.4 : 0.9,
      completedReviewCount: index % 3 === 2 ? 0 : 40,
    });
  }

  /**
   * The endpoint id is kept so the delivery assertions can be SCOPED to it.
   * Deliveries are not tenant-filtered by the worker — it delivers across every
   * tenant, deliberately — so a query by `eventType` alone finds whichever suite's
   * row happened to be written first, and the failure reads as a wrong payload
   * rather than as a query that was never specific enough.
   */
  const registered = await registerWebhookEndpoint(tenant.tenant, {
    url: 'https://receiver.invalid/corrections',
    eventTypes: ['case.decided', 'decision.corrected'],
  });
  webhookEndpointId = registered.endpoint.webhookEndpointId;

  const externalReportId = `revision-${Date.now()}`;
  const created = await request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', externalReportId)
    .send(
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: `post_revision_${Date.now()}`,
        allegationCode: CODE,
        language: LANGUAGE,
        text: 'material under appeal',
      }),
    );
  expect(created.status).toBe(202);
  caseId = created.body.caseId;

  await drainUntil(
    async () => (await sortitionDraws.findOne({ caseId })) !== null,
    'the first draw',
  );

  firstJury = await seatsOf(1);
  expect(firstJury).toHaveLength(3);
  for (const reviewerId of firstJury) await vote(reviewerId, 'violation');

  await drainUntil(
    async () => (await decisions.countDocuments(tenant.tenant, { caseId })) === 1,
    'the first decision',
  );

  const [first] = await decisions.find(tenant.tenant, { caseId });
  firstDecisionId = first.decisionId;
  expect(first.outcome).toBe('violation');
}, 180_000);

afterAll(async () => {
  await stopDatabase();
});

describe('§9.9: a revision supersedes; it never edits', () => {
  let frozen: {
    outcome: string;
    findings: string;
    policyVersions: string;
    confidence: number;
    jury: string;
    publishedAt: number;
  };

  beforeAll(async () => {
    const [first] = await decisions.find(tenant.tenant, { caseId, revision: 1 });
    frozen = {
      outcome: first.outcome,
      findings: JSON.stringify(first.findings),
      policyVersions: JSON.stringify(first.policyVersions),
      confidence: first.confidence,
      jury: JSON.stringify(first.jury),
      publishedAt: first.publishedAt.getTime(),
    };

    const opened = await openCaseRevision(tenant.tenant, caseId);
    expect(opened).toEqual({ opened: true, revision: 2 });

    /**
     * FIVE, not three. §9.4's appeal row — "jurado nuevo, mínimo 5" — is enforced
     * by every revision past the first opening on the appeal ladder, whose lowest
     * rung is five seats (`APPEAL_MIN_ROUND`). That holds for a revision opened
     * through this mechanism directly, with no appeal object behind it, which is
     * the point of asserting it here: the panel size follows the REVISION, so no
     * path can produce a three-person appeal panel.
     */
    await drainUntil(async () => (await seatsOf(2)).length === 5, 'the second panel');
  }, 180_000);

  it('leaves revision 1 byte-identical except for its status', async () => {
    const [first] = await decisions.find(tenant.tenant, { caseId, revision: 1 });

    expect(first.status).toBe('superseded');
    expect(first.outcome).toBe(frozen.outcome);
    expect(JSON.stringify(first.findings)).toBe(frozen.findings);
    expect(JSON.stringify(first.policyVersions)).toBe(frozen.policyVersions);
    expect(first.confidence).toBe(frozen.confidence);
    expect(JSON.stringify(first.jury)).toBe(frozen.jury);
    expect(first.publishedAt.getTime()).toBe(frozen.publishedAt);
  });

  it('§9.8: the second jury contains nobody from the first', async () => {
    const second = await seatsOf(2);

    expect(second).toHaveLength(5);
    for (const reviewerId of second) {
      expect(firstJury, 'a juror sat on both panels').not.toContain(reviewerId);
    }
  });

  it('the second panel is its own draw at revision 2, with its own seed', async () => {
    const draws = await sortitionDraws.find({ caseId }, { sort: { drawnAt: 1 } });
    const second = draws.filter((draw) => draw.caseRevision === 2);

    expect(second).toHaveLength(1);
    /** Round 2 of the APPEAL ladder: five seats, §9.4's minimum. */
    expect(second[0].round).toBe(2);
    expect(second[0].panelSpecId).toBe('community.appeal.round2');
    expect(second[0].seed).not.toBe(draws[0].seed);
  });

  it('§9.8: the new jury cannot see the original votes', async () => {
    const second = await seatsOf(2);
    const profile = await reviewerProfiles.findOne({ reviewerId: second[0] });
    if (!profile) throw new Error('expected a profile');

    const opened = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(profile.oxyUserId));
    expect(opened.status).toBe(200);

    const body = JSON.stringify(opened.body);
    expect(body).not.toContain(firstDecisionId);
    expect(body).not.toContain('violation');
    expect(body).not.toContain('superseded');
    for (const reviewerId of firstJury) {
      expect(body).not.toContain(reviewerId);
    }
  });

  it('a second attempt to open the same revision moves nothing', async () => {
    const again = await openCaseRevision(tenant.tenant, caseId);

    // The case is at revision 2 and revision 2 is not decided, so the swap
    // refuses: you cannot open revision 3 of a decision nobody has reached.
    expect(again).toEqual({ opened: false, reason: 'not_decided' });

    const stored = await cases.findOne(tenant.tenant, { caseId });
    expect(stored?.currentRevision).toBe(2);
    expect(stored?.decidedRevision).toBe(1);
  });
});

describe('§9.8: an overturned decision is a correction; an upheld one is not', () => {
  beforeAll(async () => {
    const second = await seatsOf(2);
    // The reviewer whose assignment was opened by the blindness test above votes
    // through the same path as the others; opening twice is what §8.7's token
    // rotation is for.
    for (const reviewerId of second) await vote(reviewerId, 'no_violation');

    await drainUntil(
      async () => (await decisions.countDocuments(tenant.tenant, { caseId })) === 2,
      'the second decision',
    );
  }, 180_000);

  it('publishes revision 2 as a new row that names what it replaced', async () => {
    const [second] = await decisions.find(tenant.tenant, { caseId, revision: 2 });

    expect(second.status).toBe('final');
    expect(second.outcome).toBe('no_violation');
    expect(second.supersedesDecisionId).toBe(firstDecisionId);
    expect(second.decisionId).not.toBe(firstDecisionId);
    expect(second.jury).toMatchObject({ size: 5, decisiveVotes: 5, winningVotes: 5 });
  });

  it('keeps the whole history, and shows the one in force', async () => {
    const history = await decisions.find(tenant.tenant, { caseId }, { sort: { revision: 1 } });
    expect(history.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(history.map((entry) => entry.status)).toEqual(['superseded', 'final']);

    const view = await request(app)
      .get(`/v1/cases/${caseId}`)
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(view.status).toBe(200);
    expect(view.body.decision.revision).toBe(2);
    expect(view.body.currentRevision).toBe(2);

    /** §10.2: a superseded revision stays readable by id, forever. */
    const superseded = await request(app)
      .get(`/v1/decisions/${firstDecisionId}`)
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(superseded.status).toBe(200);
    expect(superseded.body.status).toBe('superseded');
    expect(superseded.body.outcome).toBe('violation');
  });

  it('emits `decision.corrected` because the outcome changed', async () => {
    const corrections = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.decisionCorrected,
      'payload.caseId': caseId,
    });

    expect(corrections).toHaveLength(1);

    // And `case.decided` as well, not instead: an application subscribed only to
    // the ordinary event must not miss the revision that overturned the one it
    // already acted on.
    const decided = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.caseDecided,
      'payload.caseId': caseId,
    });
    expect(decided).toHaveLength(2);
  });

  it('emits no `appeal.decided`, because no appeal opened this revision', async () => {
    /**
     * §10.6's `appeal.decided` answers an appeal. A revision opened by this
     * mechanism directly has no appellant and nobody waiting for a result, so
     * emitting one would tell an application an appeal it never received had been
     * resolved — and phase 7 consumes that event to reverse a conduct effect.
     */
    const appealDecided = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.appealDecided,
      'payload.caseId': caseId,
    });
    expect(appealDecided).toHaveLength(0);

    const appealCreated = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.appealCreated,
      'payload.caseId': caseId,
    });
    expect(appealCreated).toHaveLength(0);
  });

  it('delivers the correction, carrying the decision that replaced the old one', async () => {
    const mine = { webhookEndpointId, eventType: 'decision.corrected' };
    await drainUntil(
      async () => (await webhookDeliveries.find(mine)).length > 0,
      'a decision.corrected delivery',
    );

    const [delivered] = await webhookDeliveries.find(mine);
    const payload = JSON.parse(delivered.body);

    expect(payload.type).toBe('decision.corrected');
    expect(payload.data.caseId).toBe(caseId);
    expect(payload.data.decision.revision).toBe(2);
    expect(payload.data.decision.outcome).toBe('no_violation');
    /** The contract refuses a correction that supersedes nothing. */
    expect(payload.data.decision.supersedesDecisionId).toBe(firstDecisionId);
  });

  it('the reviewers who were overturned are not punished (§9.7)', async () => {
    /**
     * §9.7: "no castigar automáticamente a una minoría. Solo reducir acceso ante
     * evidencia estadística o controles conocidos." Being overturned by a second
     * jury is neither. Nothing in this phase writes reliability, and this is the
     * assertion that says so before something does.
     */
    for (const reviewerId of firstJury) {
      const profile = await reviewerProfiles.findOne({ reviewerId });
      expect(profile?.state).not.toBe('suspended');
      expect(profile?.suspendedUntil).toBeNull();
      expect(profile?.available).toBe(true);
      expect(profile?.reliabilityByCategory[FAMILY]).toBeGreaterThan(0);
    }
  });

  it('the ballots of revision 1 never counted toward revision 2', async () => {
    const all = await reviews.find({ caseId });
    expect(all).toHaveLength(8);
    expect(all.filter((review) => review.caseRevision === 1)).toHaveLength(3);
    expect(all.filter((review) => review.caseRevision === 2)).toHaveLength(5);

    const [second] = await decisions.find(tenant.tenant, { caseId, revision: 2 });
    expect(second.jury.decisiveVotes).toBe(5);
  });
});
