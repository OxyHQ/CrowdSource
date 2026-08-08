import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import {
  moderationReportColumns,
  moderationReportTableExtras,
} from '../../../postgres/reportColumns.js';
import { moderationTables } from '../../../postgres/tables.js';
import { TEST_ACTIONS } from '../backend.js';

/**
 * The fictional application's schema, in Postgres — the adopter's half.
 *
 * This is what an adopting application writes, and it is deliberately the ONLY
 * drizzle schema in this package: `drizzle.config.ts` points here, so the
 * migrations generated from it live under `src/__tests__/` and are never
 * published. A package that shipped its own migrations folder would interleave
 * its journal with the adopter's against one `drizzle.__drizzle_migrations`
 * table, and the loser is skipped in SILENCE with exit 0.
 *
 * `TEST_ACTIONS` comes from `support/backend.ts`, whose only runtime export it is
 * — every other import there is `import type`, so drizzle-kit loading this file
 * pulls in no pipeline code.
 */

/**
 * The application's own noun: a widget with a body, a status and a flag.
 *
 * `owner_id` is an id-shaped column with no foreign key, and it is the
 * ADOPTER's to classify — the schema test's ledger carries it alongside the
 * eight entries this package ships, which is exactly how the two fragments are
 * meant to compose.
 */
export const widgets = pgTable('widgets', {
  id: generatedId(),
  body: text('body').notNull(),
  ownerId: text('owner_id').notNull(),
  status: text('status').notNull().default('published'),
  flagged: boolean('flagged').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * The application's reportable types and categories, declared ONCE and passed to
 * both halves of the report table so the columns and their CHECKs cannot drift.
 */
export const REPORT_MODERATION = {
  reportedTypes: ['widget', 'gizmo', 'doodad'],
  categories: ['spam', 'harassment', 'other'],
} as const;

/**
 * The application's own report table.
 *
 * Named `moderation_reports` here; an adopter names it whatever it already calls
 * its reports. `legacy_status` is the verdict column an application had before it
 * adopted CrowdSource, which is what exercises the extra-fields escape hatch.
 */
export const reports = pgTable(
  'moderation_reports',
  {
    ...moderationReportColumns(REPORT_MODERATION),
    legacyStatus: text('legacy_status').notNull().default('pending'),
  },
  moderationReportTableExtras(REPORT_MODERATION),
);

/**
 * The three tables this package owns, built once.
 *
 * Exported individually as well, because drizzle-kit discovers a schema by
 * inspecting a module's exported VALUES for tables.
 */
export const moderation = moderationTables({ enforcementActions: TEST_ACTIONS });

export const moderationOutbox = moderation.outbox;
export const moderationEvents = moderation.events;
export const moderationEnforcements = moderation.enforcements;
