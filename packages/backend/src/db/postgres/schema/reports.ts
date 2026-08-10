import { boolean, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * A report as delivered by an application, and its link to the case it joined.
 *
 * Both tables are tenant-owned. Note what the unique indexes are prefixed by:
 * `application_id` alone, never the pair. An application id is a globally unique
 * random public id, so prefixing by organization as well would add a column to
 * every index key and change nothing about what collides.
 */
export const reports = pgTable(
  'reports',
  {
    reportId: text('report_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    externalReportId: text('external_report_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),

    /**
     * The delivered envelope, verbatim.
     *
     * `jsonb` rather than a child table, and rather than columns: nothing queries
     * or filters on it — every read is by a scalar key — and the zod contract in
     * `@oxyhq/crowdsource-contracts` is the single authority on its shape.
     * Normalising it here would create a second, drifting description of a
     * structure this service deliberately does not interpret.
     */
    envelope: jsonb('envelope').notNull(),

    caseId: text('case_id').notNull(),
    contentHash: text('content_hash').notNull(),
    status: text('status').notNull().default('received'),
    receivedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * The two idempotency arbiters, and they are NAMED because the service tells
     * them apart.
     *
     * `report.service.ts` inserts, catches the duplicate-key failure, and reads
     * WHICH index collided to decide whether this was a replay of the same
     * delivery or a different report reusing an external id. On Mongo that came
     * off `error.keyPattern`; on Postgres the equivalent is the constraint name in
     * `23505`, so these names are part of the contract rather than decoration.
     */
    uniqueIndex('reports_application_external_key').on(
      table.applicationId,
      table.externalReportId,
    ),
    uniqueIndex('reports_application_idempotency_key').on(
      table.applicationId,
      table.idempotencyKey,
    ),
  ],
);

/**
 * The link between a report and the case it was merged into.
 *
 * Append-only: one insert on ingestion, one read per case. Nothing updates a row
 * here.
 */
export const caseReports = pgTable(
  'case_reports',
  {
    /**
     * No natural single-column key exists on Mongo — the row was identified by
     * `(applicationId, reportId)`, which is the unique below. A surrogate would
     * be a second identity nobody references, so the composite IS the key.
     */
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),
    caseId: text('case_id').notNull(),
    reportId: text('report_id').notNull(),
    externalReportId: text('external_report_id').notNull(),

    /**
     * Taxonomy codes, as `text[]`.
     *
     * Deliberately WITHOUT a CHECK against the taxonomy vocabulary. The Mongo
     * schema declared this as bare `[String]` with no enum, so the stored values
     * were never validated at the storage layer — adding a constraint here would
     * be a tightening the existing data has never been held to, and this port
     * changes storage rather than policy. It belongs on a backfill audit list,
     * not in this migration.
     */
    allegationCodes: text('allegation_codes').array().notNull().default([]),

    merged: boolean('merged').notNull().default(false),
    linkedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('case_reports_application_report_key').on(table.applicationId, table.reportId),
    index('case_reports_application_case_idx').on(table.applicationId, table.caseId),
  ],
);
