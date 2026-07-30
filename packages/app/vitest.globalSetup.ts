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
}

export async function teardown(): Promise<void> {
  await replicaSet?.stop();
  replicaSet = null;
}
