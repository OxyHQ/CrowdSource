import { asc, eq, inArray, or, sql } from 'drizzle-orm';

import { cases } from '../../schema/cases';
import {
  communityNoteAssignments,
  communityNoteRatings,
  communityNoteStatusRevisions,
  communityNotes,
} from '../../schema/communityNotes';
import { appeals } from '../../schema/decisions';
import { auditEvents } from '../../schema/governance';
import { reports } from '../../schema/reports';
import type { TenantScopedHandle } from '../../withTenant';

/**
 * Account erasure, the TENANT-scoped half (`docs/architecture/account-erasure.md`).
 *
 * Every statement runs inside `withTenant`, entered from the stored application
 * row, so row security holds exactly as it does for a request: one tenant's
 * rows at a time. Each statement matches by the person's id and leaves nothing
 * that still matches, which is what makes a re-run a no-op.
 */

export interface NoteErasureCounts {
  readonly notesDeleted: number;
  readonly noteRatingsDeleted: number;
  readonly noteAssignmentsDeleted: number;
  readonly noteRevisionsDeleted: number;
}

/**
 * The person's own notes go, with everything hanging off them: the ratings
 * others gave them, the assignments to rate them, and their status history. A
 * note is the writer's own words and nothing else in the system points at one.
 */
export async function deleteCommunityNotesByAuthor(
  db: TenantScopedHandle,
  authorPrincipalId: string,
): Promise<NoteErasureCounts> {
  const notes = await db
    .select({ noteId: communityNotes.noteId })
    .from(communityNotes)
    .where(eq(communityNotes.authorPrincipalId, authorPrincipalId));
  const noteIds = notes.map((note) => note.noteId);
  if (noteIds.length === 0) {
    return { notesDeleted: 0, noteRatingsDeleted: 0, noteAssignmentsDeleted: 0, noteRevisionsDeleted: 0 };
  }

  const ratings = await db
    .delete(communityNoteRatings)
    .where(inArray(communityNoteRatings.noteId, noteIds))
    .returning({ id: communityNoteRatings.ratingId });
  const assignments = await db
    .delete(communityNoteAssignments)
    .where(inArray(communityNoteAssignments.noteId, noteIds))
    .returning({ id: communityNoteAssignments.assignmentId });
  const revisions = await db
    .delete(communityNoteStatusRevisions)
    .where(inArray(communityNoteStatusRevisions.noteId, noteIds))
    .returning({ id: communityNoteStatusRevisions.revisionId });
  const deleted = await db
    .delete(communityNotes)
    .where(inArray(communityNotes.noteId, noteIds))
    .returning({ id: communityNotes.noteId });

  return {
    notesDeleted: deleted.length,
    noteRatingsDeleted: ratings.length,
    noteAssignmentsDeleted: assignments.length,
    noteRevisionsDeleted: revisions.length,
  };
}

/** The person's ratings of other people's notes, and their open rating seats. */
export async function deleteCommunityNoteRatingsByRater(
  db: TenantScopedHandle,
  raterPrincipalId: string,
): Promise<{ ratingsDeleted: number; assignmentsDeleted: number }> {
  const ratings = await db
    .delete(communityNoteRatings)
    .where(eq(communityNoteRatings.raterPrincipalId, raterPrincipalId))
    .returning({ id: communityNoteRatings.ratingId });
  const assignments = await db
    .delete(communityNoteAssignments)
    .where(eq(communityNoteAssignments.raterPrincipalId, raterPrincipalId))
    .returning({ id: communityNoteAssignments.assignmentId });
  return { ratingsDeleted: ratings.length, assignmentsDeleted: assignments.length };
}

/**
 * Notes OTHER people wrote about the person's material stay: they are those
 * people's words. The subject author's id only ever served one exclusion (an
 * author never rates a note on their own post), which a deleted account can no
 * longer trigger.
 */
export async function anonymiseCommunityNoteSubjectAuthor(
  db: TenantScopedHandle,
  principalId: string,
  erased: string,
): Promise<number> {
  const rows = await db
    .update(communityNotes)
    .set({ subjectAuthorPrincipalId: erased })
    .where(eq(communityNotes.subjectAuthorPrincipalId, principalId))
    .returning({ id: communityNotes.noteId });
  return rows.length;
}

/**
 * An appeal the person filed is a moderation record and stays, with the
 * appellant replaced and their own statement removed.
 */
export async function anonymiseAppellant(
  db: TenantScopedHandle,
  principalId: string,
  erased: string,
): Promise<number> {
  const rows = await db
    .update(appeals)
    .set({ appellantExternalPrincipalId: erased, authorContext: null })
    .where(eq(appeals.appellantExternalPrincipalId, principalId))
    .returning({ id: appeals.appealId });
  return rows.length;
}

/** The tenant's audit trail keeps the act and loses the actor. */
export async function anonymiseAuditActor(
  db: TenantScopedHandle,
  oxyUserId: string,
  erased: string,
): Promise<number> {
  const rows = await db
    .update(auditEvents)
    .set({ actorOxyUserId: erased })
    .where(eq(auditEvents.actorOxyUserId, oxyUserId))
    .returning({ id: auditEvents.auditId });
  return rows.length;
}

/** A binding in a stored envelope that names `principalId`, by either field. */
function bindingNames(principalId: string, field: 'externalPrincipalId' | 'bindingProofId') {
  return sql`${reports.envelope} -> 'principalBindings' @> jsonb_build_array(jsonb_build_object(${field}::text, ${principalId}::text))`;
}

/** Reports whose envelope still binds the person, a bounded page at a time. */
export async function findReportsNamingPrincipal(
  db: TenantScopedHandle,
  principalId: string,
  limit: number,
): Promise<{ reportId: string; envelope: unknown }[]> {
  return await db
    .select({ reportId: reports.reportId, envelope: reports.envelope })
    .from(reports)
    .where(or(bindingNames(principalId, 'externalPrincipalId'), bindingNames(principalId, 'bindingProofId')))
    .orderBy(asc(reports.reportId))
    .limit(limit);
}

export async function replaceReportEnvelope(
  db: TenantScopedHandle,
  reportId: string,
  envelope: unknown,
): Promise<void> {
  await db.update(reports).set({ envelope }).where(eq(reports.reportId, reportId));
}

/**
 * Cases whose stored snapshot names the person as a principal of the material,
 * or whose reporter set holds the person's fingerprint.
 */
export async function findCasesNamingPrincipal(
  db: TenantScopedHandle,
  principalId: string,
  reporterFingerprint: string,
  limit: number,
): Promise<{ caseId: string; contentSnapshot: unknown; reporterFingerprints: string[] }[]> {
  return await db
    .select({
      caseId: cases.caseId,
      contentSnapshot: cases.contentSnapshot,
      reporterFingerprints: cases.reporterFingerprints,
    })
    .from(cases)
    .where(
      or(
        sql`${cases.contentSnapshot} -> 'principals' @> jsonb_build_array(jsonb_build_object('externalPrincipalId', ${principalId}::text))`,
        sql`${reporterFingerprint} = any(${cases.reporterFingerprints})`,
      ),
    )
    .orderBy(asc(cases.caseId))
    .limit(limit);
}

export async function replaceCaseIdentity(
  db: TenantScopedHandle,
  caseId: string,
  contentSnapshot: unknown,
  reporterFingerprints: string[],
): Promise<void> {
  await db
    .update(cases)
    .set({ contentSnapshot, reporterFingerprints })
    .where(eq(cases.caseId, caseId));
}
