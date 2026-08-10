import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TaxonomyFamily } from '@oxyhq/crowdsource-contracts';
import { isCheckViolation } from '@oxyhq/db';

import * as reviewerRepository from '../db/postgres/repositories/reviewers';
import { reviewerProfiles } from '../db/postgres/schema/reviewers';
import type { CaseEligibilityCriteria } from '../modules/reviewer/eligibility';
import { affinityPairKey } from '../modules/reviewer/reviewer.collection';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './support/postgresTestDatabase';

/**
 * The reviewer person-model repositories, against a real PostgreSQL server.
 *
 * These functions have no production caller yet, and this suite is why that is
 * acceptable: a repository that only type-checks is a set of statements whose
 * first execution happens in production. Below they have genuinely run, against
 * the real schema, the real unique indexes and the real unprivileged role.
 *
 * ## This file is NOT in `support/reviewerAxes.ts`, and that is checked
 *
 * `reviewerAxes.test.ts` requires every suite that seeds a globally drawable
 * reviewer profile to own a `(family, language)` cell no other suite holds. That
 * rule exists because the Mongo integration suites share ONE
 * `mongodb-memory-server` replica set, where reviewer profiles are global and one
 * file's pool is a candidate for another file's case.
 *
 * This file seeds reviewers into a THROWAWAY POSTGRES DATABASE created in its own
 * `beforeAll` — one per test file, dropped at the end — so the mechanism the
 * registry exists to prevent structurally does not exist here. It is recorded in
 * that gate's not-applicable list WITH that reason, rather than left to slip past
 * a marker list that only knows Mongo shapes.
 *
 * ## Fixture policy
 *
 * Every instant is written RELATIVE to a `now` captured per test. A hardcoded
 * absolute date in a committed fixture is a time bomb that detonates later, in
 * whichever file happens to run beside it.
 */

let database: PostgresTestDatabase;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.asMigrator`TRUNCATE reviewer_profiles, reviewer_principal_links, reviewer_relations, reviewer_affinities`;
});

const APPLICATION_ID = 'app_reviewer_repo_fixture';

/** A profile that is drawable on every dimension unless a test says otherwise. */
function drawableProfile(
  overrides: Partial<typeof reviewerProfiles.$inferInsert> & { readonly oxyUserId: string },
): Omit<typeof reviewerProfiles.$inferInsert, 'reviewerId'> {
  return {
    state: 'community',
    accountActive: true,
    oxyAccountVerified: true,
    isAdult: true,
    suspectedSockPuppet: false,
    riskClusterId: null,
    languages: ['en'],
    categories: ['integrity', 'commerce'],
    specialistCategories: [],
    maxSensitivityRank: 2,
    consentedSensitiveCategories: ['integrity', 'commerce'],
    declaredConflictApplications: [],
    rulesAcceptedAt: new Date(),
    available: true,
    dailyReviewLimit: 10,
    trainingCompletedModules: [],
    trainingCompletedAt: null,
    calibrationPassedAt: null,
    calibrationScore: null,
    calibrationAttempts: 0,
    lastCalibrationAt: null,
    reliabilityByCategory: {},
    completedReviewCount: 0,
    personhoodConfidence: 0.9,
    samplingKey: 0.5,
    suspendedUntil: null,
    ...overrides,
  };
}

function criteriaWith(overrides: Partial<CaseEligibilityCriteria> = {}): CaseEligibilityCriteria {
  return {
    families: ['integrity'] as readonly TaxonomyFamily[],
    language: 'en',
    sensitivity: 'standard',
    requiresAdult: false,
    ...overrides,
  };
}

/** Reads every profile the window query would consider, ignoring the window. */
async function drawnReviewerIds(criteria: CaseEligibilityCriteria, now: Date): Promise<string[]> {
  const rows = await reviewerRepository.findEligibleReviewerWindow(
    database.db,
    criteria,
    now,
    { kind: 'from', samplingKey: 0 },
    100,
  );
  return rows.map((row) => row.reviewerId).sort();
}

describe('reviewer profiles', () => {
  it('inserts a profile and reads it back by id and by Oxy user', async () => {
    const created = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_alpha' }),
    );

    expect(created.reviewerId).toMatch(/^rvw_[0-9a-f]{32}$/);

    const byId = await reviewerRepository.findReviewerProfileById(database.db, created.reviewerId);
    const byOxy = await reviewerRepository.findReviewerProfileByOxyUserId(database.db, 'oxy_alpha');

    expect(byId?.reviewerId).toBe(created.reviewerId);
    expect(byOxy?.reviewerId).toBe(created.reviewerId);
  });

  it('returns null rather than throwing for a reviewer that does not exist', async () => {
    expect(await reviewerRepository.findReviewerProfileById(database.db, 'rvw_absent')).toBeNull();
    expect(
      await reviewerRepository.findReviewerProfileByOxyUserId(database.db, 'oxy_absent'),
    ).toBeNull();
  });

  /**
   * A REPEATED call is the discriminator.
   *
   * A single call returns the same answer whether the statement inserts or
   * upserts, so it cannot tell the two apart. Called twice, an insert that is not
   * conflict-guarded either raises `23505` or produces a second profile — and a
   * second profile for one person is exactly what the Mongo unique index existed
   * to stop.
   */
  it('gives one Oxy account one profile however many times it is claimed', async () => {
    const first = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_race' }),
    );
    const second = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_race', dailyReviewLimit: 99 }),
    );

    expect(second.reviewerId).toBe(first.reviewerId);
    /** The second call's values are DISCARDED, matching Mongo's `$setOnInsert`. */
    expect(second.dailyReviewLimit).toBe(10);

    const [{ n }] = await database.asMigrator<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reviewer_profiles`;
    expect(n).toBe(1);
  });

  it('patches a profile and returns the row after the write', async () => {
    const created = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_patch' }),
    );
    const before = created.updatedAt;

    const updated = await reviewerRepository.updateReviewerProfile(
      database.db,
      created.reviewerId,
      { state: 'trusted', personhoodConfidence: 0.95 },
    );

    expect(updated?.state).toBe('trusted');
    expect(updated?.personhoodConfidence).toBe(0.95);
    /**
     * `$onUpdate` is applied by the query BUILDER. Asserted rather than assumed,
     * because it would NOT apply to a raw `db.execute` and the difference is
     * invisible in the returned row's other fields.
     */
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('reports a patch against a reviewer that does not exist as null', async () => {
    expect(
      await reviewerRepository.updateReviewerProfile(database.db, 'rvw_absent', {
        personhoodConfidence: 0.1,
      }),
    ).toBeNull();
  });

  it('loads several profiles by id, and none for an empty list', async () => {
    const a = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_many_a' }),
    );
    const b = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_many_b' }),
    );

    const found = await reviewerRepository.findReviewerProfilesByIds(database.db, [
      a.reviewerId,
      b.reviewerId,
      'rvw_absent',
    ]);
    expect(found.map((row) => row.reviewerId).sort()).toEqual(
      [a.reviewerId, b.reviewerId].sort(),
    );

    /** `inArray(column, [])` renders as `false`, agreeing with Mongo's `$in: []`. */
    expect(await reviewerRepository.findReviewerProfilesByIds(database.db, [])).toEqual([]);
  });
});

/**
 * The `$all` divergence, which is the one behaviour change in the repository.
 *
 * Each assertion about the EMPTY families case is paired with a non-empty control
 * on the same reviewer, the same table and the same query — so "zero rows"
 * cannot be confused with a fixture that seeded nothing or a predicate that
 * stopped matching for an unrelated reason.
 */
describe('an empty allegation list draws nobody, as it did on Mongo', () => {
  let reviewerId: string;
  let now: Date;

  beforeEach(async () => {
    now = new Date();
    const created = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_all' }),
    );
    reviewerId = created.reviewerId;
  });

  it('draws the reviewer when the case alleges something (the control)', async () => {
    expect(await drawnReviewerIds(criteriaWith({ families: ['integrity'] }), now)).toEqual([reviewerId]);
  });

  /**
   * Mongo's `$all: []` matched NOTHING; `categories @> ARRAY[]::text[]` matches
   * EVERYTHING. Measured on both servers 2026-08-11 — see the repository header.
   *
   * The failure this pins is not an error. Without the branch the SAME reviewer
   * the control just proved drawable comes back here too, a full panel is seated,
   * and the case that alleges nothing gets a jury instead of the refusal
   * (`candidate_pool_too_small`) Mongo produced.
   */
  it('draws NOBODY when the case alleges nothing', async () => {
    expect(await drawnReviewerIds(criteriaWith({ families: [] }), now)).toEqual([]);
  });

  it('draws the reviewer for a sensitive case that alleges something (the control)', async () => {
    expect(
      await drawnReviewerIds(criteriaWith({ families: ['integrity'], sensitivity: 'sensitive' }), now),
    ).toEqual([reviewerId]);
  });

  /** The second `$all` clause — consent — has the same shape and the same fix. */
  it('draws NOBODY for a sensitive case that alleges nothing', async () => {
    expect(
      await drawnReviewerIds(criteriaWith({ families: [], sensitivity: 'sensitive' }), now),
    ).toEqual([]);
  });
});

describe('the eligibility predicate narrows on every dimension it claims to', () => {
  let now: Date;

  beforeEach(() => {
    now = new Date();
  });

  it('requires every alleged family, not merely one of them', async () => {
    const created = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_partial', categories: ['integrity'] }),
    );

    expect(await drawnReviewerIds(criteriaWith({ families: ['integrity'] }), now)).toEqual([
      created.reviewerId,
    ]);
    expect(await drawnReviewerIds(criteriaWith({ families: ['integrity', 'commerce'] }), now)).toEqual(
      [],
    );
  });

  it('applies the language clause only when the case states one', async () => {
    const created = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_lang', languages: ['es'] }),
    );

    expect(await drawnReviewerIds(criteriaWith({ language: 'en' }), now)).toEqual([]);
    expect(await drawnReviewerIds(criteriaWith({ language: 'es' }), now)).toEqual([
      created.reviewerId,
    ]);
    /** Null is not "any language" as a convenience — it removes the constraint. */
    expect(await drawnReviewerIds(criteriaWith({ language: null }), now)).toEqual([
      created.reviewerId,
    ]);
  });

  it('excludes a reviewer who has not accepted the reviewing rules', async () => {
    await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_rules', rulesAcceptedAt: null }),
    );
    expect(await drawnReviewerIds(criteriaWith(), now)).toEqual([]);
  });

  it('excludes a currently suspended reviewer and admits one whose suspension lapsed', async () => {
    const lapsed = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({
        oxyUserId: 'oxy_lapsed',
        suspendedUntil: new Date(now.getTime() - 60_000),
      }),
    );
    await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({
        oxyUserId: 'oxy_suspended',
        suspendedUntil: new Date(now.getTime() + 60_000),
      }),
    );

    expect(await drawnReviewerIds(criteriaWith(), now)).toEqual([lapsed.reviewerId]);
  });

  it('excludes an inactive, unavailable, sock-puppet or undrawable-state reviewer', async () => {
    await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_inactive', accountActive: false }),
    );
    await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_unavailable', available: false }),
    );
    await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_sock', suspectedSockPuppet: true }),
    );
    await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_applicant', state: 'applicant' }),
    );

    expect(await drawnReviewerIds(criteriaWith(), now)).toEqual([]);
  });

  it('requires an adult attestation only when the case needs one', async () => {
    const minor = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_minor', isAdult: false }),
    );

    expect(await drawnReviewerIds(criteriaWith({ requiresAdult: false }), now)).toEqual([
      minor.reviewerId,
    ]);
    expect(await drawnReviewerIds(criteriaWith({ requiresAdult: true }), now)).toEqual([]);
  });

  it('excludes a reviewer whose consent rank is below the case', async () => {
    await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_rank', maxSensitivityRank: 0 }),
    );
    expect(await drawnReviewerIds(criteriaWith({ sensitivity: 'restricted' }), now)).toEqual([]);
  });

  it('excludes a reviewer who has not consented to the family for a sensitive case', async () => {
    await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_consent', consentedSensitiveCategories: ['commerce'] }),
    );
    expect(
      await drawnReviewerIds(criteriaWith({ families: ['integrity'], sensitivity: 'sensitive' }), now),
    ).toEqual([]);
  });

  /** The head and the wrap of `sampleCandidates`, which are the two windows. */
  it('reads the window above and below a sampling key', async () => {
    const low = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_low', samplingKey: 0.1 }),
    );
    const high = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_high', samplingKey: 0.9 }),
    );

    const head = await reviewerRepository.findEligibleReviewerWindow(
      database.db,
      criteriaWith(),
      now,
      { kind: 'from', samplingKey: 0.5 },
      10,
    );
    const tail = await reviewerRepository.findEligibleReviewerWindow(
      database.db,
      criteriaWith(),
      now,
      { kind: 'before', samplingKey: 0.5 },
      10,
    );

    expect(head.map((row) => row.reviewerId)).toEqual([high.reviewerId]);
    expect(tail.map((row) => row.reviewerId)).toEqual([low.reviewerId]);
  });
});

describe('reviewer principal links', () => {
  it('replaces one reviewer’s links wholesale, leaving another reviewer alone', async () => {
    const mine = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_links_mine' }),
    );
    const theirs = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_links_theirs' }),
    );

    await database.db.transaction(async (tx) => {
      await reviewerRepository.replaceReviewerPrincipalLinks(tx, mine.reviewerId, [
        { applicationId: APPLICATION_ID, externalPrincipalId: 'ext_one' },
        { applicationId: APPLICATION_ID, externalPrincipalId: 'ext_two' },
      ]);
      await reviewerRepository.replaceReviewerPrincipalLinks(tx, theirs.reviewerId, [
        { applicationId: APPLICATION_ID, externalPrincipalId: 'ext_theirs' },
      ]);
    });

    await database.db.transaction(async (tx) => {
      await reviewerRepository.replaceReviewerPrincipalLinks(tx, mine.reviewerId, [
        { applicationId: APPLICATION_ID, externalPrincipalId: 'ext_three' },
      ]);
    });

    const links = await reviewerRepository.findReviewerPrincipalLinks(
      database.db,
      mine.reviewerId,
    );
    expect(links.map((link) => link.externalPrincipalId)).toEqual(['ext_three']);

    /** The control: a wholesale replace is scoped to ONE reviewer. */
    const untouched = await reviewerRepository.findReviewerPrincipalLinks(
      database.db,
      theirs.reviewerId,
    );
    expect(untouched.map((link) => link.externalPrincipalId)).toEqual(['ext_theirs']);
  });

  it('clears the links when the reviewer declares none', async () => {
    const created = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_links_clear' }),
    );

    await database.db.transaction(async (tx) => {
      await reviewerRepository.replaceReviewerPrincipalLinks(tx, created.reviewerId, [
        { applicationId: APPLICATION_ID, externalPrincipalId: 'ext_gone' },
      ]);
    });
    await database.db.transaction(async (tx) => {
      await reviewerRepository.replaceReviewerPrincipalLinks(tx, created.reviewerId, []);
    });

    expect(
      await reviewerRepository.findReviewerPrincipalLinks(database.db, created.reviewerId),
    ).toEqual([]);
  });

  /**
   * The runtime half of the transaction requirement.
   *
   * The type refuses the pool at every honestly typed call site; this covers the
   * handle that arrives through a cast, an `any` or a generic boundary, which is
   * the case the Mongo guard was written for. A `DELETE` that ran outside a
   * transaction and was followed by a failed `INSERT` would leave a reviewer with
   * no self-exclusion links and nothing to say so.
   */
  it('refuses a handle that is not a transaction', async () => {
    await expect(
      reviewerRepository.replaceReviewerPrincipalLinks(
        database.db as unknown as Parameters<
          typeof reviewerRepository.replaceReviewerPrincipalLinks
        >[0],
        'rvw_whoever',
        [],
      ),
    ).rejects.toThrow();
  });

  /**
   * `$elemMatch` returned the parent document ONCE however many elements matched.
   * A join returns it once PER matching row, so the reviewer below — who has
   * claimed two of this case's principals — is the case that tells a correct
   * `DISTINCT` from a missing one.
   */
  it('returns a reviewer linked to two of the case’s principals exactly once', async () => {
    const created = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_two_links' }),
    );

    await database.db.transaction(async (tx) => {
      await reviewerRepository.replaceReviewerPrincipalLinks(tx, created.reviewerId, [
        { applicationId: APPLICATION_ID, externalPrincipalId: 'ext_a' },
        { applicationId: APPLICATION_ID, externalPrincipalId: 'ext_b' },
      ]);
    });

    const found = await reviewerRepository.findReviewerProfilesLinkedToPrincipals(
      database.db,
      APPLICATION_ID,
      ['ext_a', 'ext_b'],
    );
    expect(found.map((row) => row.reviewerId)).toEqual([created.reviewerId]);
  });

  it('does not cross application id spaces', async () => {
    const created = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_other_app' }),
    );
    await database.db.transaction(async (tx) => {
      await reviewerRepository.replaceReviewerPrincipalLinks(tx, created.reviewerId, [
        { applicationId: APPLICATION_ID, externalPrincipalId: 'ext_shared' },
      ]);
    });

    /** The control proves the fixture is findable at all under its own application. */
    expect(
      await reviewerRepository.findReviewerProfilesLinkedToPrincipals(database.db, APPLICATION_ID, [
        'ext_shared',
      ]),
    ).toHaveLength(1);
    expect(
      await reviewerRepository.findReviewerProfilesLinkedToPrincipals(
        database.db,
        'app_somebody_else',
        ['ext_shared'],
      ),
    ).toEqual([]);
  });
});

describe('reviewer relations', () => {
  it('records a declared conflict once, keeping the first source', async () => {
    await reviewerRepository.declareReviewerRelation(database.db, {
      reviewerId: 'rvw_relation',
      applicationId: APPLICATION_ID,
      externalPrincipalId: 'ext_party',
      source: 'declared',
    });
    /**
     * Called TWICE, which is the discriminator. A single call cannot tell an
     * insert from a conflict-guarded one, and Mongo's `$setOnInsert`-only write
     * left `source` as whatever the FIRST declaration said.
     */
    await reviewerRepository.declareReviewerRelation(database.db, {
      reviewerId: 'rvw_relation',
      applicationId: APPLICATION_ID,
      externalPrincipalId: 'ext_party',
      source: 'recusal',
    });

    const found = await reviewerRepository.findReviewerRelationsForPrincipals(
      database.db,
      APPLICATION_ID,
      ['ext_party'],
    );
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('declared');
  });

  it('finds only the relations naming one of this case’s principals', async () => {
    await reviewerRepository.declareReviewerRelation(database.db, {
      reviewerId: 'rvw_party',
      applicationId: APPLICATION_ID,
      externalPrincipalId: 'ext_wanted',
      source: 'declared',
    });
    await reviewerRepository.declareReviewerRelation(database.db, {
      reviewerId: 'rvw_party',
      applicationId: APPLICATION_ID,
      externalPrincipalId: 'ext_unwanted',
      source: 'declared',
    });

    const found = await reviewerRepository.findReviewerRelationsForPrincipals(
      database.db,
      APPLICATION_ID,
      ['ext_wanted'],
    );
    expect(found.map((row) => row.externalPrincipalId)).toEqual(['ext_wanted']);
  });
});

describe('reviewer affinities', () => {
  const A = 'rvw_aaaa';
  const B = 'rvw_bbbb';

  /**
   * The first co-service must leave the counter at ONE, not zero.
   *
   * Mongo applied `$setOnInsert` and `$inc` together, so the insert that created
   * the row also incremented it. A Postgres insert that seeded 0 would undercount
   * every pair's first panel forever, and the error is invisible until a pair
   * reaches the threshold one panel later than it should — no exception, no log
   * line, just two reviewers who keep being seated together.
   */
  it('counts the first panel as one and each later one as another', async () => {
    const now = new Date();

    await database.db.transaction(async (tx) => {
      await reviewerRepository.recordCoService(tx, affinityPairKey(A, B), A, B, now);
    });

    const afterFirst = await reviewerRepository.findAffinitiesAboveThreshold(
      database.db,
      [A, B],
      1,
    );
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].coServedCount).toBe(1);

    const later = new Date(now.getTime() + 1_000);
    await database.db.transaction(async (tx) => {
      await reviewerRepository.recordCoService(tx, affinityPairKey(A, B), A, B, later);
    });

    const afterSecond = await reviewerRepository.findAffinitiesAboveThreshold(
      database.db,
      [A, B],
      1,
    );
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].coServedCount).toBe(2);
    /**
     * `excluded.last_served_at`, spelled through `sqlColumnName`. Interpolating
     * the column object would emit `excluded.lastservedat` and fail with `42703`
     * at runtime — which no typecheck and no mock can reach, so it is asserted
     * against a real server or not at all.
     */
    expect(afterSecond[0].lastServedAt.getTime()).toBe(later.getTime());
  });

  it('returns only pairs at or above the threshold', async () => {
    const now = new Date();
    await database.db.transaction(async (tx) => {
      await reviewerRepository.recordCoService(tx, affinityPairKey(A, B), A, B, now);
    });

    /** The control: the same pair IS found at a threshold it meets. */
    expect(await reviewerRepository.findAffinitiesAboveThreshold(database.db, [A, B], 1)).toHaveLength(
      1,
    );
    expect(await reviewerRepository.findAffinitiesAboveThreshold(database.db, [A, B], 2)).toEqual([]);
  });

  it('requires BOTH reviewers to be in the sample, not merely one', async () => {
    const now = new Date();
    await database.db.transaction(async (tx) => {
      await reviewerRepository.recordCoService(tx, affinityPairKey(A, B), A, B, now);
    });

    expect(await reviewerRepository.findAffinitiesAboveThreshold(database.db, [A, B], 1)).toHaveLength(
      1,
    );
    expect(
      await reviewerRepository.findAffinitiesAboveThreshold(database.db, [A, 'rvw_stranger'], 1),
    ).toEqual([]);
  });

  it('refuses a handle that is not a transaction', async () => {
    await expect(
      reviewerRepository.recordCoService(
        database.db as unknown as Parameters<typeof reviewerRepository.recordCoService>[0],
        affinityPairKey(A, B),
        A,
        B,
        new Date(),
      ),
    ).rejects.toThrow();
  });
});

/**
 * The two CHECK constraints migration 0004 restores.
 *
 * These are the port's replacement for `enum: REVIEWER_STATES` and
 * `enum: REVIEWER_RELATION_SOURCES`, and they are asserted against a REAL server
 * because there is no other way to assert them: a mocked insert accepts any
 * statement, and a synthetic `{ code: '23514' }` fixture satisfies any predicate
 * written to read it. The errors below are caught from the server that raised
 * them.
 *
 * Each is NAMED. `isCheckViolation(error)` alone cannot tell "this constraint
 * fired" from "some other constraint on the same table fired", so a test that
 * omitted the name would keep passing if the state check were dropped and a
 * different one happened to catch the row.
 */
describe('the restored closed value sets are enforced by the database', () => {
  it('refuses a reviewer state outside REVIEWER_STATES, and accepts one inside it', async () => {
    /** The control, first: a legitimate state is accepted on this same column. */
    const created = await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_state_ok', state: 'specialist' }),
    );
    expect(created.state).toBe('specialist');

    const refused = await database.db
      .update(reviewerProfiles)
      .set({ state: 'archbishop' })
      .where(eq(reviewerProfiles.reviewerId, created.reviewerId))
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refused, 'the state CHECK did not fire; the value was accepted').not.toBeNull();
    expect(isCheckViolation(refused, 'reviewer_profiles_state_check')).toBe(true);

    /** And the refusal left the row alone rather than half-writing it. */
    const after = await reviewerRepository.findReviewerProfileById(
      database.db,
      created.reviewerId,
    );
    expect(after?.state).toBe('specialist');
  });

  it('refuses a relation source outside REVIEWER_RELATION_SOURCES', async () => {
    /** The control: both legitimate members are accepted. */
    await reviewerRepository.declareReviewerRelation(database.db, {
      reviewerId: 'rvw_source_ok',
      applicationId: APPLICATION_ID,
      externalPrincipalId: 'ext_ok',
      source: 'recusal',
    });
    const stored = await reviewerRepository.findReviewerRelationsForPrincipals(
      database.db,
      APPLICATION_ID,
      ['ext_ok'],
    );
    expect(stored[0].source).toBe('recusal');

    const refused = await reviewerRepository
      .declareReviewerRelation(database.db, {
        reviewerId: 'rvw_source_bad',
        applicationId: APPLICATION_ID,
        externalPrincipalId: 'ext_bad',
        source: 'rumour',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refused, 'the source CHECK did not fire; the value was accepted').not.toBeNull();
    expect(isCheckViolation(refused, 'reviewer_relations_source_check')).toBe(true);
  });
});

/**
 * A vacuity floor for the whole file.
 *
 * Every assertion above is of the form "these rows come back" or "no rows come
 * back", and the second form is also what a suite connected to an empty or wrong
 * database reports. This states that the tables under test are the ones being
 * written to.
 */
describe('the fixtures reach the tables under test', () => {
  it('writes to reviewer_profiles on the database the repository reads', async () => {
    await reviewerRepository.insertReviewerProfileIfAbsent(
      database.db,
      drawableProfile({ oxyUserId: 'oxy_floor' }),
    );

    const result = await database.db.execute(
      sql`SELECT count(*)::int AS n FROM reviewer_profiles`,
    );
    const [row] = result as unknown as { n: number }[];
    expect(Number(row.n)).toBe(1);
  });
});
