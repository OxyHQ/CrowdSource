import type { ClientSession, Connection } from 'mongoose';
import type { ModerationTransactionRunner } from '../../store/types.js';

/**
 * The transaction runner, in Mongo.
 *
 * One runner for the whole package rather than a `startSession()` at each of the
 * three call sites that needs one. That is not tidying: the options below are
 * what make the guarantee real, and three copies of them are three chances for
 * one to drift to a weaker read concern and for the divergence to show up as
 * nothing at all until the day two writes need to agree.
 *
 * Transactions require a replica set. A standalone fails on the first intake
 * rather than at boot, so an application asserts its own topology.
 */

/**
 * Read what was committed, decide from a consistent snapshot, and do not
 * acknowledge until a majority has it.
 *
 * `snapshot` matters for the read intake makes INSIDE the transaction (the
 * duplicate check), and `majority` is what stops an acknowledged report from
 * disappearing with a failover. `primary` keeps the read on the node the write
 * is about to happen on.
 */
const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};

export function mongooseTransactionRunner(
  connection: Connection,
): ModerationTransactionRunner<ClientSession> {
  return {
    async run<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
      const session = await connection.startSession();
      try {
        /**
         * The result is captured in a WRAPPER rather than assigned directly,
         * because `withTransaction` returns nothing and `undefined` is a
         * perfectly good `T` — the inbound receiver's operation returns exactly
         * that. Testing the value itself for `undefined` would turn a
         * successful void transaction into a thrown error.
         *
         * `withTransaction` re-runs the callback on a transient conflict, so
         * this is overwritten on a retry, which is the correct outcome: the last
         * attempt is the one that committed.
         */
        let outcome: { value: T } | undefined;
        await session.withTransaction(async () => {
          outcome = { value: await operation(session) };
        }, TRANSACTION_OPTIONS);
        if (outcome === undefined) {
          throw new Error(
            'A moderation transaction committed without running its operation.',
          );
        }
        return outcome.value;
      } finally {
        await session.endSession();
      }
    },
  };
}
