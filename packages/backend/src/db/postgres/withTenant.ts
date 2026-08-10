import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { TablesRelationalConfig } from 'drizzle-orm';

import type { TenantContext } from '../tenantScope';
import { APPLICATION_GUC, ORGANIZATION_GUC } from './tenancy';

/**
 * The one place a tenant context reaches PostgreSQL.
 *
 * Everything the row-security policies do depends on two runtime parameters
 * being set for the statement that reads them, and this is the only function
 * that sets them. A module that opens its own transaction and issues its own
 * `SET` is how the boundary stops being a property of this codebase — the same
 * rule `collections.ts` enforces one layer up, for the same reason.
 *
 * The handle type is the BASE `PgDatabase` deliberately, so a pool handle and a
 * transaction handle are one type and a repository can take either. That has a
 * cost worth knowing: passing the POOL where a transaction belongs type-checks
 * perfectly and runs on a different connection, committing independently. The
 * guard for that is `instanceof PgTransaction` at the point of use, not a type.
 */
export type PgHandle = PgDatabase<
  PgQueryResultHKT,
  Record<string, unknown>,
  TablesRelationalConfig
>;

/**
 * Runs `operation` with the tenant parameters set for the duration of ONE
 * transaction.
 *
 * `SET LOCAL` rather than `SET`, and inside an explicit transaction rather than
 * on a bare connection. Both halves are load-bearing and were measured:
 *
 *  - A plain `SET` persists for the life of the connection. postgres.js pools
 *    connections, so a request that sets its tenant and returns its connection
 *    leaves the next request — possibly another tenant's, possibly an
 *    unauthenticated path — running under the previous context. Measured: after a
 *    plain `SET`, a second independent operation on the same pooled connection
 *    still returned the first tenant's row.
 *  - `SET LOCAL` outside a transaction is a no-op with a warning, which would
 *    leave the parameters unset. Unset is not a leak — `current_setting(…, true)`
 *    returns NULL, nothing matches, and the read answers zero rows — but it is an
 *    outage that looks like an empty database, so the transaction is not
 *    optional.
 *
 * Measured after commit on the same connection: the next operation sees zero
 * rows rather than the previous tenant's. That is the property a single-tenant
 * test cannot distinguish from a leak, which is why the fixture runs two tenants
 * in sequence on one pooled connection.
 */
export async function withTenant<T>(
  db: PgHandle,
  context: TenantContext,
  operation: (tx: PgHandle) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    // `set_config(name, value, is_local => true)` rather than the `SET LOCAL`
    // statement, because a parameter NAME cannot be a bind placeholder while
    // `set_config`'s arguments can. The tenant values arrive from a credential
    // rather than from a caller, but building DDL-shaped strings by
    // interpolation is a habit that eventually meets a value that did come from
    // one.
    await tx.execute(
      sql`select set_config(${ORGANIZATION_GUC}, ${context.organizationId}, true),
                 set_config(${APPLICATION_GUC}, ${context.applicationId}, true)`,
    );

    return await operation(tx);
  });
}
