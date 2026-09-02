import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, inList, timestamptz, updatedAt } from '@oxyhq/db';

import { APPLICATION_STANDINGS, STANDING_REASONS } from '../../../domain/closedValues';

/**
 * The lifecycle of an outbox row, and the ONE definition of it.
 *
 * It lives with the PostgreSQL schema because the closed set is a property of
 * the COLUMN: the CHECK below is
 * rendered from this tuple, so adding a member is a code change plus a migration
 * in the same PR rather than a silent divergence between a constraint and a type.
 * Drizzle Kit loads this schema barrel directly, so the definition stays free of
 * runtime module dependencies.
 *
 * `dispatching` is a LEASE, not a state a consumer reports: the dispatcher stamps
 * it with an expiry, and a row whose lease has run out is claimable again. That
 * is what makes a dispatcher crash a delay rather than a stranded row.
 */
export const OUTBOX_STATUSES = ['pending', 'dispatching', 'dispatched', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

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

    /**
     * The port's replacement for Mongoose's `enum: OUTBOX_STATUSES`.
     *
     * That validator was the single writer-side enforcement this table had, and
     * a port that dropped it would convert a structural guarantee into a comment
     * — which is where a wrong belief survives, because nothing recomputes it. A
     * prohibition is a TYPE or a CHECK, never a convention.
     *
     * `sql.raw` on the value list is REQUIRED, not stylistic: a value
     * interpolated into `check()` the ordinary way is emitted as the bound
     * parameter `$1` in the generated migration, which then fails at APPLY time
     * with no local signal. The COLUMN stays an interpolated drizzle column so
     * its SQL name still comes from the casing authority.
     *
     * `type` DELIBERATELY GETS NO CHECK, and the asymmetry is recorded so a later
     * reader does not "fix" it: `type` was never enum-constrained in Mongo
     * (`type: { type: String, required: true }`), so constraining it here would
     * be a NEW restriction smuggled in under a port, not a preserved one.
     */
    check(
      'outbox_events_status_check',
      sql`${table.status} in (${sql.raw(inList(OUTBOX_STATUSES))})`,
    ),
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
    check(
      'app_trust_snapshots_standing_check',
      sql`${table.standing} in (${sql.raw(inList(APPLICATION_STANDINGS))})`,
    ),
    check(
      'app_trust_snapshots_last_standing_reason_check',
      sql`${table.lastStandingReason} in (${sql.raw(inList(STANDING_REASONS))})`,
    ),
  ],
);
