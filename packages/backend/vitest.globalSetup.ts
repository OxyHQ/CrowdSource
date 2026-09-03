import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './src/__tests__/support/postgresTestDatabase';

let fixture: PostgresTestDatabase | undefined;

/** One disposable PostgreSQL database for the serial backend suite. */
export async function setup(): Promise<void> {
  /**
   * Postgres is required, not optional, and an absent URL THROWS here rather
   * than letting the row-security tests skip.
   *
   * A skipped test is a green run that gated nothing — and these are the tests
   * standing where the tenant boundary is, on a property whose failure mode is
   * RETURNING ROWS rather than erroring. Nothing else in this repository, and
   * nothing in production, will ever notice if they stop running: the production
   * database can hold rows whose reader intentionally spans every tenant.
   *
   * Global setup creates a uniquely named database, migrates it with the
   * unprivileged two-role topology, and publishes only those disposable URLs to
   * workers before any application module imports config.
   */
  if (!process.env.CROWDSOURCE_BACKEND_TEST_POSTGRES_URL) {
    throw new Error(
      'CROWDSOURCE_BACKEND_TEST_POSTGRES_URL is unset. Start the database with:\n' +
        '  docker compose -f docker-compose.postgres.yml up -d --wait postgres\n' +
        'then export:\n' +
        '  CROWDSOURCE_BACKEND_TEST_POSTGRES_URL=postgres://crowdsource:crowdsource@127.0.0.1:5436/postgres',
    );
  }

  fixture = await createPostgresTestDatabase();
  process.env.DATABASE_URL = fixture.url;
  process.env.CROWDSOURCE_BACKEND_TEST_MIGRATOR_URL = fixture.migratorUrl;
}

export async function teardown(): Promise<void> {
  const current = fixture;
  fixture = undefined;
  delete process.env.CROWDSOURCE_BACKEND_TEST_MIGRATOR_URL;
  if (current !== undefined) await current.close();
}
