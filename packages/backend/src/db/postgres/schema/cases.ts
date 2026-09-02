import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * A moderation case: the unit a jury decides.
 *
 * The first tenant-owned table to be ported, chosen deliberately rather than for
 * convenience. It carries the composite tenant key and it is the jury's own
 * material, so if the boundary is ever wrong here the damage is one organization
 * reading another's cases. Proving the isolation machinery on this table means
 * every later table lands against a gate already demonstrated on the material
 * that matters.
 *
 * Column names are written out explicitly rather than left to drizzle's
 * derivation, which mangles a capital run — `caseS3Key` becomes `case_s_3_key`.
 * The exception is `@oxyhq/db`'s `timestamptz` family, which takes no name and
 * derives through the one shared `DATABASE_CASING` value, so the DDL and the
 * queries cannot disagree about it.
 */
export const cases = pgTable(
  'cases',
  {
    caseId: text('case_id').primaryKey(),

    /**
     * The tenant, as a PAIR. Neither column carries a foreign key: both name a
     * row in a table this service owns, but the pair is also the RLS predicate,
     * and the point of the migration is that the DATABASE decides visibility
     * rather than a join. They are `NOT NULL` because a row outside every tenant
     * would be invisible to the application role and immortal — no policy would
     * ever match it, so nothing could read or delete it.
     */
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    /** The subject under moderation, in the reporting application's own id space. */
    externalSubjectId: text('subject_external_id').notNull(),
    contentHash: text('content_hash').notNull(),
    policyVersion: text('policy_version').notNull(),
    caseDedupKey: text('case_dedup_key').notNull(),

    subjectType: text('subject_type').notNull(),
    primaryResourceId: text('primary_resource_id').notNull(),
    policySetId: text('policy_set_id').notNull(),
    taxonomyVersion: text('taxonomy_version').notNull(),
    contentSnapshot: jsonb('content_snapshot').notNull(),

    status: text('status').notNull(),

    allegationCodes: text('allegation_codes').array().notNull(),
    reportCount: integer('report_count').notNull(),
    reporterFingerprints: text('reporter_fingerprints').array().notNull(),

    reach: integer('reach').notNull(),
    activeDistribution: boolean('active_distribution').notNull(),
    allowCommunityReview: boolean('allow_community_review').notNull(),
    containsPersonalData: boolean('contains_personal_data').notNull(),
    retentionDays: integer('retention_days').notNull(),

    priorityScore: doublePrecision('priority_score').notNull(),
    sensitivityClass: text('sensitivity_class'),
    reviewPool: text('review_pool'),
    requiresRedaction: boolean('requires_redaction').notNull(),
    escalated: boolean('escalated').notNull(),
    triagedAt: timestamptz(),

    currentRevision: integer('current_revision').notNull(),
    decidedRevision: integer('decided_revision').notNull(),
    incidentId: text('incident_id'),

    firstReportedAt: timestamptz().notNull(),
    lastReportedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * §7.3's exact identity. Edited content or a new policy version opens a new
     * case; concurrent reports for the same four values merge through
     * `upsertCaseForReport`. The tenant prefix is the application because sibling
     * products of one organization have independent subject-id namespaces.
     */
    uniqueIndex('cases_application_subject_content_policy_key').on(
      table.applicationId,
      table.externalSubjectId,
      table.contentHash,
      table.policyVersion,
    ),

    /**
     * The tenant-first ordering matters: every application query is filtered by
     * the pair before anything else, and RLS adds that predicate to statements
     * that did not write it themselves, so an index that does not lead with the
     * tenant is one the planner cannot use for the common read.
     */
    index('cases_tenant_status_idx').on(
      table.organizationId,
      table.applicationId,
      table.status,
    ),
    index('cases_application_dedup_idx').on(table.applicationId, table.caseDedupKey),
    index('cases_status_priority_created_idx').on(
      table.status,
      table.priorityScore.desc(),
      table.createdAt,
    ),
    check(
      'cases_status_check',
      sql`${table.status} in ('received', 'triaged', 'awaiting_review', 'under_review', 'awaiting_consensus', 'decided', 'escalated', 'appealed', 'superseded', 'closed')`,
    ),
    check('cases_report_count_check', sql`${table.reportCount} >= 0`),
    check('cases_reach_check', sql`${table.reach} >= 0`),
    check('cases_retention_days_check', sql`${table.retentionDays} > 0`),
    check('cases_current_revision_check', sql`${table.currentRevision} >= 1`),
    check(
      'cases_decided_revision_check',
      sql`${table.decidedRevision} >= 0 and ${table.decidedRevision} <= ${table.currentRevision}`,
    ),
  ],
);
