import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * One MongoDB replica set for the whole suite.
 *
 * A replica SET rather than a standalone, because the two properties this
 * package's correctness rests on only exist there: multi-document transactions
 * (a report and its outbox row commit together, or neither does) and the unique
 * indexes that make a retry idempotent. A mocked driver can be made to agree
 * with any of those claims, which is exactly why it must not be the thing they
 * are tested against — the tests would keep passing after the guarantee broke.
 */
let replicaSet: MongoMemoryReplSet | null = null;

export async function setup(): Promise<void> {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.CROWDSOURCE_APP_TEST_MONGODB_URI = replicaSet.getUri();

  /**
   * Postgres is required, not optional, and an absent URL THROWS here rather
   * than letting the schema tests skip.
   *
   * A skipped test is a green run that gated nothing — the same vacuity a test
   * floor exists to catch, arriving through the one door a floor cannot see. A
   * developer who has not started the database gets this message; CI starts the
   * same compose file, so the version they test against cannot disagree.
   *
   * Unlike Mongo, this is not started in-process: `mongodb-memory-server`
   * downloads and runs a mongod, and there is no equivalent for Postgres that is
   * worth the download on every machine — the container is one command.
   */
  if (!process.env.CROWDSOURCE_APP_TEST_POSTGRES_URL) {
    throw new Error(
      'CROWDSOURCE_APP_TEST_POSTGRES_URL is unset. Start the database with:\n' +
        '  docker compose -f docker-compose.postgres.yml up -d --wait postgres\n' +
        'then export the URL printed in that file (port 5436 on this repository).',
    );
  }
}

export async function teardown(): Promise<void> {
  await replicaSet?.stop();
  replicaSet = null;
}
