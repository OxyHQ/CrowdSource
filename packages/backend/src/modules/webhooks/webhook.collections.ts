import { defineTenantCollection, defineUnscopedCollection } from '../../db/collections';
import type {
  WebhookDeadLetterReason,
  WebhookDeliveryStatus,
} from '../../db/postgres/schema/webhooks';
import type { TenantContext } from '../../db/tenantScope';
import {
  WEBHOOK_DISABLED_REASONS,
  WEBHOOK_ATTEMPT_OUTCOMES,
  WEBHOOK_ENDPOINT_STATUSES,
  WEBHOOK_FAILURE_KINDS,
} from '../../domain/closedValues';

/**
 * Outbound webhook storage (§10.6–§10.9, §12.6 `webhook_endpoints`,
 * `webhook_secrets`, `webhook_deliveries`, `webhook_attempts`).
 *
 * Four collections, and exactly one of them is exempt from the tenant filter:
 *
 *  - `webhook_endpoints`, `webhook_secrets` and `webhook_attempts` are
 *    TENANT-owned. The first two are an application acting on its own
 *    configuration through its own credential. The third is written by the
 *    worker, which has a tenant for the same reason the triage worker does: the
 *    delivery row it claimed was tenant-stamped inside the transaction that
 *    created it, and that stamp is the only trustworthy source a worker has.
 *  - `webhook_deliveries` is UNSCOPED, for the same reason `outbox_events` is,
 *    and only for that reason: the worker's CLAIM spans every tenant, so it is
 *    the one query in the module that cannot carry a context. Rows are
 *    tenant-stamped on write, and no application-API route reads them — §10.2
 *    has no delivery-listing endpoint, and when the console grows one it goes
 *    through a function that takes a `TenantContext`.
 *
 * The delivery row is the RECORD, not a queue message. That is the invariant the
 * whole module rests on: the Valkey CrowdSource shares with six other backends is
 * a single node with no replica, no failover and no snapshots, so a job is a hint
 * that work is pending and never the only evidence that it exists. Nothing here
 * is enqueued that has not been written down first — today nothing is enqueued at
 * all, and the worker polls these rows directly.
 */

/** §10.6's event types, as stored. Kept as strings so a new event is additive. */
export { WEBHOOK_ENDPOINT_STATUSES } from '../../domain/closedValues';
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

/**
 * Why an endpoint stopped receiving deliveries.
 *
 * `gone` is the only value written today: §10.9 allows a 410 to disable an
 * endpoint, and 410 is the one status whose HTTP meaning is "this resource is
 * permanently gone" rather than "not right now". `operator` exists for the Trust
 * & Safety surface that will need it and is written by nothing yet.
 */
export { WEBHOOK_DISABLED_REASONS } from '../../domain/closedValues';
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];

export interface WebhookEndpointDocument extends TenantContext {
  webhookEndpointId: string;
  /** Always https, always a public host. See `endpoint.service.ts`. */
  url: string;
  /** The §10.6 event types this endpoint asked for. Others are never delivered. */
  eventTypes: string[];
  status: WebhookEndpointStatus;
  disabledReason: WebhookDisabledReason | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const webhookEndpoints = defineTenantCollection<WebhookEndpointDocument>('WebhookEndpoint');

/**
 * A versioned signing secret (§13.4: "versioned and rotated").
 *
 * Two timestamps express the rotation overlap §10.2 requires, and they are the
 * whole mechanism:
 *
 *  - `activatesAt` — when this version starts SIGNING.
 *  - `expiresAt` — when it stops being valid at all. `null` means "current".
 *
 * A rotation mints version N+1 with `activatesAt = now + overlap` and stamps
 * version N with `expiresAt = now + overlap`. During the window both are on
 * record and the integrator can install the new one while the old one is still
 * what arrives on the wire; at the boundary the signature switches over with
 * nothing to redeploy. An overlap of zero is an immediate cutover, which is what
 * a leaked secret needs.
 *
 * The secret itself is never stored in the clear — see `secretCipher.ts`.
 */
export interface WebhookSecretDocument extends TenantContext {
  webhookEndpointId: string;
  /** 1 for the secret issued with the endpoint, incrementing per rotation. */
  version: number;
  algorithm: string;
  /** Identifies the encryption key, so a wrong one fails by name, not by garbage. */
  keyFingerprint: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  activatesAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const webhookSecrets = defineTenantCollection<WebhookSecretDocument>('WebhookSecret');

export interface WebhookDeliveryDocument extends TenantContext {
  deliveryId: string;
  webhookEndpointId: string;
  /**
   * The event id, which is the OUTBOX row's id — §10.7's `evt_…`.
   *
   * Sharing it is what makes replay safe end to end: an outbox row redelivered
   * to the fan-out handler produces the same `(endpoint, event)` pairs, the
   * unique index below refuses the second insert, and the receiver's own
   * idempotency (§10.8: "store the processed event id") keys on the same value.
   */
  eventId: string;
  eventType: string;
  /**
   * The exact bytes signed and sent, written once when the delivery is created.
   *
   * Stored rather than rebuilt per attempt, because the signature covers these
   * bytes: a payload re-derived from domain state would change under a later
   * revision and a retry would then carry something the first attempt never
   * said. The eight events of §10.6 carry ids, outcomes and policy versions —
   * references, never reported material — so this field holds no case content,
   * by the same rule that governs an outbox payload.
   */
  body: string;
  status: WebhookDeliveryStatus;
  /** Total attempts ever made. Also the source of the next attempt NUMBER. */
  attemptCount: number;
  /**
   * Attempts since this delivery was created or last replayed.
   *
   * The §10.9 ladder reads THIS one, so a manual replay gets the full schedule
   * again while `attemptCount` keeps numbering attempts monotonically and the
   * history stays complete.
   */
  cycleAttemptCount: number;
  nextAttemptAt: Date | null;
  /** While `delivering`, when another worker may take the row back. */
  leaseExpiresAt: Date | null;
  lastResponseStatus: number | null;
  deadLetterReason: WebhookDeadLetterReason | null;
  succeededAt: Date | null;
  deadLetteredAt: Date | null;
  replayCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export const webhookDeliveries = defineUnscopedCollection<WebhookDeliveryDocument>(
  'WebhookDelivery',
  {
    why: 'The delivery worker claims due rows across every tenant; rows are tenant-stamped on write.',
  },
);

/** How an attempt ended, as a closed vocabulary — never a free-text message. */
export { WEBHOOK_FAILURE_KINDS } from '../../domain/closedValues';
export type WebhookFailureKind = (typeof WEBHOOK_FAILURE_KINDS)[number];
export type WebhookAttemptOutcome = (typeof WEBHOOK_ATTEMPT_OUTCOMES)[number];

/**
 * One attempt (§10.9: "each attempt keeps status, latency, a truncated and
 * redacted response body, nextAttemptAt and secretVersion").
 *
 * `responseBodyPreview` is the field that has to be handled carefully. It comes
 * from a tenant's server, which may echo our request, quote its own credentials
 * in an error page, or return a stack trace naming a user. It is truncated and
 * redacted by `redaction.ts` before it is stored, and it is NEVER logged
 * (§10.8, §13.4, §16.6).
 */
export interface WebhookAttemptDocument extends TenantContext {
  attemptId: string;
  deliveryId: string;
  webhookEndpointId: string;
  eventId: string;
  /** 1-based, monotonic across replays, unique per delivery. */
  attemptNumber: number;
  outcome: WebhookAttemptOutcome;
  responseStatus: number | null;
  failureKind: WebhookFailureKind | null;
  latencyMs: number;
  responseBodyPreview: string;
  nextAttemptAt: Date | null;
  /** Which version of the endpoint's secret signed this attempt (§10.9). */
  secretVersion: number | null;
  attemptedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const webhookAttempts = defineTenantCollection<WebhookAttemptDocument>('WebhookAttempt');
