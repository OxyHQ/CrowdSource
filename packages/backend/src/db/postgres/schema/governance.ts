import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { POLICY_SET_STATUSES } from '@oxyhq/crowdsource-contracts';
import { createdAt, inList, timestamptz, updatedAt } from '@oxyhq/db';

import { AUDIT_ACTIONS, AUDIT_REASONS } from '../../../domain/closedValues';

/**
 * Policy sets, the audit trail, and the usage meter.
 */
export const policySets = pgTable(
  'policy_sets',
  {
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),
    policySetId: text('policy_set_id').notNull(),
    version: text('version').notNull(),
    status: text('status').notNull().default('draft'),
    title: text('title').notNull(),

    /**
     * The one genuinely optional field in this batch. Nullable, and note that on
     * Mongo the key was ABSENT rather than null on older documents — a backfill
     * must not read "missing" as a locale of `null` meaning anything.
     */
    locale: text('locale'),

    /**
     * Rules stay `jsonb`, and the Mongoose schema's own comment is the reason:
     * it used `Mixed` deliberately so the zod contract remains the single
     * authority on rule shape. Normalising them into a child table would
     * re-create exactly the drift that comment exists to prevent, and nothing
     * queries into them — both reads are by `(policy_set_id, version)`.
     */
    rules: jsonb('rules').notNull(),

    publishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * What actually makes a published version immutable is the `status = 'draft'`
     * predicate on the update; this index is what stops two concurrent publishes
     * of the same version both succeeding.
     */
    uniqueIndex('policy_sets_application_set_version_key').on(
      table.applicationId,
      table.policySetId,
      table.version,
    ),
    check(
      'policy_sets_status_check',
      sql`${table.status} in (${sql.raw(inList(POLICY_SET_STATUSES))})`,
    ),
  ],
);

/**
 * The audit trail.
 *
 * Flat by design — scalars only, no nested object and no array, because no field
 * here may ever hold reported material. Append-only: the module exposes an append
 * and nothing else. §13.6 makes this the longest-retained data in the system, so
 * it deliberately carries no expiry.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    auditId: text('audit_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    action: text('action').notNull(),

    /**
     * Two nullable actor columns rather than one polymorphic pair, so a query for
     * a credential can never match an Oxy user id. Keeping them separate is the
     * point; collapsing them would make the trail ambiguous in exactly the case
     * somebody is reading it to resolve.
     */
    actorCredentialId: text('actor_credential_id'),
    actorOxyUserId: text('actor_oxy_user_id'),

    reportId: text('report_id'),
    caseId: text('case_id'),
    externalReportId: text('external_report_id'),
    reason: text('reason'),
    subjectId: text('subject_id'),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('audit_events_application_occurred_idx').on(
      table.applicationId,
      table.occurredAt.desc(),
    ),
    index('audit_events_application_case_occurred_idx').on(
      table.applicationId,
      table.caseId,
      table.occurredAt.desc(),
    ),
    check(
      'audit_events_action_check',
      sql`${table.action} in (${sql.raw(inList(AUDIT_ACTIONS))})`,
    ),
    check(
      'audit_events_reason_check',
      sql`${table.reason} is null or ${table.reason} in (${sql.raw(inList(AUDIT_REASONS))})`,
    ),
  ],
);

/**
 * One row per application per UTC day, incremented on every accepted report.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    /**
     * `text`, holding `YYYY-MM-DD`, and NOT a date column.
     *
     * The Mongoose schema states the reason and it survives the port intact: a
     * date invites a timezone-dependent truncation that splits one day's count
     * across two rows. It is range-queried as a string, and lexical ordering on
     * the ISO form is what makes that correct.
     */
    day: text('day').notNull(),

    reportsReceived: integer('reports_received').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * The whole design. The write is an upsert incrementing in place, inside the
     * ingestion transaction, so this index is the arbiter rather than a
     * read-then-write. `created_at` must not be touched on conflict.
     */
    uniqueIndex('usage_counters_application_day_key').on(table.applicationId, table.day),
  ],
);
