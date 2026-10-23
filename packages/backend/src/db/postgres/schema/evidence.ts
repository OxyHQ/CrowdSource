import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  boolean,
} from 'drizzle-orm/pg-core';

import { createdAt, inList, timestamptz, updatedAt } from '@oxy.so/db';

/**
 * The Oxy files a case's evidence is made of, and what CrowdSource knows about
 * each (oxy ADR 0043, `docs/architecture/evidence-files.md`).
 *
 * A case's material is its immutable `content_snapshot`; an image, video, audio
 * or document resource in it names its bytes by a bare Oxy file id. This table
 * is the one row per (case, file) that turns that id into three duties:
 *
 *  - **Oxy is told CrowdSource uses the file** (`file_references`, entity type
 *    `case`, entity id the case id), so an application-owned file is never
 *    garbage-collected from under a jury and its owning application cannot
 *    delete it while a case holds it. The row IS the durable work record: it
 *    commits in the report's own transaction, and the reference worker claims it.
 *  - **What Oxy says about the file is recorded** (`file_status`,
 *    `file_visibility`, from the verified file-events webhook), so a blocked,
 *    trashed, deleted or private file is withheld from the jury rather than left
 *    to fail in a reviewer's browser.
 *  - **The nightly reconciliation's inventory** is read from here.
 *
 * Tenant-stamped from the case inside the report's transaction, and read by the
 * reference worker, the file-events receiver and the reconciliation across every
 * tenant, and by the reviewer surface, whose caller carries no tenant
 * (`tableRegistry.ts`). It holds ids and Oxy's own status words; never content.
 */

/** What Oxy last said the file's status is. `unknown` is a status this code does not know: withheld. */
export const EVIDENCE_FILE_STATUSES = ['active', 'trash', 'blocked', 'deleted', 'unknown'] as const;
export type EvidenceFileStatus = (typeof EVIDENCE_FILE_STATUSES)[number];

export const EVIDENCE_FILE_VISIBILITIES = ['public', 'unlisted', 'private'] as const;
export type EvidenceFileVisibility = (typeof EVIDENCE_FILE_VISIBILITIES)[number];

/**
 * Where CrowdSource's reference to the file stands at Oxy.
 *
 * - `pending`: owed; the worker adds it.
 * - `registered`: Oxy holds it.
 * - `refused`: Oxy answered that CrowdSource may not reference this file (it is
 *   another application's private file, or not active). Withheld from the jury.
 * - `removal_pending`: the file is gone; the reference is owed a removal.
 * - `removed`: removed (or never held).
 */
export const EVIDENCE_REFERENCE_STATES = [
  'pending',
  'registered',
  'refused',
  'removal_pending',
  'removed',
] as const;
export type EvidenceReferenceState = (typeof EVIDENCE_REFERENCE_STATES)[number];

export const caseEvidenceFiles = pgTable(
  'case_evidence_files',
  {
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),
    caseId: text('case_id').notNull(),
    fileId: text('file_id').notNull(),

    fileStatus: text('file_status').$type<EvidenceFileStatus>().notNull(),
    fileVisibility: text('file_visibility').$type<EvidenceFileVisibility>(),
    /** `occurredAt` of the last file event applied; an older event changes nothing. */
    fileStateAt: timestamptz(),

    referenceState: text('reference_state').$type<EvidenceReferenceState>().notNull(),
    referenceAttempts: integer('reference_attempts').notNull(),
    /** When the worker may next claim the row; while claimed, when the claim lapses. */
    referenceDueAt: timestamptz().notNull(),
    /** The claim a worker holds; its result is written only while it still holds it. */
    referenceClaim: text('reference_claim'),
    /** A CLASS (an HTTP status or an error name), never a message. */
    referenceError: text('reference_error'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: 'case_evidence_files_pkey',
      columns: [table.caseId, table.fileId],
    }),
    index('case_evidence_files_file_id_idx').on(table.fileId),
    index('case_evidence_files_reference_due_idx')
      .on(table.referenceDueAt)
      .where(sql`${table.referenceState} in ('pending', 'removal_pending')`),
    check(
      'case_evidence_files_file_status_check',
      sql`${table.fileStatus} in (${sql.raw(inList(EVIDENCE_FILE_STATUSES))})`,
    ),
    check(
      'case_evidence_files_file_visibility_check',
      sql`${table.fileVisibility} is null or ${table.fileVisibility} in (${sql.raw(inList(EVIDENCE_FILE_VISIBILITIES))})`,
    ),
    check(
      'case_evidence_files_reference_state_check',
      sql`${table.referenceState} in (${sql.raw(inList(EVIDENCE_REFERENCE_STATES))})`,
    ),
    check('case_evidence_files_reference_attempts_check', sql`${table.referenceAttempts} >= 0`),
  ],
);

/**
 * Every file event Oxy has delivered, keyed on Oxy's event id.
 *
 * The dedupe ledger (delivery is at least once, and the same event reaches every
 * application that uses the file under one id) and the record of what each did:
 * which file, what Oxy said about it, and how many evidence rows it changed. It
 * commits in the same transaction as those changes, so a recorded event is an
 * applied one. Addressed to this SERVICE, not to any tenant.
 */
export const OXY_FILE_EVENT_TYPES = [
  'file.deleted',
  'file.visibility_changed',
  'file.trashed',
  'file.restored',
  'file.blocked',
  'file.unblocked',
  'file.lost',
] as const;
export type OxyFileEventType = (typeof OXY_FILE_EVENT_TYPES)[number];

export const oxyFileEvents = pgTable(
  'oxy_file_events',
  {
    eventId: text('event_id').primaryKey(),
    type: text('type').$type<OxyFileEventType>().notNull(),
    fileId: text('file_id').notNull(),
    occurredAt: timestamptz().notNull(),
    /** Oxy's words for the file after the change, as received. */
    fileStatus: text('file_status').notNull(),
    fileVisibility: text('file_visibility').notNull(),
    /** Evidence rows whose recorded state this event changed. */
    rowsChanged: integer('rows_changed').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('oxy_file_events_file_id_idx').on(table.fileId),
    check(
      'oxy_file_events_type_check',
      sql`${table.type} in (${sql.raw(inList(OXY_FILE_EVENT_TYPES))})`,
    ),
    check('oxy_file_events_rows_changed_check', sql`${table.rowsChanged} >= 0`),
  ],
);

/**
 * The nightly reconciliation of CrowdSource's references, one row per entity
 * type: who holds the run, when one last finished, and what it found.
 *
 * Every task runs the timer and there is no leader election in this service, so
 * the run is taken under a lease on this row, as the account-event feed is.
 */
export const oxyFileReconciliations = pgTable('oxy_file_reconciliations', {
  entityType: text('entity_type').primaryKey(),
  leaseOwner: text('lease_owner'),
  leaseUntil: timestamptz(),
  lastStartedAt: timestamptz(),
  lastCompletedAt: timestamptz(),
  lastDryRun: boolean('last_dry_run'),
  lastCounts: jsonb('last_counts').$type<Record<string, number>>(),
  /** A CLASS, never a message. */
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
