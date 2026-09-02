/**
 * A real PostgreSQL server is required, not optional, and an absent URL throws
 * here rather than letting the schema tests skip.
 *
 * A skipped test is a green run that gated nothing. A developer who has not
 * started the database gets this message; CI starts the same compose file, so
 * the version under test cannot disagree.
 */
export async function setup(): Promise<void> {
  if (!process.env.CROWDSOURCE_APP_TEST_POSTGRES_URL) {
    throw new Error(
      'CROWDSOURCE_APP_TEST_POSTGRES_URL is unset. Start the database with:\n' +
        '  docker compose -f docker-compose.postgres.yml up -d --wait postgres\n' +
        'then export the URL printed in that file (port 5436 on this repository).',
    );
  }
}
