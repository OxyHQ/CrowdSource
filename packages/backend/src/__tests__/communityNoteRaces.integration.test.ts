import type { CommunityNoteRatingSubmission } from '@crowdsource.you/contracts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The community-note paths only a race reaches, made deterministic.
 *
 * Each of these is what the unique indexes and compare-and-swaps exist for: two
 * retries of one write landing together, a withdrawal losing to a rescore, a
 * rating that slipped past its assignment check. A real race cannot be scheduled,
 * so the repository read that would have seen the winner is made to miss it once,
 * and the database is left to refuse the loser exactly as it would.
 */

vi.mock('../db/postgres/repositories/scoped/communityNotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/postgres/repositories/scoped/communityNotes')>();
  return {
    ...actual,
    findCommunityNoteByIdempotencyKey: vi.fn(actual.findCommunityNoteByIdempotencyKey),
    findCommunityNoteRatingByIdempotencyKey: vi.fn(actual.findCommunityNoteRatingByIdempotencyKey),
    transitionCommunityNoteStatus: vi.fn(actual.transitionCommunityNoteStatus),
    consumeCommunityNoteAssignment: vi.fn(actual.consumeCommunityNoteAssignment),
    drawCommunityNotesToRate: vi.fn(actual.drawCommunityNotesToRate),
    findCommunityNoteStatuses: vi.fn(actual.findCommunityNoteStatuses),
  };
});

const repository = await import('../db/postgres/repositories/scoped/communityNotes');
const service = await import('../modules/communityNotes/communityNotes.service');
const { ApiError } = await import('../http/apiError');
const { provisionTenant, startDatabase } = await import('./support/tenants');
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

let tenant: ProvisionedTenant;
let sequence = 0;
const key = (label: string) => `${label}-${Date.now()}-${(sequence += 1)}`;
const write = (label: string) => ({ idempotencyKey: key(label), credentialId: 'csk_test' });

const note = (overrides: Record<string, unknown> = {}) => ({
  externalSubjectId: `post_race_${Date.now()}_${(sequence += 1)}`,
  subjectAuthorPrincipalId: 'race_subject_author',
  authorPrincipalId: `race_writer_${(sequence += 1)}`,
  language: 'fi',
  text: 'Kontekstia.',
  ...overrides,
});

const helpful = (raterPrincipalId: string): CommunityNoteRatingSubmission => ({
  raterPrincipalId,
  rating: 'helpful',
  reasons: ['relevant'],
});

async function refusal(promise: Promise<unknown>): Promise<InstanceType<typeof ApiError>> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as InstanceType<typeof ApiError>;
}

beforeAll(async () => {
  await startDatabase();
  tenant = await provisionTenant(['crowdsource:community-notes:write', 'crowdsource:community-notes:read']);
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import('../db/postgres/repositories/scoped/communityNotes')>(
    '../db/postgres/repositories/scoped/communityNotes',
  );
  vi.mocked(repository.findCommunityNoteByIdempotencyKey).mockReset().mockImplementation(actual.findCommunityNoteByIdempotencyKey);
  vi.mocked(repository.findCommunityNoteRatingByIdempotencyKey)
    .mockReset()
    .mockImplementation(actual.findCommunityNoteRatingByIdempotencyKey);
  vi.mocked(repository.transitionCommunityNoteStatus).mockReset().mockImplementation(actual.transitionCommunityNoteStatus);
  vi.mocked(repository.consumeCommunityNoteAssignment).mockReset().mockImplementation(actual.consumeCommunityNoteAssignment);
  vi.mocked(repository.drawCommunityNotesToRate).mockReset().mockImplementation(actual.drawCommunityNotesToRate);
  vi.mocked(repository.findCommunityNoteStatuses).mockReset().mockImplementation(actual.findCommunityNoteStatuses);
});

describe('a write racing its own retry', () => {
  it('answers the retry with the note the winner stored', async () => {
    const idempotency = write('note');
    const body = note();
    const first = await service.writeCommunityNote(tenant.tenant, body, idempotency);

    vi.mocked(repository.findCommunityNoteByIdempotencyKey).mockResolvedValueOnce(null as never);
    const retried = await service.writeCommunityNote(tenant.tenant, body, idempotency);

    expect(retried).toMatchObject({ replayed: true, note: { noteId: first.note.noteId } });
  });

  it('asks for a retry when the winner cannot be read back', async () => {
    const idempotency = write('note');
    const body = note();
    await service.writeCommunityNote(tenant.tenant, body, idempotency);

    vi.mocked(repository.findCommunityNoteByIdempotencyKey).mockResolvedValue(null as never);
    const error = await refusal(service.writeCommunityNote(tenant.tenant, body, idempotency));
    expect(error.code).toBe('service_unavailable');
  });
});

describe('a withdrawal losing to another transition', () => {
  it('is refused rather than recording a status the note never had', async () => {
    const written = await service.writeCommunityNote(tenant.tenant, note(), write('note'));
    vi.mocked(repository.transitionCommunityNoteStatus).mockResolvedValueOnce(false);

    const error = await refusal(
      service.withdrawCommunityNote(tenant.tenant, written.note.noteId, written.note.authorPrincipalId, 'csk_test'),
    );
    expect(error.code).toBe('conflict');
  });
});

describe('ratings racing', () => {
  async function assignedNote(rater: string) {
    const written = await service.writeCommunityNote(tenant.tenant, note(), write('note'));
    await service.issueCommunityNoteAssignments(tenant.tenant, { raterPrincipalId: rater, languages: ['fi'] }, write('draw'));
    return written.note.noteId;
  }

  it('answers a retried rating with the stored one, or asks for a retry when it cannot be read', async () => {
    const noteId = await assignedNote('race_rater_1');
    const idempotency = write('rate');
    const first = await service.rateCommunityNote(tenant.tenant, noteId, helpful('race_rater_1'), idempotency);

    vi.mocked(repository.findCommunityNoteRatingByIdempotencyKey).mockResolvedValueOnce(null as never);
    vi.mocked(repository.consumeCommunityNoteAssignment).mockResolvedValueOnce(1);
    const retried = await service.rateCommunityNote(tenant.tenant, noteId, helpful('race_rater_1'), idempotency);
    expect(retried).toMatchObject({ replayed: true, rating: { ratingId: first.rating.ratingId } });

    vi.mocked(repository.findCommunityNoteRatingByIdempotencyKey).mockResolvedValue(null as never);
    vi.mocked(repository.consumeCommunityNoteAssignment).mockResolvedValueOnce(1);
    const error = await refusal(service.rateCommunityNote(tenant.tenant, noteId, helpful('race_rater_1'), idempotency));
    expect(error.code).toBe('service_unavailable');
  });

  it('refuses a second rating that slipped past a consumed assignment', async () => {
    const noteId = await assignedNote('race_rater_2');
    await service.rateCommunityNote(tenant.tenant, noteId, helpful('race_rater_2'), write('rate'));

    vi.mocked(repository.consumeCommunityNoteAssignment).mockResolvedValueOnce(1);
    const error = await refusal(service.rateCommunityNote(tenant.tenant, noteId, helpful('race_rater_2'), write('rate')));
    expect(error.code).toBe('conflict');
  });
});

describe('draws and rescores that lose', () => {
  it('skips a note whose assignment another draw already holds', async () => {
    const written = await service.writeCommunityNote(tenant.tenant, note(), write('note'));
    const first = await service.issueCommunityNoteAssignments(
      tenant.tenant,
      { raterPrincipalId: 'race_drawer', languages: ['fi'] },
      write('draw'),
    );
    expect(first.map((assignment) => assignment.note.id)).toContain(written.note.noteId);

    vi.mocked(repository.drawCommunityNotesToRate).mockResolvedValueOnce([written.note]);
    const second = await service.issueCommunityNoteAssignments(
      tenant.tenant,
      { raterPrincipalId: 'race_drawer', languages: ['fi'] },
      write('draw'),
    );
    expect(second).toEqual([]);
  });

  it('records nothing for a note that moved, vanished or was withdrawn while it was being scored', async () => {
    const fresh = await provisionTenant(['crowdsource:community-notes:write']);
    expect(await service.rescoreCommunityNotes(fresh.tenant)).toBe(0);
    expect(await service.shownCommunityNotes(fresh.tenant, [])).toEqual([]);

    const raters = Array.from({ length: 6 }, (_, index) => `race_scorer_${index}`);
    const written = await service.writeCommunityNote(fresh.tenant, note({ language: 'et' }), write('note'));
    for (const rater of raters) {
      await service.issueCommunityNoteAssignments(fresh.tenant, { raterPrincipalId: rater, languages: ['et'] }, write('draw'));
      await service.rateCommunityNote(fresh.tenant, written.note.noteId, helpful(rater), write('rate'));
    }

    // A status the scorer will disagree with, so it tries the transition — and loses it.
    vi.mocked(repository.findCommunityNoteStatuses).mockResolvedValueOnce([
      { noteId: written.note.noteId, status: 'withdrawn_elsewhere', statusRevision: 99 },
    ]);
    vi.mocked(repository.transitionCommunityNoteStatus).mockResolvedValueOnce(false);
    expect(await service.rescoreCommunityNotes(fresh.tenant)).toBe(0);
    expect(repository.transitionCommunityNoteStatus).toHaveBeenCalledTimes(1);

    vi.mocked(repository.findCommunityNoteStatuses).mockResolvedValueOnce([]);
    expect(await service.rescoreCommunityNotes(fresh.tenant)).toBe(0);

    await service.withdrawCommunityNote(fresh.tenant, written.note.noteId, written.note.authorPrincipalId, 'csk_test');
    vi.mocked(repository.findCommunityNoteStatuses).mockResolvedValueOnce([
      { noteId: written.note.noteId, status: 'withdrawn', statusRevision: 2 },
    ]);
    expect(await service.rescoreCommunityNotes(fresh.tenant)).toBe(0);
  });
});

describe('two shown notes on one subject', () => {
  it('keeps the note shown first, and a stale revision cannot move a note', async () => {
    const { withTransaction } = await import('../db/transaction');
    const { withTenantTransaction } = await import('../db/postgres/withTenant');
    const actual = await vi.importActual<typeof import('../db/postgres/repositories/scoped/communityNotes')>(
      '../db/postgres/repositories/scoped/communityNotes',
    );
    const externalSubjectId = `post_twice_${Date.now()}`;
    const first = await service.writeCommunityNote(tenant.tenant, note({ externalSubjectId }), write('note'));
    const second = await service.writeCommunityNote(tenant.tenant, note({ externalSubjectId }), write('note'));

    const show = (noteId: string, fromRevision: number, at: Date) =>
      withTransaction((session) =>
        withTenantTransaction(session, tenant.tenant, (tx) =>
          actual.transitionCommunityNoteStatus(tx, noteId, fromRevision, {
            revisionId: `cnv_${noteId.slice(4)}`,
            organizationId: tenant.organizationId,
            applicationId: tenant.applicationId,
            noteId,
            revision: fromRevision + 1,
            status: 'shown',
            algorithmVersion: 'mf-1',
            noteIntercept: 0.5,
            noteFactor: 0,
            ratingCount: 5,
            recordedAt: at,
            createdAt: at,
            updatedAt: at,
          }),
        ),
      );

    expect(await show(first.note.noteId, 1, new Date(Date.now() - 60_000))).toBe(true);
    expect(await show(second.note.noteId, 1, new Date())).toBe(true);
    expect(await show(second.note.noteId, 1, new Date())).toBe(false);

    const shown = await service.shownCommunityNotes(tenant.tenant, [externalSubjectId]);
    expect(shown.map((row) => row.id)).toEqual([first.note.noteId]);
  });
});

