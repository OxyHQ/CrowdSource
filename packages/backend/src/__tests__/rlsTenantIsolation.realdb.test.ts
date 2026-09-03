import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@oxyhq/db';

import { cases } from '../db/postgres/schema';
import {
  APPLICATION_GUC,
  APPLICATION_ROLE,
  MIGRATOR_ACCESS_POLICY,
  MIGRATOR_ROLE,
  ORGANIZATION_GUC,
  TENANT_ISOLATION_POLICY,
  TENANT_PREDICATE_PARAMETERS,
} from '../db/postgres/tenancy';
import { createTenantContext } from '../db/tenantScope';
import { withTenant, type PgHandle } from '../db/postgres/withTenant';
import {
  createPostgresTestDatabase,
  type BackendSchema,
  type PostgresTestDatabase,
} from './support/postgresTestDatabase';

/**
 * Tenant isolation, as PostgreSQL enforces it.
 *
 * `tenantIsolation.integration.test.ts` is the Mongo half of this and its header
 * explains why it is written the way it is: on Mongo the boundary is a property
 * of the codebase and of nothing else. These are the tests standing where that
 * file said Row Level Security would have stood.
 *
 * THIS FILE IS THE ONLY EVIDENCE THE COMPOSITE PROPERTY WILL EVER HAVE.
 * `crowdsource-production` holds two documents, both `reviewer_profiles`, and no
 * document anywhere carries an `organizationId` + `applicationId` pair — a census
 * run as a one-shot task in the VPC, with a 26-collection positive control. So
 * production will never supply a counterexample: if the policy is ever narrowed
 * to the organization key alone, nothing else in the system will notice. That is
 * why the mutation test at the bottom is load-bearing rather than hygienic, and
 * why the property is exercised on all five verbs rather than on a read.
 *
 * Two vacuity hazards shape every assertion here, and they point in OPPOSITE
 * directions:
 *
 *  1. The failure mode of broken isolation is RETURNING ROWS, not erroring. So
 *     no assertion of the form "the row I inserted comes back" proves anything —
 *     they all pass under total bypass. Every claim below is a NEGATIVE, and the
 *     positive controls exist only to keep the negatives meaningful.
 *  2. A negative is equally worthless if the row was never there. Under FORCE the
 *     application role cannot read around its own policy, so the controls run on
 *     a second connection as the migrator. A 0 is evidence of filtering only
 *     when something else can see the row.
 */

let database: PostgresTestDatabase;

/** Two organizations, and a SECOND application under the first one. */
const alpha = createTenantContext('org_alpha', 'app_alpha');
const beta = createTenantContext('org_beta', 'app_beta');
/**
 * The fixture that makes this file mean anything.
 *
 * With only alpha and beta, a policy that matched `organization_id` and forgot
 * `application_id` passes every assertion here — two separate customers are
 * isolated by their organization alone. One customer's two products are not, and
 * that is the realistic shape: a staging application and a production one under
 * one account. Measured directly against a real server, not reasoned about; the
 * Mongo half of this suite records finding the identical defect by mutation.
 */
const alphaSibling = createTenantContext('org_alpha', 'app_sibling');

const seeded = [
  { context: alpha, caseId: 'case_alpha', subject: 'post_1' },
  { context: beta, caseId: 'case_beta', subject: 'post_2' },
  { context: alphaSibling, caseId: 'case_sibling', subject: 'post_3' },
];

/** SQLSTATE `42501`, which is what a row-security refusal raises. */
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Rows a write affected.
 *
 * The base `PgDatabase` handle types `execute` as `unknown`, deliberately — it
 * cannot know which driver is underneath. postgres.js reports the row count on
 * the result, and that number is the entire point of the UPDATE and DELETE cases
 * below: under a broken policy they affect rows, and under a correct one they
 * affect none WITHOUT erroring.
 */
async function affectedRows(handle: PgHandle, statement: SQL): Promise<number> {
  const result = (await handle.execute(statement)) as unknown as { count?: number };
  return result.count ?? 0;
}

/**
 * Asserts a write was refused BY THE POLICY, not by something else.
 *
 * drizzle wraps a driver error, and the wrapper's own message is only
 * `Failed query: …` — so matching the message of the thrown error passes for any
 * failing statement at all, including a typo. The Postgres error is the `cause`,
 * and asserting its SQLSTATE is what makes this distinguish a policy refusal
 * from a broken statement. The message is checked too, on the cause, because
 * `42501` also covers an ordinary missing GRANT and those are different bugs.
 */
async function expectPolicyRefusal(operation: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  expect(caught, 'the write must be refused, not silently accepted').toBeDefined();

  const cause = (caught as { cause?: unknown }).cause ?? caught;
  const { code, message } = cause as { code?: string; message?: string };

  expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  expect(String(message)).toMatch(/row-level security/i);
}

function insertCaseStatement(input: {
  readonly caseId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly subject: string;
}): SQL {
  return sql`
    INSERT INTO cases (
      case_id, organization_id, application_id, subject_external_id,
      content_hash, policy_version, case_dedup_key, subject_type,
      primary_resource_id, policy_set_id, taxonomy_version, content_snapshot,
      status, allegation_codes, report_count, reporter_fingerprints, reach,
      active_distribution, allow_community_review, contains_personal_data,
      retention_days, priority_score, sensitivity_class, review_pool,
      requires_redaction, escalated, triaged_at, current_revision,
      decided_revision, incident_id, first_reported_at, last_reported_at
    ) VALUES (
      ${input.caseId}, ${input.organizationId}, ${input.applicationId}, ${input.subject},
      ${`hash_${input.caseId}`}, 'baseline@1', ${`dedup_${input.caseId}`}, 'post',
      ${`resource_${input.caseId}`}, 'baseline', '2026.08', '{}'::jsonb,
      'received', ARRAY['integrity.spam'], 1, ARRAY[${`reporter_${input.caseId}`}], 0,
      false, true, false, 30, 0, NULL, NULL, false, false, NULL, 1, 0, NULL,
      now(), now()
    )
  `;
}

async function seedCaseAsMigrator(input: {
  readonly caseId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly subject: string;
}): Promise<void> {
  await database.asMigrator`
    INSERT INTO cases (
      case_id, organization_id, application_id, subject_external_id,
      content_hash, policy_version, case_dedup_key, subject_type,
      primary_resource_id, policy_set_id, taxonomy_version, content_snapshot,
      status, allegation_codes, report_count, reporter_fingerprints, reach,
      active_distribution, allow_community_review, contains_personal_data,
      retention_days, priority_score, sensitivity_class, review_pool,
      requires_redaction, escalated, triaged_at, current_revision,
      decided_revision, incident_id, first_reported_at, last_reported_at
    ) VALUES (
      ${input.caseId}, ${input.organizationId}, ${input.applicationId}, ${input.subject},
      ${`hash_${input.caseId}`}, 'baseline@1', ${`dedup_${input.caseId}`}, 'post',
      ${`resource_${input.caseId}`}, 'baseline', '2026.08', '{}'::jsonb,
      'received', ARRAY['integrity.spam'], 1, ARRAY[${`reporter_${input.caseId}`}], 0,
      false, true, false, 30, 0, NULL, NULL, false, false, NULL, 1, 0, NULL,
      now(), now()
    )
  `;
}

beforeAll(async () => {
  database = await createPostgresTestDatabase();

  // Seeded as the MIGRATOR, deliberately. Seeding through the application role
  // would prove only that the policy admits writes it also admits reads for; the
  // rows have to exist independently of the mechanism under test.
  for (const row of seeded) {
    await seedCaseAsMigrator({
      caseId: row.caseId,
      organizationId: row.context.organizationId,
      applicationId: row.context.applicationId,
      subject: row.subject,
    });
  }
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe('the harness itself', () => {
  /**
   * The guard that decides whether every other test in this file measures a
   * policy or measures a bypass.
   *
   * Measured on PostgreSQL 17: a superuser bypasses row security even with FORCE,
   * and the compose role this repository's container ships is
   * `rolsuper=t, rolbypassrls=t`. Inheriting it would leave the whole suite green
   * and asserting nothing — the purest form of the vacuity failure, applied to the
   * security property itself.
   */
  it('connects as roles that cannot bypass row security', async () => {
    const roles = await database.asMigrator<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
      WHERE rolname IN (${MIGRATOR_ROLE}, ${APPLICATION_ROLE})
      ORDER BY rolname
    `;

    expect(roles).toHaveLength(2);
    for (const role of roles) {
      expect(role.rolsuper, `${role.rolname} must not be a superuser`).toBe(false);
      expect(role.rolbypassrls, `${role.rolname} must not hold BYPASSRLS`).toBe(false);
    }
  });

  /**
   * `ENABLE` without `FORCE` is inert for the table's owner — the DDL succeeds,
   * `pg_policies` lists the policy, and every tenant's rows stay visible. Read
   * from the catalogue rather than inferred from behaviour, so a future migration
   * that creates a table and forgets `FORCE` fails here by name.
   */
  it('has row security both enabled and FORCED on cases', async () => {
    const [table] = await database.asMigrator<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'cases'`;

    expect(table.relrowsecurity).toBe(true);
    expect(table.relforcerowsecurity).toBe(true);
  });

  /**
   * The policy is SQL and `tenancy.ts` is TypeScript — two representations of one
   * fact, which can drift. A policy narrowed to the organization key would leave
   * every module compiling.
   */
  it('states both tenant parameters in the live policy', async () => {
    const [policy] = await database.asMigrator<{ qual: string }[]>`
      SELECT qual FROM pg_policies
      WHERE tablename = 'cases' AND policyname = ${TENANT_ISOLATION_POLICY}
    `;

    for (const parameter of TENANT_PREDICATE_PARAMETERS) {
      expect(policy.qual).toContain(parameter);
    }
  });

  /**
   * The default-privilege contract, asserted rather than assumed.
   *
   * The migration issues no `GRANT`: the application role can read this table
   * only because provisioning set `ALTER DEFAULT PRIVILEGES FOR ROLE
   * crowdsource_migrator`. Nothing else in Oxy does this — there is no second
   * role anywhere else — so there is no prior art to have copied it from, and a
   * missing default privilege surfaces at runtime rather than at migration time.
   * A `42501` here means provisioning drifted from runbook 30 §2A.
   */
  it('lets the application role reach a table the migration never granted', async () => {
    const granted = await database.asMigrator<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'cases' AND grantee = ${APPLICATION_ROLE}
      ORDER BY privilege_type
    `;

    expect(granted.map((row) => row.privilege_type)).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });
});

describe('a tenant sees only its own rows', () => {
  /**
   * The control for every negative in this file. It reads the same rows on the
   * migrator connection, which holds `migrator_full_access` — so if this ever
   * stops finding three rows, the zeroes below have stopped proving anything and
   * this test says so instead of letting them pass quietly.
   */
  it('control: all three rows exist and are reachable without a tenant context', async () => {
    const rows = await database.asMigrator<{ case_id: string }[]>`
      SELECT case_id FROM cases ORDER BY case_id
    `;

    expect(rows.map((row) => row.case_id)).toEqual([
      'case_alpha',
      'case_beta',
      'case_sibling',
    ]);
  });

  it('READ: excludes another organization and a sibling application', async () => {
    const visible = await withTenant(database.db, alpha, async (tx) =>
      tx.select({ caseId: cases.caseId }).from(cases),
    );

    // The positive half: alpha's own row is there, so the exclusions below are
    // filtering rather than an empty table.
    expect(visible.map((row) => row.caseId)).toEqual(['case_alpha']);
  });

  it('COUNT: counts only its own, for each of the three tenants', async () => {
    for (const context of [alpha, beta, alphaSibling]) {
      const [row] = await withTenant(database.db, context, async (tx) =>
        tx.select({ total: sql<number>`count(*)::int` }).from(cases),
      );
      expect(row.total, `${context.applicationId} must count only its own`).toBe(1);
    }
  });

  it('UPDATE: cannot touch a sibling application of its own organization', async () => {
    const affected = await withTenant(database.db, alpha, async (tx) =>
      affectedRows(tx, sql`UPDATE cases SET status = 'triaged' WHERE case_id = 'case_sibling'`),
    );
    expect(affected).toBe(0);

    // And the row is genuinely untouched, read back on the bypass connection —
    // `UPDATE 0` alone would also be what a missing row looks like.
    const [row] = await database.asMigrator<{ status: string }[]>`
      SELECT status FROM cases WHERE case_id = 'case_sibling'
    `;
    expect(row.status).toBe('received');
  });

  it('DELETE: cannot remove another organization row', async () => {
    const affected = await withTenant(database.db, alpha, async (tx) =>
      affectedRows(tx, sql`DELETE FROM cases WHERE case_id = 'case_beta'`),
    );
    expect(affected).toBe(0);

    const [row] = await database.asMigrator<{ total: number }[]>`
      SELECT count(*)::int AS total FROM cases WHERE case_id = 'case_beta'
    `;
    expect(row.total).toBe(1);
  });

  it('INSERT: refuses a row belonging to another tenant', async () => {
    await expectPolicyRefusal(async () =>
      withTenant(database.db, alpha, async (tx) =>
        tx.execute(insertCaseStatement({
          caseId: 'case_forged',
          organizationId: 'org_beta',
          applicationId: 'app_beta',
          subject: 'post_forged',
        })),
      ),
    );

    // And the sibling direction, which is the one a two-tenant fixture misses:
    // same organization, different application.
    await expectPolicyRefusal(async () =>
      withTenant(database.db, alpha, async (tx) =>
        tx.execute(insertCaseStatement({
          caseId: 'case_forged_sib',
          organizationId: 'org_alpha',
          applicationId: 'app_sibling',
          subject: 'post_forged_sib',
        })),
      ),
    );

    // The positive control: an insert into its OWN tenant succeeds, so the
    // refusal above is the policy and not a broken statement.
    await withTenant(database.db, alpha, async (tx) =>
      tx.execute(insertCaseStatement({
        caseId: 'case_alpha_own',
        organizationId: 'org_alpha',
        applicationId: 'app_alpha',
        subject: 'post_own',
      })),
    );

    const [row] = await database.asMigrator<{ total: number }[]>`
      SELECT count(*)::int AS total FROM cases WHERE case_id = 'case_alpha_own'
    `;
    expect(row.total).toBe(1);
  });
});

describe('the tenant context does not outlive its transaction', () => {
  /**
   * The pooled-connection leak, pinned.
   *
   * `SET LOCAL` reverts at commit; a plain `SET` does not, and postgres.js pools
   * connections — so a request that sets its tenant and returns its connection
   * would leave the next one running under the previous context. Measured on a
   * real server: after a plain `SET`, a second independent operation on the same
   * connection still returned the first tenant's row.
   *
   * `max: 1` is what makes this test capable of failing. With a larger pool the
   * second operation may take a different connection and pass regardless, so a
   * test that does not pin the pool cannot tell the two behaviours apart.
   */
  it('runs two tenants in sequence on ONE pooled connection without leaking', async () => {
    const pinned = createDatabase<BackendSchema>({
      databaseUrl: database.url,
      schema: {} as BackendSchema,
      client: { max: 1 },
    });

    try {
      /**
       * Asserted per ROW rather than against a fixed list, deliberately. An
       * expected set would couple this to whatever earlier tests inserted, and a
       * test that fails because a sibling test changed is one somebody
       * eventually pins to the wrong answer. Every row this tenant can see must
       * carry its pair, whatever the count.
       */
      const readAs = async (
        context: typeof alpha,
      ): Promise<{ organization_id: string; application_id: string }[]> =>
        (await withTenant(pinned.db, context, async (tx) =>
          tx.execute(sql`SELECT organization_id, application_id FROM cases`),
        )) as unknown as { organization_id: string; application_id: string }[];

      const first = await readAs(alpha);
      expect(first.length, 'alpha must see something, or the check is vacuous')
        .toBeGreaterThan(0);
      for (const row of first) {
        expect(row.organization_id).toBe(alpha.organizationId);
        expect(row.application_id).toBe(alpha.applicationId);
      }

      // The second operation, on the SAME connection the first just released.
      const second = await readAs(beta);
      expect(second.length).toBeGreaterThan(0);
      for (const row of second) {
        expect(row.organization_id).toBe(beta.organizationId);
        expect(row.application_id).toBe(beta.applicationId);
      }

      // And with no context at all the same connection answers nothing, rather
      // than whatever the previous operation could see.
      const leaked = await pinned.db.execute(sql`SELECT case_id FROM cases`);
      expect(leaked).toHaveLength(0);
    } finally {
      await pinned.client.end();
    }
  });
});

describe('the mutation test', () => {
  /**
   * The only witness this property will ever have.
   *
   * Production holds two documents and neither carries a tenant pair, so nothing
   * outside this file can ever demonstrate that isolation holds on the
   * APPLICATION key rather than merely on the organization. If narrowing the
   * policy stops being observable, the property silently has no coverage at all.
   *
   * So this breaks the policy for real — the DDL is committed, because the
   * application connection is a different session and would not see an
   * uncommitted change — confirms the sibling leak becomes visible, and restores
   * it. The restore is asserted rather than assumed: a mutation left in place
   * would make every test above pass for the wrong reason on a re-run.
   */
  it('a policy narrowed to the organization key alone leaks the sibling application', async () => {
    const restore = async (): Promise<void> => {
      await database.asMigrator.unsafe(`DROP POLICY IF EXISTS "${TENANT_ISOLATION_POLICY}" ON cases`);
      await database.asMigrator.unsafe(`
        CREATE POLICY "${TENANT_ISOLATION_POLICY}" ON cases
          FOR ALL
          USING (
            organization_id = current_setting('${ORGANIZATION_GUC}', true)
            AND application_id = current_setting('${APPLICATION_GUC}', true)
          )
          WITH CHECK (
            organization_id = current_setting('${ORGANIZATION_GUC}', true)
            AND application_id = current_setting('${APPLICATION_GUC}', true)
          )
      `);
    };

    try {
      await database.asMigrator.unsafe(`DROP POLICY "${TENANT_ISOLATION_POLICY}" ON cases`);
      await database.asMigrator.unsafe(`
        CREATE POLICY "${TENANT_ISOLATION_POLICY}" ON cases
          FOR ALL
          USING (organization_id = current_setting('${ORGANIZATION_GUC}', true))
          WITH CHECK (organization_id = current_setting('${ORGANIZATION_GUC}', true))
      `);

      // Assert the mutation actually landed before believing anything it
      // produces. A replacement that silently failed to apply is
      // indistinguishable from one that applied and was survived.
      const [mutated] = await database.asMigrator<{ qual: string }[]>`
        SELECT qual FROM pg_policies
        WHERE tablename = 'cases' AND policyname = ${TENANT_ISOLATION_POLICY}
      `;
      expect(mutated.qual).toContain(ORGANIZATION_GUC);
      expect(mutated.qual).not.toContain(APPLICATION_GUC);

      const visible = await withTenant(database.db, alpha, async (tx) =>
        tx.select({ caseId: cases.caseId }).from(cases),
      );

      // The leak, demonstrated: a second application of the SAME organization is
      // now readable. `case_beta` stays hidden throughout, which is precisely why
      // a two-tenant fixture would have reported this policy as correct.
      expect(visible.map((row) => row.caseId)).toContain('case_sibling');
      expect(visible.map((row) => row.caseId)).not.toContain('case_beta');
    } finally {
      await restore();
    }

    const [restored] = await database.asMigrator<{ qual: string }[]>`
      SELECT qual FROM pg_policies
      WHERE tablename = 'cases' AND policyname = ${TENANT_ISOLATION_POLICY}
    `;
    expect(restored.qual).toContain(APPLICATION_GUC);

    const afterRestore = await withTenant(database.db, alpha, async (tx) =>
      tx.select({ caseId: cases.caseId }).from(cases),
    );
    expect(afterRestore.map((row) => row.caseId)).not.toContain('case_sibling');
  });

  /**
   * The other half: the migrator policy is what lets a data-bearing migration
   * work on a forced table, and its absence fails SILENTLY for three of the four
   * verbs. Measured with no tenant parameters set — `INSERT` errors, while
   * `SELECT`, `UPDATE` and `DELETE` all answer 0 with no error, so a backfill
   * touches nothing and is recorded in the ledger as applied.
   */
  it('without the migrator policy, a migration silently affects zero rows', async () => {
    try {
      await database.asMigrator.unsafe(`DROP POLICY "${MIGRATOR_ACCESS_POLICY}" ON cases`);

      const [dropped] = await database.asMigrator<{ total: number }[]>`
        SELECT count(*)::int AS total FROM pg_policies
        WHERE tablename = 'cases' AND policyname = ${MIGRATOR_ACCESS_POLICY}
      `;
      expect(dropped.total).toBe(0);

      // No error, no rows. This is the shape that reaches production as a
      // migration recorded successful having done nothing.
      const seen = await database.asMigrator<{ case_id: string }[]>`SELECT case_id FROM cases`;
      expect(seen).toHaveLength(0);

      const updated = await database.asMigrator.unsafe(`UPDATE cases SET status = 'swept'`);
      expect(updated.count).toBe(0);
    } finally {
      await database.asMigrator.unsafe(`
        CREATE POLICY "${MIGRATOR_ACCESS_POLICY}" ON cases
          FOR ALL TO "${MIGRATOR_ROLE}" USING (true) WITH CHECK (true)
      `);
    }

    const restored = await database.asMigrator<{ case_id: string }[]>`SELECT case_id FROM cases`;
    expect(restored.length).toBeGreaterThan(0);
  });
});
