import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';

import { stubOxySession } from './support/reviewers';

/**
 * The paths that REFUSE, and the ones nobody thinks to exercise.
 *
 * `consensusDecision.integration.test.ts` proves the engine decides. This proves
 * the other half — that it declines to — because every one of these is a rule
 * rather than an error condition, and each fails silently if it stops working:
 *
 *  - a case §7.5 routed to the legal pool never gets a decision from a jury,
 *  - a case nobody drew a panel for is not "unanimous among zero jurors",
 *  - a tenant cannot read, decide or revise another tenant's case,
 *  - a decision published WITHOUT the compare-and-swap still fails, loudly,
 *    because the unique index on `caseId + revision` is a second lock.
 *
 * The last one is the mutation test for §12.11 that can live inside the suite:
 * it does not weaken the swap, it removes it, and shows that the failure is a
 * refused write rather than two contradictory decisions and two webhooks.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { registerOutboxWorkers } = await import('../modules/outbox/workers');
const { evaluateCase } = await import('../modules/consensus/consensus.service');
const { handleReviewSubmitted } = await import('../modules/consensus/consensus.worker');
const { confidenceScore } = await import('../modules/consensus/confidence');
const { positionOf } = await import('../modules/consensus/consensus');
const {
  currentDecision,
  decisionHistory,
  markSuperseded,
  publishDecision,
} = await import('../modules/decision/decision.service');
const { openCaseRevision } = await import('../modules/decision/revision.service');
const { decisions } = await import('../modules/decision/decision.collection');
const { cases } = await import('../modules/cases/case.collection');
const { sortitionDraws } = await import('../modules/sortition/draw.collection');
const { fanOutWebhookEvent } = await import('../modules/webhooks/fanout');
const { registerWebhookEndpoint } = await import('../modules/webhooks/endpoint.service');
const { OUTBOX_EVENT_TYPES } = await import('../modules/outbox/outbox.collection');
const { newPublicId } = await import('../utils/identifiers');
const { CASE_ENVELOPE_SCHEMA_VERSION, UNIVERSAL_TAXONOMY_VERSION, OXY_CONDUCT_POLICY_VERSION } =
  await import('@oxyhq/crowdsource-contracts');
const { BASELINE_POLICY_VERSION } = await import('../modules/policy/policyBaseline');
const { deliveryBody, drainUntil, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();

/**
 * `child_safety.grooming` is §7.5 row 1: prohibited, legal pool, never a
 * community jury. There is no reviewer pool in this file at all — every case
 * here is one no jury should ever be drawn for, and creating reviewers would
 * make that harder to assert rather than easier.
 */
const LEGAL_CODE: TaxonomyCode = 'child_safety.grooming';
/** An ordinary case with no pool to draw from, so it never gets a panel. */
const UNSERVED_CODE: TaxonomyCode = 'commerce.unsafe_product';
const UNSERVED_LANGUAGE = 'oc';

let tenant: ProvisionedTenant;
let other: ProvisionedTenant;

async function ingest(code: TaxonomyCode, subject: string, language?: string): Promise<string> {
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
    `a draw record for case '${String(created.body.caseId)}'`,
  );
  return created.body.caseId;
}

beforeAll(async () => {
  await startDatabase();
  registerOutboxWorkers();
  tenant = await provisionTenant();
  other = await provisionTenant();
}, 180_000);

afterAll(async () => {
  await stopDatabase();
});

describe('cases no jury decides', () => {
  it('§7.5 row 1: a legal-pool case is never counted, however it is poked', async () => {
    const caseId = await ingest(LEGAL_CODE, `post_legal_${Date.now()}`);

    const draw = await sortitionDraws.findOne({ caseId });
    expect(draw?.status).toBe('refused');
    expect(draw?.refusalReason).toBe('legal_pool');

    expect(await evaluateCase(tenant.tenant, caseId)).toEqual({ status: 'no_panel' });
    expect(await decisions.countDocuments(tenant.tenant, { caseId })).toBe(0);
  });

  it('a case whose pool could not be filled waits, rather than deciding on nobody', async () => {
    const caseId = await ingest(
      UNSERVED_CODE,
      `post_unserved_${Date.now()}`,
      UNSERVED_LANGUAGE,
    );

    const draw = await sortitionDraws.findOne({ caseId });
    expect(draw?.status).toBe('refused');

    expect(await evaluateCase(tenant.tenant, caseId)).toEqual({ status: 'no_panel' });
  });

  it('a case that was never triaged has no risk row to apply', async () => {
    const caseId = newPublicId('case');
    const now = new Date();

    await cases.insertOne(tenant.tenant, {
      caseId,
      externalSubjectId: `subject_${caseId}`,
      contentHash: `sha256:${'e'.repeat(64)}`,
      policyVersion: BASELINE_POLICY_VERSION,
      caseDedupKey: `dedup_${caseId}`,
      subjectType: 'social.post',
      primaryResourceId: 'res_post',
      policySetId: 'crowdsource.baseline',
      taxonomyVersion: UNIVERSAL_TAXONOMY_VERSION,
      contentSnapshot: {
        schemaVersion: CASE_ENVELOPE_SCHEMA_VERSION,
        subject: {
          externalId: `subject_${caseId}`,
          type: 'social.post',
          primaryResourceId: 'res_post',
        },
        resources: [],
        relations: [],
        principals: [],
      },
      status: 'received',
      allegationCodes: [],
      reportCount: 1,
      reporterFingerprints: [],
      reach: 0,
      activeDistribution: false,
      allowCommunityReview: true,
      containsPersonalData: false,
      retentionDays: 30,
      priorityScore: 0,
      // Never triaged: no sensitivity class and no pool.
      sensitivityClass: null,
      reviewPool: null,
      requiresRedaction: false,
      escalated: false,
      triagedAt: null,
      currentRevision: 1,
      decidedRevision: 0,
      incidentId: null,
      firstReportedAt: now,
      lastReportedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    expect(await evaluateCase(tenant.tenant, caseId)).toEqual({ status: 'no_panel' });
  });
});

describe('a tenant reaches only its own decisions', () => {
  let caseId: string;
  let decisionId: string;

  beforeAll(async () => {
    caseId = await ingest(LEGAL_CODE, `post_isolation_${Date.now()}`);

    /**
     * Published directly rather than through a jury: this block is about the
     * tenant filter, and driving a whole panel to get one row would make the
     * failure mode of the panel a failure mode of an isolation test.
     */
    const published = await publishDecision({
      context: tenant.tenant,
      caseId,
      revision: 1,
      outcome: 'escalated',
      contextSufficiency: 'insufficient',
      confidence: 0.5,
      findings: [],
      recommendedActions: [],
      jury: {
        size: 3,
        decisiveVotes: 3,
        winningVotes: 0,
        agreement: 0,
        specialistPresent: false,
      },
      policyVersions: {
        taxonomy: UNIVERSAL_TAXONOMY_VERSION,
        application: BASELINE_POLICY_VERSION,
        oxyConduct: OXY_CONDUCT_POLICY_VERSION,
      },
      agreeingReviewerIds: [],
      supersedes: null,
      now: new Date(),
    });

    if (!published.published) throw new Error('expected the first publish to succeed');
    decisionId = published.decisionId;
  }, 180_000);

  it('refuses to evaluate a case belonging to another tenant', async () => {
    await expect(evaluateCase(other.tenant, caseId)).rejects.toThrow(/does not own/);
  });

  it('refuses to revise a case belonging to another tenant', async () => {
    await expect(openCaseRevision(other.tenant, caseId)).rejects.toThrow(/does not own/);
  });

  it('answers 404 for another tenant’s decision, the same as for one that never existed', async () => {
    const foreign = await request(app)
      .get(`/v1/decisions/${decisionId}`)
      .set('Authorization', `Bearer ${other.token}`);

    const invented = await request(app)
      .get(`/v1/decisions/dec_${'0'.repeat(32)}`)
      .set('Authorization', `Bearer ${other.token}`);

    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    // Identical, so a caller cannot distinguish "exists elsewhere" from "never
    // existed" — the same reasoning `cases.routes.ts` gives for its own 404.
    expect(foreign.body).toEqual(invented.body);
  });

  it('answers 404 for a value that is not a decision id at all', async () => {
    const malformed = await request(app)
      .get('/v1/decisions/not-an-id')
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(malformed.status).toBe(404);
    expect(malformed.body.error.code).toBe('not_found');
  });

  /**
   * §12.11's SECOND lock, shown to be load-bearing by removing the first.
   *
   * `publishDecision` is called again for a revision already decided — the swap
   * refuses, which is the normal path — and then the insert is attempted
   * directly, without any swap at all, which is what a future caller that
   * forgot §12.11 would do. The unique index refuses it. Without that index the
   * case would carry two revision-1 decisions and the application would receive
   * two contradictory `case.decided` webhooks.
   */
  it('mutation: publishing without the swap is refused by the unique index', async () => {
    const again = await publishDecision({
      context: tenant.tenant,
      caseId,
      revision: 1,
      outcome: 'violation',
      contextSufficiency: 'sufficient',
      confidence: 0.9,
      findings: [],
      recommendedActions: [],
      jury: {
        size: 3,
        decisiveVotes: 3,
        winningVotes: 3,
        agreement: 1,
        specialistPresent: false,
      },
      policyVersions: {
        taxonomy: UNIVERSAL_TAXONOMY_VERSION,
        application: BASELINE_POLICY_VERSION,
        oxyConduct: OXY_CONDUCT_POLICY_VERSION,
      },
      agreeingReviewerIds: [],
      supersedes: null,
      now: new Date(),
    });

    expect(again).toEqual({ published: false, reason: 'already_decided' });

    await expect(
      decisions.insertOne(tenant.tenant, {
        decisionId: newPublicId('decision'),
        caseId,
        revision: 1,
        status: 'final',
        outcome: 'no_violation',
        contextSufficiency: 'sufficient',
        confidence: 0.9,
        findings: [],
        recommendedActions: [],
        jury: {
          size: 3,
          decisiveVotes: 3,
          winningVotes: 3,
          agreement: 1,
          specialistPresent: false,
        },
        policyVersions: {
          taxonomy: UNIVERSAL_TAXONOMY_VERSION,
          application: BASELINE_POLICY_VERSION,
          oxyConduct: OXY_CONDUCT_POLICY_VERSION,
        },
        supersedesDecisionId: null,
        agreeingReviewerIds: [],
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 11000 });

    expect(await decisions.countDocuments(tenant.tenant, { caseId })).toBe(1);
  });

  it('supersession is idempotent, and only ever moves a final revision', async () => {
    const first = await markSuperseded(tenant.tenant, caseId, 1, new Date());
    const second = await markSuperseded(tenant.tenant, caseId, 1, new Date());

    expect(first).toBe(1);
    expect(second).toBe(0);

    const [stored] = await decisionHistory(tenant.tenant, caseId);
    expect(stored.status).toBe('superseded');
    // What was DECIDED is untouched: §9.9 protects the outcome, not the status.
    expect(stored.outcome).toBe('escalated');
  });

  it('reports no current decision for a case that has none', async () => {
    expect(await currentDecision(tenant.tenant, newPublicId('case'))).toBeNull();
    expect(await decisionHistory(tenant.tenant, newPublicId('case'))).toEqual([]);
  });
});

describe('an event that names nothing is a fault, not a no-op', () => {
  it('the consensus worker refuses an event with no case', async () => {
    await expect(
      handleReviewSubmitted({
        eventId: 'evt_broken',
        organizationId: tenant.tenant.organizationId,
        applicationId: tenant.tenant.applicationId,
        type: OUTBOX_EVENT_TYPES.reviewSubmitted,
        payload: {},
        status: 'dispatching',
        attempts: 1,
        availableAt: new Date(),
        dispatchedAt: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(/no caseId/);
  });

  it('the webhook fan-out refuses a decision event it cannot read back', async () => {
    /**
     * Throwing rather than returning keeps the outbox row PENDING instead of
     * marking work done that nobody did. A decision that could not be read is a
     * decision the application was never told about, and the row is the only
     * record that it should have been.
     *
     * An endpoint has to be subscribed for this to be reachable at all: with
     * nobody listening the fan-out returns before it builds a payload, which is
     * correct and is asserted first so the throw below cannot pass for the wrong
     * reason.
     */
    const orphan = {
      eventId: 'evt_missing_decision',
      organizationId: tenant.tenant.organizationId,
      applicationId: tenant.tenant.applicationId,
      type: OUTBOX_EVENT_TYPES.caseDecided,
      payload: { decisionId: newPublicId('decision') },
      status: 'dispatching' as const,
      attempts: 1,
      availableAt: new Date(),
      dispatchedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(fanOutWebhookEvent(orphan)).resolves.toEqual({ subscribed: 0, created: 0 });

    await registerWebhookEndpoint(tenant.tenant, {
      url: 'https://receiver.invalid/refusals',
      eventTypes: ['case.decided'],
    });

    await expect(fanOutWebhookEvent(orphan)).rejects.toThrow(/could not be read/);
  });
});

describe('the arithmetic survives inputs nobody should produce', () => {
  it('a panel with no ballots scores zero rather than NaN', () => {
    expect(
      confidenceScore({
        winningDecisiveVotes: 0,
        decisiveVotes: 0,
        reviewerQuality: [],
        contextSufficiency: 'insufficient',
      }),
    ).toBe(0.05);
  });

  it('a non-finite reliability counts as zero rather than poisoning the score', () => {
    expect(
      confidenceScore({
        winningDecisiveVotes: 3,
        decisiveVotes: 3,
        reviewerQuality: [Number.NaN, 1, 1],
        contextSufficiency: 'sufficient',
      }),
    ).toBe(0.9);
  });

  it('the primary finding is stable when severities tie in the other direction', () => {
    // The reducer's `difference < 0` arm: the more severe finding arrives second.
    const position = positionOf({
      reviewerId: 'rvw_a',
      outcome: 'violation',
      contextSufficiency: 'sufficient',
      recommendedActions: [],
      reviewerState: 'community',
      isSpecialist: false,
      findings: [
        { code: 'integrity.scam', resourceIds: ['res_a'], severity: 'critical', confidence: 0.9 },
        { code: 'integrity.spam', resourceIds: ['res_b'], severity: 'low', confidence: 0.9 },
      ],
    });

    expect(position.severity).toBe('critical');
    expect(position.family).toBe('integrity');
  });
});
