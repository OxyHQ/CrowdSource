import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';

import { reviewerAxesFor } from './support/reviewerAxes';
import { stubOxySession } from './support/reviewers';

/**
 * §7.5's specialist route, end to end: **sensitive categories never reach a
 * community jury.**
 *
 * The rule is enforced in three places that have to agree, and only a run through
 * all three shows that they do:
 *
 *  1. **Triage** routes the allegation to the specialist pool (§7.5 row 3).
 *  2. **The panel specification** for that pool is every-slot-a-specialist, and
 *     `slotAllowsFallback` refuses the fallback chain the community ladder has.
 *  3. **The draw** therefore REFUSES rather than seating a general reviewer, and
 *     records the refusal so an operator sees a case waiting for specialists rather
 *     than a case that quietly stopped.
 *
 * `appealStandard.test.ts` pins (2) and (3) as pure functions, including on the
 * appeal ladder. What this file adds is the seam: that the route a real report
 * takes actually lands there, and that a fully ELIGIBLE general reviewer — adult,
 * consented to the category, consented to the sensitivity, reliable, available —
 * is still refused. Any of those missing would make the refusal an eligibility
 * result and prove nothing about §7.5.
 */
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return { ...actual, createOptionalOxyAuth: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { registerOutboxWorkers } = await import('../modules/outbox/workers');
const { cases } = await import('../modules/cases/case.collection');
const { assignments } = await import('../modules/sortition/assignment.collection');
const { sortitionDraws } = await import('../modules/sortition/draw.collection');
const { openPanel } = await import('../modules/sortition/sortition.service');
const { reviewerProfiles } = await import('../modules/reviewer/reviewer.collection');
const { createReviewer } = await import('./support/reviewers');
const { deliveryBody, drainUntil, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();

/**
 * `violence.graphic` is §7.5 row 3: `sensitive`, specialist pool, voluntary
 * exposure. The language is this file's isolation axis — `violence` is alleged by
 * one block of `sortitionPanel.integration.test.ts`, and a reviewer must have the
 * case's language to be drawn at all (§8.2). The pair is assigned in
 * `support/reviewerAxes.ts`, which is the only place both claims on `violence`
 * are visible at once, and `reviewerAxes.test.ts` fails if they ever converge.
 */
const axes = reviewerAxesFor(import.meta.url);
const FAMILY = axes('specialist').family;
const CODE: TaxonomyCode = 'violence.graphic';
const LANGUAGE = axes('specialist').language;

/** `sensitive` is rank 1 in `sensitivityRank`; a `standard`-only reviewer is 0. */
const SENSITIVE_RANK = 1;

let tenant: ProvisionedTenant;
let caseId: string;
let generalists: string[];

beforeAll(async () => {
  await startDatabase();
  registerOutboxWorkers();
  tenant = await provisionTenant();

  /**
   * Five general reviewers who are eligible in every OTHER respect: consented to
   * the category and to its sensitivity, adult, reliable, experienced, available.
   * The only thing they are not is specialists.
   */
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    created.push(
      await createReviewer({
        family: FAMILY,
        languages: [LANGUAGE],
        reliability: 0.95,
        completedReviewCount: 60,
        maxSensitivityRank: SENSITIVE_RANK,
        consentedSensitiveCategories: [FAMILY],
      }),
    );
  }
  generalists = created.map((reviewer) => reviewer.reviewerId);

  const externalReportId = `specialist-${Date.now()}`;
  const response = await request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', externalReportId)
    .send(
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: `post_specialist_${Date.now()}`,
        allegationCode: CODE,
        language: LANGUAGE,
        text: 'material for the specialist route',
      }),
    );

  expect(response.status).toBe(202);
  caseId = response.body.caseId;

  await drainUntil(
    async () => (await sortitionDraws.findOne({ caseId })) !== null,
    'a draw or a refusal for the specialist case',
  );
}, 240_000);

afterAll(async () => {
  await stopDatabase();
});

describe('§7.5: a case routed to the specialist pool', () => {
  it('is triaged to that pool, and to sensitive rather than standard', async () => {
    const stored = await cases.findOne(tenant.tenant, { caseId });

    expect(stored?.reviewPool).toBe('specialist');
    expect(stored?.sensitivityClass).toBe('sensitive');
  });

  it('refuses to open a panel rather than seating a general reviewer', async () => {
    const [draw] = await sortitionDraws.find({ caseId }, { sort: { drawnAt: 1 } });

    expect(draw.status).toBe('refused');
    expect(draw.pool).toBe('specialist');
    expect(draw.panelSpecId).toBe('specialist.round1');
    expect(draw.refusalReason).toBe('slot_unfillable');
    expect(draw.selected).toHaveLength(0);
    expect([...new Set(draw.requestedSlots)]).toEqual(['category_specialist']);
  });

  it('had those general reviewers in the pool, and rejected none of them as ineligible', async () => {
    /**
     * The vacuity guard for the test above. If the generalists had been filtered
     * out by eligibility — a missing consent, an expired calibration — the draw
     * would still have refused, and the assertion would have passed while proving
     * nothing about §7.5. They are in the candidate snapshot, which means the draw
     * saw them, considered them, and would not seat them.
     */
    const [draw] = await sortitionDraws.find({ caseId }, { sort: { drawnAt: 1 } });
    const considered = draw.candidateSnapshot.map((candidate) => candidate.reviewerId);

    for (const reviewerId of generalists) {
      expect(considered, 'a general reviewer was not even a candidate').toContain(reviewerId);
    }
    for (const candidate of draw.candidateSnapshot) {
      // They satisfy the general slot and cannot satisfy the specialist one.
      if (!generalists.includes(candidate.reviewerId)) continue;
      expect(candidate.eligibleSlots).toContain('reliable_general');
      expect(candidate.eligibleSlots).not.toContain('category_specialist');
    }
  });

  it('seats nobody at all, and the case waits', async () => {
    expect(await assignments.find({ caseId })).toHaveLength(0);

    const stored = await cases.findOne(tenant.tenant, { caseId });
    /**
     * Still where triage left it: a refused draw does not advance a lifecycle.
     * `triaged` rather than `escalated` because §7.5 row 3 routes graphic violence
     * to a specialist POOL without the urgent escalation rows 1 and 2 carry.
     */
    expect(stored?.status).toBe('triaged');
  });

  it('no general reviewer can reach it through the reviewer surface either', async () => {
    /**
     * The other half of §7.5, and the one that matters most: not merely that the
     * draw refused, but that a general reviewer has no route to the material. There
     * is no reviewer endpoint that accepts a case id, so "next" is the whole
     * surface — and it has nothing for them.
     */
    const profile = await reviewerProfiles.findOne({ reviewerId: generalists[0] });
    if (!profile) throw new Error('expected a profile');

    const next = await request(app)
      .post('/v1/reviewer/assignments/next')
      .set({ 'x-test-oxy-user': profile.oxyUserId });

    expect(next.status).toBe(204);
  });
});

describe('§7.5 + §13.7: the panel opens once specialists exist, and only specialists sit', () => {
  let specialists: string[];
  let withoutConsent: string;

  beforeAll(async () => {
    /**
     * Three specialists in this family, plus one who is a specialist in the family
     * but has NOT consented to sensitive material in it (§13.7: "consentimiento por
     * categoría y posibilidad de desactivarla en cualquier momento"). The fourth is
     * the wellbeing rule under test: competence does not override consent.
     */
    const consented = [];
    for (let index = 0; index < 3; index += 1) {
      consented.push(
        await createReviewer({
          family: FAMILY,
          languages: [LANGUAGE],
          state: 'specialist',
          specialistCategories: [FAMILY],
          reliability: 0.95,
          completedReviewCount: 200,
          maxSensitivityRank: SENSITIVE_RANK,
          consentedSensitiveCategories: [FAMILY],
        }),
      );
    }
    specialists = consented.map((reviewer) => reviewer.reviewerId);

    const unconsented = await createReviewer({
      family: FAMILY,
      languages: [LANGUAGE],
      state: 'specialist',
      specialistCategories: [FAMILY],
      reliability: 0.95,
      completedReviewCount: 200,
      maxSensitivityRank: SENSITIVE_RANK,
      consentedSensitiveCategories: [],
    });
    withoutConsent = unconsented.reviewerId;

    const outcome = await openPanel({ context: tenant.tenant, caseId, kind: 'initial' });
    expect(outcome.status).toBe('drawn');
  }, 240_000);

  it('seats three specialists and nobody else', async () => {
    const panel = await assignments.find({ caseId });

    expect(panel).toHaveLength(3);
    for (const seat of panel) {
      expect(specialists, 'somebody who is not a specialist was seated').toContain(seat.reviewerId);
      expect(seat.slotType).toBe('category_specialist');
      /**
       * `filledAs` is what would reveal a silent downgrade: a community panel
       * records `filledAs: 'reliable_general'` when a specialist slot falls back.
       * In this pool it must equal the slot itself.
       */
      expect(seat.filledAs).toBe('category_specialist');
      expect(seat.sensitivityClass).toBe('sensitive');
    }

    for (const reviewerId of generalists) {
      expect(panel.map((seat) => seat.reviewerId)).not.toContain(reviewerId);
    }
  });

  it('§13.7: never draws the specialist who withdrew consent for this category', async () => {
    /**
     * "Consentimiento por categoría y posibilidad de desactivarla en cualquier
     * momento." Competence does not override consent: this reviewer is a specialist
     * in exactly this family and is still never considered.
     *
     * They are absent from the candidate SNAPSHOT rather than present in the
     * rejection list, and that is the stronger of the two: `eligibilityFilter`
     * removes them in the query, so a case they did not consent to is never even
     * fetched against their profile. `eligibilityRejection` re-checks the same rule
     * as the second lock — see `reviewerEligibility.test.ts`, which exercises the
     * reason code directly.
     */
    const drawn = await sortitionDraws.find({ caseId }, { sort: { drawnAt: 1 } });
    const successful = drawn.find((draw) => draw.status === 'drawn');
    if (!successful) throw new Error('expected a successful draw');

    expect(successful.candidateSnapshot.map((candidate) => candidate.reviewerId)).not.toContain(
      withoutConsent,
    );
    expect(successful.selected.map((seat) => seat.reviewerId)).not.toContain(withoutConsent);
    expect((await assignments.find({ caseId })).map((seat) => seat.reviewerId)).not.toContain(
      withoutConsent,
    );

    // The vacuity floor: the three who DID consent were considered.
    for (const reviewerId of specialists) {
      expect(successful.candidateSnapshot.map((candidate) => candidate.reviewerId)).toContain(
        reviewerId,
      );
    }
  });

  it('records the whole history: the refusal, then the panel', async () => {
    const drawn = await sortitionDraws.find({ caseId }, { sort: { drawnAt: 1 } });

    expect(drawn.map((draw) => draw.status)).toEqual(['refused', 'drawn']);
    expect(drawn.every((draw) => draw.pool === 'specialist')).toBe(true);
  });
});
