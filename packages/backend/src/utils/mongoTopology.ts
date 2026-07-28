import type { Connection } from 'mongoose';
import mongoose from 'mongoose';

/**
 * Multi-document transactions require a replica set or a sharded cluster. A
 * standalone `mongod` accepts every write this service makes today and then
 * fails the FIRST time a domain write and its outbox event try to commit
 * together — which is the moment the outbox stops being able to protect
 * anything.
 *
 * That failure is expensive to diagnose later and free to detect now, so the
 * topology is asserted at boot rather than discovered at runtime.
 */

interface HelloResponse {
  /** Present on a replica set member. */
  setName?: unknown;
  /** `isdbgrid` on a mongos router. */
  msg?: unknown;
}

/** True when the connected deployment can run multi-document transactions. */
export function supportsTransactions(hello: HelloResponse): boolean {
  const isReplicaSet = typeof hello.setName === 'string' && hello.setName.length > 0;
  const isShardedCluster = hello.msg === 'isdbgrid';
  return isReplicaSet || isShardedCluster;
}

export async function assertTransactionalTopology(
  connection: Connection = mongoose.connection,
): Promise<void> {
  const database = connection.db;
  if (!database) {
    throw new Error('Cannot inspect the MongoDB topology before a connection is open.');
  }

  const hello = (await database.admin().command({ hello: 1 })) as HelloResponse;

  if (!supportsTransactions(hello)) {
    throw new Error(
      'MongoDB is a standalone deployment, which cannot run multi-document transactions. ' +
        'The outbox pattern requires a domain write and its outbox event to commit together, ' +
        'so moderation work would be silently lost. Connect to a replica set or a sharded ' +
        "cluster (check with `mongosh --eval 'rs.status().set'`).",
    );
  }
}
