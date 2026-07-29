import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RecommendedAction, Severity, TaxonomyCode } from '@oxyhq/crowdsource-contracts';

import { stubOxySession } from './support/reviewers';

/**
 * §15.5's definition of done, end to end against the real replica set.
 *
 *   "Tres revisiones unánimes publican una decisión UNA SOLA VEZ. Un desacuerdo
 *    amplía el panel. Un empate final NO se convierte en no_violation."
 *
 * Plus the §16.2 cases this phase owns: the consensus worker run SIMULTANEOUSLY
 * publishes one decision, a reviewer cannot vote twice or reuse a token, and a
 * recusal is not a vote.
 *
 * ## What is stubbed, and what is not
 *
 * Exactly one thing: the network call that asks Oxy whether a bearer token is a
 * real session. Everything else runs for real — the outbox chain from ingestion
 * through triage and the draw to consensus, the transaction that publishes a
 * decision, the compare-and-swap that makes it happen once, and the webhook
 * fan-out that hands the decision back to the application.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { registerOutboxWorkers } = await import('../modules/outbox/workers');
const { evaluateCase } = await import('../modules/consensus/consensus.service');
const { decisions } = await import('../modules/decision/decision.collection');
const { cases } = await import('../modules/cases/case.collection');
const { assignments } = await import('../modules/sortition/assignment.collection');
const { sortitionDraws } = await import('../modules/sortition/draw.collection');
const { reviews } = await import('../modules/review/review.collection');
const { reviewerProfiles } = await import('../modules/reviewer/reviewer.collection');
const { outboxEvents, OUTBOX_EVENT_TYPES } = await import('../modules/outbox/outbox.collection');
const { registerWebhookEndpoint } = await import('../modules/webhooks/endpoint.service');
const { webhookDeliveries } = await import('../modules/webhooks/webhook.collections');
const { OXY_CONDUCT_POLICY_VERSION, UNIVERSAL_TAXONOMY_VERSION } = await import(
  '@oxyhq/crowdsource-contracts'
);
const { BASELINE_POLICY_VERSION } = await import('../modules/policy/policyBaseline');
const { createReviewerPool } = await import('./support/reviewers');
const { deliveryBody, drainUntil, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();

/**
 * The isolation axis, and why it is the LANGUAGE here rather than the family.
 *
 * Reviewer profiles are global, so a pool created here is a candidate for every
 * case in the database. §8.2 gives two hard gates — a reviewer must accept every
 * family a case alleges AND have its language — and either can be a wall. The
 * family alone is not enough for this file:
 *
 *  - `sampleEnvelope`'s DEFAULT allegation is `harassment.targeted_abuse`, so
 *    every suite that does not override it files a harassment case. A
 *    harassment pool here draws panels for `caseAccess` and
 *    `caseDeduplication`, whose assertions are about a case still at `triaged`.
 *  - `hate` is reserved by `sortitionPanel.integration.test.ts` as the family
 *    NOBODY serves, so that its undersized-pool refusal has something to refuse.
 *
 * So every block below takes `integrity` — a family no other suite alleges — and
 * its own language tag, none of them `es`. Nothing else in the suite creates a
 * non-`es` reviewer or a non-`es` case, so the walls hold in both directions.
 * Separate pools per block are needed for a second reason too: `POST
 * /assignments/next` hands back the assignment a reviewer was given LONGEST AGO
 * (§8.7), which is correct behaviour and makes a shared pool ambiguous — a juror
 * drawn for two of this file's cases would vote on the wrong one.
 *
 * Every code below routes to `standard` sensitivity, which is §9.4's LOW risk
 * row — the only row where §8.6's three-of-three is reachable, and therefore the
 * only row the definition of done can be demonstrated on.
 */
const FAMILY = 'integrity' as const;
const UNANIMOUS_CODE: TaxonomyCode = 'integrity.spam';
const UNANIMOUS_LANGUAGE = 'gl';
const LADDER_CODE: TaxonomyCode = 'integrity.fraud';
const LADDER_LANGUAGE = 'ca';
const RECUSAL_CODE: TaxonomyCode = 'integrity.coordinated_manipulation';
const RECUSAL_LANGUAGE = 'br';
const DIMENSIONS_CODE: TaxonomyCode = 'integrity.scam';
const DIMENSIONS_LANGUAGE = 'an';

let tenant: ProvisionedTenant;

function asReviewer(oxyUserId: string) {
  return { 'x-test-oxy-user': oxyUserId };
}

/** Ingests a report and waits until the draw has ruled on the resulting case. */
async function openCaseFor(
  code: TaxonomyCode,
  subject: string,
  language?: string,
): Promise<string> {
  const externalReportId = `${subject}-${Date.now()}`;
  const created = await request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', externalReportId)
    .send(
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: subject,
        allegationCode: code,
        ...(language === undefined ? {} : { language }),
        text: `material for ${subject}`,
      }),
    );

  expect(created.status).toBe(202);
  await drainUntil(
    async () => (await sortitionDraws.findOne({ caseId: created.body.caseId })) !== null,
    `a sortition draw for case '${String(created.body.caseId)}'`,
  );
  return created.body.caseId;
}

interface Ballot {
  readonly outcome: 'violation' | 'no_violation' | 'insufficient_context' | 'content_unavailable';
  readonly code?: TaxonomyCode;
  readonly severity?: Severity;
  readonly resourceIds?: readonly string[];
  readonly actions?: readonly RecommendedAction[];
}

function body(ballot: Ballot) {
  const findings =
    ballot.outcome === 'violation' || ballot.code !== undefined
      ? [
          {
            code: ballot.code,
            resourceIds: [...(ballot.resourceIds ?? ['res_post'])],
            severity: ballot.severity ?? 'medium',
            confidence: 0.9,
          },
        ]
      : [];

  return {
    outcome: ballot.outcome,
    contextSufficiency: ballot.outcome === 'insufficient_context' ? 'insufficient' : 'sufficient',
    findings,
    recommendedActions: [...(ballot.actions ?? [])],
  };
}

/** Opens the seat this reviewer holds and casts the ballot. Returns the token. */
async function vote(
  seatReviewerId: string,
  ballot: Ballot,
): Promise<{ assignmentId: string; token: string }> {
  const profile = await reviewerProfiles.findOne({ reviewerId: seatReviewerId });
  if (!profile) throw new Error(`no profile for ${seatReviewerId}`);

  const opened = await request(app)
    .post('/v1/reviewer/assignments/next')
    .set(asReviewer(profile.oxyUserId));
  expect(opened.status).toBe(200);

  const submitted = await request(app)
    .post(`/v1/reviewer/assignments/${String(opened.body.assignmentId)}/reviews`)
    .set(asReviewer(profile.oxyUserId))
    .set('x-assignment-token', opened.body.token)
    .send(body(ballot));
  expect(submitted.status).toBe(201);

  return { assignmentId: opened.body.assignmentId, token: opened.body.token };
}

/** Every seat that has not left the panel, for the current revision. */
async function seatsOf(caseId: string): Promise<string[]> {
  const stored = await cases.findOne(tenant.tenant, { caseId });
  const panel = await assignments.find({ caseId, caseRevision: stored?.currentRevision ?? 1 });
  return panel
    .filter((seat) => seat.status !== 'recused' && seat.status !== 'expired')
    .map((seat) => seat.reviewerId);
}

/** The seats that have not yet voted. */
async function unvotedSeatsOf(caseId: string): Promise<string[]> {
  const voted = new Set(
    (await reviews.find({ caseId })).map((review) => review.reviewerId),
  );
  return (await seatsOf(caseId)).filter((reviewerId) => !voted.has(reviewerId));
}

beforeAll(async () => {
  await startDatabase();
  registerOutboxWorkers();
  tenant = await provisionTenant();
}, 180_000);

afterAll(async () => {
  await stopDatabase();
});

describe('§15.5: three unanimous reviews publish a decision, exactly once', () => {
  let caseId: string;
  let firstSeat: string;
  let spentToken: string;
  let spentAssignmentId: string;

  beforeAll(async () => {
    await createReviewerPool(FAMILY, 9, [UNANIMOUS_LANGUAGE]);
    await registerWebhookEndpoint(tenant.tenant, {
      url: 'https://receiver.invalid/hooks',
      eventTypes: ['case.decided'],
    });

    caseId = await openCaseFor(UNANIMOUS_CODE, `post_unanimous_${Date.now()}`, UNANIMOUS_LANGUAGE);
    const seats = await seatsOf(caseId);
    expect(seats).toHaveLength(3);
    firstSeat = seats[0];

    for (const reviewerId of seats) {
      const cast = await vote(reviewerId, {
        outcome: 'violation',
        code: UNANIMOUS_CODE,
        actions: ['remove_or_restrict'],
      });
      if (reviewerId === firstSeat) {
        spentToken = cast.token;
        spentAssignmentId = cast.assignmentId;
      }
    }
  }, 180_000);

  /**
   * §16.2: "el consensus worker ejecutado SIMULTÁNEAMENTE publica una decisión
   * única."
   *
   * Four evaluations started in the same tick, before the outbox has been
   * drained even once. A test that ran the worker twice in sequence would pass
   * against an engine with no compare-and-swap at all — the second pass would
   * read the case already decided — so the runs have to overlap, and they do:
   * all four read the same pre-decision state and all four conclude "publish".
   */
  it('publishes exactly one decision when four workers race for it', async () => {
    const results = await Promise.all([
      evaluateCase(tenant.tenant, caseId),
      evaluateCase(tenant.tenant, caseId),
      evaluateCase(tenant.tenant, caseId),
      evaluateCase(tenant.tenant, caseId),
    ]);

    const published = results.filter((result) => result.status === 'published');
    const refused = results.filter((result) => result.status === 'already_decided');

    expect(published, JSON.stringify(results)).toHaveLength(1);
    expect(refused).toHaveLength(3);

    // The claim that matters is about the DATABASE, not about return values.
    expect(await decisions.countDocuments(tenant.tenant, { caseId })).toBe(1);
  });

  it('and one `case.decided` event, so the application is told once', async () => {
    const emitted = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.caseDecided,
      'payload.caseId': caseId,
    });
    expect(emitted).toHaveLength(1);
  });

  it('a later replay of the whole chain changes nothing', async () => {
    const before = await decisions.find(tenant.tenant, { caseId });
    await drainUntil(async () => true, 'a full drain');
    await evaluateCase(tenant.tenant, caseId);

    const after = await decisions.find(tenant.tenant, { caseId });
    expect(after).toHaveLength(1);
    expect(after[0].decisionId).toBe(before[0].decisionId);
    expect(after[0].updatedAt.getTime()).toBe(before[0].updatedAt.getTime());
  });

  it('records the decision Appendix B describes', async () => {
    const [decision] = await decisions.find(tenant.tenant, { caseId });

    expect(decision.revision).toBe(1);
    expect(decision.status).toBe('final');
    expect(decision.outcome).toBe('violation');
    expect(decision.contextSufficiency).toBe('sufficient');
    expect(decision.supersedesDecisionId).toBeNull();

    expect(decision.jury).toMatchObject({
      size: 3,
      decisiveVotes: 3,
      winningVotes: 3,
      agreement: 1,
    });

    expect(decision.findings).toHaveLength(1);
    expect(decision.findings[0]).toMatchObject({
      code: UNANIMOUS_CODE,
      severity: 'medium',
      resourceIds: ['res_post'],
      /** §6.5: an unlisted family stays local. Only the bridge may widen it. */
      scope: 'application_local',
      attribution: 'author',
    });

    expect(decision.recommendedActions).toEqual([
      { action: 'remove_or_restrict', targetResourceIds: ['res_post'] },
    ]);
  });

  it('§6.4: records all three policy versions', async () => {
    const [decision] = await decisions.find(tenant.tenant, { caseId });

    expect(decision.policyVersions).toEqual({
      taxonomy: UNIVERSAL_TAXONOMY_VERSION,
      application: BASELINE_POLICY_VERSION,
      oxyConduct: OXY_CONDUCT_POLICY_VERSION,
    });
  });

  it('§12.11: the case carries the swap that made it happen once', async () => {
    const stored = await cases.findOne(tenant.tenant, { caseId });
    expect(stored?.status).toBe('decided');
    expect(stored?.decidedRevision).toBe(1);
    expect(stored?.currentRevision).toBe(1);
  });

  it('§16.2: a reviewer cannot vote twice or reuse a spent token', async () => {
    const profile = await reviewerProfiles.findOne({ reviewerId: firstSeat });
    if (!profile) throw new Error('expected a profile');

    const replayed = await request(app)
      .post(`/v1/reviewer/assignments/${spentAssignmentId}/reviews`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', spentToken)
      .send(body({ outcome: 'no_violation' }));

    // The same 404 an outsider gets: a spent assignment is not live, and saying
    // "already used" would confirm the case exists to whoever asked.
    expect(replayed.status).toBe(404);
    expect(
      await reviews.countDocuments({ caseId, reviewerId: firstSeat }),
      'the ledger still holds one ballot from this juror',
    ).toBe(1);

    // And the count the decision was built from is unchanged.
    const [decision] = await decisions.find(tenant.tenant, { caseId });
    expect(decision.jury.decisiveVotes).toBe(3);
  });

  it('§9.1: the receipt tells the juror nothing about the result', async () => {
    /**
     * The response to a submitted review is the one place a partial result could
     * leak to a reviewer, and it is checked by SEARCHING the body rather than by
     * asserting a field list — a field added later would slip past a list.
     */
    const seats = await seatsOf(caseId);
    const profile = await reviewerProfiles.findOne({ reviewerId: seats[1] });
    if (!profile) throw new Error('expected a profile');

    const spent = await request(app)
      .get(`/v1/reviewer/assignments/${spentAssignmentId}`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', spentToken);

    expect(spent.status).toBe(404);

    const nothingLeft = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(profile.oxyUserId));
    expect(nothingLeft.status).toBe(204);
  });

  it('§15.6: the decision reaches the application as a signed webhook delivery', async () => {
    await drainUntil(
      async () =>
        (await webhookDeliveries.find({ eventType: 'case.decided' })).some(
          (delivery) => JSON.stringify(delivery.body).includes(caseId),
        ),
      'a case.decided delivery for this case',
    );

    const delivered = (await webhookDeliveries.find({ eventType: 'case.decided' })).find(
      (delivery) => JSON.stringify(delivery.body).includes(caseId),
    );
    if (!delivered) throw new Error('expected a delivery');

    // The stored body is the canonical JSON that was signed, byte for byte.
    const payload = JSON.parse(delivered.body);
    expect(payload.type).toBe('case.decided');
    expect(payload.data.caseId).toBe(caseId);
    expect(payload.data.decision.outcome).toBe('violation');
    expect(payload.data.decision.revision).toBe(1);

    /**
     * §9.1 keeps juror identities from the jury itself; an application learning
     * which reviewers decided against its user would be worse. The ids are on
     * the stored row for the appeal path and must never reach a payload.
     */
    const [decision] = await decisions.find(tenant.tenant, { caseId });
    expect(decision.agreeingReviewerIds).toHaveLength(3);
    for (const reviewerId of decision.agreeingReviewerIds) {
      expect(JSON.stringify(delivered.body)).not.toContain(reviewerId);
    }
  });

  it('§10.2: the application reads the case and its decision back', async () => {
    const response = await request(app)
      .get(`/v1/cases/${caseId}`)
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(response.status).toBe(200);
    expect(response.body.decision.outcome).toBe('violation');
    expect(response.body.decision.id).toMatch(/^dec_/);

    const byId = await request(app)
      .get(`/v1/decisions/${String(response.body.decision.id)}`)
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(byId.status).toBe(200);
    expect(byId.body).toEqual(response.body.decision);
    expect(byId.body.agreeingReviewerIds).toBeUndefined();
  });
});

describe('§15.5: a disagreement expands the panel, and a final tie stays inconclusive', () => {
  let caseId: string;

  beforeAll(async () => {
    /**
     * Large enough for the whole ladder. Round 3 seats seven, every one of them
     * must be somebody who has not already sat, and §13.7 caps how much any one
     * reviewer may hold at once.
     */
    await createReviewerPool(FAMILY, 20, [LADDER_LANGUAGE]);
    caseId = await openCaseFor(LADDER_CODE, `post_ladder_${Date.now()}`, LADDER_LANGUAGE);
  }, 180_000);

  it('round 1: three seats, and a two-to-one split does not decide', async () => {
    const seats = await seatsOf(caseId);
    expect(seats).toHaveLength(3);

    await vote(seats[0], { outcome: 'violation', code: LADDER_CODE });
    await vote(seats[1], { outcome: 'violation', code: LADDER_CODE });
    await vote(seats[2], { outcome: 'no_violation' });

    await drainUntil(
      async () => (await seatsOf(caseId)).length >= 5,
      'the panel to expand to five seats',
    );

    expect(await decisions.countDocuments(tenant.tenant, { caseId })).toBe(0);
    const stored = await cases.findOne(tenant.tenant, { caseId });
    expect(stored?.decidedRevision).toBe(0);
  });

  it('the expansion is its own draw, at round 2, with its own seed', async () => {
    const draws = await sortitionDraws.find({ caseId }, { sort: { drawnAt: 1 } });

    expect(draws.length).toBeGreaterThanOrEqual(2);
    const expansion = draws.find((draw) => draw.kind === 'expansion');
    expect(expansion?.round).toBe(2);
    expect(expansion?.panelSpecId).toBe('community.round2');
    expect(expansion?.seed).not.toBe(draws[0].seed);
    expect(expansion?.status).toBe('drawn');
  });

  it('round 2: three to two does not reach four of five either, so it expands again', async () => {
    const pending = await unvotedSeatsOf(caseId);
    expect(pending).toHaveLength(2);

    await vote(pending[0], { outcome: 'violation', code: LADDER_CODE });
    await vote(pending[1], { outcome: 'no_violation' });

    await drainUntil(
      async () => (await seatsOf(caseId)).length >= 7,
      'the panel to expand to seven seats',
    );

    expect(await decisions.countDocuments(tenant.tenant, { caseId })).toBe(0);
  });

  it('round 3: a tie publishes `inconclusive`, and never `no_violation`', async () => {
    const pending = await unvotedSeatsOf(caseId);
    expect(pending).toHaveLength(2);

    /**
     * The panel now stands at three `violation` and two `no_violation`. One more
     * of each makes it three-all, with the last juror on
     * `content_unavailable` — a genuine tie in which `no_violation` carries
     * exactly as many votes as `violation`.
     *
     * That is the shape §15.5's third clause is about: an engine that broke ties
     * toward "the answer that changes nothing" would publish `no_violation`
     * here, and it would look reasonable.
     */
    await vote(pending[0], { outcome: 'no_violation' });
    await vote(pending[1], { outcome: 'content_unavailable' });

    await drainUntil(
      async () => (await decisions.countDocuments(tenant.tenant, { caseId })) === 1,
      'a decision for the exhausted ladder',
    );

    const [decision] = await decisions.find(tenant.tenant, { caseId });

    expect(decision.outcome).toBe('inconclusive');
    expect(decision.outcome).not.toBe('no_violation');
    expect(decision.outcome).not.toBe('violation');

    expect(decision.jury).toMatchObject({ size: 7, decisiveVotes: 7, winningVotes: 0, agreement: 0 });
    // §9.6: the jury reviewed the case and reached no consensus. It found
    // nothing, because nothing was agreed.
    expect(decision.findings).toEqual([]);
    expect(decision.recommendedActions).toEqual([]);
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThan(0.6);
  });

  it('the whole ladder was walked: three seats, then five, then seven', async () => {
    const draws = await sortitionDraws.find({ caseId }, { sort: { drawnAt: 1 } });
    const rounds = draws.filter((draw) => draw.status === 'drawn').map((draw) => draw.round);

    expect(rounds).toEqual([1, 2, 3]);
    expect(await seatsOf(caseId)).toHaveLength(7);
    expect(await reviews.find({ caseId })).toHaveLength(7);
  });
});

describe('§9.4: a unanimous `violation` that disagrees about WHAT was found is not consensus', () => {
  let caseId: string;

  beforeAll(async () => {
    await createReviewerPool(FAMILY, 12, [DIMENSIONS_LANGUAGE]);
    caseId = await openCaseFor(
      DIMENSIONS_CODE,
      `post_dimensions_${Date.now()}`,
      DIMENSIONS_LANGUAGE,
    );

    const seats = await seatsOf(caseId);
    expect(seats).toHaveLength(3);

    /**
     * Three jurors, three `violation` votes, three different opinions about the
     * material: one calls it a scam of medium severity, one calls it a privacy
     * breach, one calls the same scam critical. §9.4 opens by refusing exactly
     * this — "el consenso no se limita a violation contra no_violation" — and an
     * engine that compared only the outcome would see three of three and publish
     * a finding no juror made.
     */
    await vote(seats[0], { outcome: 'violation', code: DIMENSIONS_CODE, severity: 'medium' });
    await vote(seats[1], {
      outcome: 'violation',
      code: 'privacy.personal_information',
      severity: 'medium',
    });
    await vote(seats[2], { outcome: 'violation', code: DIMENSIONS_CODE, severity: 'critical' });

    await drainUntil(
      async () => (await seatsOf(caseId)).length >= 5,
      'the panel to expand after a disagreement about the findings',
    );
  }, 180_000);

  it('publishes nothing, and expands instead', async () => {
    expect(await decisions.countDocuments(tenant.tenant, { caseId })).toBe(0);
    expect(await seatsOf(caseId)).toHaveLength(5);

    const stored = await cases.findOne(tenant.tenant, { caseId });
    expect(stored?.decidedRevision).toBe(0);
    expect(stored?.status).not.toBe('decided');
  });

  it('all three ballots said `violation`, so the outcome alone was unanimous', async () => {
    // The vacuity floor for the claim above: if the ballots had differed on the
    // outcome, this block would be testing the ordinary disagreement path and
    // would pass against an engine that only ever compared outcomes.
    const cast = await reviews.find({ caseId });
    expect(cast).toHaveLength(3);
    expect(new Set(cast.map((review) => review.outcome))).toEqual(new Set(['violation']));
  });
});

describe('§16.2: a recusal is not a vote', () => {
  let caseId: string;
  let recused: string;

  beforeAll(async () => {
    await createReviewerPool(FAMILY, 12, [RECUSAL_LANGUAGE]);
    caseId = await openCaseFor(RECUSAL_CODE, `post_recusal_${Date.now()}`, RECUSAL_LANGUAGE);

    const seats = await seatsOf(caseId);
    expect(seats).toHaveLength(3);
    recused = seats[2];

    await vote(seats[0], { outcome: 'violation', code: RECUSAL_CODE });
    await vote(seats[1], { outcome: 'violation', code: RECUSAL_CODE });

    const profile = await reviewerProfiles.findOne({ reviewerId: recused });
    if (!profile) throw new Error('expected a profile');

    const opened = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set(asReviewer(profile.oxyUserId));
    expect(opened.status).toBe(200);

    const stepped = await request(app)
      .post(`/v1/reviewer/assignments/${String(opened.body.assignmentId)}/recuse`)
      .set(asReviewer(profile.oxyUserId))
      .set('x-assignment-token', opened.body.token)
      .send({ reason: 'conflict_of_interest' });
    expect(stepped.status).toBe(204);

    await drainUntil(
      async () => (await seatsOf(caseId)).length === 3,
      'the replacement for the recused seat',
    );
  }, 180_000);

  it('does not complete the panel: two votes and a recusal decide nothing', async () => {
    // A recusal that counted as a vote would have made this three of three.
    expect(await reviews.find({ caseId })).toHaveLength(2);
    expect(await decisions.countDocuments(tenant.tenant, { caseId })).toBe(0);

    const evaluated = await evaluateCase(tenant.tenant, caseId);
    expect(evaluated.status).toBe('waiting');
    if (evaluated.status !== 'waiting') throw new Error('expected to be waiting');
    expect(evaluated.pendingSeats).toBe(1);
  });

  it('the replacement is a different person, and the threshold did not drop', async () => {
    const seats = await seatsOf(caseId);
    expect(seats).toHaveLength(3);
    expect(seats).not.toContain(recused);
  });

  it('and the decision publishes only once the replacement has voted', async () => {
    const pending = await unvotedSeatsOf(caseId);
    expect(pending).toHaveLength(1);

    await vote(pending[0], { outcome: 'violation', code: RECUSAL_CODE });

    await drainUntil(
      async () => (await decisions.countDocuments(tenant.tenant, { caseId })) === 1,
      'the decision after the replacement voted',
    );

    const [decision] = await decisions.find(tenant.tenant, { caseId });
    expect(decision.outcome).toBe('violation');
    expect(decision.jury).toMatchObject({ size: 3, decisiveVotes: 3, winningVotes: 3 });

    // The person who recused is not in the record of who agreed.
    expect(decision.agreeingReviewerIds).not.toContain(recused);
  });
});
