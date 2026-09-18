import { createTenantContext } from '../../db/tenantScope';
import { OUTBOX_EVENT_TYPES, type OutboxEventDocument } from '../outbox/outbox.collection';
import { registerOutboxHandler } from '../outbox/outbox.dispatcher';
import { rescoreCommunityNotes } from './communityNotes.service';

/**
 * Rescores a tenant's community notes after a rating (the community notes ADR).
 *
 * The event names the rated note, but the rescore covers the whole tenant: the
 * model is fitted over every rating at once, so one new rating can move a note it
 * never touched. Replay is a no-op when nothing changed, which is the normal case
 * for an at-least-once consumer.
 */
export async function handleCommunityNoteRated(event: OutboxEventDocument): Promise<void> {
  if (!event.payload.communityNoteId) {
    throw new Error(`Outbox event '${event.eventId}' carries no communityNoteId to rescore after.`);
  }
  await rescoreCommunityNotes(createTenantContext(event.organizationId, event.applicationId));
}

export function registerCommunityNotesWorker(): void {
  registerOutboxHandler(OUTBOX_EVENT_TYPES.communityNoteRated, handleCommunityNoteRated);
}
