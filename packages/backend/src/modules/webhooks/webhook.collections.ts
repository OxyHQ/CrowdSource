import { Schema } from 'mongoose';

import { defineTenantCollection, defineUnscopedCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';

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
export const WEBHOOK_ENDPOINT_STATUSES = ['active', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

/**
 * Why an endpoint stopped receiving deliveries.
 *
 * `gone` is the only value written today: §10.9 allows a 410 to disable an
 * endpoint, and 410 is the one status whose HTTP meaning is "this resource is
 * permanently gone" rather than "not right now". `operator` exists for the Trust
 * & Safety surface that will need it and is written by nothing yet.
 */
export const WEBHOOK_DISABLED_REASONS = ['gone', 'operator'] as const;
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

const webhookEndpointSchema = new Schema<WebhookEndpointDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    webhookEndpointId: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    eventTypes: { type: [String], required: true, default: [] },
    status: {
      type: String,
      required: true,
      enum: WEBHOOK_ENDPOINT_STATUSES,
      default: 'active',
    },
    disabledReason: { type: String, enum: [...WEBHOOK_DISABLED_REASONS, null], default: null },
    disabledAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'webhook_endpoints' },
);

/**
 * One endpoint per URL per application.
 *
 * §10.2 gives registration no idempotency key, so an integrator whose deploy
 * script POSTs on every boot would otherwise accumulate identical endpoints and
 * every event would be delivered to the same URL several times. With this index
 * the second registration updates the first — which is also the only route back
 * for an endpoint a 410 disabled, since §10.2 has no re-enable endpoint.
 */
webhookEndpointSchema.index({ applicationId: 1, url: 1 }, { unique: true });

/** The fan-out query: which of this tenant's live endpoints wanted this event. */
webhookEndpointSchema.index({ applicationId: 1, status: 1, eventTypes: 1 });

export const webhookEndpoints = defineTenantCollection('WebhookEndpoint', webhookEndpointSchema);

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

const webhookSecretSchema = new Schema<WebhookSecretDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    webhookEndpointId: { type: String, required: true },
    version: { type: Number, required: true },
    algorithm: { type: String, required: true },
    keyFingerprint: { type: String, required: true },
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    activatesAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'webhook_secrets' },
);

/**
 * One row per version, enforced rather than assumed.
 *
 * Two rotations racing would otherwise both read "the highest version is 3" and
 * both write a 4, leaving two secrets claiming to sign the same deliveries and no
 * way to say which one an integrator was handed.
 */
webhookSecretSchema.index({ applicationId: 1, webhookEndpointId: 1, version: 1 }, { unique: true });
/** The signer's question: which versions of this endpoint's secret are live. */
webhookSecretSchema.index({ applicationId: 1, webhookEndpointId: 1, activatesAt: -1 });

export const webhookSecrets = defineTenantCollection('WebhookSecret', webhookSecretSchema);

/**
 * A LOGICAL delivery: one event to one endpoint, however many attempts it takes
 * (§12.7, App. D).
 *
 * `pending` carries a `nextAttemptAt`; `delivering` is a lease the worker holds
 * while an attempt is in flight; `succeeded` and `dead_letter` are terminal.
 * A dead letter is never deleted — §10.9 promises manual replay, and a row that
 * was discarded is a decision the tenant never received and nobody can name.
 */
export const WEBHOOK_DELIVERY_STATUSES = [
  'pending',
  'delivering',
  'succeeded',
  'dead_letter',
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** Why a delivery stopped. Each one is a different operator conversation. */
export const WEBHOOK_DEAD_LETTER_REASONS = [
  /** The §10.9 ladder ran out. */
  'attempts_exhausted',
  /** 410: the endpoint is gone, and it was disabled. */
  'endpoint_gone',
  /** A 4xx that will not become a 2xx by waiting (§10.9's "with classification"). */
  'client_error',
  /** The URL resolved into a private or reserved address at delivery time. */
  'unsafe_target',
  /** The endpoint was disabled between fan-out and the attempt. */
  'endpoint_disabled',
] as const;
export type WebhookDeadLetterReason = (typeof WEBHOOK_DEAD_LETTER_REASONS)[number];

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

const webhookDeliverySchema = new Schema<WebhookDeliveryDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    deliveryId: { type: String, required: true, unique: true },
    webhookEndpointId: { type: String, required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    body: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: WEBHOOK_DELIVERY_STATUSES,
      default: 'pending',
    },
    attemptCount: { type: Number, required: true, default: 0 },
    cycleAttemptCount: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    leaseExpiresAt: { type: Date, default: null },
    lastResponseStatus: { type: Number, default: null },
    deadLetterReason: {
      type: String,
      enum: [...WEBHOOK_DEAD_LETTER_REASONS, null],
      default: null,
    },
    succeededAt: { type: Date, default: null },
    deadLetteredAt: { type: Date, default: null },
    replayCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, collection: 'webhook_deliveries' },
);

/**
 * §12.7 verbatim: one logical delivery per endpoint and event, many attempts
 * beneath it.
 *
 * This is the constraint that stops a retry from becoming a second delivery, and
 * it is an INDEX rather than a lookup because a lookup races — two workers
 * replaying the same outbox row both read nothing and both insert, and the
 * tenant receives one decision twice. No tenant prefix on purpose: it is exactly
 * the plan's pair, and endpoint ids are random and globally unique, so the pair
 * is already stronger than a prefixed version of it.
 */
webhookDeliverySchema.index({ webhookEndpointId: 1, eventId: 1 }, { unique: true });

/** The worker's claim, which spans every tenant. */
webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
/** "What happened to this tenant's webhooks lately" — the console's question. */
webhookDeliverySchema.index({ applicationId: 1, status: 1, createdAt: -1 });

export const webhookDeliveries = defineUnscopedCollection(
  'WebhookDelivery',
  webhookDeliverySchema,
  {
    why: 'The delivery worker claims due rows across every tenant; rows are tenant-stamped on write.',
  },
);

/** How an attempt ended, as a closed vocabulary — never a free-text message. */
export const WEBHOOK_FAILURE_KINDS = [
  /** The endpoint answered, but not with a 2xx. */
  'http_status',
  /** The URL resolved into a private, loopback or reserved address. */
  'unsafe_target',
  /** No usable response: connection refused, TLS failure, redirect loop, timeout. */
  'upstream_unreachable',
  /** The endpoint's secret could not be decrypted, so nothing was sent. */
  'secret_unavailable',
  /** The endpoint was disabled before the attempt was made. */
  'endpoint_disabled',
] as const;
export type WebhookFailureKind = (typeof WEBHOOK_FAILURE_KINDS)[number];

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
  outcome: 'succeeded' | 'failed';
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

const webhookAttemptSchema = new Schema<WebhookAttemptDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    attemptId: { type: String, required: true, unique: true },
    deliveryId: { type: String, required: true },
    webhookEndpointId: { type: String, required: true },
    eventId: { type: String, required: true },
    attemptNumber: { type: Number, required: true },
    outcome: { type: String, required: true, enum: ['succeeded', 'failed'] },
    responseStatus: { type: Number, default: null },
    failureKind: { type: String, enum: [...WEBHOOK_FAILURE_KINDS, null], default: null },
    latencyMs: { type: Number, required: true },
    // Not `required`: Mongoose treats an empty string as a missing value, and
    // empty is the CORRECT stored form for a success, where nothing is kept.
    responseBodyPreview: { type: String, default: '' },
    nextAttemptAt: { type: Date, default: null },
    secretVersion: { type: Number, default: null },
    attemptedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'webhook_attempts' },
);

/**
 * One row per attempt number, so a worker that crashed after sending and before
 * recording cannot write the same attempt twice on replay.
 */
webhookAttemptSchema.index({ deliveryId: 1, attemptNumber: 1 }, { unique: true });
webhookAttemptSchema.index({ applicationId: 1, attemptedAt: -1 });

/**
 * §13.6's retention for webhook attempts: 90 days.
 *
 * A TTL index rather than a job, and this is the only retention rule the module
 * implements. Attempts are an operational journal — statuses, latencies and a
 * redacted preview — so deleting them on a clock is the whole requirement.
 * Everything else §13.6 covers is evidence with a legal-hold path attached, and
 * that belongs to the retention module rather than to a silent expiry here.
 */
export const WEBHOOK_ATTEMPT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
webhookAttemptSchema.index(
  { attemptedAt: 1 },
  { expireAfterSeconds: WEBHOOK_ATTEMPT_RETENTION_SECONDS },
);

export const webhookAttempts = defineTenantCollection('WebhookAttempt', webhookAttemptSchema);
