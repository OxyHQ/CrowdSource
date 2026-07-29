import { createTenantContext } from '../../db/tenantScope';
import { logger } from '../../utils/logger';
import { OUTBOX_EVENT_TYPES, type OutboxEventDocument } from '../outbox/outbox.collection';
import { registerOutboxHandler } from '../outbox/outbox.dispatcher';
import { assignments } from './assignment.collection';
import { openPanel } from './sortition.service';

/**
 * The sortition workers (§12.5, §15.4).
 *
 * Two consumers, one service. `case.ready_for_review` opens the first panel;
 * `assignment.vacated` replaces a juror who recused or ran out of time. Both go
 * through `openPanel`, which is what keeps a replacement subject to exactly the
 * rules the original draw was subject to — §8.7 forbids lowering the threshold
 * to fill a vacancy, and the only reliable way to honour that is for there to be
 * no second code path that could.
 *
 * Both handlers are idempotent because every outbox consumer has to be. A
 * replayed `case.ready_for_review` finds the panel already complete and does
 * nothing; a replayed `assignment.vacated` finds the seat already filled and
 * does nothing. Neither relies on the event being delivered once.
 *
 * ## A refusal is not a failure
 *
 * When the pool cannot fill a panel, `openPanel` records a refused draw and
 * returns. The handler then returns normally, so the event is marked dispatched
 * rather than retried eight times into a dead letter. That is deliberate: the
 * pool being too small is a state of the world, not a transient error, and
 * retrying it on a backoff would bury the one row an operator needs to see under
 * seven identical ones. The case keeps its status and is drawn again when
 * something changes.
 */

export async function handleCaseReadyForReview(event: OutboxEventDocument): Promise<void> {
  const caseId = event.payload.caseId;
  if (!caseId) {
    throw new Error(`Outbox event '${event.eventId}' carries no caseId to draw a panel for.`);
  }

  const context = createTenantContext(event.organizationId, event.applicationId);

  /**
   * A replay guard, and the reason it is a query rather than a flag: the
   * assignments ARE the record of whether this case has a panel. A boolean on
   * the case would be a second source of truth that can disagree with them.
   */
  const existing = await assignments.find({ caseId });
  if (existing.length > 0) return;

  const outcome = await openPanel({ context, caseId, kind: 'initial' });
  if (outcome.status === 'refused') {
    logger.warn(
      { caseId, drawId: outcome.drawId, reason: outcome.reason },
      'No panel could be opened for this case',
    );
  }
}

export async function handleAssignmentVacated(event: OutboxEventDocument): Promise<void> {
  const { caseId, assignmentId } = event.payload;
  if (!caseId || !assignmentId) {
    throw new Error(`Outbox event '${event.eventId}' names no assignment to replace.`);
  }

  const vacated = await assignments.findOne({ assignmentId });
  if (!vacated) {
    throw new Error(`Outbox event '${event.eventId}' names assignment '${assignmentId}', which does not exist.`);
  }

  // Already replaced — a replayed event, or a sweep and a recusal racing.
  if (vacated.replacementAssignmentId !== null) return;

  const context = createTenantContext(event.organizationId, event.applicationId);

  /**
   * The SAME slot, under the same specification. §8.7: "if it expires or the
   * reviewer recuses, the system selects a replacement without lowering the
   * threshold." Passing the vacated slot rather than recomputing which slots are
   * missing is what makes that exact — a recused specialist is replaced by a
   * specialist, not by whoever the panel happens to be short of.
   */
  const outcome = await openPanel({
    context,
    caseId,
    kind: 'replacement',
    slots: [vacated.slotType],
  });

  if (outcome.status === 'refused') {
    logger.warn(
      { caseId, assignmentId, drawId: outcome.drawId, reason: outcome.reason },
      'No replacement could be drawn for a vacated seat',
    );
    return;
  }

  const replacement = outcome.seats[0];
  if (!replacement) return;

  await assignments.updateOne(
    { assignmentId },
    { replacementAssignmentId: replacement.assignmentId, updatedAt: new Date() },
  );
}

/** Wires both consumers. Called once, from `registerOutboxWorkers`. */
export function registerSortitionWorkers(): void {
  registerOutboxHandler(OUTBOX_EVENT_TYPES.caseReadyForReview, handleCaseReadyForReview);
  registerOutboxHandler(OUTBOX_EVENT_TYPES.assignmentVacated, handleAssignmentVacated);
}
