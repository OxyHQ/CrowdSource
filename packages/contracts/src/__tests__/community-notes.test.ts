import { describe, expect, it } from 'vitest';

import {
  COMMUNITY_NOTE_ASSIGNMENT_BATCH_MAX,
  COMMUNITY_NOTE_SOURCES_MAX,
  COMMUNITY_NOTE_STATUSES,
  COMMUNITY_NOTE_TEXT_MAX_LENGTH,
  CommunityNoteAssignmentRequestSchema,
  CommunityNoteRatingSubmissionSchema,
  CommunityNoteSchema,
  CommunityNoteSubmissionSchema,
  CommunityNoteWithdrawalSchema,
  ShownCommunityNotesSchema,
} from '../community-notes.js';
import { KnownWebhookEventSchema } from '../webhooks.js';
import { accepted, rejectionPaths } from './support/assertions.js';

/**
 * the community notes ADR's community notes, as a contract.
 *
 * A note is text a reader wrote and every other reader of the subject will see,
 * so the inbound schemas are where a hostile writer or rater meets the service.
 * The outbound note is pinned for what it must NOT carry: who wrote it and how it
 * is being rated.
 */

const submission = (overrides: Record<string, unknown> = {}) => ({
  externalSubjectId: 'post_987',
  subjectAuthorPrincipalId: 'mention_user_1',
  authorPrincipalId: 'mention_user_2',
  language: 'es-ES',
  text: 'Los murciélagos no son ciegos.',
  sourceUrls: ['https://example.com/bats'],
  ...overrides,
});

const note = (overrides: Record<string, unknown> = {}) => ({
  id: 'cnt_0123456789abcdef0123456789abcdef',
  externalSubjectId: 'post_987',
  language: 'es-ES',
  text: 'Los murciélagos no son ciegos.',
  sourceUrls: ['https://example.com/bats'],
  status: 'shown',
  createdAt: '2026-09-01T10:00:00.000Z',
  statusChangedAt: '2026-09-02T10:00:00.000Z',
  ...overrides,
});

describe('the note vocabulary', () => {
  it('has no status that is a verdict on the writer', () => {
    expect([...COMMUNITY_NOTE_STATUSES]).toEqual(['needs_ratings', 'shown', 'not_shown', 'withdrawn']);
  });
});

describe('writing a note', () => {
  it('accepts a note with its sources, trimmed', () => {
    const parsed = accepted(CommunityNoteSubmissionSchema, submission({ text: '  context  ' }));
    expect(parsed.text).toBe('context');
  });

  it('defaults to no sources', () => {
    const { sourceUrls: _omitted, ...rest } = submission();
    expect(accepted(CommunityNoteSubmissionSchema, rest).sourceUrls).toEqual([]);
  });

  it('refuses an empty note, an overlong one, too many sources and a non-http source', () => {
    expect(rejectionPaths(CommunityNoteSubmissionSchema, submission({ text: '   ' }))).toEqual(['text']);
    expect(
      rejectionPaths(CommunityNoteSubmissionSchema, submission({ text: 'x'.repeat(COMMUNITY_NOTE_TEXT_MAX_LENGTH + 1) })),
    ).toEqual(['text']);
    expect(
      rejectionPaths(
        CommunityNoteSubmissionSchema,
        submission({ sourceUrls: Array.from({ length: COMMUNITY_NOTE_SOURCES_MAX + 1 }, (_, i) => `https://e.com/${i}`) }),
      ),
    ).toEqual(['sourceUrls']);
    expect(rejectionPaths(CommunityNoteSubmissionSchema, submission({ sourceUrls: ['javascript:alert(1)'] }))).toEqual([
      'sourceUrls.0',
    ]);
  });

  it('carries no application id and nothing it did not declare', () => {
    expect(rejectionPaths(CommunityNoteSubmissionSchema, submission({ applicationId: 'app_other' }))).toEqual(['']);
  });

  it('requires both the writer and the subject author, so the rater exclusion is enforceable', () => {
    const { subjectAuthorPrincipalId: _a, ...withoutSubjectAuthor } = submission();
    expect(rejectionPaths(CommunityNoteSubmissionSchema, withoutSubjectAuthor)).toEqual(['subjectAuthorPrincipalId']);
    expect(rejectionPaths(CommunityNoteWithdrawalSchema, {})).toEqual(['authorPrincipalId']);
  });
});

describe('asking for notes to rate', () => {
  it('defaults the batch to the maximum and bounds it', () => {
    const parsed = accepted(CommunityNoteAssignmentRequestSchema, { raterPrincipalId: 'u1', languages: ['es'] });
    expect(parsed.limit).toBe(COMMUNITY_NOTE_ASSIGNMENT_BATCH_MAX);
    expect(
      rejectionPaths(CommunityNoteAssignmentRequestSchema, {
        raterPrincipalId: 'u1',
        languages: ['es'],
        limit: COMMUNITY_NOTE_ASSIGNMENT_BATCH_MAX + 1,
      }),
    ).toEqual(['limit']);
    expect(rejectionPaths(CommunityNoteAssignmentRequestSchema, { raterPrincipalId: 'u1', languages: [] })).toEqual([
      'languages',
    ]);
  });
});

describe('rating a note', () => {
  it('accepts reasons that explain the rating given', () => {
    accepted(CommunityNoteRatingSubmissionSchema, { raterPrincipalId: 'u1', rating: 'helpful', reasons: ['reliable_source'] });
    accepted(CommunityNoteRatingSubmissionSchema, { raterPrincipalId: 'u1', rating: 'not_helpful', reasons: ['incorrect'] });
  });

  it('refuses a reason from the other list, and a rating with no reason', () => {
    expect(
      rejectionPaths(CommunityNoteRatingSubmissionSchema, { raterPrincipalId: 'u1', rating: 'not_helpful', reasons: ['reliable_source'] }),
    ).toEqual(['reasons.0']);
    expect(rejectionPaths(CommunityNoteRatingSubmissionSchema, { raterPrincipalId: 'u1', rating: 'helpful', reasons: [] })).toEqual([
      'reasons',
    ]);
  });
});

describe('the note a reader receives', () => {
  it('passes unknown fields through and names no principal', () => {
    const parsed = accepted(CommunityNoteSchema, note({ addedLater: true }));
    expect(parsed).toMatchObject({ addedLater: true });
    expect(Object.keys(CommunityNoteSchema.shape)).not.toEqual(
      expect.arrayContaining(['authorPrincipalId', 'raterPrincipalId', 'ratingCount']),
    );
    accepted(ShownCommunityNotesSchema, { notes: [note()] });
  });
});

describe('the status webhook', () => {
  it('is a known event carrying the note, its subject and the writer', () => {
    const event = accepted(KnownWebhookEventSchema, {
      id: 'evt_1',
      createdAt: '2026-09-02T10:00:00.000Z',
      organizationId: 'org_1',
      applicationId: 'app_1',
      type: 'community_note.status_changed',
      data: {
        noteId: 'cnt_1',
        externalSubjectId: 'post_987',
        authorPrincipalId: 'mention_user_2',
        previousStatus: 'needs_ratings',
        status: 'shown',
      },
    });
    expect(event.type).toBe('community_note.status_changed');
  });
});
