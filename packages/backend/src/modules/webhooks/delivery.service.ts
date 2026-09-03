import { createTenantContext, type TenantContext } from '../../db/tenantScope';
import { getPostgresDatabase } from '../../db/postgres/database';
import {
  claimDueDelivery as claimDueDeliveryRow,
  countDeliveriesAcrossTenants,
  countDeliveriesForEndpoint,
  findTenantDelivery as findTenantDeliveryRow,
  insertDeliveryIfAbsent,
  listDeadLetteredAcrossTenants,
  listTenantDeliveries as listTenantDeliveryRows,
  recordDeliveryOutcome,
  replayDeadLetteredDelivery as replayDeadLetteredDeliveryRow,
} from '../../db/postgres/repositories/webhookDeliveries';
import { duplicateKeyViolation } from '../../db/transaction';
import { ApiError } from '../../http/apiError';
import { canonicalize } from '../../utils/canonicalJson';
import { newPublicId } from '../../utils/identifiers';
import { logger } from '../../utils/logger';
import { redactResponseBody } from './redaction';
import { nextRetry, type WebhookOutcome } from './retrySchedule';
import {
  webhookAttempts,
  type WebhookDeliveryDocument,
  type WebhookFailureKind,
} from './webhook.collections';

/**
 * Logical deliveries and their attempts (§10.7, §10.9, §12.7).
 *
 * The unit here is the LOGICAL delivery — one event to one endpoint — and it is
 * unique on `(webhookEndpointId, eventId)`. Everything else in this file is
 * about keeping that true while a delivery is retried, replayed and claimed by
 * more than one worker.
 *
 * Nothing is ever enqueued. The row IS the record: written before any attempt,
 * read back by the worker's own poll, and re-derivable in full from the outbox
 * row that produced it. There is no queue to lose, which is the strongest form
 * of the rule that a job may never be the only evidence that work exists.
 */

/** How long a worker holds a claimed delivery before another may take it back. */
export const WEBHOOK_DELIVERY_LEASE_MS = 60_000;

/**
 * Builds §10.7's envelope for one endpoint.
 *
 * Canonical JSON — sorted keys — so the same event produces the same bytes on
 * every process and every retry. Receivers parse JSON and do not care about key
 * order; WE care, because the signature covers these bytes and a delivery that
 * re-serialised differently between two attempts would be two different
 * documents wearing one event id.
 */
export function buildWebhookEventBody(input: {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly data: Record<string, unknown>;
}): string {
  return canonicalize({
    id: input.eventId,
    type: input.eventType,
    createdAt: input.occurredAt.toISOString(),
    organizationId: input.organizationId,
    applicationId: input.applicationId,
    data: input.data,
  });
}

export interface DeliveryRequest {
  readonly webhookEndpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly body: string;
  readonly now?: Date;
}

/**
 * Records one logical delivery, or recognises that it already exists.
 *
 * Insert-then-interpret rather than read-then-insert. A read cannot be trusted
 * here: two workers replaying the same outbox row both find nothing and both
 * insert, and the tenant receives one decision twice. The unique index is the
 * arbiter, and a duplicate key means the delivery is already recorded — with
 * whatever attempt state it has accumulated, which a second write would reset.
 *
 * Returns false when the delivery already existed, which is what makes a
 * replayed event id produce no second delivery.
 */
export async function recordDelivery(
  context: TenantContext,
  request: DeliveryRequest,
): Promise<boolean> {
  const now = request.now ?? new Date();

  return insertDeliveryIfAbsent(getPostgresDatabase(), {
      organizationId: context.organizationId,
      applicationId: context.applicationId,
      deliveryId: newPublicId('webhookDelivery'),
      webhookEndpointId: request.webhookEndpointId,
      eventId: request.eventId,
      eventType: request.eventType,
      body: request.body,
      status: 'pending',
      attemptCount: 0,
      cycleAttemptCount: 0,
      // Due immediately: §10.9's ladder begins with the initial attempt.
      nextAttemptAt: now,
      leaseExpiresAt: null,
      lastResponseStatus: null,
      deadLetterReason: null,
      succeededAt: null,
      deadLetteredAt: null,
      replayCount: 0,
      createdAt: now,
      updatedAt: now,
  });
}

/**
 * Claims the next delivery that is due, atomically and across every tenant.
 *
 * Two claimable shapes, and the second is crash recovery: a `pending` row whose
 * time has come, and a `delivering` row whose lease ran out because the worker
 * holding it died. Without the second, a task killed mid-attempt would strand
 * the delivery forever and nothing would say so.
 *
 * The attempt counters increment HERE, at the claim, not after the response.
 * A process that dies between sending and recording has already spent an
 * attempt, and counting it is what stops a request that reliably kills the
 * worker from being retried forever.
 */
export async function claimDueDelivery(now: Date): Promise<WebhookDeliveryDocument | null> {
  return (await claimDueDeliveryRow(
    getPostgresDatabase(),
    now,
    new Date(now.getTime() + WEBHOOK_DELIVERY_LEASE_MS),
  )) as WebhookDeliveryDocument | null;
}

/** What one attempt produced. */
export interface AttemptResult {
  readonly outcome: WebhookOutcome;
  readonly responseStatus: number | null;
  readonly failureKind: WebhookFailureKind | null;
  /** Raw, straight off the socket. Redacted here, before it is written down. */
  readonly responseBody: string;
  readonly latencyMs: number;
  readonly secretVersion: number | null;
  /** A `Retry-After` the receiver asked for, in milliseconds. */
  readonly retryAfterMs?: number;
}

export interface AttemptRecord {
  readonly attemptNumber: number;
  readonly status: WebhookDeliveryDocument['status'];
  readonly nextAttemptAt: Date | null;
  readonly deadLettered: boolean;
}

/**
 * Writes the attempt and moves the delivery on (§10.9).
 *
 * The attempt row is written FIRST. If the process dies between the two writes,
 * the lease expires, the delivery is reclaimed, and the next attempt takes the
 * next number — so the history is complete even when the delivery's own state is
 * one step behind. The other order would lose the attempt entirely, which is the
 * record §10.9 asks for.
 *
 * ## What is kept of the response, and what is not
 *
 * §10.9 requires each attempt to keep a truncated and redacted response body,
 * and this is the only field in the module holding bytes CrowdSource did not
 * compose. Three rules narrow it as far as the requirement allows:
 *
 *  1. **Nothing is kept for a SUCCESS.** A 2xx body has no diagnostic value —
 *    the status already said everything — and successes are the overwhelming
 *    majority of deliveries, so this removes most receiver-controlled bytes from
 *    storage at no operational cost.
 *  2. **A failure keeps a bounded, redacted prefix**, on the tenant-scoped
 *    attempt row, under §13.6's 90-day expiry. That is the field an integrator
 *    debugs a rejected signature with.
 *  3. **It reaches no log, at any level, ever.** A receiver's body can echo our
 *    payload, quote its own credentials, or print a stack trace naming a person.
 *    Logs, metrics and attestations are the boundary that has no exceptions, and
 *    a test asserts it rather than a comment claiming it.
 *
 * The residual is worth naming: a receiver that prints reported text into its
 * own error page puts that text in the preview, and no redactor can recognise
 * arbitrary prose. Rules 1 and 3 are what bound that; rule 2 is the plan's
 * explicit instruction, not a default.
 */
export async function recordAttempt(
  delivery: WebhookDeliveryDocument,
  result: AttemptResult,
  now: Date,
): Promise<AttemptRecord> {
  const context = createTenantContext(delivery.organizationId, delivery.applicationId);
  const succeeded = result.outcome.kind === 'succeeded';

  const decision = succeeded
    ? null
    : nextRetry({
        outcome: result.outcome,
        cycleAttemptCount: delivery.cycleAttemptCount,
        retryAfterMs: result.retryAfterMs,
      });

  const nextAttemptAt =
    decision?.retry === true ? new Date(now.getTime() + decision.delayMs) : null;

  try {
    await webhookAttempts.insertOne(context, {
      attemptId: newPublicId('webhookAttempt'),
      deliveryId: delivery.deliveryId,
      webhookEndpointId: delivery.webhookEndpointId,
      eventId: delivery.eventId,
      attemptNumber: delivery.attemptCount,
      outcome: succeeded ? 'succeeded' : 'failed',
      responseStatus: result.responseStatus,
      failureKind: result.failureKind,
      latencyMs: result.latencyMs,
      // Kept only for a failure, and redacted even then. See the note above.
      responseBodyPreview: succeeded ? '' : redactResponseBody(result.responseBody),
      nextAttemptAt,
      secretVersion: result.secretVersion,
      attemptedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error: unknown) {
    /**
     * This attempt number is already recorded, which means a worker sent it and
     * died before updating the delivery. The history is intact; carry on and
     * finish the state transition it never made.
     */
    if (!duplicateKeyViolation(error)) throw error;
  }

  const status: WebhookDeliveryDocument['status'] = succeeded
    ? 'succeeded'
    : decision?.retry === true
      ? 'pending'
      : 'dead_letter';

  await recordDeliveryOutcome(getPostgresDatabase(), delivery.deliveryId, {
    status,
    nextAttemptAt,
    lastResponseStatus: result.responseStatus,
    deadLetterReason: status === 'dead_letter' ? (decision?.deadLetterReason ?? null) : null,
    succeededAt: succeeded ? now : delivery.succeededAt,
    deadLetteredAt: status === 'dead_letter' ? now : delivery.deadLetteredAt,
  });

  if (status === 'dead_letter') {
    /**
     * §16.6 asks for an alert on the dead-letter queue, and §10.9 for an alert
     * to the tenant. This log line is the first; the second needs a notification
     * channel CrowdSource does not have yet, and the durable `dead_letter` row
     * is what a console or a runbook reads until it does.
     *
     * Ids, a status and a classification. No body, no preview, no URL — the
     * response preview lives on the attempt row and stays there.
     */
    logger.warn(
      {
        deliveryId: delivery.deliveryId,
        eventId: delivery.eventId,
        eventType: delivery.eventType,
        webhookEndpointId: delivery.webhookEndpointId,
        applicationId: delivery.applicationId,
        attempts: delivery.attemptCount,
        reason: decision?.deadLetterReason ?? null,
        responseStatus: result.responseStatus,
      },
      'Webhook delivery dead-lettered',
    );
  }

  return {
    attemptNumber: delivery.attemptCount,
    status,
    nextAttemptAt,
    deadLettered: status === 'dead_letter',
  };
}

/**
 * Puts a dead letter back in the queue (§10.9's manual replay).
 *
 * The attempt COUNTER keeps climbing so attempt numbers stay unique and the
 * whole history is readable, while the CYCLE counter resets so the ladder starts
 * again from thirty seconds — a replay after the cause was fixed should get the
 * same patience the first delivery had.
 *
 * There is no HTTP route for this yet. It is the operation the Trust & Safety
 * console calls, and the console is not scaffolded; §10.2 defines no
 * application-facing replay endpoint, and an application replaying its own
 * deliveries is not what "manual replay" in §10.9 describes.
 */
export async function replayDeadLetteredDelivery(
  context: TenantContext,
  deliveryId: string,
  now: Date = new Date(),
): Promise<WebhookDeliveryDocument> {
  const delivery = await findTenantDelivery(context, deliveryId);
  if (!delivery) {
    throw new ApiError('not_found', 'No such webhook delivery.');
  }
  if (delivery.status !== 'dead_letter') {
    throw new ApiError(
      'conflict',
      `Only a dead-lettered delivery can be replayed; this one is '${delivery.status}'.`,
    );
  }

  await replayDeadLetteredDeliveryRow(getPostgresDatabase(), deliveryId, now);

  const replayed = await findTenantDelivery(context, deliveryId);
  if (!replayed) {
    throw new ApiError('not_found', 'No such webhook delivery.');
  }
  return replayed;
}

/**
 * Reads one delivery, filtered by tenant.
 *
 * `webhook_deliveries` is exempt from the tenant filter because the worker's
 * claim spans every tenant — and that exemption is exactly why every read that
 * serves a CALLER goes through this function instead of the collection. The
 * filter is explicit here so there is one place to audit rather than one per
 * call site.
 */
export async function findTenantDelivery(
  context: TenantContext,
  deliveryId: string,
): Promise<WebhookDeliveryDocument | null> {
  return (await findTenantDeliveryRow(
    getPostgresDatabase(),
    context.organizationId,
    context.applicationId,
    deliveryId,
  )) as WebhookDeliveryDocument | null;
}

/**
 * One page of a tenant's deliveries, newest first (§4.2: "webhooks, secretos,
 * intentos, replay y dead letter queue").
 *
 * Lives here rather than in the console module for the same reason
 * `findTenantDelivery` does: this collection is exempt from the tenant filter, so
 * every read that serves a caller states the filter explicitly and they are all in
 * one file to audit. A console reaching into the collection itself would be a second
 * place where forgetting two clauses leaks another tenant's delivery log.
 */
export async function listTenantDeliveries(
  context: TenantContext,
  filter: {
    readonly status?: WebhookDeliveryDocument['status'];
    readonly webhookEndpointId?: string;
    readonly limit?: number;
  } = {},
): Promise<readonly WebhookDeliveryDocument[]> {
  return (await listTenantDeliveryRows(
    getPostgresDatabase(),
    context.organizationId,
    context.applicationId,
    filter,
    filter.limit ?? 50,
  )) as WebhookDeliveryDocument[];
}

/** How many of one endpoint's deliveries sit in each state. */
export interface DeliveryHealth {
  readonly pending: number;
  readonly delivering: number;
  readonly succeeded: number;
  readonly deadLetter: number;
}

/**
 * Delivery health for one endpoint (§16.4's `webhook_success_rate`, per endpoint).
 *
 * Four counts rather than a ratio: a ratio hides the case an operator actually
 * needs to see, which is a healthy-looking success rate next to a growing dead
 * letter queue. The console can divide.
 */
export async function deliveryHealthFor(
  context: TenantContext,
  webhookEndpointId: string,
): Promise<DeliveryHealth> {
  return countDeliveriesForEndpoint(
    getPostgresDatabase(),
    context.organizationId,
    context.applicationId,
    webhookEndpointId,
  );
}

/**
 * Dead-lettered deliveries across every tenant, for Trust & Safety (§4.3).
 *
 * The ONE cross-tenant read in this module, and it is confined to what a delivery
 * row says about ITSELF: ids, status, attempt counts, the reason it stopped. The
 * `body` field is never projected by any caller of this function — see the Trust &
 * Safety routes — because a webhook body carries case ids and outcomes for a tenant
 * the reader has no relationship with.
 *
 * Permitted at all only because this collection is already unscoped by design: the
 * delivery worker's claim spans every tenant, so there is no tenant filter here to
 * subvert.
 */
export async function listDeadLetteredDeliveriesAcrossTenants(
  limit = 100,
): Promise<readonly WebhookDeliveryDocument[]> {
  return (await listDeadLetteredAcrossTenants(
    getPostgresDatabase(),
    limit,
  )) as WebhookDeliveryDocument[];
}

/** How many deliveries sit in each state across every tenant (§16.4). */
export async function deliveryCountsAcrossTenants(): Promise<DeliveryHealth> {
  return countDeliveriesAcrossTenants(getPostgresDatabase());
}
