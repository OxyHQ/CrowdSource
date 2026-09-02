import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
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
 * transaction handle are one type and an UNSCOPED repository can take either.
 * That has a cost: passing the POOL where a transaction belongs type-checks
 * perfectly and runs on a different connection, committing independently.
 *
 * That cost used to be unmitigated, and this comment used to say the guard was
 * `instanceof PgTransaction` at the point of use rather than a type. It is now a
 * TYPE — see `TenantScopedHandle` below, which a tenant-scoped repository takes
 * and which only this module can mint. `PgHandle` remains correct for repositories
 * that are unscoped by design.
 */
export type PgHandle = PgDatabase<
  PgQueryResultHKT,
  Record<string, unknown>,
  TablesRelationalConfig
>;

/**
 * A handle that is INSIDE a transaction — the type drizzle itself distinguishes.
 *
 * `PgTransaction` extends `PgDatabase` and adds `rollback`, `schema`,
 * `nestedIndex` and `setTransaction`, so the pool is NOT assignable to it and
 * "passed the pool where a transaction was required" is a `tsc` error rather
 * than a runtime surprise. Measured: assigning a `PgHandle` here reports
 * `TS2739` naming all four missing members.
 *
 * This is what the Mongo side could not have. There, the root connection and a
 * session-bearing handle share ONE type alias, so nothing could discriminate
 * them at compile time and `requireTransaction` had to be a runtime predicate.
 * Here the type does the work, and the runtime check below is the second layer
 * for handles that arrive through a cast or an `any`.
 */
export type PgTransactionHandle = PgTransaction<
  PgQueryResultHKT,
  Record<string, unknown>,
  TablesRelationalConfig
>;

declare const tenantScopedBrand: unique symbol;

/**
 * A handle that is INSIDE a tenant transaction, with both parameters set.
 *
 * The type comment above states the cost of `PgHandle` covering both a pool and a
 * transaction: passing the pool where a transaction belongs type-checks perfectly.
 * This is what makes that a COMPILE error instead of a production incident, and
 * the failure it prevents is worth being exact about — under `FORCE`, a scoped
 * read on the pool evaluates its policy against an unset parameter, so it returns
 * ZERO ROWS and a write is refused. Not an error. Silence. Zero rows reads as
 * "this tenant has no data", an entirely ordinary state, and it would surface as a
 * customer saying their cases disappeared.
 *
 * A tenant-scoped repository takes THIS type; an unscoped one keeps `PgHandle`.
 * The brand is only producible by `withTenant` below, so the wrong handle cannot
 * be passed rather than merely being discouraged. A runtime assertion in each
 * repository was the alternative and is weaker for one reason: it is a
 * CONVENTION, so a repository somebody adds later without it has the hole. A
 * parameter type is not a convention — it is what makes a function scoped.
 *
 * WHAT THIS DOES NOT COVER, said here so the brand is not read as total: it says a
 * tenant is set, NOT WHICH ONE. A scoped repository called under the wrong
 * tenant's context is a different bug, and row security then correctly returns
 * that tenant's rows. Nothing in this type addresses it.
 *
 * DO NOT MAKE THE BRAND OPTIONAL. Writing `[tenantScopedBrand]?: true` removes the
 * need for the assertion in `asTenantScoped` below and DESTROYS THE GUARANTEE in
 * the same edit: with the property optional, `PgHandle` becomes assignable to
 * `TenantScopedHandle` again, so the pool is silently accepted everywhere a
 * transaction is required and every scoped read quietly returns zero rows. It
 * reads as a simplification — one fewer cast — which is exactly why the warning is
 * here, on the line somebody would change, rather than only beside the cast.
 */
export type TenantScopedHandle = PgTransactionHandle & {
  readonly [tenantScopedBrand]: true;
};

/**
 * The ONE place a branded handle is minted, and the only assertion in this layer.
 *
 * A double assertion is required rather than sloppy: the brand is a `unique
 * symbol` property, so a transaction handle and `TenantScopedHandle` do not
 * overlap and `tsc` refuses the direct cast. Making the brand OPTIONAL would
 * remove the need for it and destroy the guarantee in the same move — `PgHandle`
 * would become assignable to `TenantScopedHandle`, which is precisely the pool
 * being accepted where a transaction is required.
 *
 * Confined to this function so there is exactly one line to audit, and
 * `scopedRepositoryBoundary.test.ts` fails the build if the brand or this cast
 * appears anywhere outside this module.
 */
function asTenantScoped(tx: PgTransactionHandle): TenantScopedHandle {
  return tx as TenantScopedHandle;
}

/**
 * The unscoped writer's guard: prove at RUNTIME that a handle is a transaction.
 *
 * `TenantScopedHandle` covers repositories that carry a tenant. It does not
 * cover the rest of the atomicity requirement: `outbox_events` is UNSCOPED — the
 * dispatcher claims across every tenant — yet its row must commit with the
 * domain write it records, because a single-node Valkey can lose a queued job
 * and the outbox is the only thing that makes the work re-derivable. A row
 * written outside that transaction is lost moderation work with no trace.
 *
 * `PgTransactionHandle` makes the ordinary mistake a compile error, and it is
 * not sufficient on its own. A handle reaching an unscoped repository through a
 * cast, an `any`, or a generic boundary can be typed as a transaction and be a
 * pool at run time — which is exactly the case the Mongo guard was written for.
 * So this checks a property the pool cannot have: drizzle puts `rollback` on
 * `PgTransaction` and nowhere else.
 *
 * Structural rather than `instanceof`, because `PgTransaction` is abstract and
 * the concrete class is the driver's own; asserting on the shape survives a
 * driver swap, an `instanceof` against a subclass does not.
 *
 * @throws {Error} When `handle` is not inside a transaction.
 */
export function requireTransaction(handle: PgHandle): PgTransactionHandle {
  if (typeof (handle as Partial<PgTransactionHandle>).rollback !== 'function') {
    throw new Error(
      'This write must run inside a transaction: it records something whose ' +
        'outbox row has to commit with it. A pool handle commits independently, ' +
        'so the row and the work it records can be separated by a crash.',
    );
  }
  return handle as PgTransactionHandle;
}

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
  operation: (tx: TenantScopedHandle) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) =>
    withTenantTransaction(tx, context, operation),
  );
}

/**
 * Applies a tenant to an existing PostgreSQL transaction.
 *
 * Domain writes that also append an unscoped outbox row start one transaction
 * before the tenant-owned repository is entered. Starting a nested transaction
 * here would split those commits. This helper is therefore the transaction-aware
 * half of `withTenant`: it sets the same LOCAL GUCs and mints the same branded
 * handle, but never owns or commits the transaction it receives.
 */
export async function withTenantTransaction<T>(
  tx: PgTransactionHandle,
  context: TenantContext,
  operation: (tx: TenantScopedHandle) => Promise<T>,
): Promise<T> {
  // `set_config(name, value, is_local => true)` rather than the `SET LOCAL`
  // statement, because a parameter NAME cannot be a bind placeholder while
  // `set_config`'s arguments can. The tenant values arrive from a credential
  // rather than from a caller, but building DDL-shaped strings by
  // interpolation is a habit that eventually meets a value that did come from
  // one.
  //
  // The CTE is not decoration. `current_setting` is READ BACK in the same round
  // trip to prove the parameters really took, and a plain SELECT list would not
  // guarantee that the reads evaluate after the writes — a CTE does, because it
  // is materialised first. This is the one thing the type above cannot see: a
  // branded handle whose context was never actually set, which fails exactly as
  // silently as the wrong handle would.
  const [applied] = (await tx.execute(
    sql`with applied as (
          select set_config(${ORGANIZATION_GUC}, ${context.organizationId}, true) as organization_id,
                 set_config(${APPLICATION_GUC}, ${context.applicationId}, true) as application_id
        )
        select current_setting(${ORGANIZATION_GUC}, true) as organization_id,
               current_setting(${APPLICATION_GUC}, true) as application_id
        from applied`,
  )) as unknown as { organization_id: string | null; application_id: string | null }[];

  if (
    applied?.organization_id !== context.organizationId ||
    applied?.application_id !== context.applicationId
  ) {
    // Fails CLOSED and LOUD. The alternative is every scoped statement in this
    // transaction quietly matching nothing, which is indistinguishable from a
    // tenant that owns no data.
    throw new Error(
      'withTenant could not set the tenant runtime parameters; refusing to run the operation unscoped.',
    );
  }

  return await operation(asTenantScoped(tx));
}
