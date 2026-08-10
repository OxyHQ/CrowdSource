import { boolean, doublePrecision, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * The two tables a background worker CLAIMS from, and the one that scores an
 * application.
 *
 * `outbox_events` and `webhook_deliveries` are the same shape as the jury tables
 * one file over: both carry the tenant pair, both are stamped on write, and both
 * are claimed by a dispatcher that runs for the whole deployment. A claim spans
 * every tenant by construction — `claimDueDelivery(now)` in
 * `delivery.service.ts:130` matches on status and a deadline and nothing else —
 * so the row it claims could not be found through a tenant filter.
 *
 * `app_trust_snapshots` is the odd one and is exempt for a DIFFERENT reason,
 * which is why it is filed under `tenant_attributed_not_tenant_owned` rather than
 * with the two above. Its tenant-serving read DOES filter by both keys, in one
 * place, on purpose (`applicationTrustFor`). What it cannot survive is a policy,
 * because Trust & Safety compares standing ACROSS applications with no filter at
 * all (`listApplicationTrust`, `applicationCountsByStanding`) — and because the
 * row is CrowdSource's opinion OF an application rather than that application's
 * own data.
 */

export const outboxEvents = pgTable(
  'outbox_events',
  {
    eventId: text('event_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    type: text('type').notNull(),
    /**
     * Five optional id fields, none of them queried into — the dispatcher reads
     * the payload whole and hands it to a handler. jsonb, no index.
     */
    payload: jsonb('payload').notNull(),

    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),

    /**
     * When this row may next be claimed; while leased, when the lease expires.
     *
     * `dispatching` is a LEASE, not a state a consumer reports, which is what
     * makes a dispatcher crash a delay rather than a stuck row.
     */
    availableAt: timestamptz().notNull(),
    dispatchedAt: timestamptz(),
    lastError: text('last_error'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * The claim, and the only read that matters for throughput: the oldest row
     * whose status is claimable and whose deadline has passed. Status leads
     * because it is the equality term; `available_at` is the range.
     */
    index('outbox_events_status_available_at_idx').on(table.status, table.availableAt),
  ],
);

export const appTrustSnapshots = pgTable(
  'app_trust_snapshots',
  {
    /**
     * One row per application, so the application id IS the identity — it was a
     * `unique: true` path in Mongo. `organization_id` rides along because the
     * console shows standing per organization, not because the row is owned.
     */
    applicationId: text('application_id').primaryKey(),
    organizationId: text('organization_id').notNull(),

    standing: text('standing').notNull(),

    /**
     * Whether a decision about this application's cases may reach Oxy Trust.
     *
     * Stored rather than derived from `standing`, because the two are genuinely
     * separable: an operator promoting an application to `trusted` for throughput
     * may still withhold global effects while identity binding is under review.
     * Deriving it would silently grant the larger power with the smaller one.
     */
    globalReputationEffectsAllowed: boolean('global_reputation_effects_allowed').notNull(),

    /**
     * §11.13's quality signals — NULLABLE where nothing measures them yet, and
     * null rather than 0 on purpose. A fabricated 0.5 on an operator screen is
     * worse than an absent number: it looks like a measurement, it will be acted
     * on, and nothing in the system would ever contradict it.
     *
     * `decisionOverturnRate` is deliberately absent as a column — it is the one
     * signal with a source of truth today, and it is derived at read time so it
     * cannot go stale against the decisions it summarises.
     */
    evidenceIntegrity: doublePrecision('evidence_integrity'),
    identityBindingReliability: doublePrecision('identity_binding_reliability'),
    policyQuality: doublePrecision('policy_quality'),

    lastStandingReason: text('last_standing_reason').notNull(),
    standingChangedAt: timestamptz(),
    /** The staff member who moved it, or null while it is still the initial state. */
    standingChangedByOxyUserId: text('standing_changed_by_oxy_user_id'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * The Trust & Safety dashboard's two reads: the headline counts per standing,
     * and the list ordered by most recently moved. Both run with NO tenant term —
     * which is the exemption, stated as an index.
     */
    index('app_trust_snapshots_standing_updated_at_idx').on(table.standing, table.updatedAt),
    /** The console's per-organization view of its own applications' standing. */
    index('app_trust_snapshots_organization_id_idx').on(table.organizationId),
  ],
);
