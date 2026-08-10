import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { config } from '../config';
import {
  closePostgresDatabase,
  getPostgresDatabase,
  pingPostgres,
} from '../db/postgres/database';
import { cases } from '../db/postgres/schema/cases';
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
