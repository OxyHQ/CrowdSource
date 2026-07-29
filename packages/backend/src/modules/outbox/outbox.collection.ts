import { Schema, type ClientSession } from 'mongoose';

import { defineUnscopedCollection } from '../../db/collections';
import { tenantScopedDocument, type TenantContext } from '../../db/tenantScope';
import { newPublicId } from '../../utils/identifiers';

/**
 * The transactional outbox (§12.5).
 *
 * The plan specified SQS — replicated, durable, with dead-letter queues. What
 * CrowdSource actually runs is a single-node Valkey with no replica, no failover
 * and no snapshots, shared with six live backends. A node replacement (routine
 * AWS maintenance counts) or an out-of-memory condition loses queued work
 * outright.
 *
 * That is survivable only because of this collection, which makes the outbox
 * load-bearing rather than good practice: a domain write and its outbox row
 * commit in ONE transaction, and the queue is only a hint that something is
 * pending. If the queue is wiped, every pending piece of work is still
 * re-derivable by re-reading these rows. Work enqueued WITHOUT a row here is
 * lost moderation work with no trace, and it fails silently until the day a node
 * is replaced.
 *
 * Nothing in the infrastructure enforces this. `appendOutboxEvent` requiring a
 * `ClientSession` is the enforcement: there is no way to write an event outside
 * a transaction, so an event and the domain object it describes cannot come
 * apart.
 */

/** The internal event types of §12.5 that exist today. */
export const OUTBOX_EVENT_TYPES = {
  /** A universal report was stored and attached to a case. */
  reportReceived: 'report.received',
  /** A case was created or changed, and its priority and route must be computed. */
  caseReadyForTriage: 'case.ready_for_triage',
  /** Triage is done: the case can be handed to sortition (§8). */
  caseReadyForReview: 'case.ready_for_review',
  /**
   * A juror left their seat without reviewing — recused or expired (§8.7).
   *
   * Through the outbox rather than as a direct call, because §8.7 requires a
   * REPLACEMENT and a replacement that lived only in the recusal request would
   * be lost the moment that request failed after the recusal committed. The
   * panel would then sit one member short of its own threshold forever, which is
   * the failure the outbox exists to make impossible.
   */
  assignmentVacated: 'assignment.vacated',
} as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];

/**
 * What an event carries.
 *
 * References only — ids that let a consumer read the domain object back. Never
 * reported content: sensitive material must never reach logs, metrics or
 * attestations, and an outbox payload is copied into every one of them by the
 * time a delivery has been retried a few times.
 */
export interface OutboxEventPayload {
  readonly reportId?: string;
  readonly caseId?: string;
  readonly assignmentId?: string;
}

/**
 * §3.2-style lifecycle for a row.
 *
 * `dispatching` is a LEASE, not a state a consumer reports: the dispatcher
 * stamps it with an expiry, and a row whose lease has run out is claimable
 * again. That is what makes a dispatcher crash a delay rather than a stuck row —
 * without it, a process that died mid-handler would hold its events forever and
 * nothing would say so.
 */
export const OUTBOX_STATUSES = ['pending', 'dispatching', 'dispatched', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxEventDocument {
  eventId: string;
  organizationId: string;
  applicationId: string;
  type: OutboxEventType;
  payload: OutboxEventPayload;
  status: OutboxStatus;
  attempts: number;
  /** When this row may next be claimed; while leased, when the lease expires. */
  availableAt: Date;
  dispatchedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const outboxEventSchema = new Schema<OutboxEventDocument>(
  {
    eventId: { type: String, required: true, unique: true },
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true, default: {} },
    status: {
      type: String,
      required: true,
      enum: OUTBOX_STATUSES,
      default: 'pending',
    },
    attempts: { type: Number, required: true, default: 0 },
    availableAt: { type: Date, required: true },
    dispatchedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, collection: 'outbox_events' },
);

// The dispatcher's claim query: the oldest available pending row first.
outboxEventSchema.index({ status: 1, availableAt: 1 });

export const outboxEvents = defineUnscopedCollection('OutboxEvent', outboxEventSchema, {
  why: 'The dispatcher publishes across every tenant; rows are tenant-stamped on write.',
});

/**
 * Appends an event inside the caller's transaction.
 *
 * `session` is REQUIRED and not optional by oversight. It is the only structural
 * guarantee that an event and the domain write it describes commit together —
 * an optional session would make the safe call and the unsafe one look alike at
 * the call site, and the unsafe one is shorter.
 */
export async function appendOutboxEvent(
  context: TenantContext,
  session: ClientSession,
  event: { type: OutboxEventType; payload: OutboxEventPayload },
): Promise<string> {
  const eventId = newPublicId('outboxEvent');
  const now = new Date();

  await outboxEvents.insertOne(
    tenantScopedDocument(context, {
      eventId,
      type: event.type,
      payload: event.payload,
      status: 'pending',
      attempts: 0,
      availableAt: now,
      dispatchedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }),
    session,
  );

  return eventId;
}
