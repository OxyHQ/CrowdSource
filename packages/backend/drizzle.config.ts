import { defineConfig } from 'drizzle-kit';
import { DATABASE_CASING } from '@oxyhq/db';

/**
 * drizzle-kit configuration for this service's own schema.
 *
 * `packages/app` argues at length that a package must NOT ship migrations,
 * because two journals against one `drizzle.__drizzle_migrations` ledger
 * interleave and the loser is skipped silently. That reasoning is about a
 * LIBRARY living inside an adopter's database, and it inverts here: this package
 * is private, it owns its database outright, and its journal is the only one.
 * Migrations therefore live in the normal place and are committed.
 *
 * `casing` decides what the DDL CREATES; the same value passed to
 * `createDatabase` decides what queries REFERENCE. Both read `DATABASE_CASING`,
 * so they cannot drift.
 *
 * Regeneration DROPS every hand-written statement — the row-security DDL in
 * `0000` is not something drizzle-kit can model, so it cannot round-trip it.
 * After any `db:generate`, re-apply the block the migration's own header
 * describes and read the result for statements you did not intend.
 */

const url = process.env.CROWDSOURCE_BACKEND_TEST_POSTGRES_URL;
if (!url) {
  throw new Error(
    'CROWDSOURCE_BACKEND_TEST_POSTGRES_URL is required by drizzle-kit. Start a local Postgres with:\n' +
      '  docker compose -f ../../docker-compose.postgres.yml up -d --wait postgres\n' +
      'then export CROWDSOURCE_BACKEND_TEST_POSTGRES_URL (see that file for the URL).',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/postgres/schema/index.ts',
  out: './src/db/postgres/migrations',
  casing: DATABASE_CASING,
  strict: true,
  verbose: true,
  dbCredentials: { url },
});
