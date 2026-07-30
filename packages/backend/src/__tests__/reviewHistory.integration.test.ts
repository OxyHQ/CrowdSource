import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubOxySession } from './support/reviewers';

/**
 * §4.1's "Historial" — pagination, and what a decided case discloses back.
 *
 * ## Why this file exists
 *
 * `reviewHistoryPage` shipped with its cursor encode/decode pair and its
 * decision join uncovered: every existing test read page one of a history whose
 * cases had never been decided, so three things nobody had exercised were the
 * three that carry the risk.
 *
 *  - **The cursor round trip.** A cursor is `submittedAt.getTime()` and the
 *    review id joined, because two reviews can land in the same millisecond and
 *    a cursor on time alone would either repeat one or lose one — in a list whose
 *    whole purpose is somebody checking their own record.
 *  - **A malformed cursor is a 400, not a silent restart.** Ignoring it would
 *    show page one where page three was asked for, and a client bug would look
 *    like a server that forgets.
 *  - **The decision join**, which is the §4.1 disclosure I want pinned in both
 *    directions at once: the outcome of the revision this reviewer JUDGED comes
 *    back, and the tally never does.
 *
 * ## The two constraints this pins
 *
 * §9.1 hides "votos anteriores o resultado parcial" — previous votes, or a
 * PARTIAL result. A published decision is neither, and §4.1 requires the screen
 * to show "resultados que ya puedan revelarse". So the outcome crosses.
 *
 * What must never cross is the tally. An agreement ratio IS a partial result seen
 * from the far end, and `status` is withheld for a quieter reason: `superseded`
 * says a later revision exists, which tells a juror their case was appealed and
 * that somebody has already ruled on it. The assertion below is a key-set
 * comparison rather than a list of `not.toHaveProperty` calls, because the former
 * fails when a field is ADDED and the latter only fails for fields somebody
 * thought to name.
 */

vi.mock('@oxyhq/core/server', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@oxyhq/core/server');
  return { ...actual, createOxyAuthMiddleware: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { cases } = await import('../modules/cases/case.collection');
const { publishDecision } = await import('../modules/decision/decision.service');
const { reviews } = await import('../modules/review/review.collection');
const { reviewHistoryPage } = await import('../modules/review/reviewHistory');
const { BASELINE_POLICY_SET_ID, BASELINE_POLICY_VERSION } = await import(
  '../modules/policy/policyBaseline'
);
const { deliveryBody, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);

const app = createApp();

beforeAll(async () => {
  await startDatabase();
}, 120_000);

afterAll(async () => {
  await stopDatabase();
});

const JURY = {
  size: 3,
  decisiveVotes: 3,
  winningVotes: 3,
  agreement: 1,
  specialistPresent: false,
} as const;

const POLICY_VERSIONS = {
  taxonomy: 'crowdsource.taxonomy.2026.1',
  application: `${BASELINE_POLICY_SET_ID}@${BASELINE_POLICY_VERSION}`,
  oxyConduct: 'oxy.conduct.2026.1',
} as const;

interface SeededCase {
  readonly caseId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly tenant: Awaited<ReturnType<typeof provisionTenant>>;
}

let sharedTenant: Awaited<ReturnType<typeof provisionTenant>> | null = null;

/**
 * One tenant for the file, a distinct subject per case.
 *
 * Provisioning is what costs; the cases only have to be distinct, and
 * `externalSubjectId` is what §7.3 keys them on. Ten provisions in one file was
 * enough to make this suite intermittently time out its setup.
 */
async function ingestCase(): Promise<SeededCase> {
  sharedTenant ??= await provisionTenant();
  const tenant = sharedTenant;
  const delivered = await request(app)
    .post('/v1/reports')
    .set('authorization', `Bearer ${tenant.token}`)
    .set('idempotency-key', `history-${randomUUID()}`)
    .send(
      deliveryBody(tenant, `history-report-${randomUUID()}`, {
        text: 'reported material',
        subjectExternalId: `subject_${randomUUID().replace(/-/g, '')}`,
      }),
    );
  expect(delivered.status).toBe(202);
  return {
    caseId: delivered.body.caseId,
    organizationId: tenant.organizationId,
    applicationId: tenant.applicationId,
    tenant,
  };
}

/**
 * One review row, at an explicit instant so the ordering under test is the one
 * written rather than whatever the clock produced during the run.
 */
async function seedReview(
  seeded: SeededCase,
  reviewerId: string,
  submittedAt: Date,
  reviewId = `rev_${randomUUID().replace(/-/g, '')}`,
): Promise<string> {
  await reviews.insertOne({
    reviewId,
    organizationId: seeded.organizationId,
    applicationId: seeded.applicationId,
    assignmentId: `asg_${randomUUID().replace(/-/g, '')}`,
    caseId: seeded.caseId,
    caseRevision: 1,
    reviewerId,
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    findings: [],
    recommendedActions: [],
    notes: null,
    submittedAt,
    createdAt: submittedAt,
    updatedAt: submittedAt,
  });
  return reviewId;
}

describe('§4.1: the reviewer history paginates', () => {
  it('walks every entry exactly once across pages, and stops', async () => {
    const reviewerId = `rvw_${randomUUID().replace(/-/g, '')}`;
    const base = Date.UTC(2026, 6, 30, 12, 0, 0);
    // A case each, because `caseId + reviewerId + caseRevision` is unique — one
    // review per juror per revision is the invariant, so a reviewer with five
    // entries in their history reviewed five different cases.
    for (let index = 0; index < 5; index += 1) {
      await seedReview(await ingestCase(), reviewerId, new Date(base + index * 1000));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    // Bounded so a cursor that fails to advance ends the test rather than the run.
    for (let page = 0; page < 10; page += 1) {
      const result = await reviewHistoryPage(reviewerId, { limit: 2, cursor });
      seen.push(...result.entries.map((entry) => entry.reviewId));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('orders by the id when two reviews share a millisecond', async () => {
    const reviewerId = `rvw_${randomUUID().replace(/-/g, '')}`;
    const sameInstant = new Date(Date.UTC(2026, 6, 30, 13, 0, 0));
    // Ids chosen so their ordering is known and is NOT the insertion order: a
    // cursor keyed on time alone would repeat one of these or lose it.
    await seedReview(await ingestCase(), reviewerId, sameInstant, `rev_${'a'.repeat(32)}`);
    await seedReview(await ingestCase(), reviewerId, sameInstant, `rev_${'b'.repeat(32)}`);

    const first = await reviewHistoryPage(reviewerId, { limit: 1 });
    expect(first.entries.map((entry) => entry.reviewId)).toEqual([`rev_${'b'.repeat(32)}`]);
    expect(first.nextCursor).not.toBeNull();

    const second = await reviewHistoryPage(reviewerId, {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.entries.map((entry) => entry.reviewId)).toEqual([`rev_${'a'.repeat(32)}`]);
  });

  it.each([
    ['no separator', '1785386937000'],
    ['a separator in the first position', '.rev_1'],
    ['a non-numeric instant', 'later.rev_1'],
    ['an empty review id', '1785386937000.'],
  ])('refuses a cursor with %s rather than restarting at page one', async (_label, cursor) => {
    const reviewerId = `rvw_${randomUUID().replace(/-/g, '')}`;
    await expect(reviewHistoryPage(reviewerId, { cursor })).rejects.toThrow(
      /not one this endpoint issued/,
    );
  });
});

describe('§4.1 against §9.1: what a decided case tells its juror', () => {
  it('returns the outcome of the revision the reviewer judged, and no tally', async () => {
    const seeded = await ingestCase();
    const reviewerId = `rvw_${randomUUID().replace(/-/g, '')}`;
    await seedReview(seeded, reviewerId, new Date(Date.UTC(2026, 6, 30, 14, 0, 0)));

    const published = await publishDecision({
      context: seeded.tenant.tenant,
      caseId: seeded.caseId,
      revision: 1,
      outcome: 'violation',
      contextSufficiency: 'sufficient',
      confidence: 0.9,
      findings: [],
      recommendedActions: [{ action: 'remove_or_restrict' }],
      jury: JURY,
      policyVersions: POLICY_VERSIONS,
      agreeingReviewerIds: [reviewerId],
      supersedes: null,
      now: new Date(),
    });
    expect(published.published).toBe(true);

    const page = await reviewHistoryPage(reviewerId, {});
    const entry = page.entries[0];
    expect(entry?.decision?.outcome).toBe('violation');

    /**
     * An exact key set, not a list of absences. `jury`, `agreement`,
     * `agreeingReviewerIds` and `status` are all things a decision document
     * carries and this projection must not — and only a set comparison fails
     * when a NEW one of them is added by somebody who never read this file.
     */
    expect(Object.keys(entry?.decision ?? {}).sort()).toEqual(['outcome', 'publishedAt']);
  });

  it('leaves the decision null while the case is undecided', async () => {
    const seeded = await ingestCase();
    const reviewerId = `rvw_${randomUUID().replace(/-/g, '')}`;
    await seedReview(seeded, reviewerId, new Date(Date.UTC(2026, 6, 30, 15, 0, 0)));

    const page = await reviewHistoryPage(reviewerId, {});
    expect(page.entries[0]?.decision).toBeNull();
  });

  it('shows the juror the revision THEY judged, not the one that superseded it', async () => {
    const seeded = await ingestCase();
    const reviewerId = `rvw_${randomUUID().replace(/-/g, '')}`;
    await seedReview(seeded, reviewerId, new Date(Date.UTC(2026, 6, 30, 16, 0, 0)));

    const first = await publishDecision({
      context: seeded.tenant.tenant,
      caseId: seeded.caseId,
      revision: 1,
      outcome: 'violation',
      contextSufficiency: 'sufficient',
      confidence: 0.9,
      findings: [],
      recommendedActions: [{ action: 'remove_or_restrict' }],
      jury: JURY,
      policyVersions: POLICY_VERSIONS,
      agreeingReviewerIds: [reviewerId],
      supersedes: null,
      now: new Date(),
    });
    expect(first.published).toBe(true);

    // The appeal's revision, which this reviewer did not sit on.
    await cases.updateOne(seeded.tenant.tenant, { caseId: seeded.caseId }, { set: { currentRevision: 2 } });
    const second = await publishDecision({
      context: seeded.tenant.tenant,
      caseId: seeded.caseId,
      revision: 2,
      outcome: 'no_violation',
      contextSufficiency: 'sufficient',
      confidence: 0.8,
      findings: [],
      recommendedActions: [{ action: 'restore' }],
      jury: JURY,
      policyVersions: POLICY_VERSIONS,
      agreeingReviewerIds: [`rvw_${randomUUID().replace(/-/g, '')}`],
      supersedes:
        first.published === true
          ? { decisionId: first.decisionId, outcome: 'violation', appealId: null }
          : null,
      now: new Date(),
    });
    expect(second.published).toBe(true);

    /**
     * `violation`, not `no_violation`. Keying on `currentDecision` instead of the
     * revision on the reviewer's own row would show them an outcome they never
     * voted on and tell them, by implication, that an appeal overturned them.
     */
    const page = await reviewHistoryPage(reviewerId, {});
    expect(page.entries[0]?.decision?.outcome).toBe('violation');
  });
});
