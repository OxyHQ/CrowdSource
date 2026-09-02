import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, inList, timestamptz, updatedAt } from '@oxyhq/db';

import {
  WEBHOOK_ATTEMPT_OUTCOMES,
  WEBHOOK_DISABLED_REASONS,
  WEBHOOK_ENDPOINT_STATUSES,
  WEBHOOK_FAILURE_KINDS,
} from '../../../domain/closedValues';

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


/**
 * Webhook endpoints, their signing secrets, the delivery attempt journal — and
 * `webhook_deliveries`, which is the odd one out and sits at the bottom.
 *
 * Three of these four tables are tenant-owned and carry a policy. The delivery
 * does not: the worker claims due rows across every tenant, so the row it claims
 * could not be found through a tenant filter. It is nonetheless tenant-STAMPED
 * like the other three, which is why it lives beside them rather than in another
 * file — and why the registry's `tenant_stamped_reached_through_parent` kind
 * exists to keep somebody from "correcting" it later.
 *
 * Its `webhook_attempts` children ARE tenant-scoped, because the worker derives a
 * context from the delivery row it has just claimed. That is the seam: one claim
 * spanning tenants, everything below it scoped.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    webhookEndpointId: text('webhook_endpoint_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    url: text('url').notNull(),

    /**
     * The ONE array in this batch that is genuinely QUERIED — the fan-out asks
     * for active endpoints subscribed to an event type, which on Mongo was array
     * containment. `text[]` preserves that with `= ANY`/`&&` and takes a GIN
     * index below; `jsonb` would make the hot path awkward for no gain.
     *
     * No CHECK against the event vocabulary, and the Mongoose file says why:
     * the values are kept as plain strings so a new event type is additive. A
     * constraint here would make adding one a migration.
     */
    eventTypes: text('event_types').array().notNull().default([]),

    status: text('status').notNull().default('active'),
    disabledReason: text('disabled_reason'),
    disabledAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * What makes re-registering an existing URL an update rather than a second
     * row — and the only way back for an endpoint a 410 disabled, since there is
     * no re-enable route.
     */
    uniqueIndex('webhook_endpoints_application_url_key').on(table.applicationId, table.url),
    /**
     * GIN, because the fan-out predicate is array containment. A btree on the
     * array column would be an index the planner cannot use for that query,
     * which reads as "we have an index" while every fan-out sequential-scans.
     */
    index('webhook_endpoints_event_types_idx').using('gin', table.eventTypes),
    index('webhook_endpoints_application_status_idx').on(table.applicationId, table.status),
    check(
      'webhook_endpoints_status_check',
      sql`${table.status} in (${sql.raw(inList(WEBHOOK_ENDPOINT_STATUSES))})`,
    ),
    check(
      'webhook_endpoints_disabled_reason_check',
      sql`${table.disabledReason} is null or ${table.disabledReason} in (${sql.raw(inList(WEBHOOK_DISABLED_REASONS))})`,
    ),
  ],
);

/**
 * A signing secret, envelope-encrypted.
 *
 * The row has no public id of its own — identity is
 * `(application_id, webhook_endpoint_id, version)`, which is the unique below.
 * `ciphertext`, `iv`, `auth_tag` and `key_fingerprint` are opaque and must never
 * be logged.
 */
export const webhookSecrets = pgTable(
  'webhook_secrets',
  {
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),
    webhookEndpointId: text('webhook_endpoint_id').notNull(),
    version: integer('version').notNull(),
    algorithm: text('algorithm').notNull(),
    keyFingerprint: text('key_fingerprint').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    activatesAt: timestamptz().notNull(),

    /** NULL means "current". The rotation overlap reads null-or-future. */
    expiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Stops two racing rotations both minting version N+1. */
    uniqueIndex('webhook_secrets_endpoint_version_key').on(
      table.applicationId,
      table.webhookEndpointId,
      table.version,
    ),
    index('webhook_secrets_endpoint_activates_idx').on(
      table.applicationId,
      table.webhookEndpointId,
      table.activatesAt.desc(),
    ),
  ],
);

/**
 * The delivery attempt journal. Append-only; nothing outside tests reads it.
 *
 * THIS TABLE IS THE ONE WITH A RETENTION DEADLINE. On Mongo a TTL index on
 * `attempted_at` deleted rows after 90 days silently, on a clock nobody ran.
 * Postgres has no equivalent, so the deadline is carried by an
 * `@oxyhq/db/expiry` sweep target AND a caller that runs it — a registry nothing
 * runs is how another Oxy service served expired rows for hours while every code
 * search came up clean. See `db/postgres/expiry.ts`.
 */
export const webhookAttempts = pgTable(
  'webhook_attempts',
  {
    attemptId: text('attempt_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    deliveryId: text('delivery_id').notNull(),
    webhookEndpointId: text('webhook_endpoint_id').notNull(),
    eventId: text('event_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    outcome: text('outcome').notNull(),
    responseStatus: integer('response_status'),
    failureKind: text('failure_kind'),
    latencyMs: integer('latency_ms').notNull(),

    /**
     * NOT NULL with an empty-string default, never nullable: the empty string is
     * the correct stored value for a success, and a null would make "succeeded,
     * no body" indistinguishable from "we failed to record one".
     *
     * It holds a truncated, redacted body from a TENANT's server. Never log it,
     * never index it, never return it on a public surface.
     */
    responseBodyPreview: text('response_body_preview').notNull().default(''),

    nextAttemptAt: timestamptz(),
    secretVersion: integer('secret_version'),
    attemptedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * NOT tenant-prefixed, deliberately — as on Mongo. It is what stops a worker
     * that crashed after sending and before recording from writing the same
     * attempt twice on replay, and a delivery id is globally unique.
     */
    uniqueIndex('webhook_attempts_delivery_attempt_key').on(
      table.deliveryId,
      table.attemptNumber,
    ),
    index('webhook_attempts_application_attempted_idx').on(
      table.applicationId,
      table.attemptedAt.desc(),
    ),
    /** The sweep's index. Without it the reaper degrades to a full scan. */
    index('webhook_attempts_attempted_at_idx').on(table.attemptedAt),
    check(
      'webhook_attempts_outcome_check',
      sql`${table.outcome} in (${sql.raw(inList(WEBHOOK_ATTEMPT_OUTCOMES))})`,
    ),
    check(
      'webhook_attempts_failure_kind_check',
      sql`${table.failureKind} is null or ${table.failureKind} in (${sql.raw(inList(WEBHOOK_FAILURE_KINDS))})`,
    ),
  ],
);

/**
 * One logical delivery per endpoint and event; many attempts beneath it.
 *
 * Unscoped, and the only table in this file that is. See the header.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),

    /** Stamped on write from the outbox row's own tenant. */
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    webhookEndpointId: text('webhook_endpoint_id').notNull(),
    /**
     * The event id, which is the OUTBOX row's id — §10.7's `evt_…`.
     *
     * Sharing it is what makes replay safe end to end: an outbox row redelivered
     * produces the same `(endpoint, event)` pairs, the unique below refuses the
     * second insert, and the receiver's own idempotency keys on the same value.
     */
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),

    /**
     * The exact bytes signed and sent, written once when the delivery is created.
     *
     * Stored rather than rebuilt per attempt, because the signature covers these
     * bytes: a payload re-derived from domain state would change under a later
     * revision, and a retry would carry something the first attempt never said.
     */
    body: text('body').notNull(),

    status: text('status').notNull(),
    /** Total attempts ever made. Also the source of the next attempt NUMBER. */
    attemptCount: integer('attempt_count').notNull(),
    /**
     * Attempts since this delivery was created or last replayed. The §10.9 ladder
     * reads THIS one, so a manual replay gets the full schedule again while
     * `attempt_count` keeps numbering monotonically and the history stays whole.
     */
    cycleAttemptCount: integer('cycle_attempt_count').notNull(),

    nextAttemptAt: timestamptz(),
    /** While `delivering`, when another worker may take the row back. */
    leaseExpiresAt: timestamptz(),
    lastResponseStatus: integer('last_response_status'),
    deadLetterReason: text('dead_letter_reason'),
    succeededAt: timestamptz(),
    deadLetteredAt: timestamptz(),
    replayCount: integer('replay_count').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * §12.7 verbatim, and the constraint that stops a retry becoming a second
     * delivery. An INDEX rather than a lookup because a lookup races: two workers
     * replaying the same outbox row both read nothing and both insert, and the
     * tenant receives one decision twice.
     *
     * No tenant prefix, on purpose and as on Mongo — endpoint ids are random and
     * globally unique, so the pair is already stronger than a prefixed version.
     */
    uniqueIndex('webhook_deliveries_endpoint_event_key').on(
      table.webhookEndpointId,
      table.eventId,
    ),
    /** The worker's claim, which spans every tenant. */
    index('webhook_deliveries_status_next_attempt_at_idx').on(
      table.status,
      table.nextAttemptAt,
    ),
    /** "What happened to this tenant's webhooks lately" — the console's question. */
    index('webhook_deliveries_application_status_created_idx').on(
      table.applicationId,
      table.status,
      table.createdAt.desc(),
    ),

    /**
     * §12.7's delivery lifecycle and §10.9's stop reasons, restored as
     * constraints. Both validators fired on Mongo: a delivery is written through
     * `insertOne`, which reaches `Model.create()`.
     *
     * `dead_letter_reason` IS NULLABLE and this CHECK admits NULL without saying
     * so anywhere else, which is the thing a reader gets wrong: a CHECK rejects
     * only FALSE, and `NULL in (…)` is NULL rather than FALSE. Measured on a real
     * server — the same constraint accepted a NULL row and rejected `'zzz'` with
     * 23514. So "no reason yet" is already legal and an `OR … IS NULL` would be
     * redundant rather than protective.
     *
     * `event_type` DELIBERATELY GETS NO CHECK, recorded here because its absence
     * beside these two reads as an omission. §10.6's event types are a published
     * vocabulary, but the Mongoose path is `{ type: String, required: true }`
     * with no `enum` — so a constraint would be a NEW restriction rather than a
     * restored one. It is also the field most likely to gain a member, and a
     * CHECK there dead-letters a legitimate new event at the DATABASE rather than
     * at the contract, in exactly the rollout where that is hardest to diagnose.
     */
    check(
      'webhook_deliveries_status_check',
      sql`${table.status} in (${sql.raw(inList(WEBHOOK_DELIVERY_STATUSES))})`,
    ),
    check(
      'webhook_deliveries_dead_letter_reason_check',
      sql`${table.deadLetterReason} in (${sql.raw(inList(WEBHOOK_DEAD_LETTER_REASONS))})`,
    ),
  ],
);
