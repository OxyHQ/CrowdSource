import { defineConfig } from 'drizzle-kit';
import { DATABASE_CASING } from '@oxyhq/db';

/**
 * drizzle-kit configuration — for the TEST schema, and only ever that.
 *
 * This package publishes table DEFINITIONS, not migrations. The SQL under
 * `src/__tests__/support/postgres/migrations/` exists so this package's own suite
 * can run against a real migrated database; an ADOPTER generates its own
 * migrations from its own schema, in its own journal.
 *
 * That is not a preference. `@oxyhq/db`'s ledger applies a migration only when
 * its journal timestamp is strictly newer than the newest recorded one, so two
 * journals against one `drizzle.__drizzle_migrations` table interleave and the
 * loser is SKIPPED — silently, with exit 0. Shipping a migrations folder from a
 * library is therefore not a convenience with a caveat; it is a way to lose an
 * adopter's migration with no error. The `files` array in `package.json` excludes
 * everything under `src/__tests__/`, and Task 13 asserts that against the packed
 * tarball.
 *
 * A glob is deliberately NOT spelled out anywhere in this comment: a doc comment
 * containing a recursive glob closes itself early, because the glob's own
 * separator IS the comment terminator. That is what the first version of this
 * file did — and since `drizzle.config.ts` sat outside every tsconfig project, no
 * typecheck saw the broken syntax; drizzle-kit failed with
 * `__tests__ is not defined`, an error naming a path rather than a comment. It is
 * in `tsconfig.test.json` now.
 *
 * `casing` decides what the DDL CREATES; the same value passed to `drizzle()`
 * decides what queries REFERENCE. Both read `DATABASE_CASING` from `@oxyhq/db`,
 * so they cannot drift apart.
 */

const url = process.env.CROWDSOURCE_APP_TEST_POSTGRES_URL;
if (!url) {
  throw new Error(
    'CROWDSOURCE_APP_TEST_POSTGRES_URL is required by drizzle-kit. Start a local Postgres with:\n' +
      '  docker compose -f ../../docker-compose.postgres.yml up -d --wait postgres\n' +
      'then export CROWDSOURCE_APP_TEST_POSTGRES_URL (see that file for the URL).',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/__tests__/support/postgres/schema.ts',
  out: './src/__tests__/support/postgres/migrations',
  casing: DATABASE_CASING,
  strict: true,
  verbose: true,
  dbCredentials: { url },
});
