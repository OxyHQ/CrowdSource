import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm';

import {
  communityNoteAssignments,
  communityNoteRatings,
  communityNoteStatusRevisions,
  communityNotes,
} from '../../schema/communityNotes';
import type { TenantScopedHandle } from '../../withTenant';

/**
 * Community notes (the community notes ADR), as a TENANT-SCOPED repository.
 *
 * Every function takes the branded `TenantScopedHandle`, and no query below
 * carries a tenant predicate: `tenant_isolation` decides visibility, exactly as
 * in `cases.ts`. Adding an `application_id` term here would be a second authority
 * that could disagree with the policy.
 */

export type CommunityNoteRow = typeof communityNotes.$inferSelect;
export type CommunityNoteRatingRow = typeof communityNoteRatings.$inferSelect;
export type CommunityNoteAssignmentRow = typeof communityNoteAssignments.$inferSelect;
export type NewCommunityNote = typeof communityNotes.$inferInsert;
export type NewCommunityNoteRating = typeof communityNoteRatings.$inferInsert;
export type NewCommunityNoteRevision = typeof communityNoteStatusRevisions.$inferInsert;

export async function insertCommunityNote(db: TenantScopedHandle, note: NewCommunityNote): Promise<void> {
  await db.insert(communityNotes).values(note);
}

export async function findCommunityNoteById(db: TenantScopedHandle, noteId: string) {
  const [row] = await db.select().from(communityNotes).where(eq(communityNotes.noteId, noteId)).limit(1);
  return row ?? null;
}

export async function findCommunityNoteByIdempotencyKey(db: TenantScopedHandle, idempotencyKey: string) {
  const [row] = await db
    .select()
    .from(communityNotes)
    .where(eq(communityNotes.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

/** Notes one writer wrote since `since` — the per-writer daily cap. */
export async function countCommunityNotesByAuthorSince(
  db: TenantScopedHandle,
  authorPrincipalId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(communityNotes)
    .where(and(eq(communityNotes.authorPrincipalId, authorPrincipalId), gte(communityNotes.createdAt, since)));
  // An aggregate always answers one row; summing keeps that fact out of a branch.
  return rows.reduce((sum, row) => sum + row.total, 0);
}

/** A writer's own notes, newest first. */
export async function findCommunityNotesByAuthor(db: TenantScopedHandle, authorPrincipalId: string, limit: number) {
  return await db
    .select()
    .from(communityNotes)
    .where(eq(communityNotes.authorPrincipalId, authorPrincipalId))
    .orderBy(desc(communityNotes.createdAt), desc(communityNotes.noteId))
    .limit(limit);
}

/**
 * The shown note for each subject asked about.
 *
 * At most one per subject: if the scorer shows two notes on one subject, the one
 * shown FIRST keeps its place, so a reader does not watch the note under a post
 * swap every time ratings move.
 */
export async function findShownCommunityNotes(db: TenantScopedHandle, externalSubjectIds: readonly string[]) {
  if (externalSubjectIds.length === 0) return [];
  const rows = await db
    .select()
    .from(communityNotes)
    .where(and(inArray(communityNotes.externalSubjectId, [...externalSubjectIds]), eq(communityNotes.status, 'shown')))
    .orderBy(asc(communityNotes.externalSubjectId), asc(communityNotes.statusChangedAt), asc(communityNotes.noteId));

  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.externalSubjectId)) return false;
    seen.add(row.externalSubjectId);
    return true;
  });
}

/**
 * Draws up to `limit` notes for one rater to rate.
 *
 * Eligible: still `needs_ratings`, in one of the rater's languages (matched on
 * the primary subtag, so `es` is handed `es-ES`), not written by the rater, not
 * about a subject the rater authored, not already rated by them, and not already
 * held by them under a live assignment. `random()` is the draw: nobody chooses
 * the note they rate, and nothing about the order is predictable from outside.
 */
export async function drawCommunityNotesToRate(
  db: TenantScopedHandle,
  raterPrincipalId: string,
  primaryLanguages: readonly string[],
  limit: number,
  now: Date,
) {
  return await db
    .select()
    .from(communityNotes)
    .where(
      and(
        eq(communityNotes.status, 'needs_ratings'),
        inArray(sql`split_part(${communityNotes.language}, '-', 1)`, [...primaryLanguages]),
        ne(communityNotes.authorPrincipalId, raterPrincipalId),
        ne(communityNotes.subjectAuthorPrincipalId, raterPrincipalId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(communityNoteRatings)
            .where(
              and(
                eq(communityNoteRatings.noteId, communityNotes.noteId),
                eq(communityNoteRatings.raterPrincipalId, raterPrincipalId),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(communityNoteAssignments)
            .where(
              and(
                eq(communityNoteAssignments.noteId, communityNotes.noteId),
                eq(communityNoteAssignments.raterPrincipalId, raterPrincipalId),
                or(
                  sql`${communityNoteAssignments.ratedAt} is not null`,
                  gte(communityNoteAssignments.expiresAt, now),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(sql`random()`)
    .limit(limit);
}

/**
 * Issues an assignment, or reissues an expired unrated one in place.
 *
 * Returns the row only when THIS call issued it. A live or already-rated
 * assignment for the same (note, rater) is left alone and answers `null`, which is
 * what a concurrent second request for the same rater should see.
 */
export async function issueCommunityNoteAssignment(
  db: TenantScopedHandle,
  assignment: typeof communityNoteAssignments.$inferInsert,
) {
  const [row] = await db
    .insert(communityNoteAssignments)
    .values(assignment)
    .onConflictDoUpdate({
      target: [
        communityNoteAssignments.applicationId,
        communityNoteAssignments.noteId,
        communityNoteAssignments.raterPrincipalId,
      ],
      set: {
        assignmentId: assignment.assignmentId,
        issuanceKey: assignment.issuanceKey,
        issuedAt: assignment.issuedAt,
        expiresAt: assignment.expiresAt,
        updatedAt: assignment.issuedAt,
      },
      setWhere: and(isNull(communityNoteAssignments.ratedAt), lt(communityNoteAssignments.expiresAt, assignment.issuedAt)),
    })
    .returning();
  return row ?? null;
}

/** The live assignments one request issued — the replay of an assignment request. */
export async function findAssignmentsByIssuance(
  db: TenantScopedHandle,
  raterPrincipalId: string,
  issuanceKey: string,
) {
  return await db
    .select({ assignment: communityNoteAssignments, note: communityNotes })
    .from(communityNoteAssignments)
    .innerJoin(communityNotes, eq(communityNotes.noteId, communityNoteAssignments.noteId))
    .where(
      and(
        eq(communityNoteAssignments.raterPrincipalId, raterPrincipalId),
        eq(communityNoteAssignments.issuanceKey, issuanceKey),
      ),
    )
    .orderBy(asc(communityNoteAssignments.issuedAt), asc(communityNoteAssignments.assignmentId));
}

export async function findAssignmentForRater(db: TenantScopedHandle, noteId: string, raterPrincipalId: string) {
  const [row] = await db
    .select()
    .from(communityNoteAssignments)
    .where(
      and(eq(communityNoteAssignments.noteId, noteId), eq(communityNoteAssignments.raterPrincipalId, raterPrincipalId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Marks an assignment rated. A compare-and-swap: it wins only on an assignment
 * that is still unrated and unexpired, so the returned count is "did this rating
 * get to use the assignment".
 */
export async function consumeCommunityNoteAssignment(
  db: TenantScopedHandle,
  assignmentId: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .update(communityNoteAssignments)
    .set({ ratedAt: now, updatedAt: now })
    .where(
      and(
        eq(communityNoteAssignments.assignmentId, assignmentId),
        isNull(communityNoteAssignments.ratedAt),
        gte(communityNoteAssignments.expiresAt, now),
      ),
    )
    .returning({ assignmentId: communityNoteAssignments.assignmentId });
  return rows.length;
}

export async function insertCommunityNoteRating(db: TenantScopedHandle, rating: NewCommunityNoteRating): Promise<void> {
  await db.insert(communityNoteRatings).values(rating);
}

export async function findCommunityNoteRatingByIdempotencyKey(db: TenantScopedHandle, idempotencyKey: string) {
  const [row] = await db
    .select()
    .from(communityNoteRatings)
    .where(eq(communityNoteRatings.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

/** A rater's own ratings with the notes they rated, newest first. */
export async function findCommunityNoteRatingsByRater(db: TenantScopedHandle, raterPrincipalId: string, limit: number) {
  return await db
    .select({ rating: communityNoteRatings, note: communityNotes })
    .from(communityNoteRatings)
    .innerJoin(communityNotes, eq(communityNotes.noteId, communityNoteRatings.noteId))
    .where(eq(communityNoteRatings.raterPrincipalId, raterPrincipalId))
    .orderBy(desc(communityNoteRatings.ratedAt), desc(communityNoteRatings.ratingId))
    .limit(limit);
}

/** Every rating on a note that is not withdrawn — the scorer's input for one tenant. */
export async function findRatingsForScoring(db: TenantScopedHandle) {
  return await db
    .select({
      noteId: communityNoteRatings.noteId,
      raterPrincipalId: communityNoteRatings.raterPrincipalId,
      rating: communityNoteRatings.rating,
    })
    .from(communityNoteRatings)
    .innerJoin(communityNotes, eq(communityNotes.noteId, communityNoteRatings.noteId))
    .where(ne(communityNotes.status, 'withdrawn'));
}

/** Current status of the given notes, for the scorer to diff against. */
export async function findCommunityNoteStatuses(db: TenantScopedHandle, noteIds: readonly string[]) {
  if (noteIds.length === 0) return [];
  return await db
    .select({
      noteId: communityNotes.noteId,
      status: communityNotes.status,
      statusRevision: communityNotes.statusRevision,
    })
    .from(communityNotes)
    .where(inArray(communityNotes.noteId, [...noteIds]));
}

/**
 * Moves a note to a new status under a compare-and-swap on its revision, and
 * appends the revision that records why.
 *
 * Returns false when the note moved since it was read — another rescore or a
 * withdrawal won — and then writes nothing: the revision row is only inserted by
 * the caller that won the swap, so the history never holds a status the note
 * never had.
 */
export async function transitionCommunityNoteStatus(
  db: TenantScopedHandle,
  noteId: string,
  fromRevision: number,
  revision: NewCommunityNoteRevision,
): Promise<boolean> {
  const moved = await db
    .update(communityNotes)
    .set({
      status: revision.status,
      statusRevision: revision.revision,
      statusChangedAt: revision.recordedAt,
      updatedAt: revision.recordedAt,
    })
    .where(
      and(
        eq(communityNotes.noteId, noteId),
        eq(communityNotes.statusRevision, fromRevision),
        ne(communityNotes.status, 'withdrawn'),
      ),
    )
    .returning({ noteId: communityNotes.noteId });

  if (moved.length === 0) return false;
  await db.insert(communityNoteStatusRevisions).values(revision);
  return true;
}

export async function insertCommunityNoteRevision(
  db: TenantScopedHandle,
  revision: NewCommunityNoteRevision,
): Promise<void> {
  await db.insert(communityNoteStatusRevisions).values(revision);
}

export async function findCommunityNoteRevisions(db: TenantScopedHandle, noteId: string) {
  return await db
    .select()
    .from(communityNoteStatusRevisions)
    .where(eq(communityNoteStatusRevisions.noteId, noteId))
    .orderBy(asc(communityNoteStatusRevisions.revision));
}
