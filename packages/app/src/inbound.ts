import type { ClientSession, Connection, Model } from 'mongoose';
import type { ProcessedEventStore } from '@oxyhq/crowdsource-express';
import {
  MODERATION_EVENT_RETENTION_SECONDS,
  type ModerationEventDocument,
} from './models';
import { decisionApplyEventId, type OutboxService } from './outbox/service';

/**
 * What happens between "a signed decision arrived" and "2xx".
 *
 * The receiver's contract is to answer quickly and queue the processing. So
 * exactly two writes happen here, in ONE transaction — the event's audit row is
 * completed and a durable `decision.apply` event is created — and the dispatcher
 * does the rest.
 *
 * The transaction is what makes the dedupe safe. The middleware has already
 * claimed the event id by inserting the row (see {@link createProcessedEventStore});
 * if completing that row and queueing the work were two operations, a crash
 * between them would leave an event that is permanently deduplicated with no
 * work queued — a decision silently lost, with a row that says it arrived.
 * Committing both together means the only two possible outcomes are "recorded
 * and queued" or "neither", and "neither" releases the claim and gets
 * redelivered.
 */

const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

/**
 * The webhook dedupe store, in Mongo.
 *
 * `@oxyhq/crowdsource-express` defaults to an in-process store and says exactly
 * when that is not enough: two instances behind a load balancer each keep their
 * own, so a redelivery landing on the other instance is not deduplicated. Every
 * Oxy backend runs several tasks behind one load balancer, so this is that case.
 *
 * The claim/release contract is the store's, and it is the right one. A row
 * inserted BEFORE the handler runs means a concurrent redelivery cannot also run
 * it; deleting that row when the handler THROWS means the sender's retry
 * schedule can still deliver the event later. Recording the id only after
 * success would let two copies run at once; recording it before and never
 * releasing would make a transient failure permanent and lose a decision
 * silently.
 */
export function createProcessedEventStore(
  model: Model<ModerationEventDocument>,
): ProcessedEventStore {
  return {
    /**
     * True when this call took the claim.
     *
     * The insert IS the claim: `_id` is the event id and the index on it is
     * unique, so the duplicate-key error is not an error condition to work
     * around — it is the answer "somebody else has this event".
     */
    async claim(eventId: string): Promise<boolean> {
      const now = new Date();
      try {
        await model.create({
          _id: eventId,
          state: 'claimed',
          receivedAt: now,
          expiresAt: new Date(now.getTime() + MODERATION_EVENT_RETENTION_SECONDS * 1_000),
        });
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

    /** Give the claim back so a redelivery can be processed. */
    async release(eventId: string): Promise<void> {
      await model.deleteOne({ _id: eventId });
    },
  };
}

export interface RecordDecisionEventInput {
  eventId: string;
  type: string;
  caseId: string;
  /**
   * The decision as delivered.
   *
   * `unknown`, deliberately. It is stored whole and parsed against the published
   * contract by the worker that acts on it — these payloads are deliberately
   * loose, and validating here would mean an event whose shape this deployment
   * does not recognise yet is refused at the door and retried until it
   * dead-letters, instead of being kept until the code catches up.
   */
  decision: unknown;
}

export interface InboundService {
  /** Record a decision-bearing event and queue its application. */
  recordDecisionEvent(input: RecordDecisionEventInput): Promise<void>;
  /**
   * Record an event there is nothing to do about.
   *
   * `case.created`, `case.escalated`, `case.closed` and any type a newer
   * CrowdSource introduces. No outbox row, because no work — but the row is
   * kept, because "did CrowdSource tell us about this case, and when" is the
   * first question asked when a report looks stuck, and it has to be answerable.
   */
  recordIgnoredEvent(input: {
    eventId: string;
    type: string;
    caseId?: string;
  }): Promise<void>;
}

export function createInboundService(input: {
  connection: Connection;
  model: Model<ModerationEventDocument>;
  outbox: OutboxService;
}): InboundService {
  const inTransaction = async (
    operation: (session: ClientSession) => Promise<void>,
  ): Promise<void> => {
    const session = await input.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await operation(session);
      }, TRANSACTION_OPTIONS);
    } finally {
      await session.endSession();
    }
  };

  return {
    async recordDecisionEvent(event) {
      await inTransaction(async (session) => {
        const now = new Date();
        await input.model.updateOne(
          { _id: event.eventId },
          {
            $set: {
              type: event.type,
              caseId: event.caseId,
              payload: { caseId: event.caseId, decision: event.decision },
              state: 'queued',
              queuedAt: now,
              updatedAt: now,
            },
          },
          { session },
        );

        await input.outbox.enqueue(
          {
            eventId: decisionApplyEventId(event.eventId),
            kind: 'decision.apply',
            payload: {
              eventId: event.eventId,
              caseId: event.caseId,
              decision: event.decision,
            },
          },
          session,
        );
      });
    },

    async recordIgnoredEvent(event) {
      const now = new Date();
      await input.model.updateOne(
        { _id: event.eventId },
        {
          $set: {
            type: event.type,
            ...(event.caseId === undefined ? {} : { caseId: event.caseId }),
            state: 'ignored',
            updatedAt: now,
          },
        },
      );
    },
  };
}
