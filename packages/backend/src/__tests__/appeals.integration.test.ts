import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';

import { stubOxySession } from './support/reviewers';

/**
 * §9.8 and §15.9's appeals, end to end against the real replica set.
 *
 * The four properties this phase is answerable for, and none of them is provable
 * without running the whole chain:
 *
 *  1. **An appeal draws a jury disjoint from the original** — five of them, §9.4's
 *     minimum, sharing nobody with the panel that decided first.
 *  2. **The original decision is byte-identical afterwards.** An appeal supersedes;
 *     it never edits.
 *  3. **An appeal refused as ineligible creates NO revision.** A case left at
 *     `appealed` with no jury owed to it is the one failure §9.8 cannot tolerate,
 *     because by then the author has been told their case is being looked at again.
 *  4. **An accepted appeal that changes the outcome emits `decision.corrected`**,
 *     alongside `appeal.decided` and `case.decided`.
 *
 * ## What is stubbed
 *
 * One thing: the network call that asks Oxy whether a bearer token is a real
 * session. The appeal route authenticates a SERVICE CREDENTIAL, which is this
 * service's own and is not stubbed at all.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { registerOutboxWorkers } = await import('../modules/outbox/workers');
const { appeals } = await import('../modules/appeals/appeal.collection');
const { decisions } = await import('../modules/decision/decision.collection');
const { cases } = await import('../modules/cases/case.collection');
const { assignments } = await import('../modules/sortition/assignment.collection');
const { sortitionDraws } = await import('../modules/sortition/draw.collection');
const { reviewerProfiles } = await import('../modules/reviewer/reviewer.collection');
const { reviews } = await import('../modules/review/review.collection');
const { outboxEvents, OUTBOX_EVENT_TYPES } = await import('../modules/outbox/outbox.collection');
const { auditEvents } = await import('../modules/audit/audit.collection');
const { registerWebhookEndpoint } = await import('../modules/webhooks/endpoint.service');
const { fanOutWebhookEvent } = await import('../modules/webhooks/fanout');
const { webhookDeliveries } = await import('../modules/webhooks/webhook.collections');
const { handleCaseReadyForReview } = await import('../modules/sortition/sortition.worker');
const { createReviewer } = await import('./support/reviewers');
const {
  deliveryBody,
  drainUntil,
  provisionApplication,
  provisionTenant,
  startDatabase,
  stopDatabase,
} = await import('./support/tenants');
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();

/**
 * The isolation axis is the LANGUAGE, one per block.
 *
 * Reviewer profiles are global, so a pool created here is a candidate for every
 * case in the database, and §8.2 requires a reviewer to have the case's language.
 * `harassment.targeted_abuse` is `sampleEnvelope`'s default allegation, so a
 * harassment pool speaking `es` would draw panels for half the suite; these speak
 * tags nothing else uses. A pool per block is needed for a second reason as well:
 * `POST /assignments/next` returns the assignment a reviewer was given LONGEST AGO
 * (§8.7), so a juror holding two of this file's cases would vote on the wrong one.
 */
const FAMILY = 'harassment' as const;
const CODE: TaxonomyCode = 'harassment.targeted_abuse';
const APPEALED_LANGUAGE = 'ast';
const CLEARED_LANGUAGE = 'sc';
/** A case decided `violation` and never appealed: the fixture for WHO may file. */
const REFUSED_LANGUAGE = 'vec';
/** Nobody serves this one, so the case stays undecided with no panel. */
const UNSERVED_LANGUAGE = 'lij';

const SCOPES = [
  'crowdsource:reports:write',
  'crowdsource:cases:read',
  'crowdsource:appeals:write',
] as const;

/** The envelope's author, and the only principal the MATERIAL identifies. */
const AUTHOR = 'user_author';
/** Referenced by an allegation and never by the material — §9.8 excludes them. */
const REPORTER = 'reporter_1';

let tenant: ProvisionedTenant;
let appealedCaseId: string;
let clearedCaseId: string;
let refusedCaseId: string;
let undecidedCaseId: string;
let firstDecisionId: string;
let firstJury: string[];
let appealsReviewerId: string;
let webhookEndpointId: string;

function asReviewer(oxyUserId: string) {
  return { 'x-test-oxy-user': oxyUserId };
}

async function seatsOf(caseId: string, revision: number): Promise<string[]> {
  const panel = await assignments.find({ caseId, caseRevision: revision });
  return panel
    .filter((seat) => seat.status !== 'recused' && seat.status !== 'expired')
    .map((seat) => seat.reviewerId);
}

async function openCase(subject: string, language: string): Promise<string> {
  const externalReportId = `${subject}-${Date.now()}`;
  const created = await request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', externalReportId)
    .send(
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: `post_${subject}_${Date.now()}`,
        allegationCode: CODE,
        language,
        text: `material for ${subject}`,
      }),
    );

  expect(created.status).toBe(202);
  return created.body.caseId;
}

async function vote(
  reviewerId: string,
  outcome: 'violation' | 'no_violation',
): Promise<void> {
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
      /**
       * `remove_or_restrict` is what makes the first decision SEVERE (§9.4), which
       * is the condition that raises the appeal's threshold. A decision that only
       * asked for a label would take the other branch, which
       * `appealStandard.test.ts` pins directly.
       */
      recommendedActions: outcome === 'violation' ? ['remove_or_restrict'] : ['restore'],
    });
  expect(submitted.status).toBe(201);
}

/** §9.8's additional context, carrying everything redaction has to remove. */
const HOSTILE_STATEMENT = [
  'La cita venía de un artículo publicado el 2026-07-01.',
  'Pruebas en https://tracker.invalid/beacon?j=1 y escríbeme a author@example.com',
  'o al +34 600 123 456. Mi DNI es 12345678 por si acaso.',
].join('\n');

function filing(overrides: Record<string, unknown> = {}) {
  return {
    appellantExternalPrincipalId: AUTHOR,
    reason: 'context_missing',
    authorContext: {
      statement: HOSTILE_STATEMENT,
      resourceIds: ['res_post'],
      fields: { publishedOn: '2026-07-01', source: 'https://elpais.invalid/a' },
    },
    ...overrides,
  };
}

function fileAppealRequest(caseId: string, key: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/v1/cases/${caseId}/appeals`)
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', key)
    .send(body);
}

beforeAll(async () => {
  await startDatabase();
  registerOutboxWorkers();
  tenant = await provisionTenant(SCOPES);

  /**
   * Kept so every delivery assertion below can be scoped to THIS endpoint. The
   * delivery worker is not tenant-filtered — it delivers across every tenant on
   * purpose — so a query by `eventType` alone would find whichever suite wrote a
   * row of that type first.
   */
  const registered = await registerWebhookEndpoint(tenant.tenant, {
    url: 'https://receiver.invalid/appeals',
    eventTypes: ['case.decided', 'decision.corrected', 'appeal.created', 'appeal.decided'],
  });
  webhookEndpointId = registered.endpoint.webhookEndpointId;

  /**
   * Fourteen, because §9.8's second jury may contain nobody from the first and
   * §9.4's appeal panel is five — so the appeal ladder's slots have to be fillable
   * from what is left after three people have already served.
   */
  for (let index = 0; index < 14; index += 1) {
    await createReviewer({
      family: FAMILY,
      languages: [APPEALED_LANGUAGE],
      reliability: index % 4 === 3 ? 0.4 : 0.9,
      completedReviewCount: index % 4 === 3 ? 0 : 40,
    });
  }

  appealedCaseId = await openCase('appealed', APPEALED_LANGUAGE);
  await drainUntil(
    async () => (await sortitionDraws.findOne({ caseId: appealedCaseId })) !== null,
    'the first draw',
  );

  firstJury = await seatsOf(appealedCaseId, 1);
  expect(firstJury).toHaveLength(3);
  for (const reviewerId of firstJury) await vote(reviewerId, 'violation');

  await drainUntil(
    async () => (await decisions.countDocuments(tenant.tenant, { caseId: appealedCaseId })) === 1,
    'the first decision',
  );

  const [first] = await decisions.find(tenant.tenant, { caseId: appealedCaseId });
  firstDecisionId = first.decisionId;
  expect(first.outcome).toBe('violation');

  /**
   * The appeals reviewer is created AFTER the first panel, deliberately.
   *
   * §8.1's state is what the appeal ladder's `appeals_reviewer` slot is for, and
   * §9.8 excludes anybody who sat on the original jury. Creating them now means
   * they cannot have been drawn for revision 1, so "the appeals seat went to an
   * appeals reviewer" is a statement about the SLOT rather than about which way
   * the first draw happened to fall.
   */
  const appealsReviewer = await createReviewer({
    family: FAMILY,
    languages: [APPEALED_LANGUAGE],
    state: 'appeals',
    reliability: 0.95,
    completedReviewCount: 400,
  });
  appealsReviewerId = appealsReviewer.reviewerId;
}, 240_000);

afterAll(async () => {
  await stopDatabase();
});

describe('§10.2: POST /v1/cases/{id}/appeals', () => {
  let filed: Record<string, unknown>;
  let frozen: {
    outcome: string;
    findings: string;
    policyVersions: string;
    confidence: number;
    jury: string;
    recommendedActions: string;
    publishedAt: number;
  };

  beforeAll(async () => {
    const [first] = await decisions.find(tenant.tenant, { caseId: appealedCaseId, revision: 1 });
    frozen = {
      outcome: first.outcome,
      findings: JSON.stringify(first.findings),
      policyVersions: JSON.stringify(first.policyVersions),
      confidence: first.confidence,
      jury: JSON.stringify(first.jury),
      recommendedActions: JSON.stringify(first.recommendedActions),
      publishedAt: first.publishedAt.getTime(),
    };

    const response = await fileAppealRequest(appealedCaseId, 'appeal-key-1', filing());
    expect(response.status).toBe(201);
    filed = response.body;

    await drainUntil(
      async () => (await seatsOf(appealedCaseId, 2)).length === 5,
      'the appeal panel',
    );
  }, 240_000);

  it('answers with the appeal, the two revisions and the bar the new panel must clear', () => {
    expect(filed.caseId).toBe(appealedCaseId);
    expect(filed.status).toBe('open');
    expect(filed.reason).toBe('context_missing');
    expect(filed.supersededRevision).toBe(1);
    expect(filed.supersededDecisionId).toBe(firstDecisionId);
    expect(filed.openedRevision).toBe(2);
    /**
     * §9.4: the first decision was unanimous at three, which needed 3, and it
     * recommended `remove_or_restrict` — a severe action. So the appeal needs one
     * more than the first decision did.
     */
    expect(filed.requiredAgreeingVotes).toBe(4);
    expect(filed.decision).toBeUndefined();
  });

  it('never returns the author’s own context to the tenant (§13.5)', () => {
    /**
     * The application supplied it, so echoing it back adds nothing and puts case
     * content in one more place — including, for the webhook, a place a receiver
     * will store, retry and log.
     */
    const body = JSON.stringify(filed);
    expect(body).not.toContain('artículo');
    expect(body).not.toContain('author@example.com');
    expect(body).not.toContain('statement');
  });

  it('§9.8: validates and REDACTS the author’s context before storing it', async () => {
    const [appeal] = await appeals.find(tenant.tenant, { caseId: appealedCaseId });
    const context = appeal.authorContext;
    if (!context) throw new Error('expected the author context to be stored');

    // The beacon that would tell the author which juror looked at their case, and
    // the contact details of whoever is named in it.
    expect(context.statement).not.toContain('tracker.invalid');
    expect(context.statement).not.toContain('author@example.com');
    expect(context.statement).not.toContain('+34 600 123 456');
    expect(context.statement).toContain('[link removed]');
    expect(context.statement).toContain('[redacted]');

    // And the defence itself survives: the sentence, and the date it turns on.
    expect(context.statement).toContain('La cita venía de un artículo publicado el 2026-07-01.');

    expect(context.resourceIds).toEqual(['res_post']);
    expect(context.fields).toEqual({
      publishedOn: '2026-07-01',
      source: '[link removed]',
    });
  });

  it('§9.9: leaves the appealed decision byte-identical, except for its status', async () => {
    const [first] = await decisions.find(tenant.tenant, { caseId: appealedCaseId, revision: 1 });

    expect(first.status).toBe('superseded');
    expect(first.decisionId).toBe(firstDecisionId);
    expect(first.outcome).toBe(frozen.outcome);
    expect(JSON.stringify(first.findings)).toBe(frozen.findings);
    expect(JSON.stringify(first.policyVersions)).toBe(frozen.policyVersions);
    expect(first.confidence).toBe(frozen.confidence);
    expect(JSON.stringify(first.jury)).toBe(frozen.jury);
    expect(JSON.stringify(first.recommendedActions)).toBe(frozen.recommendedActions);
    expect(first.publishedAt.getTime()).toBe(frozen.publishedAt);
  });

  it('§9.8: the appeal jury shares NOBODY with the panel that decided first', async () => {
    const second = await seatsOf(appealedCaseId, 2);

    expect(new Set(second).size, 'the same person was seated twice').toBe(second.length);
    for (const reviewerId of second) {
      expect(firstJury, 'a juror sat on both panels').not.toContain(reviewerId);
    }
  });

  it('§9.4: the appeal panel is wider than the panel it reviews, and at least five', async () => {
    const second = await seatsOf(appealedCaseId, 2);

    /**
     * The PROPERTY first — "mínimo 5", and never narrower than the panel whose
     * decision is under appeal — then the rung the ladder defines today as a
     * literal. The property survives a ladder edit; the literal makes moving the
     * rung a deliberate act rather than a drift.
     */
    expect(second.length, '§9.4: an appeal panel is at least five').toBeGreaterThanOrEqual(5);
    expect(
      second.length,
      'the appeal panel is no narrower than the panel it reviews',
    ).toBeGreaterThan(firstJury.length);
    expect(second).toHaveLength(5);
  });

  it('§9.4: the appeal panel is five, on the appeal ladder, with its own seed', async () => {
    const draws = await sortitionDraws.find(
      { caseId: appealedCaseId },
      { sort: { drawnAt: 1 } },
    );
    const second = draws.filter((draw) => draw.caseRevision === 2);

    expect(second).toHaveLength(1);
    expect(second[0].round).toBe(2);
    expect(second[0].panelSpecId).toBe('community.appeal.round2');
    expect(second[0].selected).toHaveLength(5);
    expect(second[0].seed).not.toBe(draws[0].seed);

    /**
     * §8.1's Appeals Reviewer, actually seated. The slot prefers that state and
     * only falls back when nobody holds it, so a panel drawn from a pool
     * containing one is where the state stops being a label.
     */
    const appealsSeat = second[0].selected.find((seat) => seat.slotType === 'appeals_reviewer');
    expect(appealsSeat?.filledAs).toBe('appeals_reviewer');
    expect(appealsSeat?.reviewerId).toBe(appealsReviewerId);

    // §8.3's newcomer slot is not on an appeal panel.
    expect(second[0].requestedSlots).not.toContain('calibrated_newcomer');
  });

  it('§9.8: gives the new jury the author’s context, and nothing about the old votes', async () => {
    const second = await seatsOf(appealedCaseId, 2);
    const profile = await reviewerProfiles.findOne({ reviewerId: second[0] });
    if (!profile) throw new Error('expected a profile');

    const opened = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(profile.oxyUserId));
    expect(opened.status).toBe(200);

    // Shown: the author's explanation, labelled as the unverified claim it is.
    expect(opened.body.authorContext.unverified).toBe(true);
    expect(opened.body.authorContext.statement).toContain('La cita venía de un artículo');
    expect(opened.body.authorContext.statement).not.toContain('tracker.invalid');

    // Hidden: §9.8's blindness. The decision, its outcome, the jurors who reached
    // it, the reason code that argues for a verdict, and the raised threshold.
    const body = JSON.stringify(opened.body);
    expect(body).not.toContain(firstDecisionId);
    expect(body).not.toContain('violation');
    expect(body).not.toContain('superseded');
    expect(body).not.toContain('context_missing');
    expect(body).not.toContain('requiredAgreeingVotes');
    for (const reviewerId of firstJury) {
      expect(body).not.toContain(reviewerId);
    }
  });

  it('§10.6: publishes `appeal.created`, exactly once, through the outbox', async () => {
    const created = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.appealCreated,
      'payload.caseId': appealedCaseId,
    });

    expect(created).toHaveLength(1);
    expect(created[0].payload.appealId).toBe(filed.id);
  });

  it('delivers `appeal.created` carrying the appeal and no case content', async () => {
    const mine = { webhookEndpointId, eventType: 'appeal.created' };
    await drainUntil(
      async () => (await webhookDeliveries.find(mine)).length > 0,
      'an appeal.created delivery',
    );

    const [delivered] = await webhookDeliveries.find(mine);
    const payload = JSON.parse(delivered.body);

    expect(payload.type).toBe('appeal.created');
    expect(payload.data.caseId).toBe(appealedCaseId);
    expect(payload.data.appealId).toBe(filed.id);
    expect(payload.data.appeal.status).toBe('open');
    expect(payload.data.appeal.requiredAgreeingVotes).toBe(4);
    expect(payload.data.decision).toBeUndefined();

    // The author's words never reach a receiver's disk.
    expect(delivered.body).not.toContain('artículo');
    expect(delivered.body).not.toContain('statement');
  });

  it('records the filing in the audit trail, without the reason or the context', async () => {
    const rows = await auditEvents.find(tenant.tenant, {
      caseId: appealedCaseId,
      action: 'appeal.filed',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].actorCredentialId).not.toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain('context_missing');
  });

  it('§10.4: a retry under the same key returns the same appeal and opens nothing', async () => {
    const retried = await fileAppealRequest(appealedCaseId, 'appeal-key-1', filing());

    expect(retried.status).toBe(200);
    expect(retried.body.id).toBe(filed.id);
    expect(retried.body.openedRevision).toBe(2);

    expect(await appeals.countDocuments(tenant.tenant, { caseId: appealedCaseId })).toBe(1);
    const stored = await cases.findOne(tenant.tenant, { caseId: appealedCaseId });
    expect(stored?.currentRevision).toBe(2);

    const replays = await auditEvents.find(tenant.tenant, {
      caseId: appealedCaseId,
      action: 'appeal.filed.replayed',
    });
    expect(replays).toHaveLength(1);
  });

  it('§10.5: the same key with a different appeal is a conflict, not a second filing', async () => {
    const conflicting = await fileAppealRequest(
      appealedCaseId,
      'appeal-key-1',
      filing({ reason: 'policy_misapplied' }),
    );

    expect(conflicting.status).toBe(409);
    expect(await appeals.countDocuments(tenant.tenant, { caseId: appealedCaseId })).toBe(1);
  });

  it('refuses a SECOND appeal of the same revision under a fresh key', async () => {
    const second = await fileAppealRequest(appealedCaseId, 'appeal-key-2', filing());

    /**
     * 409, and the message is the STATE check rather than the unique index: the
     * case is now at a revision whose jury is still working, and §9.8's appeal is
     * against a published decision. The index is the guard for the concurrent case
     * that this sequential one can never reach — see the last block in this file.
     */
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/already under review/);
    expect(await appeals.countDocuments(tenant.tenant, { caseId: appealedCaseId })).toBe(1);

    const stored = await cases.findOne(tenant.tenant, { caseId: appealedCaseId });
    expect(stored?.currentRevision).toBe(2);
  });
});

describe('§9.8: the appeal is decided, and a changed outcome is a correction', () => {
  beforeAll(async () => {
    const second = await seatsOf(appealedCaseId, 2);
    /**
     * Four for `no_violation`, one against. §9.4's raised bar for this appeal is
     * FOUR, so this is the tightest panel that decides — three would expand.
     */
    for (const [index, reviewerId] of second.entries()) {
      await vote(reviewerId, index === 4 ? 'violation' : 'no_violation');
    }

    await drainUntil(
      async () => (await decisions.countDocuments(tenant.tenant, { caseId: appealedCaseId })) === 2,
      'the appeal decision',
    );
  }, 240_000);

  it('publishes revision 2 as a new row that names what it replaced', async () => {
    const [second] = await decisions.find(tenant.tenant, { caseId: appealedCaseId, revision: 2 });

    expect(second.status).toBe('final');
    expect(second.outcome).toBe('no_violation');
    expect(second.supersedesDecisionId).toBe(firstDecisionId);
    expect(second.jury).toMatchObject({ size: 5, decisiveVotes: 5, winningVotes: 4 });
  });

  it('§10.6: emits `appeal.decided` and `decision.corrected`, alongside `case.decided`', async () => {
    const decided = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.appealDecided,
      'payload.caseId': appealedCaseId,
    });
    expect(decided).toHaveLength(1);

    const [appeal] = await appeals.find(tenant.tenant, { caseId: appealedCaseId });
    expect(decided[0].payload.appealId).toBe(appeal.appealId);

    const corrections = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.decisionCorrected,
      'payload.caseId': appealedCaseId,
    });
    expect(corrections).toHaveLength(1);

    const published = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.caseDecided,
      'payload.caseId': appealedCaseId,
    });
    expect(published).toHaveLength(2);
  });

  it('delivers `appeal.decided` with the decision that answered it', async () => {
    const mine = { webhookEndpointId, eventType: 'appeal.decided' };
    await drainUntil(
      async () => (await webhookDeliveries.find(mine)).length > 0,
      'an appeal.decided delivery',
    );

    const [delivered] = await webhookDeliveries.find(mine);
    const payload = JSON.parse(delivered.body);

    expect(payload.type).toBe('appeal.decided');
    expect(payload.data.caseId).toBe(appealedCaseId);
    expect(payload.data.appeal.status).toBe('decided');
    expect(payload.data.decision.revision).toBe(2);
    expect(payload.data.decision.outcome).toBe('no_violation');
    expect(payload.data.decision.supersedesDecisionId).toBe(firstDecisionId);
    expect(delivered.body).not.toContain('statement');
  });

  it('§9.7: the jurors the appeal overturned are not punished', async () => {
    /**
     * "No castigar automáticamente a una minoría. Solo reducir acceso ante
     * evidencia estadística o controles conocidos." Being overturned by a second
     * jury is neither, and nothing in this phase writes a reliability figure.
     */
    for (const reviewerId of firstJury) {
      const profile = await reviewerProfiles.findOne({ reviewerId });
      expect(profile?.state).not.toBe('suspended');
      expect(profile?.suspendedUntil).toBeNull();
      expect(profile?.available).toBe(true);
      expect(profile?.reliabilityByCategory[FAMILY]).toBeGreaterThan(0);
    }
  });

  it('a juror’s own revision stays resolvable after the appeal overturned it', async () => {
    /**
     * §4.1's Historial may show a reviewer "resultados que ya puedan revelarse",
     * and §9.1 hides only previous votes and PARTIAL results — so a reviewer
     * history surface discloses the outcome of the revision that reviewer judged.
     * This is the property such a surface depends on, asserted from this side
     * because supersession is what could break it.
     *
     * The join is `review.caseRevision` → `decision.revision`. Each revision-1
     * juror must resolve to the `violation` THEY produced, not to the
     * `no_violation` that replaced it — a surface keyed on `currentDecision`
     * instead would show them an outcome they never voted on and tell them, by
     * implication, that an appeal overturned them.
     */
    const current = await decisions.findOne(tenant.tenant, {
      caseId: appealedCaseId,
      revision: 2,
    });
    expect(current?.outcome).toBe('no_violation');

    for (const reviewerId of firstJury) {
      const [own] = await reviews.find({ caseId: appealedCaseId, reviewerId });
      expect(own.caseRevision, 'a revision-1 juror’s review moved revision').toBe(1);

      const judged = await decisions.findOne(tenant.tenant, {
        caseId: appealedCaseId,
        revision: own.caseRevision,
      });

      expect(judged?.outcome, 'the outcome this juror produced changed under them').toBe(
        'violation',
      );
      expect(judged?.decisionId).toBe(firstDecisionId);
      // And it is a DIFFERENT row from the one in force, so the two cannot be
      // confused by a surface that reads the case rather than the review.
      expect(judged?.decisionId).not.toBe(current?.decisionId);
    }
  });

  it('§10.2: the case now reports the revision in force, and keeps the history', async () => {
    const view = await request(app)
      .get(`/v1/cases/${appealedCaseId}`)
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(view.status).toBe(200);
    expect(view.body.currentRevision).toBe(2);
    expect(view.body.decision.revision).toBe(2);
    expect(view.body.decision.outcome).toBe('no_violation');

    const superseded = await request(app)
      .get(`/v1/decisions/${firstDecisionId}`)
      .set('Authorization', `Bearer ${tenant.token}`);
    expect(superseded.status).toBe(200);
    expect(superseded.body.outcome).toBe('violation');
    expect(superseded.body.status).toBe('superseded');
  });

  it('the decision that answered the appeal is now on the appeal itself', async () => {
    const [appeal] = await appeals.find(tenant.tenant, { caseId: appealedCaseId });
    const view = await fileAppealRequest(appealedCaseId, 'appeal-key-1', filing());

    // The retry path is also the read-back path, and it reports the appeal as
    // decided because a decision exists at the revision it opened — nothing stores
    // that status.
    expect(view.status).toBe(200);
    expect(view.body.id).toBe(appeal.appealId);
    expect(view.body.status).toBe('decided');
    expect(view.body.decision.revision).toBe(2);
  });
});

describe('§9.8: an appeal that is not eligible creates no revision', () => {
  /**
   * Three fixtures, because the refusals are about three different things and one
   * case cannot exercise them all. The ORDER of the checks is why: an appealable
   * decision has to exist before "who may file" is ever reached, so a case decided
   * `no_violation` answers 409 for every filing — and the appellant rules would go
   * untested while every assertion passed.
   */
  async function decideOwnCase(
    subject: string,
    language: string,
    outcome: 'violation' | 'no_violation',
  ): Promise<string> {
    for (let index = 0; index < 4; index += 1) {
      await createReviewer({
        family: FAMILY,
        languages: [language],
        reliability: index === 3 ? 0.4 : 0.9,
        completedReviewCount: index === 3 ? 0 : 40,
      });
    }

    const caseId = await openCase(subject, language);
    await drainUntil(
      async () => (await seatsOf(caseId, 1)).length === 3,
      `a panel for the ${subject} case`,
    );
    for (const reviewerId of await seatsOf(caseId, 1)) {
      await vote(reviewerId, outcome);
    }
    await drainUntil(
      async () => (await decisions.countDocuments(tenant.tenant, { caseId })) === 1,
      `the ${subject} decision`,
    );
    return caseId;
  }

  beforeAll(async () => {
    clearedCaseId = await decideOwnCase('cleared', CLEARED_LANGUAGE, 'no_violation');
    refusedCaseId = await decideOwnCase('refused', REFUSED_LANGUAGE, 'violation');
    undecidedCaseId = await openCase('undecided', UNSERVED_LANGUAGE);
  }, 240_000);

  async function expectNoRevision(caseId: string): Promise<void> {
    const stored = await cases.findOne(tenant.tenant, { caseId });
    expect(stored?.currentRevision).toBe(1);
    expect(stored?.status).not.toBe('appealed');
    expect(await appeals.countDocuments(tenant.tenant, { caseId })).toBe(0);
    expect(await decisions.countDocuments(tenant.tenant, { caseId, revision: 2 })).toBe(0);
    expect(await assignments.find({ caseId, caseRevision: 2 })).toHaveLength(0);
    expect(
      await outboxEvents.find({
        type: OUTBOX_EVENT_TYPES.appealCreated,
        'payload.caseId': caseId,
      }),
    ).toHaveLength(0);
  }

  it('refuses an appeal against a decision that found no violation', async () => {
    /**
     * §9.8 covers decisions "con consecuencias relevantes". A `no_violation`
     * decided in the author's favour; there is nothing to appeal, and opening a
     * revision would put the author back in front of a jury they had already won
     * in front of.
     */
    const refused = await fileAppealRequest(clearedCaseId, 'appeal-cleared', filing());

    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/no consequence to appeal/);
    await expectNoRevision(clearedCaseId);
  });

  it('refuses an appeal against a case no jury has decided yet', async () => {
    const refused = await fileAppealRequest(undecidedCaseId, 'appeal-undecided', filing());

    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/no published decision/);
    await expectNoRevision(undecidedCaseId);
  });

  it('§9.8: refuses anybody the reported material does not identify', async () => {
    /**
     * "El autor puede aportar una explicación." A reporter is referenced by an
     * allegation and never by the material (see `contentSnapshot.ts`), so their id
     * is not among the case's principals — which is what makes this check
     * meaningful rather than a formality.
     */
    const refused = await fileAppealRequest(
      refusedCaseId,
      'appeal-reporter',
      filing({ appellantExternalPrincipalId: REPORTER }),
    );

    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/principal the reported material identifies/);
    await expectNoRevision(refusedCaseId);
  });

  it('refuses an unrelated account the application happens to know about', async () => {
    const refused = await fileAppealRequest(
      refusedCaseId,
      'appeal-stranger',
      filing({ appellantExternalPrincipalId: 'user_someone_else' }),
    );

    expect(refused.status).toBe(403);
    await expectNoRevision(refusedCaseId);
  });

  it('refuses additional context that points at material outside the case', async () => {
    const refused = await fileAppealRequest(
      refusedCaseId,
      'appeal-foreign-resource',
      filing({
        authorContext: { statement: 'see the other post', resourceIds: ['res_elsewhere'] },
      }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/not part of this case/);
    await expectNoRevision(refusedCaseId);
  });

  it('refuses a filing with no retry key at all', async () => {
    const refused = await request(app)
      .post(`/v1/cases/${refusedCaseId}/appeals`)
      .set('Authorization', `Bearer ${tenant.token}`)
      .send(filing());

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/Idempotency-Key/);
    await expectNoRevision(refusedCaseId);
  });

  it('refuses a retry key that is not a key at all', async () => {
    const refused = await fileAppealRequest(refusedCaseId, 'not a valid key!', filing());

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/Idempotency-Key/);
    await expectNoRevision(refusedCaseId);
  });

  it('answers 404 for a value that is not a case id at all', async () => {
    // The same answer another tenant's case gets: the id shape check only saves a
    // query, and telling the two apart would say which ids are real.
    const refused = await fileAppealRequest('not-a-case-id', 'appeal-bad-id', filing());

    expect(refused.status).toBe(404);
  });

  it('refuses a body the contract does not accept', async () => {
    const refused = await fileAppealRequest(
      refusedCaseId,
      'appeal-invalid',
      filing({ reason: 'because_i_say_so' }),
    );

    expect(refused.status).toBe(400);
    await expectNoRevision(refusedCaseId);
  });
});

describe('phase 4’s bug, under the new ladder: the replay guard is scoped by REVISION', () => {
  /**
   * The single worst failure this phase can have, and it has happened once already.
   *
   * `handleCaseReadyForReview`'s replay guard asks whether the case already has a
   * panel. Phase 4 found it UNSCOPED — it looked at every assignment on the case —
   * so the moment revision 2 existed, revision 1's three assignments convinced the
   * handler a panel was already open and the appeal jury was never drawn. Silently:
   * the outbox row was marked dispatched, no error was logged, and the author had
   * been told their case was being reviewed again.
   *
   * Phase 8 gives a revision > 1 a second reason to exist and a DIFFERENT panel
   * shape, so the earlier fix is not something to take on trust. This exercises the
   * exact pre-state of that bug: a case at revision 2, revision 1 still carrying its
   * three assignments, revision 2 carrying none, and the handler invoked directly.
   *
   * The handler is called DIRECTLY rather than through the outbox because the
   * pre-state has to be observed between the filing and the draw, and a dispatcher
   * pass would close that window. Nothing else in this process drains — the polling
   * loop belongs to `server.ts` and no test starts it.
   */
  const REPLAY_LANGUAGE = 'lmo';
  let replayCaseId: string;

  function readyEvent(caseId: string) {
    return {
      eventId: `evt_replay_${Date.now()}`,
      organizationId: tenant.tenant.organizationId,
      applicationId: tenant.tenant.applicationId,
      type: OUTBOX_EVENT_TYPES.caseReadyForReview,
      payload: { caseId },
      status: 'dispatching' as const,
      attempts: 1,
      availableAt: new Date(),
      dispatchedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeAll(async () => {
    /**
     * Ten: three for the first panel, five for the appeal panel that may share
     * nobody with it, and slack so §8.3's slots stay fillable from what is left.
     */
    for (let index = 0; index < 10; index += 1) {
      await createReviewer({
        family: FAMILY,
        languages: [REPLAY_LANGUAGE],
        reliability: index % 4 === 3 ? 0.4 : 0.9,
        completedReviewCount: index % 4 === 3 ? 0 : 40,
      });
    }

    replayCaseId = await openCase('replay', REPLAY_LANGUAGE);
    await drainUntil(
      async () => (await seatsOf(replayCaseId, 1)).length === 3,
      'a panel for the replay case',
    );
    for (const reviewerId of await seatsOf(replayCaseId, 1)) await vote(reviewerId, 'violation');
    await drainUntil(
      async () => (await decisions.countDocuments(tenant.tenant, { caseId: replayCaseId })) === 1,
      'the replay case decision',
    );
  }, 240_000);

  it('draws the appeal jury even though revision 1 already has a full panel', async () => {
    const filed = await fileAppealRequest(replayCaseId, 'appeal-replay', filing());
    expect(filed.status).toBe(201);

    // The pre-state of the bug, asserted rather than assumed: if revision 2 already
    // had seats here, the draw below would prove nothing.
    expect(await seatsOf(replayCaseId, 1), 'revision 1 lost its panel').toHaveLength(3);
    expect(await seatsOf(replayCaseId, 2), 'revision 2 was drawn before the handler ran').toHaveLength(0);

    await handleCaseReadyForReview(readyEvent(replayCaseId));

    const appealPanel = await seatsOf(replayCaseId, 2);
    expect(appealPanel, 'the appeal was never empanelled').toHaveLength(5);
    // And revision 1's seats are untouched: a new panel is drawn, not a moved one.
    expect(await seatsOf(replayCaseId, 1)).toHaveLength(3);
    for (const reviewerId of appealPanel) {
      expect(await seatsOf(replayCaseId, 1)).not.toContain(reviewerId);
    }
  });

  it('and a genuinely replayed event draws no second panel', async () => {
    await handleCaseReadyForReview(readyEvent(replayCaseId));
    await handleCaseReadyForReview(readyEvent(replayCaseId));

    expect(await seatsOf(replayCaseId, 2)).toHaveLength(5);
    const draws = await sortitionDraws.find({ caseId: replayCaseId, caseRevision: 2 });
    expect(draws, 'a replay drew a second panel').toHaveLength(1);
  });

  it('refuses an event naming a case that does not exist, rather than doing nothing', async () => {
    /**
     * The other half of "silently": a handler that returned quietly for a case it
     * could not find would mark the row dispatched and lose the work. It throws, so
     * the row stays pending and an operator sees it.
     */
    await expect(handleCaseReadyForReview(readyEvent('case_missing'))).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe('two appeals of one decision, filed at the same instant', () => {
  /**
   * The concurrency the unique index and the revision swap exist for.
   *
   * Two filings under DIFFERENT keys both pass the eligibility checks — the case
   * is decided and neither has been stored yet — so nothing before the write can
   * separate them. Exactly one must win, because two revisions for one appeal would
   * mean two panels drawn for the same case revision and the second one's ballots
   * counting toward a revision already being decided.
   */
  const RACE_LANGUAGE = 'fur';
  const KEY_RACE_LANGUAGE = 'rm';
  let raceCaseId: string;
  let keyRaceCases: readonly string[];

  beforeAll(async () => {
    for (let index = 0; index < 4; index += 1) {
      await createReviewer({
        family: FAMILY,
        languages: [RACE_LANGUAGE],
        reliability: index === 3 ? 0.4 : 0.9,
        completedReviewCount: index === 3 ? 0 : 40,
      });
    }

    raceCaseId = await openCase('race', RACE_LANGUAGE);
    await drainUntil(
      async () => (await seatsOf(raceCaseId, 1)).length === 3,
      'a panel for the raced case',
    );
    for (const reviewerId of await seatsOf(raceCaseId, 1)) await vote(reviewerId, 'violation');
    await drainUntil(
      async () => (await decisions.countDocuments(tenant.tenant, { caseId: raceCaseId })) === 1,
      'the raced decision',
    );

    /**
     * Two more decided cases for the KEY race below, which needs two of them: a
     * pair of filings under one key must collide on the key index and nothing else,
     * and two filings against the same case would also collide on the revision.
     */
    for (let index = 0; index < 8; index += 1) {
      await createReviewer({
        family: FAMILY,
        languages: [KEY_RACE_LANGUAGE],
        reliability: index % 4 === 3 ? 0.4 : 0.9,
        completedReviewCount: index % 4 === 3 ? 0 : 40,
      });
    }

    const opened: string[] = [];
    for (const name of ['key-race-a', 'key-race-b']) {
      const caseId = await openCase(name, KEY_RACE_LANGUAGE);
      await drainUntil(
        async () => (await seatsOf(caseId, 1)).length === 3,
        `a panel for ${name}`,
      );
      for (const reviewerId of await seatsOf(caseId, 1)) await vote(reviewerId, 'violation');
      await drainUntil(
        async () => (await decisions.countDocuments(tenant.tenant, { caseId })) === 1,
        `the ${name} decision`,
      );
      opened.push(caseId);
    }
    keyRaceCases = opened;
  }, 240_000);

  it('files one appeal, opens one revision, and refuses the other', async () => {
    const [left, right] = await Promise.all([
      fileAppealRequest(raceCaseId, 'appeal-race-a', filing()),
      fileAppealRequest(raceCaseId, 'appeal-race-b', filing()),
    ]);

    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([201, 409]);

    expect(await appeals.countDocuments(tenant.tenant, { caseId: raceCaseId })).toBe(1);

    const stored = await cases.findOne(tenant.tenant, { caseId: raceCaseId });
    expect(stored?.currentRevision).toBe(2);

    const created = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.appealCreated,
      'payload.caseId': raceCaseId,
    });
    expect(created).toHaveLength(1);
  });

  it('§10.4: one retry key cannot be spent on two different cases, even at once', async () => {
    /**
     * The other collision, isolated so it is DETERMINISTIC.
     *
     * Two filings against the same case violate both unique indexes at once, and
     * which one MongoDB reports is its choice — so that race exercises either catch
     * branch from run to run, which is fine for the invariant and useless as
     * coverage. Two filings under one key against two DIFFERENT cases can only
     * collide on `applicationId + idempotencyKey`, so the key branch is the one
     * taken, every time.
     *
     * And the behaviour is worth having on its own: a key already spent on another
     * case is a 409 rather than a replay, because the fingerprint covers the case
     * id — returning the first case's appeal would tell the caller their second
     * appeal succeeded when nothing was filed for it.
     */
    const [left, right] = await Promise.all([
      fileAppealRequest(keyRaceCases[0], 'appeal-shared-key', filing()),
      fileAppealRequest(keyRaceCases[1], 'appeal-shared-key', filing()),
    ]);

    expect([left.status, right.status].sort()).toEqual([201, 409]);

    // Exactly one appeal exists across BOTH cases, and only the winner's case moved.
    const filedFor = await Promise.all(
      keyRaceCases.map(async (caseId) => appeals.countDocuments(tenant.tenant, { caseId })),
    );
    expect(filedFor.reduce((total, count) => total + count, 0)).toBe(1);

    const revisions = await Promise.all(
      keyRaceCases.map(async (caseId) => (await cases.findOne(tenant.tenant, { caseId }))?.currentRevision),
    );
    expect([...revisions].sort()).toEqual([1, 2]);
  });
});

describe('the fan-out refuses an appeal event it cannot read back', () => {
  /**
   * Throwing rather than returning keeps the outbox row PENDING instead of marking
   * work done that nobody did. An appeal the tenant was never told about is an
   * author waiting for a webhook that will never arrive, and the row is the only
   * record that it should have been sent.
   */
  function orphanEvent(payload: Record<string, string>) {
    return {
      eventId: `evt_orphan_appeal_${Date.now()}`,
      organizationId: tenant.tenant.organizationId,
      applicationId: tenant.tenant.applicationId,
      type: OUTBOX_EVENT_TYPES.appealCreated,
      payload,
      status: 'dispatching' as const,
      attempts: 1,
      availableAt: new Date(),
      dispatchedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it('refuses an event that names no appeal', async () => {
    await expect(fanOutWebhookEvent(orphanEvent({ caseId: appealedCaseId }))).rejects.toThrow(
      /could not be read/,
    );
  });

  it('refuses an event naming an appeal this tenant does not own', async () => {
    await expect(
      fanOutWebhookEvent(orphanEvent({ caseId: appealedCaseId, appealId: 'apl_missing' })),
    ).rejects.toThrow(/could not be read/);
  });
});

describe('an appeal reaches only the tenant’s own cases, with the right scope', () => {
  it('answers 404 for another tenant’s case, the same as for one that never existed', async () => {
    const other = await provisionApplication(tenant.organizationId, SCOPES);

    const refused = await request(app)
      .post(`/v1/cases/${appealedCaseId}/appeals`)
      .set('Authorization', `Bearer ${other.token}`)
      .set('Idempotency-Key', 'appeal-other-tenant')
      .send(filing());

    expect(refused.status).toBe(404);
    expect(await appeals.countDocuments(other.tenant, {})).toBe(0);
  });

  it('refuses a credential that may read cases but not appeal them', async () => {
    const readOnly = await provisionApplication(tenant.organizationId, [
      'crowdsource:reports:write',
      'crowdsource:cases:read',
    ]);

    const refused = await request(app)
      .post(`/v1/cases/${appealedCaseId}/appeals`)
      .set('Authorization', `Bearer ${readOnly.token}`)
      .set('Idempotency-Key', 'appeal-no-scope')
      .send(filing());

    expect(refused.status).toBe(403);
  });

  it('refuses a reviewer session, which is a different caller class entirely', async () => {
    const refused = await request(app)
      .post(`/v1/cases/${appealedCaseId}/appeals`)
      .set(asReviewer('oxy_reviewer_trying_to_appeal'))
      .set('Idempotency-Key', 'appeal-reviewer-session')
      .send(filing());

    expect(refused.status).toBe(401);
  });
});
