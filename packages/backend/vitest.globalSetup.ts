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
}

export async function teardown(): Promise<void> {
  await replicaSet?.stop();
  replicaSet = null;
}
