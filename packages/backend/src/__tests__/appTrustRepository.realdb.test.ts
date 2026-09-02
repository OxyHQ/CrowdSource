import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as appTrust from '../db/postgres/repositories/appTrust';
import { appTrustSnapshots } from '../db/postgres/schema/infrastructure';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './support/postgresTestDatabase';

/**
 * Application trust standing, against a real PostgreSQL server.
 *
 * No production caller yet; this suite is what makes these statements ones that
 * have genuinely run against the real schema and the real unprivileged role.
 *
 * Every instant is written RELATIVE to a `now` captured per test.
 */

let database: PostgresTestDatabase;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.asMigrator`TRUNCATE app_trust_snapshots`;
});

const ORGANIZATION_ID = 'org_trust_repo_fixture';
const STANDINGS = ['sandbox', 'trusted', 'restricted'] as const;
const MINUTE = 60 * 1000;
const offset = (ms: number) => new Date(Date.now() + ms);

function trustRow(
  overrides: Partial<typeof appTrustSnapshots.$inferInsert> & { readonly applicationId: string },
): typeof appTrustSnapshots.$inferInsert {
  return {
    organizationId: ORGANIZATION_ID,
    standing: 'sandbox',
    globalReputationEffectsAllowed: false,
    evidenceIntegrity: null,
    identityBindingReliability: null,
    policyQuality: null,
    lastStandingReason: 'initial',
    standingChangedAt: null,
    standingChangedByOxyUserId: null,
    ...overrides,
  };
}

async function seed(rows: readonly (typeof appTrustSnapshots.$inferInsert)[]): Promise<void> {
  await database.db.insert(appTrustSnapshots).values([...rows]);
}

describe('creating the sandbox default', () => {
  it('inserts once and leaves an existing row untouched on a retry', async () => {
    await appTrust.insertSandboxDefaultIfAbsent(
      database.db,
      trustRow({ applicationId: 'app_new', standing: 'sandbox' }),
    );

    /**
     * A retried provisioning call, with DIFFERENT content. The existing row must
     * survive unchanged — `DO NOTHING`, not `DO UPDATE`, because this path exists
     * to be idempotent and must never overwrite a standing an operator has since
     * moved.
     */
    await appTrust.insertSandboxDefaultIfAbsent(
      database.db,
      trustRow({
        applicationId: 'app_new',
        standing: 'restricted',
        lastStandingReason: 'suspected_abuse',
      }),
    );

    const row = await appTrust.findByApplicationId(database.db, 'app_new');
    expect(row?.standing, 'a retry overwrote a standing that had already moved').toBe('sandbox');
    expect(row?.lastStandingReason).toBe('initial');
  });

  /**
   * No statement FAILS, so the surrounding transaction survives.
   *
   * The Mongo site reads then inserts, which races; the port uses
   * `ON CONFLICT DO NOTHING`. This runs it inside a transaction and then writes
   * again — impossible if the conflict had aborted it (`25P02`).
   */
  it('leaves the provisioning transaction usable after a conflict', async () => {
    await seed([trustRow({ applicationId: 'app_exists' })]);

    await database.db.transaction(async (tx) => {
      await appTrust.insertSandboxDefaultIfAbsent(tx, trustRow({ applicationId: 'app_exists' }));
      await appTrust.insertSandboxDefaultIfAbsent(tx, trustRow({ applicationId: 'app_after' }));
    });

    const after = await appTrust.findByApplicationId(database.db, 'app_after');
    expect(after?.applicationId).toBe('app_after');
  });
});

describe('the tenant-filtered read', () => {
  /**
   * The whole point of the second predicate.
   *
   * A caller holding a `TenantContext` for organization A must not read the row
   * of an application belonging to B, even when it can name the application — and
   * a primary-key-only lookup would return it. This is the assertion that a
   * "simplification" to `findByApplicationId` would break.
   */
  it('refuses a row belonging to another organization', async () => {
    await seed([trustRow({ applicationId: 'app_theirs', organizationId: 'org_somebody_else' })]);

    const byId = await appTrust.findByApplicationId(database.db, 'app_theirs');
    expect(byId, "the unfiltered read should still find it — that is what it is for").not.toBeNull();

    const forTenant = await appTrust.findForTenant(database.db, ORGANIZATION_ID, 'app_theirs');
    expect(forTenant, "another organization's trust row was returned").toBeNull();
  });

  it('returns the row when both halves of the pair match', async () => {
    await seed([trustRow({ applicationId: 'app_mine' })]);

    const found = await appTrust.findForTenant(database.db, ORGANIZATION_ID, 'app_mine');

    expect(found?.applicationId).toBe('app_mine');
  });
});

describe('moving a standing', () => {
  it('writes the change and returns the row after the write', async () => {
    const now = new Date();
    await seed([trustRow({ applicationId: 'app_move' })]);

    const updated = await appTrust.updateStanding(database.db, 'app_move', {
      standing: 'trusted',
      globalReputationEffectsAllowed: true,
      lastStandingReason: 'promotion_review_passed',
      standingChangedAt: now,
      standingChangedByOxyUserId: 'oxy_staff_1',
    });

    /** The post-image, not the pre-image — the caller returns this to the operator. */
    expect(updated?.standing).toBe('trusted');
    expect(updated?.globalReputationEffectsAllowed).toBe(true);
    expect(updated?.lastStandingReason).toBe('promotion_review_passed');
    expect(updated?.standingChangedAt?.getTime()).toBe(now.getTime());
    expect(updated?.standingChangedByOxyUserId).toBe('oxy_staff_1');
  });

  it('answers null for an application that has no trust row', async () => {
    const updated = await appTrust.updateStanding(database.db, 'app_absent', {
      standing: 'trusted',
      globalReputationEffectsAllowed: true,
      lastStandingReason: 'promotion_review_passed',
      standingChangedAt: new Date(),
      standingChangedByOxyUserId: null,
    });

    expect(updated).toBeNull();
  });
});

describe('the Trust & Safety list', () => {
  it('orders by most recently updated, filters, and honours the limit', async () => {
    await seed([
      trustRow({ applicationId: 'app_old', updatedAt: offset(-30 * MINUTE) }),
      trustRow({ applicationId: 'app_new', updatedAt: offset(-1 * MINUTE) }),
      trustRow({ applicationId: 'app_restricted', standing: 'restricted', updatedAt: offset(-2 * MINUTE) }),
    ]);

    const all = await appTrust.listByStanding(database.db, undefined, 10);
    expect(all.map((r) => r.applicationId)).toEqual(['app_new', 'app_restricted', 'app_old']);

    const restricted = await appTrust.listByStanding(database.db, 'restricted', 10);
    expect(restricted.map((r) => r.applicationId)).toEqual(['app_restricted']);

    const limited = await appTrust.listByStanding(database.db, undefined, 1);
    expect(limited.map((r) => r.applicationId)).toEqual(['app_new']);
  });

  /**
   * `undefined` means "every standing", not "no standing".
   *
   * Drizzle drops an `undefined` from `.where()`, so the unfiltered call is a
   * bare `SELECT`. Asserted because the alternative reading — an unfiltered call
   * quietly matching nothing — would make the T&S dashboard show an empty list
   * and look like a system with no applications rather than a broken filter.
   */
  it('treats an absent filter as every standing rather than none', async () => {
    await seed([
      trustRow({ applicationId: 'app_a', standing: 'sandbox' }),
      trustRow({ applicationId: 'app_b', standing: 'trusted' }),
      trustRow({ applicationId: 'app_c', standing: 'restricted' }),
    ]);

    const all = await appTrust.listByStanding(database.db, undefined, 10);

    expect(all).toHaveLength(3);
  });
});

/**
 * The counts, where `GROUP BY` and `countDocuments` disagree about absence.
 */
describe('counts by standing', () => {
  it('reports ZERO for a standing nobody is in', async () => {
    await seed([
      trustRow({ applicationId: 'app_s1', standing: 'sandbox' }),
      trustRow({ applicationId: 'app_s2', standing: 'sandbox' }),
      trustRow({ applicationId: 'app_t1', standing: 'trusted' }),
    ]);

    const counts = await appTrust.countByStanding(database.db, STANDINGS);

    expect(counts).toEqual({ sandbox: 2, trusted: 1, restricted: 0 });
  });

  it('returns every requested standing even when the table is empty', async () => {
    const counts = await appTrust.countByStanding(database.db, STANDINGS);

    expect(counts).toEqual({ sandbox: 0, trusted: 0, restricted: 0 });
  });

  /**
   * `count(*)` arrives from postgres.js as a STRING typed `number` by drizzle.
   * Asserted by ARITHMETIC so the failure names itself: `"2" + 1` is `"21"`.
   */
  it('returns numbers, not the strings postgres.js decodes int8 into', async () => {
    await seed([
      trustRow({ applicationId: 'app_n1', standing: 'trusted' }),
      trustRow({ applicationId: 'app_n2', standing: 'trusted' }),
    ]);

    const counts = await appTrust.countByStanding(database.db, STANDINGS);

    expect(typeof counts.trusted).toBe('number');
    expect(counts.trusted + 1, 'the count concatenated instead of adding').toBe(3);
  });

  it('refuses a standing outside the closed database vocabulary', async () => {
    await expect(
      seed([trustRow({ applicationId: 'app_unknown', standing: 'quarantined' })]),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

/** A vacuity floor: every assertion above is "rows come back" or "none do". */
describe('the fixtures reach the table under test', () => {
  it('writes rows that are really in app_trust_snapshots', async () => {
    await seed([trustRow({ applicationId: 'app_floor' })]);

    const [row] = await database.asMigrator<{ count: string }[]>`
      SELECT count(*)::text AS count FROM app_trust_snapshots WHERE application_id = 'app_floor'
    `;
    expect(row.count).toBe('1');

    const throughRepository = await appTrust.findByApplicationId(database.db, 'app_floor');
    expect(throughRepository?.organizationId).toBe(ORGANIZATION_ID);
  });
});
