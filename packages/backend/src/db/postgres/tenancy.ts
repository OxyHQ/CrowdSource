/**
 * The tenant boundary, as the DATABASE enforces it.
 *
 * `db/tenantScope.ts` states the boundary in application code and its own header
 * says what that costs: isolation "holds only as long as every query goes through
 * this module", and nothing in the type system makes that true. This file is the
 * second mechanism. Both stay. They fail for different reasons — application
 * scoping catches a missing policy, and the database catches a forgotten call
 * path — and the whole point is that one of them failing is survivable.
 *
 * Four facts decide everything here, and each was measured against a real
 * PostgreSQL 17 rather than taken from documentation:
 *
 *  1. `ENABLE ROW LEVEL SECURITY` is INERT for a table's owner. The DDL succeeds,
 *     `pg_policies` lists the policy, and every tenant's rows stay visible.
 *  2. Oxy provisions `CREATE DATABASE <app> OWNER <app>`, so in the single-role
 *     model the application connects as the owner of every table. Combined with
 *     (1) that is not weak isolation, it is NONE — and it fails by RETURNING
 *     ROWS, so nothing errors, nothing is logged, and every test asserting that a
 *     row comes back still passes. That is why this service is provisioned with
 *     two roles instead (runbook 30 §2A).
 *  3. A SUPERUSER bypasses row security even with `FORCE`. Neither role here may
 *     be one, and the test harness creates its own unprivileged roles rather than
 *     inheriting the container's superuser — a suite run as superuser measures
 *     nothing while looking thorough.
 *  4. The tenant is a PAIR. One organization routinely owns several applications
 *     (a staging one and a production one), so a policy matching only
 *     `organization_id` isolates two customers from each other and NOT one
 *     customer's two products. Measured: under an org-only policy a sibling
 *     application's rows are returned.
 */

/**
 * The two roles, and the reason they are two.
 *
 * The migrator OWNS every table; the application owns nothing and holds only
 * DML grants. Measured: a non-owner is subject to row security, an owner is not,
 * and an owner can additionally `NO FORCE ROW LEVEL SECURITY` and `DROP POLICY`
 * on its own tables. So a single-role deployment makes the boundary advisory —
 * any path that reaches SQL as the application can switch isolation off in one
 * statement. Under the split both statements are refused with
 * `must be owner of table`.
 *
 * These names are the ones runbook 30 §2A provisions. They are spelled here
 * because the policies below and the test harness must agree with infrastructure
 * about them, and three places inventing the same string is how they drift.
 */
export const MIGRATOR_ROLE = 'crowdsource_migrator';
export const APPLICATION_ROLE = 'crowdsource_app';

/**
 * The runtime parameters the policies read.
 *
 * `SET LOCAL`, never `SET`: postgres.js pools connections, and a plain `SET`
 * outlives the operation that issued it. Measured — after a plain `SET`, the next
 * independent operation on the same pooled connection still saw the previous
 * tenant's row, which is a cross-tenant read requiring nobody to do anything
 * wrong. `SET LOCAL` inside an explicit transaction reverts at commit, and the
 * connection then answers zero rows rather than somebody else's.
 */
export const ORGANIZATION_GUC = 'app.organization_id';
export const APPLICATION_GUC = 'app.application_id';

/**
 * The policy predicate, as the migration writes it.
 *
 * Exported so a test can assert the LIVE policy in `pg_policies` still contains
 * both parameter names. The migration is SQL and this is TypeScript, so they are
 * two representations of one fact and can drift — a policy narrowed to the
 * organization key alone would keep this file compiling and every positive
 * assertion passing. `rlsTenantIsolation.realdb.test.ts` is what refuses that.
 */
export const TENANT_PREDICATE_PARAMETERS = [ORGANIZATION_GUC, APPLICATION_GUC] as const;

/** The policy each tenant-owned table carries. */
export const TENANT_ISOLATION_POLICY = 'tenant_isolation';

/**
 * The policy that lets the MIGRATOR work on a forced table.
 *
 * Under `FORCE` the owner is bound by its own policies, and the four verbs fail
 * differently — measured: `INSERT` errors loudly, while `SELECT`, `UPDATE` and
 * `DELETE` all answer 0 with NO error. So a data-bearing migration touches
 * nothing, exits zero and is recorded in the ledger as applied. Writing
 * `WITH CHECK` explicitly does not fix that: when the write predicate equals the
 * read predicate the two spellings are equivalent.
 *
 * A permissive policy scoped `TO` the migrator does fix it, and grants nothing
 * that role did not already have — it owns the tables, so it could always drop a
 * policy. What changes is that the capability is visible in `pg_policies` instead
 * of implicit in ownership. Measured not to widen anything: with this policy in
 * place the application role, reading immediately afterwards in the same
 * database, still sees exactly its own tenant's rows.
 */
export const MIGRATOR_ACCESS_POLICY = 'migrator_full_access';
