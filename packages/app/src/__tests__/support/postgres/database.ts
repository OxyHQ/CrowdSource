import { resolve } from 'node:path';
import postgres from 'postgres';
import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import { runMigrations } from '@oxyhq/db/migrate';
import { createTestDatabase, dropTestDatabase } from '@oxyhq/db/testing';
import * as schema from './schema.js';

/**
 * One throwaway Postgres database per test file, with the committed test DDL
 * applied.
 *
 * A real database, not a per-suite name on one connection: the Mongo harness can
 * hand every `createHarness` a fresh `dbName` over a single connection, and
 * Postgres has no equivalent — a database is a database. `createTestDatabase`
 * creates one with a unique name and `dropTestDatabase` removes it, so nothing a
 * developer cares about is ever written to.
 */

const MIGRATIONS_FOLDER = resolve(__dirname, 'migrations');

/**
 * Two seconds, and it is NOT tuning.
 *
 * Several properties here have a BLOCK as their natural failure mode — a claim
 * whose `SKIP LOCKED` was removed waits on the row another connection holds. A
 * test whose failure mode is a hang cannot distinguish a broken guard from a slow
 * machine, and the same lesson cost this package three different verdicts for one
 * defect on the Mongo side before `maxTimeMS` was added there. Bounded, a blocked
 * statement fails as `57014 query_canceled` in about two seconds, and a test can
 * assert that "answered null" and "was cancelled" are different outcomes.
 */
export const STATEMENT_TIMEOUT_MS = 2_000;

export type PostgresTestSchema = typeof schema;

export interface PostgresTestDatabase {
  /** The drizzle handle the stores take. Built WITH the schema — see `ModerationPgHandle`. */
  readonly db: OxyDatabase<PostgresTestSchema>;
  readonly client: postgres.Sql;
  /** The throwaway database's own connection string, for a second connection. */
  readonly url: string;
  close(): Promise<void>;
}

export async function createPostgresTestDatabase(): Promise<PostgresTestDatabase> {
  const adminUrl = process.env.CROWDSOURCE_APP_TEST_POSTGRES_URL;
  if (adminUrl === undefined) {
    throw new Error(
      'CROWDSOURCE_APP_TEST_POSTGRES_URL is unset: vitest.globalSetup.ts did not run.',
    );
  }

  const url = await createTestDatabase({
    adminUrl,
    migrate: async (databaseUrl) =>
      await runMigrations({
        databaseUrl,
        migrationsFolder: MIGRATIONS_FOLDER,
        // Nothing in these tables needs an extension. `CREATE EXTENSION` is
        // privileged on RDS, so a package that needed one would make itself an
        // infrastructure change.
        extensions: [],
        run: 'all',
        dryRun: false,
        logger: { info: () => undefined, debug: () => undefined },
      }),
  });

  const built = createDatabase<PostgresTestSchema>({
    databaseUrl: url,
    schema,
    client: {
      // More than one, because a test holds a row lock on a second connection
      // while the store works on its own.
      max: 4,
      connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    },
  });

  return {
    db: built.db,
    client: built.client,
    url,
    async close() {
      await built.client.end();
      await dropTestDatabase(url);
    },
  };
}
