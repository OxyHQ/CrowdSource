import type { ClientSession, Model } from 'mongoose';
import type { ModerationOutboxDocument } from '../../models/index.js';
import { ModerationOutboxTransactionError } from '../../outbox/service.js';
import type { ModerationOutboxStore } from '../../store/types.js';
import type { ModerationOutboxEvent } from '../../types.js';

/**
 * The moderation outbox, in Mongo.
 *
 * Every query the outbox needs and nothing else: the service above it owns the
 * backoff curve, the retry ceiling, the lease-length floor and the retention
 * window, and hands this the values they produced. What is here is the part a
 * second backend has to express differently — an atomic claim, an
 * insert-if-absent that writes nothing for a row that exists, and three
 * lease-checked transitions.
 */

/**
 * Due work, as one filter.
 *
 * Either `pending` and past its `availableAt`, or `processing` with an EXPIRED
 * lease — the second branch is what makes a dead worker's event reclaimable
 * rather than stranded. The two branches have an index each
 * (`{ status, availableAt, createdAt }` and `{ status, leaseUntil, createdAt }`).
 *
 * `eventId` narrows the same filter to one row, so a targeted claim cannot pick
 * up somebody else's due work.
 */
function claimFilter(now: Date, eventId?: string): Record<string, unknown> {
  return {
    ...(eventId ? { _id: eventId } : {}),
    $or: [
      { status: 'pending', availableAt: { $lte: now } },
      { status: 'processing', leaseUntil: { $lte: now } },
    ],
  };
}

/**
 * A claimed row exactly as Mongo returns it.
 *
 * The port calls the primary key `id`; Mongo calls it `_id`. The mapping happens
 * here, once, so `String(document._id)` never appears in the shared half.
 */
type ClaimedOutboxRow = Omit<ModerationOutboxEvent, 'id'> & { _id: string };

export function mongooseOutboxStore(input: {
  model: Model<ModerationOutboxDocument>;
}): ModerationOutboxStore<ClientSession> {
  const { model } = input;

  return {
    async enqueue(event, session) {
      if (!session.inTransaction()) {
        throw new ModerationOutboxTransactionError(event.eventId);
      }

      /**
       * `timestamps: false` on the operation, with both timestamps written
       * explicitly. Two distinct reasons, and the second is why this is not
       * interchangeable with dropping the explicit fields.
       *
       * **It has to be one or the other.** The schema declares
       * `timestamps: true`, so on an upsert Mongoose adds `createdAt` to
       * `$setOnInsert` and `updatedAt` to `$set`. Naming `updatedAt` here as
       * well puts ONE PATH UNDER TWO OPERATORS and the server rejects the whole
       * write — "Updating the path 'updatedAt' would create a conflict at
       * 'updatedAt'" — which, inside intake's transaction, aborts the report
       * too. Every report submission fails, from the first one. It is a
       * server-side update validation, so nothing in the schema, the types or a
       * mocked driver reveals it.
       *
       * The error is **code 40, `ConflictingUpdateOperators`**, and it carries no
       * error labels. That matters for two reasons. It is DETERMINISTIC and NOT
       * retryable — measured: the identical document fails identically on a
       * second attempt — so a driver's retry logic cannot mask any of it, and an
       * observed failure count is traffic rather than the surviving remainder of
       * something partially absorbed. And it is a DIFFERENT failure from code
       * 112 `WriteConflict`/`TransientTransactionError`, which is what the
       * inferior fix below causes under concurrency; blending the two sends
       * whoever greps the logs after the wrong string.
       *
       * `createdAt` is NOT symmetric with it, and the difference is worth
       * stating because the tempting rule ("never name a timestamp here") sends
       * people to churn upserts that are perfectly fine. Mongoose puts
       * `createdAt` under `$setOnInsert` too — the SAME operator — so naming it
       * merges rather than collides. Measured on mongoose 8.24.2, one upsert per
       * row against a real replica set:
       *
       *     createdAt only   -> OK
       *     updatedAt only   -> MongoServerError: … conflict at 'updatedAt'
       *     both             -> MongoServerError: … conflict at 'updatedAt'
       *     neither          -> OK
       *
       * So only an upsert naming `updatedAt` is broken. Credit: `mention-finish`
       * measured this while fixing the two live instances in Mention and used it
       * to leave three innocent sites alone with evidence rather than churn.
       *
       * **And it has to be THIS one.** Letting Mongoose own the timestamps
       * instead would leave its `$set: { updatedAt }` on the update, which turns
       * a repeated enqueue for an event that already exists into a real WRITE
       * rather than a no-op (measured: `modifiedCount` 1 vs 0). A repeated
       * enqueue is ordinary — a transaction retry, two concurrent duplicate
       * submissions, a reconciliation sweep re-deriving an event — and the
       * dispatcher is concurrently taking, renewing and completing leases on
       * these same rows. A write there conflicts with a live lease update and
       * aborts the enclosing transaction (measured: the reconciliation-shaped
       * transaction aborts under Mongoose-owned timestamps and commits under
       * this). Writing both fields explicitly keeps the upsert a genuine no-op
       * for a row that already exists, which is the property the deterministic
       * event id exists to give.
       *
       * Credit: this refinement is `homiio`'s, from the Homiio integration.
       */
      await model.updateOne(
        { _id: event.eventId },
        {
          $setOnInsert: {
            _id: event.eventId,
            kind: event.kind,
            payload: event.payload,
            status: 'pending',
            attempts: 0,
            availableAt: event.availableAt,
            expiresAt: event.expiresAt,
            createdAt: event.now,
            updatedAt: event.now,
          },
        },
        { upsert: true, session, timestamps: false },
      );
    },

    async claim({ leaseOwner, leaseUntil, now, eventId }) {
      const row = await model
        .findOneAndUpdate(
          claimFilter(now, eventId),
          {
            $set: { status: 'processing', leaseOwner, leaseUntil, updatedAt: now },
            $inc: { attempts: 1 },
            // The previous attempt's error, cleared with the claim so a stale
            // message can never be read as this attempt's.
            $unset: { lastError: '' },
          },
          // Oldest first, so a backlog drains in the order it was filed rather
          // than by whatever the storage engine happens to return.
          { new: true, sort: { createdAt: 1 } },
        )
        .select('_id kind payload attempts availableAt leaseOwner leaseUntil expiresAt createdAt')
        .lean<ClaimedOutboxRow | null>();
      if (row === null) return null;
      const { _id, ...event } = row;
      return { id: _id, ...event };
    },

    async complete({ eventId, leaseOwner, now }) {
      const result = await model.updateOne(
        { _id: eventId, status: 'processing', leaseOwner, leaseUntil: { $gt: now } },
        {
          $set: { status: 'processed', processedAt: now, updatedAt: now },
          $unset: { leaseOwner: '', leaseUntil: '', lastError: '' },
        },
      );
      return result.modifiedCount === 1;
    },

    async renew({ eventId, leaseOwner, leaseUntil, now }) {
      const result = await model.updateOne(
        { _id: eventId, status: 'processing', leaseOwner, leaseUntil: { $gt: now } },
        { $set: { leaseUntil, updatedAt: now } },
      );
      /**
       * `matchedCount`, not `modifiedCount`. The question a renewal asks is "is
       * this lease still mine", which is what the FILTER answers; whether the
       * write then changed any bytes is a different question, and a renewal
       * landing on the values already stored answers it `false` for a lease that
       * is perfectly held.
       */
      return result.matchedCount === 1;
    },

    async fail({ eventId, leaseOwner, status, availableAt, lastError, now }) {
      const result = await model.updateOne(
        { _id: eventId, status: 'processing', leaseOwner, leaseUntil: { $gt: now } },
        {
          $set: { status, availableAt, lastError, updatedAt: now },
          $unset: { leaseOwner: '', leaseUntil: '' },
        },
      );
      return result.modifiedCount === 1;
    },

    async statusOf(eventId) {
      const row = await model
        .findById(eventId)
        .select('status')
        .lean<Pick<ModerationOutboxDocument, 'status'> | null>();
      return row?.status ?? null;
    },
  };
}
