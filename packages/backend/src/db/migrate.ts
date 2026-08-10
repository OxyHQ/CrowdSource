import { join } from 'node:path';

import {
  MIGRATION_RUNS,
  readTargetDatabase,
  runMigrations,
  type MigrationRun,
} from '@oxyhq/db/migrate';

/**
 * Applying this service's PostgreSQL migrations — everything about it except
 * the process.
 *
 * The entrypoint an operator and the deploy actually run is
 * `packages/backend/scripts/migrate.ts`, which compiles to
 * `dist/scripts/migrate.js` — the path `.github/scripts/deploy-ecs-image.sh`
 * names. This module holds the parts worth testing without starting a process,
 * so the argument parsing and the credential refusal below are covered by unit
 * tests rather than by a deploy that finds out.
 *
 * ## Why not `drizzle-kit migrate`
 *
 * `drizzle-kit` is a devDependency and the runtime image installs production
 * dependencies only, so it cannot reach production at all. `@oxyhq/db/migrate`
 * wraps drizzle's own migrator, which is a runtime dependency, and adds the
 * preconditions this estate learned the hard way — the right database, an
 * unbroken ledger, and only the migrations safe for this side of the rollout.
 * Both tools share one ledger, so a database migrated by either is understood
 * by the other; `db:generate` stays a developer-machine command.
 *
 * ## `MIGRATOR_DATABASE_URL`, and why it is NOT `DATABASE_URL`
 *
 * This service is the first in Oxy provisioned with TWO database roles
 * (runbook 30 §2A). `crowdsource_app` — what `DATABASE_URL` names and what the
 * serving container holds — owns nothing and cannot create a table; the whole
 * isolation guarantee rests on it not being the owner, because a table's owner
 * is exempt from its own row-security policies and can `DROP POLICY` in one
 * statement. `crowdsource_migrator` owns every table and is the only credential
 * that can apply DDL.
 *
 * So this reads its own variable and REFUSES when it is absent. It deliberately
 * does not fall back to `DATABASE_URL`, and the reason is that the fallback is
 * the failure that leaves no trace: against a correctly provisioned two-role
 * database it fails loudly on a permission error, but against a SINGLE-role
 * database — one provisioned the ordinary Oxy way, which is every other
 * database in the estate — it SUCCEEDS. The migration applies, the deploy is
 * green, and the tables are owned by the role the application connects as,
 * which means row-level security is enabled, listed in `pg_policies`, and
 * enforcing nothing. Nothing errors and no read is wrong; isolation is simply
 * absent. A refusal here is the only thing standing between that and
 * production.
 */

/**
 * Where this module's `.sql` files are, relative to this module.
 *
 * ## Why relative to `__dirname`, and NOT by finding the package root
 *
 * The obvious implementation walks up to the nearest `package.json` and appends
 * `src/db/postgres/migrations`. It is what the sibling estate does, and here it
 * is WRONG — measured by running the compiled entrypoint rather than by reading
 * it. `tsconfig`'s `include` names `package.json` as an input, so `tsc` emits a
 * copy to `dist/package.json`; the walk from `dist/src/db` therefore stops at
 * `dist`, and the migrator looks for its journal under
 * `dist/src/db/postgres/migrations` while the image ships it somewhere else. The
 * failure is `ENOENT` on the journal, at deploy time, after the image is pushed.
 *
 * Going DOWN from `__dirname` has no such dependency. `rootDir` is the package
 * root, so the emitted tree mirrors the source one and the offset from this
 * module to its migrations is `postgres/migrations` in BOTH — `src/db/` from
 * source, `dist/src/db/` once compiled. That mirroring is already a stated
 * runtime contract in `tsconfig.json`, and `deployWiring.test.ts` pins it along
 * with the `Dockerfile` destination derived from this constant.
 *
 * `tsc` copies no `.sql` file, so the image must ship this directory itself.
 */
export const MIGRATIONS_FOLDER = join(__dirname, 'postgres', 'migrations');

/**
 * The migrator's own connection string.
 *
 * @throws {Error} When it is unset, naming the variable and refusing to guess.
 */
export function readMigratorDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.MIGRATOR_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'MIGRATOR_DATABASE_URL is unset. Migrations must be applied as ' +
        'crowdsource_migrator, which owns the tables; DATABASE_URL names ' +
        'crowdsource_app, which owns nothing and is subject to every policy. ' +
        'There is deliberately no fallback between them — see this module.',
    );
  }
  return url;
}

/**
 * Read `--phase=<pre|post|all>` out of an argument list, defaulting to `all`.
 *
 * Parsed here rather than in `@oxyhq/db`, which takes a `run` option rather
 * than a flag: how a caller spells it on its own command line is the caller's
 * business. An unrecognised value throws rather than falling back, because
 * silently running `all` for somebody who typed `--phase=pre-deploy` applies
 * the `post` migrations early, which is an outage on the image still serving.
 */
export function readPhase(argv: readonly string[]): MigrationRun {
  const prefix = '--phase=';
  const flag = argv.find((argument) => argument.startsWith(prefix));
  if (flag === undefined) return 'all';

  const value = flag.slice(prefix.length).trim();
  if (!(MIGRATION_RUNS as readonly string[]).includes(value)) {
    throw new Error(
      `Unrecognised --phase=${JSON.stringify(value)}. Use one of: ${MIGRATION_RUNS.join(', ')}.`,
    );
  }
  return value as MigrationRun;
}

/** Whether `DRY_RUN` asks for a report instead of an apply. */
export function isDryRun(env: NodeJS.ProcessEnv): boolean {
  const value = (env.DRY_RUN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export interface BackendMigrationOptions {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly logger: { info(message: string): void; debug(message: string): void };
}

/**
 * Apply this service's migrations.
 *
 * `--target-database=<name>` is required on every run, dry ones included. The
 * guard is adopted rather than inherited — `@oxyhq/db` leaves it optional — and
 * it is the one whose absence does not fail loudly: pointed at the wrong
 * database a migrator finds an empty ledger, applies the whole journal, logs a
 * success line and exits 0, leaving the real database untouched.
 *
 * No extensions. The schema is text, jsonb, timestamptz and integers; ids are
 * generated in JavaScript. `CREATE EXTENSION` is privileged on RDS, so needing
 * one would make this service an infrastructure change rather than a deploy.
 */
export async function runBackendMigrations(options: BackendMigrationOptions): Promise<void> {
  await runMigrations({
    databaseUrl: readMigratorDatabaseUrl(options.env),
    migrationsFolder: MIGRATIONS_FOLDER,
    extensions: [],
    run: readPhase(options.argv),
    expectedDatabase: readTargetDatabase(options.argv),
    dryRun: isDryRun(options.env),
    logger: options.logger,
  });
}
