/**
 * Which tables the database isolates, and which it deliberately does not.
 *
 * This is `defineTenantCollection` / `defineUnscopedCollection` carried across to
 * Postgres, and the reason it is a registry rather than a convention is the
 * defect that preceded it: `collectionBoundary.test.ts` could not see `Decision`
 * or `Appeal` because its module list was maintained by hand, so two of the most
 * consequential collections in the system sat outside the gate while every test
 * passed.
 *
 * So membership here is TOTAL. `postgresTableBoundary.realdb.test.ts` enumerates
 * the schema directory from the filesystem and fails the build for any table that
 * is in NEITHER list, and for any table in BOTH. Absence is a decision somebody
 * has to make, never a default — a new table cannot become unscoped by nobody
 * noticing it.
 */

/**
 * Tenant-owned. Every one of these carries `organization_id` + `application_id`,
 * row-level security ENABLED and FORCED, a `tenant_isolation` policy naming both
 * runtime parameters, and a `migrator_full_access` policy.
 */
export const TENANT_SCOPED_TABLES = [
  'appeals',
  'audit_events',
  'case_reports',
  'cases',
  'decisions',
  'policy_sets',
  'reports',
  'usage_counters',
  'webhook_attempts',
  'webhook_endpoints',
  'webhook_secrets',
] as const;

/**
 * Exempt, each with the reason it cannot be scoped.
 *
 * A reason is mandatory and the gate asserts it is a real sentence, for the same
 * purpose it serves in `db/collections.ts`: an exemption without a stated reason
 * is how the rule erodes. Empty for now — the unscoped tables land in their own
 * change — but the mechanism exists so the first one to arrive has to justify
 * itself rather than set a precedent that they arrive silently.
 */
export const UNSCOPED_TABLES: Readonly<Record<string, string>> = {};

/** Every table this service declares, in either category. */
export function declaredTableNames(): readonly string[] {
  return [...TENANT_SCOPED_TABLES, ...Object.keys(UNSCOPED_TABLES)];
}
