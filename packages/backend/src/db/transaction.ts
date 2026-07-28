import mongoose, { type ClientSession } from 'mongoose';

/**
 * Transactions, and the one duplicate-key error the domain treats as an answer
 * rather than a failure.
 *
 * BullMQ runs on a single-node Valkey with no replica, no failover and no
 * snapshots, so a queued job can be lost outright. That is survivable only
 * because a domain write and its outbox row commit TOGETHER: if the queue is
 * wiped, the pending work is still re-derivable by re-reading the outbox. Work
 * enqueued without its outbox row is lost with no trace, and it fails silently
 * until the day a node is replaced.
 *
 * `withTransaction` is therefore not an optimisation. It is the mechanism the
 * durability of moderation work rests on, and every module that writes a domain
 * object and an outbox event goes through it.
 */

/** Runs `operation` inside a transaction and returns its result. */
export async function withTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    // The driver's own implementation, deliberately: it is what knows to retry
    // a `TransientTransactionError` and to re-commit on an
    // `UnknownTransactionCommitResult`. A hand-rolled loop gets one of those
    // two wrong and loses a committed write or duplicates one.
    return await session.withTransaction<T>(async () => operation(session));
  } finally {
    await session.endSession();
  }
}

/** The unique index a write collided with. */
export interface DuplicateKeyViolation {
  /** The fields of the offending index, e.g. `['applicationId', 'externalReportId']`. */
  readonly indexFields: readonly string[];
}

/**
 * Classifies a write failure as a unique-index collision, or returns null.
 *
 * This is what lets idempotency be the index rather than application logic. A
 * "read, then decide whether to write" sequence races: two concurrent retries of
 * the same delivery both read nothing and both insert. Inserting first and
 * interpreting the collision cannot race, because the index is the arbiter.
 */
export function duplicateKeyViolation(error: unknown): DuplicateKeyViolation | null {
  if (typeof error !== 'object' || error === null) return null;
  if (!('code' in error) || error.code !== 11000) return null;

  if ('keyPattern' in error) {
    const keyPattern = error.keyPattern;
    if (typeof keyPattern === 'object' && keyPattern !== null) {
      return { indexFields: Object.keys(keyPattern) };
    }
  }

  // A duplicate key without a usable key pattern is still a duplicate key; the
  // caller has to decide what to do with an unattributable one rather than
  // mistake it for an ordinary write failure.
  return { indexFields: [] };
}
