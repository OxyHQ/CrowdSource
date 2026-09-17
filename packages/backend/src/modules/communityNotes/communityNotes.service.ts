import type {
  CommunityNote,
  CommunityNoteAssignment,
  CommunityNoteAssignmentRequest,
  CommunityNoteRating,
  CommunityNoteRatingSubmission,
  CommunityNoteStatus,
  CommunityNoteSubmission,
} from '@oxy.so/crowdsource-contracts';
import {
  CommunityNoteAssignmentRequestSchema,
  CommunityNoteSubmissionSchema,
} from '@oxy.so/crowdsource-contracts';

import {
  consumeCommunityNoteAssignment,
  countCommunityNotesByAuthorSince,
  drawCommunityNotesToRate,
  findAssignmentForRater,
  findAssignmentsByIssuance,
  findCommunityNoteById,
  findCommunityNoteByIdempotencyKey,
  findCommunityNoteRatingByIdempotencyKey,
  findCommunityNoteRatingsByRater,
  findCommunityNoteRevisions,
  findCommunityNoteStatuses,
  findCommunityNotesByAuthor,
  findRatingsForScoring,
  findShownCommunityNotes,
  insertCommunityNote,
  insertCommunityNoteRating,
  insertCommunityNoteRevision,
  issueCommunityNoteAssignment,
  transitionCommunityNoteStatus,
  type CommunityNoteRatingRow,
  type CommunityNoteRow,
} from '../../db/postgres/repositories/scoped/communityNotes';
import { withTenantTransaction } from '../../db/postgres/withTenant';
import type { TenantContext } from '../../db/tenantScope';
import { duplicateKeyViolation, withTransaction } from '../../db/transaction';
import { ApiError } from '../../http/apiError';
import { canonicalHash } from '../../utils/canonicalJson';
import { newPublicId } from '../../utils/identifiers';
import { logger } from '../../utils/logger';
import { appendAuditEvent } from '../audit/audit.collection';
import { appendOutboxEvent, OUTBOX_EVENT_TYPES } from '../outbox/outbox.collection';
import { SCORING_ALGORITHM_VERSION, scoreNotes, type ScoringRating } from './scoring';

/**
 * Community notes (the community notes ADR): writing, withdrawing, drawing notes to rate, rating,
 * the reads an application needs, and the rescore a rating triggers.
 *
 * Nothing here opens a case, feeds a decision or produces a reputation effect —
 * notes are a separate mechanism from moderation, and the only modules this one
 * touches are the outbox and the audit trail.
 */

/** Notes one writer may write per rolling day. A cap on noise, not on speech. */
export const NOTES_PER_AUTHOR_PER_DAY = 5;
/** How long a rater holds an assignment before it may be drawn for them again. */
export const ASSIGNMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** How many of a principal's own notes or ratings a list returns. */
export const OWN_LIST_LIMIT = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WriteContext {
  readonly idempotencyKey: string;
  readonly credentialId: string;
}

/** The DTO every reader receives: no principal, no count, no score. */
export function communityNoteView(row: CommunityNoteRow): CommunityNote {
  return {
    id: row.noteId,
    externalSubjectId: row.externalSubjectId,
    language: row.language,
    text: row.text,
    sourceUrls: row.sourceUrls,
    status: row.status as CommunityNoteStatus,
    createdAt: row.createdAt.toISOString(),
    statusChangedAt: row.statusChangedAt.toISOString(),
  };
}

export function communityNoteRatingView(row: CommunityNoteRatingRow): CommunityNoteRating {
  return {
    id: row.ratingId,
    noteId: row.noteId,
    rating: row.rating as CommunityNoteRating['rating'],
    reasons: row.reasons as CommunityNoteRating['reasons'],
    ratedAt: row.ratedAt.toISOString(),
  };
}

function replayOrConflict<T extends { payloadHash: string }>(existing: T, payloadHash: string, key: string, what: string): T {
  if (existing.payloadHash !== payloadHash) {
    throw new ApiError('conflict', `Idempotency-Key '${key}' was already used for a different ${what}.`);
  }
  return existing;
}

// ── Writing ──────────────────────────────────────────────────────────────────

export async function writeCommunityNote(
  context: TenantContext,
  submission: CommunityNoteSubmission,
  write: WriteContext,
  now: Date = new Date(),
): Promise<{ note: CommunityNoteRow; replayed: boolean }> {
  const parsed = CommunityNoteSubmissionSchema.parse(submission);
  const payloadHash = canonicalHash(parsed);

  /** A retry is recognised before the cap is judged, or a retry of the fifth note would be refused. */
  const replay = await withTransaction((session) =>
    withTenantTransaction(session, context, (tx) => findCommunityNoteByIdempotencyKey(tx, write.idempotencyKey)),
  );
  if (replay) {
    return { note: replayOrConflict(replay, payloadHash, write.idempotencyKey, 'note'), replayed: true };
  }

  const noteId = newPublicId('communityNote');
  try {
    const note = await withTransaction(async (session) => {
      const row = await withTenantTransaction(session, context, async (tx) => {
        const written = await countCommunityNotesByAuthorSince(tx, parsed.authorPrincipalId, new Date(now.getTime() - DAY_MS));
        if (written >= NOTES_PER_AUTHOR_PER_DAY) {
          throw new ApiError('rate_limited', 'This writer has reached the daily limit of community notes.');
        }
        const next = {
          noteId,
          organizationId: context.organizationId,
          applicationId: context.applicationId,
          externalSubjectId: parsed.externalSubjectId,
          subjectAuthorPrincipalId: parsed.subjectAuthorPrincipalId,
          authorPrincipalId: parsed.authorPrincipalId,
          language: parsed.language,
          text: parsed.text,
          sourceUrls: parsed.sourceUrls,
          status: 'needs_ratings',
          statusRevision: 1,
          statusChangedAt: now,
          idempotencyKey: write.idempotencyKey,
          payloadHash,
          writtenByCredentialId: write.credentialId,
          createdAt: now,
          updatedAt: now,
        } satisfies CommunityNoteRow;
        await insertCommunityNote(tx, next);
        await insertCommunityNoteRevision(tx, {
          revisionId: newPublicId('communityNoteRevision'),
          organizationId: context.organizationId,
          applicationId: context.applicationId,
          noteId,
          revision: 1,
          status: 'needs_ratings',
          algorithmVersion: null,
          noteIntercept: null,
          noteFactor: null,
          ratingCount: 0,
          recordedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        return next;
      });
      await appendAuditEvent(
        context,
        { action: 'community_note.written', actorCredentialId: write.credentialId, subjectId: noteId },
        session,
      );
      return row;
    });
    return { note, replayed: false };
  } catch (error: unknown) {
    const violation = duplicateKeyViolation(error);
    if (!violation) throw error;
    const fields = new Set(violation.indexFields);
    if (fields.has('idempotencyKey')) {
      const existing = await withTransaction((session) =>
        withTenantTransaction(session, context, (tx) => findCommunityNoteByIdempotencyKey(tx, write.idempotencyKey)),
      );
      if (existing) {
        return { note: replayOrConflict(existing, payloadHash, write.idempotencyKey, 'note'), replayed: true };
      }
      throw new ApiError('service_unavailable', 'The note could not be stored. Retry it.');
    }
    // The only other unique index on a note is one writer per subject.
    throw new ApiError('conflict', 'This writer already has a note on this subject. A note cannot be rewritten.');
  }
}

export async function withdrawCommunityNote(
  context: TenantContext,
  noteId: string,
  authorPrincipalId: string,
  credentialId: string,
  now: Date = new Date(),
): Promise<CommunityNoteRow> {
  return await withTransaction(async (session) => {
    const withdrawn = await withTenantTransaction(session, context, async (tx) => {
      const note = await findCommunityNoteById(tx, noteId);
      /** Someone else's note answers like a missing one: authorship is not disclosed. */
      if (!note || note.authorPrincipalId !== authorPrincipalId) {
        throw new ApiError('not_found', 'No such community note.');
      }
      if (note.status === 'withdrawn') return { note, changed: false };

      const revision = note.statusRevision + 1;
      const moved = await transitionCommunityNoteStatus(tx, noteId, note.statusRevision, {
        revisionId: newPublicId('communityNoteRevision'),
        organizationId: context.organizationId,
        applicationId: context.applicationId,
        noteId,
        revision,
        status: 'withdrawn',
        algorithmVersion: null,
        noteIntercept: null,
        noteFactor: null,
        ratingCount: 0,
        recordedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (!moved) {
        throw new ApiError('conflict', 'The note changed while it was being withdrawn. Retry it.');
      }
      return {
        note: { ...note, status: 'withdrawn', statusRevision: revision, statusChangedAt: now, updatedAt: now },
        changed: true,
      };
    });

    if (withdrawn.changed) {
      await appendOutboxEvent(context, session, {
        type: OUTBOX_EVENT_TYPES.communityNoteStatusChanged,
        payload: { communityNoteId: noteId, communityNoteRevision: withdrawn.note.statusRevision },
      });
      await appendAuditEvent(
        context,
        { action: 'community_note.withdrawn', actorCredentialId: credentialId, subjectId: noteId },
        session,
      );
    }
    return withdrawn.note;
  });
}

// ── Rating ───────────────────────────────────────────────────────────────────

export async function issueCommunityNoteAssignments(
  context: TenantContext,
  request: CommunityNoteAssignmentRequest,
  write: WriteContext,
  now: Date = new Date(),
): Promise<CommunityNoteAssignment[]> {
  const parsed = CommunityNoteAssignmentRequestSchema.parse(request);
  const primaryLanguages = [...new Set(parsed.languages.map((tag) => tag.split('-')[0] as string))];

  return await withTransaction(async (session) => {
    const issued = await withTenantTransaction(session, context, async (tx) => {
      /**
       * A replay of the same request returns what it issued, rather than a second
       * draw: a retried request that drew again would hand one rater twice the
       * batch they asked for.
       */
      const previous = await findAssignmentsByIssuance(tx, parsed.raterPrincipalId, write.idempotencyKey);
      if (previous.length > 0) return { rows: previous, replayed: true };

      const candidates = await drawCommunityNotesToRate(tx, parsed.raterPrincipalId, primaryLanguages, parsed.limit, now);
      const rows = [];
      for (const note of candidates) {
        const assignment = await issueCommunityNoteAssignment(tx, {
          assignmentId: newPublicId('communityNoteAssignment'),
          organizationId: context.organizationId,
          applicationId: context.applicationId,
          noteId: note.noteId,
          raterPrincipalId: parsed.raterPrincipalId,
          issuanceKey: write.idempotencyKey,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + ASSIGNMENT_TTL_MS),
          ratedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        if (assignment) rows.push({ assignment, note });
      }
      return { rows, replayed: false };
    });

    if (!issued.replayed) {
      await appendAuditEvent(
        context,
        { action: 'community_note.assignments.issued', actorCredentialId: write.credentialId },
        session,
      );
    }
    return issued.rows.map(({ assignment, note }) => ({
      id: assignment.assignmentId,
      note: communityNoteView(note),
      expiresAt: assignment.expiresAt.toISOString(),
    }));
  });
}

export async function rateCommunityNote(
  context: TenantContext,
  noteId: string,
  submission: CommunityNoteRatingSubmission,
  write: WriteContext,
  now: Date = new Date(),
): Promise<{ rating: CommunityNoteRatingRow; replayed: boolean }> {
  const payloadHash = canonicalHash({ noteId, submission });

  const replay = await withTransaction((session) =>
    withTenantTransaction(session, context, (tx) => findCommunityNoteRatingByIdempotencyKey(tx, write.idempotencyKey)),
  );
  if (replay) {
    return { rating: replayOrConflict(replay, payloadHash, write.idempotencyKey, 'rating'), replayed: true };
  }

  try {
    const rating = await withTransaction(async (session) => {
      const row = await withTenantTransaction(session, context, async (tx) => {
        const note = await findCommunityNoteById(tx, noteId);
        if (!note) throw new ApiError('not_found', 'No such community note.');

        /**
         * No assignment, no rating — whatever the note's status. Reading a note
         * under a post, or being told its id by someone, grants nothing.
         */
        const assignment = await findAssignmentForRater(tx, noteId, submission.raterPrincipalId);
        if (!assignment) {
          throw new ApiError('forbidden', 'This note was not assigned to this rater.');
        }
        if (note.status === 'withdrawn') {
          throw new ApiError('conflict', 'This note was withdrawn by its writer.');
        }
        const consumed = await consumeCommunityNoteAssignment(tx, assignment.assignmentId, now);
        if (consumed === 0) {
          throw new ApiError(
            'conflict',
            assignment.ratedAt ? 'This rater already rated this note.' : 'The assignment expired. Draw notes to rate again.',
          );
        }

        const next = {
          ratingId: newPublicId('communityNoteRating'),
          organizationId: context.organizationId,
          applicationId: context.applicationId,
          noteId,
          assignmentId: assignment.assignmentId,
          raterPrincipalId: submission.raterPrincipalId,
          rating: submission.rating,
          reasons: [...new Set<string>(submission.reasons)],
          idempotencyKey: write.idempotencyKey,
          payloadHash,
          ratedAt: now,
          createdAt: now,
          updatedAt: now,
        } satisfies CommunityNoteRatingRow;
        await insertCommunityNoteRating(tx, next);
        return next;
      });

      await appendOutboxEvent(context, session, {
        type: OUTBOX_EVENT_TYPES.communityNoteRated,
        payload: { communityNoteId: noteId },
      });
      await appendAuditEvent(
        context,
        { action: 'community_note.rated', actorCredentialId: write.credentialId, subjectId: noteId },
        session,
      );
      return row;
    });
    return { rating, replayed: false };
  } catch (error: unknown) {
    const violation = duplicateKeyViolation(error);
    if (!violation) throw error;
    const fields = new Set(violation.indexFields);
    if (fields.has('idempotencyKey')) {
      const existing = await withTransaction((session) =>
        withTenantTransaction(session, context, (tx) => findCommunityNoteRatingByIdempotencyKey(tx, write.idempotencyKey)),
      );
      if (existing) {
        return { rating: replayOrConflict(existing, payloadHash, write.idempotencyKey, 'rating'), replayed: true };
      }
      throw new ApiError('service_unavailable', 'The rating could not be stored. Retry it.');
    }
    // The only other unique index on a rating is one per rater per note.
    throw new ApiError('conflict', 'This rater already rated this note.');
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function shownCommunityNotes(context: TenantContext, externalSubjectIds: readonly string[]) {
  const rows = await withTransaction((session) =>
    withTenantTransaction(session, context, (tx) => findShownCommunityNotes(tx, externalSubjectIds)),
  );
  return rows.map(communityNoteView);
}

export async function communityNotesWrittenBy(context: TenantContext, authorPrincipalId: string) {
  const rows = await withTransaction((session) =>
    withTenantTransaction(session, context, (tx) => findCommunityNotesByAuthor(tx, authorPrincipalId, OWN_LIST_LIMIT)),
  );
  return rows.map(communityNoteView);
}

export async function communityNoteRatingsBy(context: TenantContext, raterPrincipalId: string) {
  const rows = await withTransaction((session) =>
    withTenantTransaction(session, context, (tx) => findCommunityNoteRatingsByRater(tx, raterPrincipalId, OWN_LIST_LIMIT)),
  );
  return rows.map(({ rating, note }) => ({ rating: communityNoteRatingView(rating), note: communityNoteView(note) }));
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Refits the tenant's notes and records every status that changed.
 *
 * Replay-safe: an unchanged status writes nothing, and each change is a
 * compare-and-swap on the note's revision, so two rescores racing over the same
 * ratings cannot both record a transition. Every recorded change emits
 * `community_note.status_changed` in the same transaction as its revision.
 */
export async function rescoreCommunityNotes(context: TenantContext, now: Date = new Date()): Promise<number> {
  return await withTransaction(async (session) => {
    const changed = await withTenantTransaction(session, context, async (tx) => {
      const ratings = await findRatingsForScoring(tx);
      const scores = scoreNotes(ratings as ScoringRating[]);
      const current = new Map(
        (await findCommunityNoteStatuses(tx, scores.map((score) => score.noteId))).map((row) => [row.noteId, row]),
      );

      const moved: { noteId: string; revision: number }[] = [];
      for (const score of scores) {
        const note = current.get(score.noteId);
        if (!note || note.status === 'withdrawn' || note.status === score.status) continue;
        const revision = note.statusRevision + 1;
        const won = await transitionCommunityNoteStatus(tx, score.noteId, note.statusRevision, {
          revisionId: newPublicId('communityNoteRevision'),
          organizationId: context.organizationId,
          applicationId: context.applicationId,
          noteId: score.noteId,
          revision,
          status: score.status,
          algorithmVersion: SCORING_ALGORITHM_VERSION,
          noteIntercept: score.intercept,
          noteFactor: score.factor,
          ratingCount: score.ratingCount,
          recordedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        if (won) moved.push({ noteId: score.noteId, revision });
      }
      return moved;
    });

    for (const { noteId, revision } of changed) {
      await appendOutboxEvent(context, session, {
        type: OUTBOX_EVENT_TYPES.communityNoteStatusChanged,
        payload: { communityNoteId: noteId, communityNoteRevision: revision },
      });
    }
    if (changed.length > 0) {
      logger.info({ changed: changed.length, algorithmVersion: SCORING_ALGORITHM_VERSION }, 'Community notes were rescored');
    }
    return changed.length;
  });
}

/**
 * The body of `community_note.status_changed` for one announced revision, or null
 * when the note or that revision no longer exists.
 *
 * Built from the revision the EVENT named rather than the note's current status:
 * a note that moved twice before the webhook went out announces each move, in
 * order, rather than the latest status twice.
 */
export async function communityNoteStatusChange(context: TenantContext, noteId: string, revision: number) {
  return await withTransaction((session) =>
    withTenantTransaction(session, context, async (tx) => {
      const note = await findCommunityNoteById(tx, noteId);
      if (!note) return null;
      const revisions = await findCommunityNoteRevisions(tx, noteId);
      const announced = revisions.find((row) => row.revision === revision);
      const previous = revisions.find((row) => row.revision === revision - 1);
      if (!announced || !previous) return null;
      return {
        noteId,
        externalSubjectId: note.externalSubjectId,
        authorPrincipalId: note.authorPrincipalId,
        previousStatus: previous.status,
        status: announced.status,
      };
    }),
  );
}
