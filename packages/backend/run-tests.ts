import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './src/__tests__/support/postgresTestDatabase';

/**
 * `bun test` for this package, inside ONE disposable PostgreSQL database.
 *
 * What vitest's `globalSetup` did, as a wrapper: `bun test` has no global
 * setup that runs once per run, and under `--isolate` a `--preload` runs again
 * for every file. Arguments after the script are handed to `bun test` as they
 * are, so `bun run test -- --reporter=junit …` and a single-file filter both
 * work.
 *
 * Postgres is required, not optional, and an absent URL EXITS here rather than
 * letting the row-security tests skip.
 *
 * A skipped test is a green run that gated nothing — and these are the tests
 * standing where the tenant boundary is, on a property whose failure mode is
 * RETURNING ROWS rather than erroring. Nothing else in this repository, and
 * nothing in production, will ever notice if they stop running: the production
 * database can hold rows whose reader intentionally spans every tenant.
 *
 * The wrapper creates a uniquely named database, migrates it with the
 * unprivileged two-role topology, and publishes only those disposable URLs to
 * the test process before any application module imports config.
 *
 * The flags, and why:
 *
 * - `--isolate`: every file gets a fresh global and module registry, as each
 *   vitest file did. `mock.module` is process-wide, so without it one file's
 *   mocked `@oxy.so/core/server` would be the next file's real one.
 * - NOT `--parallel`. Every integration suite runs against the one database,
 *   and two of the things under test are deliberately global: the outbox
 *   dispatcher claims across every tenant, and so does the webhook delivery
 *   worker. Run in parallel, one file's dispatcher claims another file's rows
 *   and completes them — correct behaviour for the code and a race for the
 *   assertions, showing up as a suite that fails once every several runs in a
 *   different place each time. Per-test tenants keep the DATA apart; they
 *   cannot keep the WORKERS apart, because a worker with a tenant filter would
 *   not be the worker that runs in production.
 * - `--no-env-file`: a developer's `.env` never reaches the suite (vitest
 *   never loaded one either). The script itself is started with it too.
 * - `--timeout 30000`: vitest's `testTimeout`. Bun has no separate hook
 *   timeout (vitest's was two minutes): a hook gets this one unless it passes
 *   its own, which every hook that builds a database, and the one that settles
 *   background erasures, does.
 */
if (!process.env.CROWDSOURCE_BACKEND_TEST_POSTGRES_URL) {
  console.error(
    'CROWDSOURCE_BACKEND_TEST_POSTGRES_URL is unset. Start the database with:\n' +
      '  docker compose -f docker-compose.postgres.yml up -d --wait postgres\n' +
      'then export:\n' +
      '  CROWDSOURCE_BACKEND_TEST_POSTGRES_URL=postgres://crowdsource:crowdsource@127.0.0.1:5436/postgres',
  );
  process.exit(1);
}

const fixture: PostgresTestDatabase = await createPostgresTestDatabase();

let exitCode = 1;
try {
  const suite = Bun.spawn(
    [
      process.execPath,
      'test',
      '--isolate',
      '--no-env-file',
      '--preload',
      './test.setup.ts',
      '--timeout',
      '30000',
      ...process.argv.slice(2),
    ],
    {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        DATABASE_URL: fixture.url,
        CROWDSOURCE_BACKEND_TEST_MIGRATOR_URL: fixture.migratorUrl,
      },
      stdio: ['inherit', 'inherit', 'inherit'],
    },
  );
  const forward = (signal: NodeJS.Signals) => suite.kill(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  exitCode = await suite.exited;
} finally {
  await fixture.close();
}

process.exit(exitCode);
