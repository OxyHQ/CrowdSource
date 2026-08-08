import type { ClientSession, Model } from 'mongoose';
import type { ModerationEventStore } from '../../store/types.js';
import type { ModerationEventDocument } from '../models.js';

/**
 * The inbound webhook event log, in Mongo.
 *
 * One document doing two jobs, deliberately: the DEDUPE claim and the AUDIT row
 * are the same row, so "has this event been handled" and "what did CrowdSource
 * tell us, and when" can never disagree. `_id` IS the event id, which is what
 * makes the unique index on it the deduplication.
 */

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

export function mongooseEventStore(input: {
  model: Model<ModerationEventDocument>;
}): ModerationEventStore<ClientSession> {
  const { model } = input;

  return {
    /**
     * The insert IS the claim: `_id` is the event id and the index on it is
     * unique, so the duplicate-key error is not an error condition to work
     * around — it is the answer "somebody else has this event".
     */
    async claim({ eventId, receivedAt, expiresAt }) {
      try {
        await model.create({ _id: eventId, state: 'claimed', receivedAt, expiresAt });
        return true;
      } catch (error: unknown) {
        if (isDuplicateKeyError(error)) return false;
        // Anything else — a lost connection, a failover — is NOT "already
        // processed". Rethrowing makes the middleware answer non-2xx so the
        // event stays on the sender's retry schedule; swallowing it here would
        // answer 200 and retire a decision nobody ever handled.
        throw error;
      }
    },

    async release(eventId) {
      await model.deleteOne({ _id: eventId });
    },

    async markQueued({ eventId, type, caseId, payload, now }, session) {
      await model.updateOne(
        { _id: eventId },
        {
          $set: {
            type,
            caseId,
            payload,
            state: 'queued',
            queuedAt: now,
            updatedAt: now,
          },
        },
        { session },
      );
    },

    async markIgnored({ eventId, type, caseId, now }) {
      await model.updateOne(
        { _id: eventId },
        {
          $set: {
            type,
            ...(caseId === undefined ? {} : { caseId }),
            state: 'ignored',
            updatedAt: now,
          },
        },
      );
    },
  };
}
