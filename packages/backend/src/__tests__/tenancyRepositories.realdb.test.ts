import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as tenancyRepository from '../db/postgres/repositories/tenancy';
import { createTenantContext } from '../db/tenantScope';
import { withTenant } from '../db/postgres/withTenant';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './support/postgresTestDatabase';

/**
 * The tenancy repositories, against a real PostgreSQL server.
 *
 * These functions have no production caller yet, and this suite is why that is
 * acceptable: a repository that only type-checks is a set of statements whose
 * first execution happens in production. Here they have genuinely run — against
 * the real schema, the real constraints and the real role.
 *
 * The suite carries one claim that is not merely coverage. `tableRegistry.ts`
 * files these three tables as `defines_the_tenant`, on the argument that a policy
 * keyed on the runtime parameters would be CIRCULAR: the read is what produces the
 * tenant such a policy would filter by. Until now that was an argument from call
 * sites. Below it is a measurement — every read runs with NO tenant parameters
 * set, as the application role, and returns rows.
 */

let database: PostgresTestDatabase;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

const ORGANIZATION_ID = 'org_repo_fixture';
const APPLICATION_ID = 'app_repo_fixture';

/**
 * The control query, cast to `int` in SQL.
 *
 * `count(*)` is a bigint and postgres.js decodes those as STRINGS, so an uncast
 * count arrives as `'0'` — which is truthy, compares unequal to `0`, and would
 * make the isolation control below fail for a reason that has nothing to do with
 * row security.
 */
const COUNT_CASES = sql`SELECT count(*)::int AS n FROM cases`;

/** Reads the single `n` out of a `db.execute` result, whatever its row wrapper. */
function rowCount(result: unknown): number {
  const [row] = result as { n: number | string }[];
  return Number(row.n);
}

async function seedOrganizationAndApplication(): Promise<void> {
  await tenancyRepository.insertOrganization(database.db, {
    organizationId: ORGANIZATION_ID,
    name: 'Repository Fixture',
    slug: 'repository-fixture',
    status: 'active',
  });
  await tenancyRepository.insertApplication(database.db, {
    applicationId: APPLICATION_ID,
    organizationId: ORGANIZATION_ID,
    name: 'Fixture App',
    status: 'active',
  });
}

describe('the tenant-defining tables are reachable with NO tenant context', () => {
  /**
   * The empirical form of the `defines_the_tenant` exemption.
   *
   * Every statement in this block runs as the APPLICATION role — the one bound by
   * every policy — with `app.organization_id` and `app.application_id` unset. If
   * these tables ever gained a tenant policy, `current_setting(…, true)` would be
   * NULL, nothing would match, and each read below would answer zero rows. The
   * assertions are what would notice.
   */
  it('inserts and reads an organization and an application', async () => {
    await seedOrganizationAndApplication();

    const organization = await tenancyRepository.findOrganizationById(
      database.db,
      ORGANIZATION_ID,
    );
    expect(organization?.name).toBe('Repository Fixture');

    const application = await tenancyRepository.findApplicationById(
      database.db,
      APPLICATION_ID,
    );
    expect(application?.organizationId).toBe(ORGANIZATION_ID);
  });

  /**
   * The authenticating read, and the sharpest case: by the credential's own id,
   * with no tenant term in the query at all. This is the statement a policy would
   * make unsatisfiable.
   */
  it('resolves a credential by its own id, which is what yields the tenant', async () => {
    await tenancyRepository.insertApplicationCredential(database.db, {
      credentialId: 'cred_alpha',
      organizationId: ORGANIZATION_ID,
      applicationId: APPLICATION_ID,
      secretHash: 'sha256-of-the-secret',
      scopes: ['reports:write'],
      status: 'active',
      expiresAt: null,
    });

    const credential = await tenancyRepository.findApplicationCredentialById(
      database.db,
      'cred_alpha',
    );

    expect(credential).not.toBeNull();
    // The tenant is what the row RETURNS — it is not a term the caller supplied.
    expect(credential?.organizationId).toBe(ORGANIZATION_ID);
    expect(credential?.applicationId).toBe(APPLICATION_ID);
  });

  /**
   * The negative control for the block above.
   *
   * Reading a tenant-OWNED table as the same role, in the same state, must answer
   * zero rows — otherwise "the unscoped reads worked" would be equally explained
   * by row security not being in force at all, and every assertion above would be
   * measuring nothing. The migrator seeds the row so its absence from the app
   * role's read is FILTERING rather than emptiness.
   */
  it('still cannot read a tenant-owned table without a context, which proves RLS is live', async () => {
    await database.asMigrator`
      INSERT INTO cases (case_id, organization_id, application_id, subject_external_id, status, opened_at)
      VALUES ('case_control', ${ORGANIZATION_ID}, ${APPLICATION_ID}, 'subject', 'open', now())
    `;

    const [seeded] = await database.asMigrator<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cases WHERE case_id = 'case_control'
    `;
    expect(seeded.n).toBe(1);

    const withoutContext = await database.db.execute(COUNT_CASES);
    expect(rowCount(withoutContext)).toBe(0);

    // And WITH a context it comes back, so the zero above is the policy rather
    // than a broken fixture. Both directions, because a read that answers zero is
    // equally well explained by an empty table.
    const visible = await withTenant(
      database.db,
      createTenantContext(ORGANIZATION_ID, APPLICATION_ID),
      async (tx) => await tx.execute(COUNT_CASES),
    );
    expect(rowCount(visible)).toBe(1);
  });
});

describe('the circularity claim is enforced, not merely argued', () => {
  /**
   * What would happen if somebody "fixed" the missing policy.
   *
   * `tableRegistry.ts` says a tenant policy on `application_credentials` would be
   * circular, and the test above shows the read works today — but a read working
   * is equally well explained by nobody having tried to break it. This applies the
   * exact policy an auditor would add, and shows the authenticating read then
   * returns NOTHING.
   *
   * That is the whole argument, executed: with this policy in place the service
   * cannot resolve a credential, so it cannot authenticate anybody, so it can
   * never set the parameters the policy reads. The `finally` puts the table back.
   */
  it('a tenant policy here makes the authenticating read return nothing', async () => {
    const before = await tenancyRepository.findApplicationCredentialById(database.db, 'cred_alpha');
    expect(before).not.toBeNull();

    try {
      await database.asMigrator.unsafe(`
        ALTER TABLE "application_credentials" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE "application_credentials" FORCE ROW LEVEL SECURITY;
        CREATE POLICY "probe_tenant_isolation" ON "application_credentials"
          USING (organization_id = current_setting('app.organization_id', true)
             AND application_id = current_setting('app.application_id', true));
      `);

      // Assert the mutation landed before believing what it produces.
      const [policy] = await database.asMigrator<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies WHERE tablename = 'application_credentials'
      `;
      expect(policy?.policyname).toBe('probe_tenant_isolation');

      const underPolicy = await tenancyRepository.findApplicationCredentialById(
        database.db,
        'cred_alpha',
      );

      // The credential resolution path, dead. No error, no log — just nothing,
      // which is why this failure mode needs a test rather than an argument.
      expect(underPolicy).toBeNull();
    } finally {
      await database.asMigrator.unsafe(`
        DROP POLICY IF EXISTS "probe_tenant_isolation" ON "application_credentials";
        ALTER TABLE "application_credentials" NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE "application_credentials" DISABLE ROW LEVEL SECURITY;
      `);
    }

    const restored = await tenancyRepository.findApplicationCredentialById(
      database.db,
      'cred_alpha',
    );
    expect(restored).not.toBeNull();
  });
});

describe('every tenancy repository function, exercised', () => {
  it('updates an organization status, and reports 0 for a row that is not there', async () => {
    expect(
      await tenancyRepository.updateOrganizationStatus(database.db, ORGANIZATION_ID, 'suspended'),
    ).toBe(1);

    /**
     * MEASURED against Mongo, 2026-08-10: the wrapper this replaces returns
     * `modifiedCount`, and a same-value update still counts as modified because
     * Mongoose's `timestamps: true` stamps `updated_at` — probe returned
     * `changed=1, unchangedSameValue=1, noMatch=0`. So Postgres's matched-row count
     * is equivalent and needs no `status <> $new` predicate. This assertion pins
     * that equivalence: setting the SAME status again must still answer 1.
     */
    expect(
      await tenancyRepository.updateOrganizationStatus(database.db, ORGANIZATION_ID, 'suspended'),
    ).toBe(1);

    expect(
      await tenancyRepository.updateOrganizationStatus(database.db, 'org_absent', 'suspended'),
    ).toBe(0);
  });

  it('updates an application status the same way', async () => {
    expect(
      await tenancyRepository.updateApplicationStatus(database.db, APPLICATION_ID, 'suspended'),
    ).toBe(1);
    expect(
      await tenancyRepository.updateApplicationStatus(database.db, 'app_absent', 'suspended'),
    ).toBe(0);
  });

  it('lists and counts an organization’s applications', async () => {
    await tenancyRepository.insertApplication(database.db, {
      applicationId: 'app_repo_second',
      organizationId: ORGANIZATION_ID,
      name: 'Second App',
      status: 'active',
    });

    const listed = await tenancyRepository.listApplicationsByOrganization(
      database.db,
      ORGANIZATION_ID,
    );
    expect(listed.map((row) => row.applicationId).sort()).toEqual([
      'app_repo_fixture',
      'app_repo_second',
    ]);

    /**
     * TWO applications, not one, and the count is asserted as a NUMBER.
     * postgres.js decodes a bigint as a string, so an uncast `count(*)` would
     * arrive as `'2'` — which passes a truthiness check, fails `toBe(2)`, and
     * would silently concatenate in any later arithmetic. A single-row fixture
     * could not tell 2 from '2' apart from the type.
     */
    const total = await tenancyRepository.countApplicationsByOrganization(
      database.db,
      ORGANIZATION_ID,
    );
    expect(total).toBe(2);
    expect(typeof total).toBe('number');

    expect(await tenancyRepository.countApplicationsByOrganization(database.db, 'org_absent')).toBe(
      0,
    );
  });

  it('revokes a credential once, and refuses to revoke it twice', async () => {
    const owner = { organizationId: ORGANIZATION_ID, applicationId: APPLICATION_ID };
    const revokedAt = new Date();

    expect(
      await tenancyRepository.revokeApplicationCredential(
        database.db,
        owner,
        'cred_alpha',
        revokedAt,
      ),
    ).toBe(1);

    /**
     * The second attempt answers 0 because the filter carries `status = 'active'`.
     * That is the distinction the caller turns into `not_found`, and it is also
     * what stops a re-revoke overwriting the original `revoked_at` — which a test
     * that only called it once could not tell from a no-op.
     */
    expect(
      await tenancyRepository.revokeApplicationCredential(
        database.db,
        owner,
        'cred_alpha',
        new Date(),
      ),
    ).toBe(0);

    const stored = await tenancyRepository.findApplicationCredentialById(database.db, 'cred_alpha');
    expect(stored?.status).toBe('revoked');
    expect(stored?.revokedAt?.getTime()).toBe(revokedAt.getTime());
  });

  it('refuses to revoke another application’s credential', async () => {
    await tenancyRepository.insertApplicationCredential(database.db, {
      credentialId: 'cred_beta',
      organizationId: ORGANIZATION_ID,
      applicationId: APPLICATION_ID,
      secretHash: 'another-digest',
      scopes: [],
      status: 'active',
      expiresAt: null,
    });

    expect(
      await tenancyRepository.revokeApplicationCredential(
        database.db,
        { organizationId: ORGANIZATION_ID, applicationId: 'app_repo_second' },
        'cred_beta',
        new Date(),
      ),
    ).toBe(0);
  });

  /**
   * The security property, asserted on the VALUE and not only on the type.
   *
   * `secret_hash` is absent from the select list, so `tsc` already refuses a
   * serializer that reaches for it. This checks the other half — that the row
   * handed back at runtime genuinely has no such key — because a type is a claim
   * about the query and this is a claim about the bytes.
   */
  it('never returns a secret hash in a credential summary', async () => {
    const summaries = await tenancyRepository.listCredentialSummaries(database.db, {
      organizationId: ORGANIZATION_ID,
      applicationId: APPLICATION_ID,
    });

    expect(summaries.length).toBeGreaterThanOrEqual(2);
    for (const summary of summaries) {
      expect(Object.keys(summary)).not.toContain('secretHash');
      expect(Object.keys(summary)).not.toContain('secret_hash');
    }
    // Newest first.
    expect(summaries[0].credentialId).toBe('cred_beta');
  });
});

describe('the suite exercises the whole module', () => {
  /**
   * "Exercises every exported function" is itself a claim, and an unchecked one
   * would rot on the first function somebody adds. This reads the module's exports
   * and this file's own source, so a new repository function fails the build until
   * it is either exercised or deliberately named here.
   *
   * The same device `collectionBoundary.test.ts` uses to check its own import
   * block, for the same reason: finding fewer functions looks exactly like there
   * being fewer.
   */
  it('names every exported function somewhere in this file', () => {
    const exported = Object.entries(tenancyRepository)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    // Vacuity floor: a module that exported nothing would satisfy the check below.
    expect(exported.length).toBeGreaterThanOrEqual(10);

    const source = readFileSync(path.join(__dirname, 'tenancyRepositories.realdb.test.ts'), 'utf8');
    const unexercised = exported.filter((name) => !source.includes(`tenancyRepository.${name}(`));

    expect(unexercised).toEqual([]);
  });
});
