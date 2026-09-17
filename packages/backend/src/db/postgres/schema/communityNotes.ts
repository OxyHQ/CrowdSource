import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { createdAt, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { COMMUNITY_NOTE_RATINGS, COMMUNITY_NOTE_STATUSES } from '@oxy.so/crowdsource-contracts';

/**
 * Community notes (the community notes ADR): the note, the ratings it receives, the assignments
 * that are the only way to rate one, and the append-only record of every status
 * the scorer gave it.
 *
 * All four are tenant-owned and RLS-scoped like a case. A note is written by an
 * application's user about an application's subject, and nothing about it is
 * meaningful to another tenant — including the model that scores it, which is
 * fitted per tenant over that tenant's ratings alone.
 *
 * Principal ids are the application's own opaque ids. They are stored because
 * exclusion (a writer never rates their note, a subject's author never rates a
 * note on it), per-writer caps and "your notes" all need them; they are never
 * returned on a note, never written to an audit row and never logged.
 */
export const communityNotes = pgTable(
  'community_notes',
  {
    noteId: text('note_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    externalSubjectId: text('external_subject_id').notNull(),
    subjectAuthorPrincipalId: text('subject_author_principal_id').notNull(),
    authorPrincipalId: text('author_principal_id').notNull(),
    language: text('language').notNull(),
    /** Shown to every reader of the subject. Never logged, never in an audit row. */
    text: text('text').notNull(),
    sourceUrls: jsonb('source_urls').$type<string[]>().notNull(),

    /**
     * The CURRENT status, a denormalised read of the latest revision.
     *
     * Kept on the row because every read path filters on it — the public lookup,
     * the assignment draw — and a lateral join to the newest revision on each of
     * those would be the slow half of a feed page. It is written only together
     * with a new revision, under a compare-and-swap on `statusRevision`, so the
     * two cannot disagree about which revision is current.
     */
    status: text('status').notNull(),
    statusRevision: integer('status_revision').notNull(),
    statusChangedAt: timestamptz().notNull(),

    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    writtenByCredentialId: text('written_by_credential_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** A retry returns the note it wrote. */
    uniqueIndex('community_notes_application_idempotency_key').on(
      table.applicationId,
      table.idempotencyKey,
    ),
    /**
     * One note per writer per subject. A second note by the same person is an
     * edit in disguise, and a note is not editable: a rater rated the words that
     * are there, and changing them after the fact would carry those ratings over
     * to text nobody rated.
     */
    uniqueIndex('community_notes_application_subject_author_key').on(
      table.applicationId,
      table.externalSubjectId,
      table.authorPrincipalId,
    ),
    index('community_notes_application_subject_status_idx').on(
      table.applicationId,
      table.externalSubjectId,
      table.status,
    ),
    index('community_notes_application_author_created_idx').on(
      table.applicationId,
      table.authorPrincipalId,
      table.createdAt,
    ),
    index('community_notes_application_status_language_idx').on(
      table.applicationId,
      table.status,
      table.language,
    ),
    check(
      'community_notes_status_check',
      sql`${table.status} in (${sql.raw(inList(COMMUNITY_NOTE_STATUSES))})`,
    ),
  ],
);

/**
 * One rating: final, one per rater per note, and only ever written against an
 * assignment the server issued (`assignmentId`).
 */
export const communityNoteRatings = pgTable(
  'community_note_ratings',
  {
    ratingId: text('rating_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    noteId: text('note_id').notNull(),
    assignmentId: text('assignment_id').notNull(),
    raterPrincipalId: text('rater_principal_id').notNull(),
    rating: text('rating').notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull(),

    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    ratedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('community_note_ratings_application_idempotency_key').on(
      table.applicationId,
      table.idempotencyKey,
    ),
    /** A rating is final: a second one by the same rater is refused, never merged. */
    uniqueIndex('community_note_ratings_application_note_rater_key').on(
      table.applicationId,
      table.noteId,
      table.raterPrincipalId,
    ),
    index('community_note_ratings_application_rater_rated_idx').on(
      table.applicationId,
      table.raterPrincipalId,
      table.ratedAt,
    ),
    check(
      'community_note_ratings_rating_check',
      sql`${table.rating} in (${sql.raw(inList(COMMUNITY_NOTE_RATINGS))})`,
    ),
  ],
);

/**
 * A note handed to one rater to rate — the ONLY door to a rating.
 *
 * One row per (note, rater), reissued in place once it has expired unrated, so
 * a rater who let a note lapse can be handed it again but can never hold two
 * live assignments for it.
 */
export const communityNoteAssignments = pgTable(
  'community_note_assignments',
  {
    assignmentId: text('assignment_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    noteId: text('note_id').notNull(),
    raterPrincipalId: text('rater_principal_id').notNull(),
    /** The Idempotency-Key of the request that issued (or last reissued) it. */
    issuanceKey: text('issuance_key').notNull(),
    issuedAt: timestamptz().notNull(),
    expiresAt: timestamptz().notNull(),
    ratedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('community_note_assignments_application_note_rater_key').on(
      table.applicationId,
      table.noteId,
      table.raterPrincipalId,
    ),
    index('community_note_assignments_application_issuance_idx').on(
      table.applicationId,
      table.raterPrincipalId,
      table.issuanceKey,
    ),
  ],
);

/**
 * Every status the scorer ever gave a note — append-only.
 *
 * A status is recorded with the algorithm version and the fitted parameters it
 * came from, so any past "shown" can be explained ("this intercept, this factor,
 * under this version") and recomputed. Nothing updates a row here: a new status
 * is a new revision, the same rule a decision follows.
 */
export const communityNoteStatusRevisions = pgTable(
  'community_note_status_revisions',
  {
    revisionId: text('revision_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    noteId: text('note_id').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    /** `null` for the revisions the scorer did not produce: creation and withdrawal. */
    algorithmVersion: text('algorithm_version'),
    noteIntercept: doublePrecision('note_intercept'),
    noteFactor: doublePrecision('note_factor'),
    ratingCount: integer('rating_count').notNull(),
    recordedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('community_note_status_revisions_application_note_revision_key').on(
      table.applicationId,
      table.noteId,
      table.revision,
    ),
    check(
      'community_note_status_revisions_status_check',
      sql`${table.status} in (${sql.raw(inList(COMMUNITY_NOTE_STATUSES))})`,
    ),
  ],
);
