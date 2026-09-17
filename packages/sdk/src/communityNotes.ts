import {
  CommunityNoteAssignmentBatchSchema,
  CommunityNoteListSchema,
  CommunityNoteRatedListSchema,
  CommunityNoteRatingSchema,
  CommunityNoteSchema,
  ShownCommunityNotesSchema,
  type CommunityNote,
  type CommunityNoteAssignment,
  type CommunityNoteAssignmentRequest,
  type CommunityNoteRatedList,
  type CommunityNoteRating,
  type CommunityNoteRatingSubmission,
  type CommunityNoteSubmission,
} from '@oxy.so/crowdsource-contracts';
import type { z } from 'zod';

import { sha256Digest } from './digest.js';
import { CrowdSourceTransportError } from './errors.js';
import type { Transport } from './transport.js';

/**
 * Community notes (`docs/architecture/community-notes.md`): reader-written context
 * under the application's subjects, shown once raters of different viewpoints
 * agree it is helpful.
 *
 * The application acts for its users, naming each by its own opaque principal id.
 * Every write is retry-safe with no key from the caller where one can be derived
 * from what the write IS — one note per writer per subject, one rating per rater
 * per note — and the derived keys hash the principal ids, so an application's
 * user ids never travel in a header a proxy might log. Drawing notes to rate has
 * no such identity (two draws for one rater are two different requests), so that
 * one method takes the key from the caller.
 */

export interface CommunityNoteRequestOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface CommunityNoteReadOptions {
  readonly signal?: AbortSignal;
}

/** A stable, header-safe digest of the parts that identify a write. */
function digestOf(...parts: readonly string[]): string {
  return sha256Digest(JSON.stringify(parts)).replace('sha256:', '');
}

export class CommunityNotes {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Writes a note. A retry of the same writer's note on the same subject returns it. */
  async write(submission: CommunityNoteSubmission, options: CommunityNoteRequestOptions = {}): Promise<CommunityNote> {
    return this.parse(
      CommunityNoteSchema,
      await this.transport.request<unknown>({
        method: 'POST',
        path: '/v1/community-notes',
        body: submission,
        idempotencyKey:
          options.idempotencyKey ??
          `community-note.${digestOf(submission.externalSubjectId, submission.authorPrincipalId)}`,
        signal: options.signal,
      }),
      'a community note',
    );
  }

  /** Withdraws a note. Only its writer may; anyone else's note answers 404. */
  async withdraw(
    noteId: string,
    authorPrincipalId: string,
    options: CommunityNoteRequestOptions = {},
  ): Promise<CommunityNote> {
    return this.parse(
      CommunityNoteSchema,
      await this.transport.request<unknown>({
        method: 'POST',
        path: `/v1/community-notes/${encodeURIComponent(noteId)}/withdraw`,
        body: { authorPrincipalId },
        idempotencyKey: options.idempotencyKey ?? `community-note-withdrawal.${digestOf(noteId)}`,
        signal: options.signal,
      }),
      'a community note',
    );
  }

  /**
   * Draws notes for one rater to rate — the ONLY way to be allowed to rate one.
   *
   * `idempotencyKey` is required: a retry with the same key returns the same
   * batch, and a new key is a new draw.
   */
  async drawToRate(
    request: CommunityNoteAssignmentRequest,
    options: CommunityNoteRequestOptions & { readonly idempotencyKey: string },
  ): Promise<CommunityNoteAssignment[]> {
    const batch = this.parse(
      CommunityNoteAssignmentBatchSchema,
      await this.transport.request<unknown>({
        method: 'POST',
        path: '/v1/community-notes/assignments',
        body: request,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      }),
      'a batch of community note assignments',
    );
    return batch.assignments;
  }

  /** Rates a note assigned to the rater. Final: a second rating is refused. */
  async rate(
    noteId: string,
    submission: CommunityNoteRatingSubmission,
    options: CommunityNoteRequestOptions = {},
  ): Promise<CommunityNoteRating> {
    return this.parse(
      CommunityNoteRatingSchema,
      await this.transport.request<unknown>({
        method: 'POST',
        path: `/v1/community-notes/${encodeURIComponent(noteId)}/ratings`,
        body: submission,
        idempotencyKey:
          options.idempotencyKey ?? `community-note-rating.${digestOf(noteId, submission.raterPrincipalId)}`,
        signal: options.signal,
      }),
      'a community note rating',
    );
  }

  /** The shown note, if any, for each of up to 50 subjects. */
  async shown(externalSubjectIds: readonly string[], options: CommunityNoteReadOptions = {}): Promise<CommunityNote[]> {
    const subjects = [...new Set(externalSubjectIds)];
    if (subjects.length === 0) return [];
    const response = this.parse(
      ShownCommunityNotesSchema,
      await this.transport.request<unknown>({
        method: 'GET',
        path: `/v1/community-notes/shown?subjects=${subjects.map(encodeURIComponent).join(',')}`,
        signal: options.signal,
      }),
      'a shown community notes lookup',
    );
    return response.notes;
  }

  /** A writer's own notes, newest first. */
  async writtenBy(authorPrincipalId: string, options: CommunityNoteReadOptions = {}): Promise<CommunityNote[]> {
    const response = this.parse(
      CommunityNoteListSchema,
      await this.transport.request<unknown>({
        method: 'GET',
        path: `/v1/community-notes/principals/${encodeURIComponent(authorPrincipalId)}/notes`,
        signal: options.signal,
      }),
      'a list of community notes',
    );
    return response.notes;
  }

  /** A rater's own ratings, each with the note it rated, newest first. */
  async ratedBy(
    raterPrincipalId: string,
    options: CommunityNoteReadOptions = {},
  ): Promise<CommunityNoteRatedList['ratings']> {
    const response = this.parse(
      CommunityNoteRatedListSchema,
      await this.transport.request<unknown>({
        method: 'GET',
        path: `/v1/community-notes/principals/${encodeURIComponent(raterPrincipalId)}/ratings`,
        signal: options.signal,
      }),
      'a list of community note ratings',
    );
    return response.ratings;
  }

  private parse<S extends z.ZodType>(schema: S, response: unknown, what: string): z.infer<S> {
    const parsed = schema.safeParse(response);
    if (!parsed.success) {
      throw new CrowdSourceTransportError(`CrowdSource answered with ${what} this client does not recognise.`, {
        retryable: false,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
