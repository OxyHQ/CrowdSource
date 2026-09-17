/**
 * Community notes (`docs/architecture/community-notes.md`).
 *
 * Context that an application's readers write under one of its subjects — a
 * post, a listing — shown to everyone once raters of DIFFERENT viewpoints agree
 * it is helpful. A separate mechanism from moderation: a note removes nothing,
 * restricts nothing and penalises nobody, never opens a case and never feeds a
 * decision or a reputation effect.
 *
 * Strictness follows the package rule. Everything a tenant sends is strict:
 * a note is attacker-controlled text shown to every reader of the subject, and a
 * field these schemas tolerated is a field nobody validated. Everything sent back
 * is loose, so a newer CrowdSource never breaks an older integrator.
 *
 * What is deliberately absent everywhere below: any count or score a rater could
 * read before rating (the moderation rule that a reviewer never sees partial
 * votes applies here for the same reason — seeing the tally is how a rating stops
 * being independent), and any principal id on a note a reader receives. A writer
 * and a rater are anonymous to everyone but the application that named them.
 */

import { z } from 'zod';

import type { Closed } from './closed.js';
import {
  CONTRACT_LIMITS,
  ExternalIdSchema,
  HttpUrlSchema,
  IdentifierSchema,
  LanguageTagSchema,
  TimestampSchema,
} from './primitives.js';

/** The longest note body. Context, not an essay: a reader takes it in at a glance. */
export const COMMUNITY_NOTE_TEXT_MAX_LENGTH = 500;
/** Sources a note may cite. One good source beats a list nobody opens. */
export const COMMUNITY_NOTE_SOURCES_MAX = 3;
/** Notes one assignment request may draw. */
export const COMMUNITY_NOTE_ASSIGNMENT_BATCH_MAX = 10;
/** Languages one rater may be assigned notes in. */
export const COMMUNITY_NOTE_RATER_LANGUAGES_MAX = 5;
/** Subjects one `shown` lookup may name — a feed page. */
export const COMMUNITY_NOTE_SUBJECTS_PER_LOOKUP_MAX = 50;

/**
 * Where a note stands.
 *
 * `needs_ratings` until the model has enough agreement either way; `shown` when
 * raters of different viewpoints found it helpful; `not_shown` when they found
 * it unhelpful. A status is a scoring OUTCOME, never a verdict on the writer, and
 * it can move again as ratings arrive — each move is an append-only revision.
 * `withdrawn` is the writer's own act, and final.
 */
export const COMMUNITY_NOTE_STATUSES = ['needs_ratings', 'shown', 'not_shown', 'withdrawn'] as const;
export const CommunityNoteStatusSchema = z.enum(COMMUNITY_NOTE_STATUSES);
export type CommunityNoteStatus = z.infer<typeof CommunityNoteStatusSchema>;

export const COMMUNITY_NOTE_RATINGS = ['helpful', 'not_helpful'] as const;
export const CommunityNoteRatingValueSchema = z.enum(COMMUNITY_NOTE_RATINGS);
export type CommunityNoteRatingValue = z.infer<typeof CommunityNoteRatingValueSchema>;

/**
 * Why a rater found a note helpful, or not.
 *
 * Closed lists rather than free text: a reason is counted, never read, and a
 * free-text field beside a rating is a channel for the harassment a note is
 * about. At least one is required — a bare thumbs-up tells the writer nothing.
 */
export const COMMUNITY_NOTE_HELPFUL_REASONS = [
  'full_explanation',
  'relevant',
  'reliable_source',
  'neutral',
  'easy_to_understand',
  'other',
] as const;
export const COMMUNITY_NOTE_NOT_HELPFUL_REASONS = [
  'incorrect',
  'unreliable_source',
  'missing_key_points',
  'opinion_or_biased',
  'hard_to_understand',
  'not_needed',
  'other',
] as const;
export const CommunityNoteHelpfulReasonSchema = z.enum(COMMUNITY_NOTE_HELPFUL_REASONS);
export const CommunityNoteNotHelpfulReasonSchema = z.enum(COMMUNITY_NOTE_NOT_HELPFUL_REASONS);

/**
 * The body of `POST /v1/community-notes`.
 *
 * `authorPrincipalId` is the application's own id for the writer, and
 * `subjectAuthorPrincipalId` its id for whoever authored the subject: CrowdSource
 * never assigns a note to either of them to rate, and that exclusion is only
 * enforceable if both are named when the note is written.
 */
export const CommunityNoteSubmissionSchema = z.strictObject({
  externalSubjectId: ExternalIdSchema,
  subjectAuthorPrincipalId: ExternalIdSchema,
  authorPrincipalId: ExternalIdSchema,
  language: LanguageTagSchema,
  text: z.string().trim().min(1).max(COMMUNITY_NOTE_TEXT_MAX_LENGTH),
  sourceUrls: z.array(HttpUrlSchema).max(COMMUNITY_NOTE_SOURCES_MAX).default([]),
});
export type CommunityNoteSubmission = z.input<typeof CommunityNoteSubmissionSchema>;

/** The body of `POST /v1/community-notes/{id}/withdraw`: only the writer may. */
export const CommunityNoteWithdrawalSchema = z.strictObject({
  authorPrincipalId: ExternalIdSchema,
});
export type CommunityNoteWithdrawal = z.infer<typeof CommunityNoteWithdrawalSchema>;

/**
 * The body of `POST /v1/community-notes/assignments`.
 *
 * A rating is accepted only against an assignment the server issued — nobody
 * chooses the note they rate, the same rule that keeps a jury from being picked
 * by the people on it.
 */
export const CommunityNoteAssignmentRequestSchema = z.strictObject({
  raterPrincipalId: ExternalIdSchema,
  languages: z.array(LanguageTagSchema).min(1).max(COMMUNITY_NOTE_RATER_LANGUAGES_MAX),
  limit: z.number().int().min(1).max(COMMUNITY_NOTE_ASSIGNMENT_BATCH_MAX).default(COMMUNITY_NOTE_ASSIGNMENT_BATCH_MAX),
});
export type CommunityNoteAssignmentRequest = z.input<typeof CommunityNoteAssignmentRequestSchema>;

/**
 * The body of `POST /v1/community-notes/{id}/ratings`.
 *
 * A discriminated union so the reasons are checked against the rating they
 * explain — "reliable source" is not a reason something is unhelpful.
 */
export const CommunityNoteRatingSubmissionSchema = z.discriminatedUnion('rating', [
  z.strictObject({
    raterPrincipalId: ExternalIdSchema,
    rating: z.literal('helpful'),
    reasons: z.array(CommunityNoteHelpfulReasonSchema).min(1).max(COMMUNITY_NOTE_HELPFUL_REASONS.length),
  }),
  z.strictObject({
    raterPrincipalId: ExternalIdSchema,
    rating: z.literal('not_helpful'),
    reasons: z.array(CommunityNoteNotHelpfulReasonSchema).min(1).max(COMMUNITY_NOTE_NOT_HELPFUL_REASONS.length),
  }),
]);
export type CommunityNoteRatingSubmission = z.infer<typeof CommunityNoteRatingSubmissionSchema>;

/**
 * A note, as it travels back to the application.
 *
 * No principal of any kind, no rating count, no score: the same DTO serves the
 * public lookup, the writer's list and a rater's assignment, and none of those
 * readers may learn who wrote it or how it is being rated.
 */
export const CommunityNoteSchema = z.looseObject({
  id: IdentifierSchema,
  externalSubjectId: ExternalIdSchema,
  language: LanguageTagSchema,
  text: z.string().min(1).max(COMMUNITY_NOTE_TEXT_MAX_LENGTH),
  sourceUrls: z.array(HttpUrlSchema).max(COMMUNITY_NOTE_SOURCES_MAX),
  status: CommunityNoteStatusSchema,
  createdAt: TimestampSchema,
  /** When the note last changed status; equal to `createdAt` until it first does. */
  statusChangedAt: TimestampSchema,
});
export type CommunityNote = Closed<z.infer<typeof CommunityNoteSchema>>;

/** One assignment: a note a rater was handed, and until when the rating is accepted. */
export const CommunityNoteAssignmentSchema = z.looseObject({
  id: IdentifierSchema,
  note: CommunityNoteSchema,
  expiresAt: TimestampSchema,
});
export type CommunityNoteAssignment = Closed<z.infer<typeof CommunityNoteAssignmentSchema>>;

export const CommunityNoteAssignmentBatchSchema = z.looseObject({
  assignments: z.array(CommunityNoteAssignmentSchema).max(COMMUNITY_NOTE_ASSIGNMENT_BATCH_MAX),
});
export type CommunityNoteAssignmentBatch = Closed<z.infer<typeof CommunityNoteAssignmentBatchSchema>>;

/** A rating, as returned to the rater who gave it. Final: there is no update. */
export const CommunityNoteRatingSchema = z.looseObject({
  id: IdentifierSchema,
  noteId: IdentifierSchema,
  rating: CommunityNoteRatingValueSchema,
  reasons: z
    .array(z.union([CommunityNoteHelpfulReasonSchema, CommunityNoteNotHelpfulReasonSchema]))
    .min(1)
    .max(COMMUNITY_NOTE_NOT_HELPFUL_REASONS.length),
  ratedAt: TimestampSchema,
});
export type CommunityNoteRating = Closed<z.infer<typeof CommunityNoteRatingSchema>>;

/** The public lookup: the shown note, if any, for each subject asked about. */
export const ShownCommunityNotesSchema = z.looseObject({
  notes: z.array(CommunityNoteSchema).max(COMMUNITY_NOTE_SUBJECTS_PER_LOOKUP_MAX),
});
export type ShownCommunityNotes = Closed<z.infer<typeof ShownCommunityNotesSchema>>;

/** A principal's own notes (as writer). */
export const CommunityNoteListSchema = z.looseObject({
  notes: z.array(CommunityNoteSchema).max(CONTRACT_LIMITS.RESOURCES_PER_ENVELOPE_MAX),
});
export type CommunityNoteList = Closed<z.infer<typeof CommunityNoteListSchema>>;

/** A principal's own ratings, each with the note it rated. */
export const CommunityNoteRatedListSchema = z.looseObject({
  ratings: z
    .array(z.looseObject({ rating: CommunityNoteRatingSchema, note: CommunityNoteSchema }))
    .max(CONTRACT_LIMITS.RESOURCES_PER_ENVELOPE_MAX),
});
export type CommunityNoteRatedList = Closed<z.infer<typeof CommunityNoteRatedListSchema>>;
