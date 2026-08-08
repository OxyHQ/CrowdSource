import type { ProcessedEventStore } from '@oxyhq/crowdsource-express';
import { decisionApplyEventId, type OutboxService } from './outbox/service.js';
import { MODERATION_EVENT_RETENTION_SECONDS } from './retention.js';
import type { ModerationEventStore, ModerationTransactionRunner } from './store/types.js';

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

/**
 * The webhook dedupe store, backed by the moderation event log.
 *
 * `@oxyhq/crowdsource-express` defaults to an in-process store and says exactly
 * when that is not enough: two instances behind a load balancer each keep their
 * own, so a redelivery landing on the other instance is not deduplicated. Every
 * Oxy backend runs several tasks behind one load balancer, so this is that case.
 *
 * The claim/release contract is the SDK's, and it is the right one. A row
 * inserted BEFORE the handler runs means a concurrent redelivery cannot also run
 * it; deleting that row when the handler THROWS means the sender's retry
 * schedule can still deliver the event later. Recording the id only after
 * success would let two copies run at once; recording it before and never
 * releasing would make a transient failure permanent and lose a decision
 * silently.
 *
 * The retention window is computed HERE rather than in a store, so both backends
 * keep an audit row for the same length of time.
 */
export function createProcessedEventStore<TTx>(
  events: ModerationEventStore<TTx>,
): ProcessedEventStore {
  return {
    async claim(eventId: string): Promise<boolean> {
      const now = new Date();
      return await events.claim({
        eventId,
        receivedAt: now,
        expiresAt: new Date(now.getTime() + MODERATION_EVENT_RETENTION_SECONDS * 1_000),
      });
    },

    async release(eventId: string): Promise<void> {
      await events.release(eventId);
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

export function createInboundService<TTx>(input: {
  transaction: ModerationTransactionRunner<TTx>;
  events: ModerationEventStore<TTx>;
  outbox: OutboxService<TTx>;
}): InboundService {
  return {
    async recordDecisionEvent(event) {
      await input.transaction.run(async (tx) => {
        const now = new Date();
        await input.events.markQueued(
          {
            eventId: event.eventId,
            type: event.type,
            caseId: event.caseId,
            payload: { caseId: event.caseId, decision: event.decision },
            now,
          },
          tx,
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
          tx,
        );
      });
    },

    async recordIgnoredEvent(event) {
      await input.events.markIgnored({
        eventId: event.eventId,
        type: event.type,
        ...(event.caseId === undefined ? {} : { caseId: event.caseId }),
        now: new Date(),
      });
    },
  };
}
