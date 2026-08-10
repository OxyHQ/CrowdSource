import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * One MongoDB replica set for the whole suite.
 *
 * A replica SET rather than a standalone, because the two properties this
 * service's correctness rests on only exist there: multi-document transactions
 * (a report and its outbox row commit together, or neither does) and the unique
 * indexes that make a retry idempotent. A mocked driver can be made to agree
 * with any of those claims, which is exactly why it must not be the thing they
 * are tested against — the tests would keep passing after the guarantee broke.
 *
 * `MONGODB_URI` is set before any worker starts. The DATABASE is still decided
 * by `databaseIdentity`, not by this URI, so the integration tests exercise the
 * same identity wiring production does.
 */
let replicaSet: MongoMemoryReplSet | null = null;

export async function setup(): Promise<void> {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MONGODB_URI = replicaSet.getUri();

  /**
   * Postgres is required, not optional, and an absent URL THROWS here rather
   * than letting the row-security tests skip.
   *
   * A skipped test is a green run that gated nothing — and these are the tests
   * standing where the tenant boundary is, on a property whose failure mode is
   * RETURNING ROWS rather than erroring. Nothing else in this repository, and
   * nothing in production, will ever notice if they stop running: the production
   * database holds two documents and neither carries a tenant pair.
   *
   * Unlike Mongo this is not started in-process. `mongodb-memory-server`
   * downloads and runs a mongod; there is no equivalent for Postgres worth the
   * download on every machine, and CI starts the same compose file a developer
   * does, so the version under test cannot disagree.
   */
  if (!process.env.CROWDSOURCE_BACKEND_TEST_POSTGRES_URL) {
    throw new Error(
      'CROWDSOURCE_BACKEND_TEST_POSTGRES_URL is unset. Start the database with:\n' +
        '  docker compose -f docker-compose.postgres.yml up -d --wait postgres\n' +
        'then export:\n' +
        '  CROWDSOURCE_BACKEND_TEST_POSTGRES_URL=postgres://crowdsource:crowdsource@127.0.0.1:5436/postgres',
    );
  }
}

export async function teardown(): Promise<void> {
  await replicaSet?.stop();
  replicaSet = null;
}
