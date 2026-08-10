import { resolve } from 'node:path';

import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import { runMigrations } from '@oxyhq/db/migrate';
import { createTestDatabase, dropTestDatabase } from '@oxyhq/db/testing';
import postgres from 'postgres';

import * as schema from '../../db/postgres/schema';
import { APPLICATION_ROLE, MIGRATOR_ROLE } from '../../db/postgres/tenancy';

/**
 * One throwaway Postgres database per test file, provisioned the way production
 * is: two roles, neither of them privileged.
 *
 * The role split is not incidental to the harness, it is the whole reason this
 * file exists rather than reusing the container's own credentials. Measured on
 * PostgreSQL 17: the compose role is `rolsuper=t, rolbypassrls=t`, and a
 * SUPERUSER bypasses row security even with FORCE. A suite that connected as it
 * would return every tenant's rows, and — because the failure mode is returning
 * rows rather than erroring — every assertion of the form "the row I inserted
 * comes back" would still pass. The isolation tests would be green and measuring
 * nothing.
 *
 * So: the admin connection creates two unprivileged roles, the MIGRATOR applies
 * the migrations and owns the tables, and the tests connect as the APPLICATION
 * role, which owns nothing.
 */

const MIGRATIONS_FOLDER = resolve(__dirname, '..', '..', 'db', 'postgres', 'migrations');

/**
 * Two seconds, and it is not tuning.
 *
 * Some properties here have a BLOCK as their natural failure mode, and a test
 * whose failure mode is a hang cannot distinguish a broken guard from a slow
 * machine. Bounded, a blocked statement fails as `57014 query_canceled` in about
 * two seconds and "answered nothing" stays distinguishable from "was cancelled".
 */
export const STATEMENT_TIMEOUT_MS = 2_000;

/**
 * Test-only passwords. Real ones arrive from SSM as two separate connection
 * strings; these exist because a role must have one to log in.
 */
const MIGRATOR_PASSWORD = 'crowdsource_migrator_test';
const APPLICATION_PASSWORD = 'crowdsource_app_test';

export type BackendSchema = typeof schema;

export interface PostgresTestDatabase {
  /** Connected as the APPLICATION role: owns nothing, subject to every policy. */
  readonly db: OxyDatabase<BackendSchema>;
  readonly client: postgres.Sql;
  /**
   * Connected as the MIGRATOR: owns the tables and holds `migrator_full_access`.
   *
   * This is the deliberate bypass path, and the fixtures need it for a reason
   * worth stating. The Mongo isolation tests prove a 404 means FILTERED rather
   * than ABSENT by reading the row straight off the driver with no tenant filter.
   * Under FORCE the application role cannot do that — so without a second
   * connection every "the row exists" control silently returns nothing and the
   * isolation assertions go vacuous in the opposite direction. Both directions
   * vacuous is how a suite ends up asserting nothing while looking thorough.
   */
  readonly asMigrator: postgres.Sql;
  readonly url: string;
  close(): Promise<void>;
}

/** Rewrites a connection string's credentials, keeping host, port and database. */
function withCredentials(databaseUrl: string, user: string, password: string): string {
  const parsed = new URL(databaseUrl);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

/**
 * Creates the two roles and the default privileges runbook 30 §2A provisions.
 *
 * Idempotent and never dropped: roles are CLUSTER objects, not per-database, so
 * two suites running against one server share them. A `DROP ROLE` at teardown
 * would break a concurrent run, and this repository's Postgres container is
 * routinely shared with `packages/app`'s suite.
 *
 * `NOSUPERUSER NOBYPASSRLS` is stated explicitly rather than relied on as the
 * default, because it is the single property that decides whether anything below
 * measures a policy or measures a bypass.
 */
async function provisionRoles(admin: postgres.Sql, databaseName: string): Promise<void> {
  for (const [role, password] of [
    [MIGRATOR_ROLE, MIGRATOR_PASSWORD],
    [APPLICATION_ROLE, APPLICATION_PASSWORD],
  ]) {
    await admin.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
        ELSE
          ALTER ROLE "${role}" WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
  }

  /**
   * The migrator OWNS the database, matching what runbook 30 §2A provisions —
   * the two-role reading of `CREATE DATABASE <app> OWNER <app>` is that the
   * MIGRATOR is the owner and the application role owns nothing.
   *
   * Ownership rather than a bare schema grant, and the difference is not
   * cosmetic: `@oxyhq/db`'s migration ledger lives in its own `drizzle` schema,
   * and `CREATE SCHEMA` needs `CREATE` on the DATABASE, which
   * `GRANT CREATE ON SCHEMA public` does not confer. Provisioned with schema
   * grants alone, the very first migration fails with
   * `42501 permission denied for database` before any table is created — which is
   * how this requirement was found rather than assumed.
   */
  await admin.unsafe(`ALTER DATABASE "${databaseName}" OWNER TO "${MIGRATOR_ROLE}"`);
  await admin.unsafe(`GRANT CREATE, USAGE ON SCHEMA public TO "${MIGRATOR_ROLE}"`);
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO "${APPLICATION_ROLE}"`);

  /**
   * The grant that covers tables which do not exist yet.
   *
   * A plain `GRANT ... ON ALL TABLES` covers only what exists when it runs, so
   * without this every future migration ships a table the application cannot
   * read — and it fails at runtime, not at migration time. `FOR ROLE` is
   * load-bearing: default privileges attach to the role that CREATES the object,
   * so a clause omitting it silently covers only objects created by whoever ran
   * the statement, which here is the admin rather than the migrator.
   *
   * Nothing else in Oxy does this, because nothing else has a second role. The
   * isolation fixture asserts it works by reading a table the migration never
   * granted explicitly.
   */
  await admin.unsafe(`
    ALTER DEFAULT PRIVILEGES FOR ROLE "${MIGRATOR_ROLE}" IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${APPLICATION_ROLE}"
  `);
  await admin.unsafe(`
    ALTER DEFAULT PRIVILEGES FOR ROLE "${MIGRATOR_ROLE}" IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO "${APPLICATION_ROLE}"
  `);
}

export async function createPostgresTestDatabase(): Promise<PostgresTestDatabase> {
  const adminUrl = process.env.CROWDSOURCE_BACKEND_TEST_POSTGRES_URL;
  if (adminUrl === undefined) {
    throw new Error(
      'CROWDSOURCE_BACKEND_TEST_POSTGRES_URL is unset: vitest.globalSetup.ts did not run.',
    );
  }

  const url = await createTestDatabase({
    adminUrl,
    migrate: async (databaseUrl) => {
      // As the admin: create the roles and the default privileges, then hand the
      // schema to the migrator. The admin creates the DATABASE and therefore owns
      // it; the migrator owns every TABLE, which is what the policies rely on.
      const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
      const admin = postgres(databaseUrl, { max: 1 });
      try {
        await provisionRoles(admin, databaseName);
      } finally {
        await admin.end();
      }

      await runMigrations({
        // The migrator's own connection string, NOT the admin's. This is the
        // whole point: tables created by the admin would be owned by a superuser,
        // every policy on them would be bypassed, and the suite would measure
        // nothing. In production these are two separate SSM parameters on two
        // separate task definitions, because ECS cannot inject a secret through a
        // container override.
        databaseUrl: withCredentials(databaseUrl, MIGRATOR_ROLE, MIGRATOR_PASSWORD),
        migrationsFolder: MIGRATIONS_FOLDER,
        // None. The schema is text, timestamptz and integers; `uuidv7` is
        // JavaScript. `CREATE EXTENSION` is privileged on RDS, so needing one
        // would make this service an infrastructure change.
        extensions: [],
        run: 'all',
        dryRun: false,
        logger: { info: () => undefined, debug: () => undefined },
      });
    },
  });

  const applicationUrl = withCredentials(url, APPLICATION_ROLE, APPLICATION_PASSWORD);
  const built = createDatabase<BackendSchema>({
    databaseUrl: applicationUrl,
    schema,
    client: {
      // More than one: a fixture holds a second connection while the first works.
      max: 4,
      connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    },
  });

  const asMigrator = postgres(withCredentials(url, MIGRATOR_ROLE, MIGRATOR_PASSWORD), {
    max: 2,
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
  });

  return {
    db: built.db,
    client: built.client,
    asMigrator,
    url: applicationUrl,
    async close() {
      await asMigrator.end();
      await built.client.end();
      await dropTestDatabase(url);
    },
  };
}
