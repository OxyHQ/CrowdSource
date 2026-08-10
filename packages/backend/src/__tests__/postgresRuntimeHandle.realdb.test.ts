import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { config } from '../config';
import {
  closePostgresDatabase,
  getPostgresDatabase,
  pingPostgres,
} from '../db/postgres/database';
import { cases } from '../db/postgres/schema/cases';
import {
  requireTransaction,
  withTenant,
  type PgTransactionHandle,
  type TenantScopedHandle,
} from '../db/postgres/withTenant';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './support/postgresTestDatabase';

/**
 * The handle the RUNNING service uses, against a real server.
 *
 * Every repository in this package has been proven through the harness's handle.
 * This file is about the other one — the one production actually builds — and it
 * exists because the ways the two could differ are all silent. A handle pointed
 * at the wrong database, built without the schema, or holding a pool where a
 * transaction was required does not error under `FORCE` row security; it returns
 * zero rows, which is an ordinary answer.
 *
 * `config.databaseUrl` is stubbed at the seam rather than mocking
 * `createDatabase`, so what runs here is the real construction with the real
 * options against a real PostgreSQL — the only version of this test that could
 * catch a wrong pool setting or a missing schema binding.
 */

let database: PostgresTestDatabase;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterEach(async () => {
  await closePostgresDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await database?.close();
});

/** Points the runtime handle at this file's throwaway database. */
function useTestDatabaseUrl(): void {
  vi.spyOn(config, 'databaseUrl', 'get').mockReturnValue(database.url);
}

describe('the runtime PostgreSQL handle', () => {
  it('is built once and reused', () => {
    useTestDatabaseUrl();

    // Both branches of the lazy build: the first call constructs, the second
    // must not. A handle rebuilt per call opens a new pool every time, which
    // exhausts `max_connections` on an instance shared with every other Oxy
    // database rather than failing anywhere near the code responsible.
    const first = getPostgresDatabase();
    const second = getPostgresDatabase();

    expect(second).toBe(first);
  });

  it('reaches the database, as the unprivileged application role', async () => {
    useTestDatabaseUrl();

    await expect(pingPostgres()).resolves.toBeUndefined();

    /**
     * Not a superuser, asserted rather than assumed. A superuser bypasses row
     * security even under `FORCE`, so a runtime handle that turned out to be one
     * would make every isolation proof in this package describe a connection
     * production does not use — and it would fail by returning rows, never by
     * erroring.
     */
    const [role] = await getPostgresDatabase().$client<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it('is bound to the schema, so a table read compiles and runs', async () => {
    useTestDatabaseUrl();

    /**
     * Zero rows is the right answer here and is exactly why the assertion is on
     * the statement SUCCEEDING rather than on a count. A handle built without
     * `schema` still type-checks at the call site and fails at run time; a
     * handle pointed somewhere with no tables fails the same way. Both are
     * distinguishable from an empty table only by whether the query throws.
     */
    await expect(getPostgresDatabase().select().from(cases)).resolves.toEqual([]);
  });

  it('rejects when the database is unreachable, rather than resolving', async () => {
    // Port 1 refuses immediately: the failure has to be fast and loud, because
    // `/health/ready` awaits this and a probe whose failure mode is a hang leaves
    // a task marked slow rather than unhealthy.
    vi.spyOn(config, 'databaseUrl', 'get').mockReturnValue(
      'postgres://nobody:nobody@127.0.0.1:1/nothing',
    );

    await expect(pingPostgres()).rejects.toThrow();
  });
});

describe('requireTransaction', () => {
  /**
   * The case the guard exists for, and the one the type cannot catch.
   *
   * `PgTransactionHandle` makes "passed the pool" a compile error wherever the
   * handle is typed. This covers what arrives through a cast, an `any` or a
   * generic boundary — the same hole the Mongo `requireTransaction` was written
   * for, where the root connection and a session-bearing handle shared one type
   * alias and nothing could tell them apart at compile time.
   *
   * The pool is passed as the REAL pool rather than a stub, because the property
   * being asserted is a fact about drizzle's own objects: `rollback` exists on
   * `PgTransaction` and on nothing else. A hand-made `{}` would pass this test
   * while proving nothing about the driver.
   */
  it('refuses the pool, which commits independently', () => {
    expect(() => requireTransaction(database.db)).toThrow(/must run inside a transaction/);
  });

  it('accepts a real transaction handle and returns it', async () => {
    const returned = await database.db.transaction(async (tx) => requireTransaction(tx));
    expect(returned).toBeDefined();
  });

  /**
   * The property the whole guard rests on, asserted directly so that a driver
   * upgrade which moved or renamed `rollback` fails HERE — naming the
   * mechanism — rather than silently turning the guard into one that accepts
   * everything.
   */
  it('discriminates on a property the pool genuinely lacks', async () => {
    const poolHasRollback = typeof (database.db as { rollback?: unknown }).rollback;
    const txHasRollback = await database.db.transaction(
      async (tx) => typeof (tx as { rollback?: unknown }).rollback,
    );

    expect(poolHasRollback).not.toBe('function');
    expect(txHasRollback).toBe('function');
  });
});

/**
 * A COMPILE-TIME assertion, checked by `tsc -p tsconfig.test.json` in `lint`.
 *
 * The runtime test below proves the handle can roll back TODAY. It cannot catch
 * the type-level weakening, because `withTenant` passes a real transaction
 * whatever the declared type says — measured: moving the brand back onto
 * `PgHandle` leaves every test in this file green.
 *
 * What must hold is that a scoped handle SATISFIES a transaction parameter, so
 * a scoped repository can call an unscoped writer that requires one — the
 * outbox above all. Until that call site exists (PR 1) nothing else pins it, so
 * this line is the pin: it stops compiling the moment `TenantScopedHandle` is
 * branded onto anything that is not a transaction.
 */
const scopedHandleSatisfiesATransaction: PgTransactionHandle =
  undefined as unknown as TenantScopedHandle;
void scopedHandleSatisfiesATransaction;

describe('the branded handle is really a transaction', () => {
  /**
   * `TenantScopedHandle` is branded onto `PgTransactionHandle`, so it now
   * asserts TWO things: a tenant is set, and this is a transaction. The second
   * half is what lets a scoped repository call an unscoped writer that requires
   * a transaction — `outbox_events` above all, whose row must commit with the
   * domain write it records.
   *
   * Branded onto the base `PgHandle` instead, as it was, the type still
   * compiles and the pool still satisfies it. This asserts the RUNTIME
   * consequence rather than the declaration, because that is what a future
   * simplification would actually break.
   */
  it('hands the operation a handle that can roll back', async () => {
    const seen = await withTenant(
      database.db,
      { organizationId: 'org_brand_probe', applicationId: 'app_brand_probe' },
      async (tx) => typeof (tx as { rollback?: unknown }).rollback,
    );

    expect(seen).toBe('function');
  });
});

describe('closing the pool', () => {
  it('closes a pool that was opened, and rebuilds on the next use', async () => {
    useTestDatabaseUrl();

    const before = getPostgresDatabase();
    await closePostgresDatabase();
    const after = getPostgresDatabase();

    expect(after).not.toBe(before);
    await expect(pingPostgres()).resolves.toBeUndefined();
  });

  /**
   * The shutdown path calls this unconditionally. A task that failed before its
   * first query has no pool, and a close that threw on that would turn a clean
   * exit into a crash — during shutdown, where the log is least likely to be read.
   */
  it('is a no-op when nothing was ever opened', async () => {
    await expect(closePostgresDatabase()).resolves.toBeUndefined();
  });
});
