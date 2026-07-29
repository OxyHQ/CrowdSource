import { createTenantContext } from '../../db/tenantScope';
import { OUTBOX_EVENT_TYPES, type OutboxEventDocument } from '../outbox/outbox.collection';
import { registerOutboxHandler } from '../outbox/outbox.dispatcher';
import { evaluateCase } from './consensus.service';

/**
 * The consensus worker (§12.5, §12.11).
 *
 * One consumer, of `review.submitted`. It re-reads the panel and the ballots
 * from scratch every time rather than accumulating anything from the event —
 * the event carries ids and says only "something changed here" — which is what
 * lets it be replayed, run late, run twice, or run for the first time against a
 * backlog after the queue was wiped, and reach the same answer each time.
 *
 * ## §12.11's "el consensus worker puede ejecutarse varias veces sin duplicar
 * decisiones", and the stronger claim underneath it
 *
 * Running twice in SEQUENCE is easy: the second pass finds the case already
 * decided and does nothing. Running twice CONCURRENTLY is the one that needs
 * machinery, because two workers can read identical state a microsecond apart
 * and both correctly conclude "this panel agreed, publish". Neither has done
 * anything wrong; they simply cannot both be allowed to finish. That is settled
 * in `publishDecision`, by a compare-and-swap on the case revision, and it is
 * settled there rather than here so that every future caller inherits it — a
 * lock held by the worker would protect only the paths that remembered to take
 * it.
 *
 * ## A no-op is a success
 *
 * `waiting`, `already_decided`, `no_panel` and `expansion_refused` all return
 * normally, so the outbox row is marked dispatched rather than retried. None of
 * them is a transient failure: the panel is still voting, somebody else
 * published, the case never had a jury, or the pool is too small today. Retrying
 * any of them on a backoff would bury the row an operator needs to see under
 * seven identical ones — the same reasoning `sortition.worker.ts` gives for a
 * refused draw.
 *
 * Genuine faults — a case that does not exist, a database that is unreachable —
 * throw, and the dispatcher's backoff handles them.
 */
export async function handleReviewSubmitted(event: OutboxEventDocument): Promise<void> {
  const caseId = event.payload.caseId;
  if (!caseId) {
    throw new Error(`Outbox event '${event.eventId}' carries no caseId to reach consensus on.`);
  }

  await evaluateCase(createTenantContext(event.organizationId, event.applicationId), caseId);
}

/** Wires the consumer. Called once, from `registerOutboxWorkers`. */
export function registerConsensusWorker(): void {
  registerOutboxHandler(OUTBOX_EVENT_TYPES.reviewSubmitted, handleReviewSubmitted);
}
