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
  /**
   * A juror voted, so the panel may now be complete (§9.4).
   *
   * The consensus engine is woken by an event rather than by the review request
   * finishing, because §9.1 forbids a reviewer learning anything about the
   * result: if evaluation ran inline, the third juror's request would be the
   * slow one, and "my submission took two seconds longer" is a partial result
   * leaking through a stopwatch. Through the outbox it is also replay-safe and
   * survives the process dying between the vote and the count.
   */
  reviewSubmitted: 'review.submitted',
  /** A decision was published for a case revision (§10.6's `case.decided`). */
  caseDecided: 'case.decided',
  /**
   * A later revision replaced a published decision (§9.8, §10.6).
   *
   * Separate from `case.decided` and emitted IN ADDITION to it, because §9.8
   * gives the correction its own consequences — reverting the conduct effect and
   * asking the application to restore — which an application must be able to
   * subscribe to without also subscribing to every ordinary decision.
   */
  decisionCorrected: 'decision.corrected',
  /**
   * An appeal was filed and opened a new revision (§9.8, §10.6).
   *
   * Written in the SAME transaction as the appeal, the revision bump and the
   * `case.ready_for_review` that asks for the new jury. That grouping is the
   * point: an appeal whose event was enqueued separately could be an appeal the
   * application was told about that never drew a panel, or a panel drawn for an
   * appeal nobody was told about, and §9.8's author has already been told their
   * case is being looked at again.
   */
  appealCreated: 'appeal.created',
  /**
   * The revision an appeal opened published its decision (§9.8, §10.6).
   *
   * Emitted alongside `case.decided`, never instead of it, and NOT the same
   * thing as `decision.corrected`: an appeal that upheld the original decision
   * has still produced a result the appellant is owed, while only an appeal that
   * changed the outcome is a correction.
   */
  appealDecided: 'appeal.decided',
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
  readonly decisionId?: string;
  readonly appealId?: string;
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
