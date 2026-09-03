import pino from 'pino';

import { runBackendMigrations } from '../src/db/migrate';

/**
 * The migration entrypoint — a process around `runBackendMigrations`, and
 * nothing else.
 *
 * It lives here rather than under `src/` because
 * `.github/scripts/deploy-ecs-image.sh` runs
 * `packages/backend/dist/scripts/migrate.js`, and `tsconfig`'s `rootDir` maps
 * this file to exactly that. Everything worth asserting is in
 * `src/db/migrate.ts`, which is imported by tests; what is left here is the
 * argv, the exit code and the log line, none of which a unit test can
 * meaningfully hold.
 *
 * ## It imports NO application configuration, and that is why it builds its own logger
 *
 * `src/config` REQUIRES `DATABASE_URL` — the application role's credential — and
 * this process must run in a task definition carrying only the migrator's.
 * Reaching for `config` would make the migration task demand a credential it
 * must not hold, and refuse to start without it.
 *
 * That is not hypothetical: this file first used `src/utils/logger`, which
 * imports `config`, and the built entrypoint died at load with
 * `Invalid environment configuration — DATABASE_URL` before a single migration
 * was read. The import was two levels away and looked like the opposite of a
 * dependency on configuration. `migrationEntrypointIsolation` in
 * `src/__tests__/deployWiring.test.ts` walks the import graph and fails the
 * build if anything here reaches `src/config` again.
 *
 * Usage:
 *   bun packages/backend/dist/scripts/migrate.js --target-database=crowdsource [--phase=pre|post|all]
 */

/**
 * The migrator's own logger: same structured output as the service, no shared
 * module. `LOG_LEVEL` is read directly rather than through `config` — one
 * variable with a default is not worth a dependency that can refuse to boot.
 */
const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'crowdsource-migrate' },
});

async function main(): Promise<void> {
  await runBackendMigrations({
    argv: process.argv.slice(2),
    env: process.env,
    logger: {
      info: (message) => logger.info(message),
      debug: (message) => logger.debug(message),
    },
  });
}

main().catch((_error: unknown) => {
  logger.error({ classification: 'migration_failed' }, 'Migration failed');
  process.exit(1);
});
