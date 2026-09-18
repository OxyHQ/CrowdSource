/**
 * The community notes namespace: the paths and bodies it sends, the retry keys
 * it derives, and that a response it does not recognise is refused rather than
 * passed through.
 *
 * The derived keys are the part worth pinning. A key that included a timestamp
 * or a random id would turn the application's own outbox retry into a second
 * note, and a key that carried the raw principal id would put an application's
 * user ids in a header every proxy logs.
 */

import { describe, expect, it } from 'vitest';

import { CrowdSource } from '../client.js';
import { formatServiceKey } from '../credential.js';
import { CrowdSourceTransportError } from '../errors.js';

const SERVICE_KEY = formatServiceKey({
  applicationId: 'app_0123456789abcdef0123456789abcdef',
  credentialId: 'csk_fedcba9876543210fedcba9876543210',
  secret: 'secret-value',
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

function client(responses: readonly Response[]): { crowdsource: CrowdSource; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      idempotencyKey: request.headers.get('idempotency-key'),
      body: request.body === null ? null : ((await request.json()) as unknown),
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('no stubbed response left');
    return next;
  };
  return {
    crowdsource: new CrowdSource({ serviceKey: SERVICE_KEY, baseUrl: 'https://api.crowdsource.oxy.so', fetch: fetchImpl }),
    calls,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const NOTE = {
  id: 'cnt_0123456789abcdef0123456789abcdef',
  externalSubjectId: 'post_1',
  language: 'es',
  text: 'Contexto.',
  sourceUrls: ['https://example.com/a'],
  status: 'needs_ratings',
  createdAt: '2026-09-01T10:00:00.000Z',
  statusChangedAt: '2026-09-01T10:00:00.000Z',
};

const SUBMISSION = {
  externalSubjectId: 'post_1',
  subjectAuthorPrincipalId: 'user_author',
  authorPrincipalId: 'user_writer',
  language: 'es',
  text: 'Contexto.',
};

describe('writing and withdrawing', () => {
  it('posts the note under a key derived from the subject and the writer, never their raw id', async () => {
    const { crowdsource, calls } = client([json(201, NOTE), json(200, NOTE)]);
    expect(await crowdsource.communityNotes.write(SUBMISSION)).toEqual(NOTE);
    await crowdsource.communityNotes.write({ ...SUBMISSION, text: 'Retry of the same note' });

    expect(calls[0]).toMatchObject({ url: 'https://api.crowdsource.oxy.so/v1/community-notes', method: 'POST', body: SUBMISSION });
    expect(calls[0]?.idempotencyKey).toMatch(/^community-note\.[0-9a-f]{64}$/);
    expect(calls[0]?.idempotencyKey).not.toContain('user_writer');
    expect(calls[1]?.idempotencyKey).toBe(calls[0]?.idempotencyKey);
  });

  it('honours an explicit key, and withdraws by note', async () => {
    const { crowdsource, calls } = client([json(201, NOTE), json(200, { ...NOTE, status: 'withdrawn' })]);
    await crowdsource.communityNotes.write(SUBMISSION, { idempotencyKey: 'mine' });
    const withdrawn = await crowdsource.communityNotes.withdraw(NOTE.id, 'user_writer');

    expect(calls[0]?.idempotencyKey).toBe('mine');
    expect(calls[1]).toMatchObject({
      url: `https://api.crowdsource.oxy.so/v1/community-notes/${NOTE.id}/withdraw`,
      body: { authorPrincipalId: 'user_writer' },
    });
    expect(calls[1]?.idempotencyKey).toMatch(/^community-note-withdrawal\.[0-9a-f]{64}$/);
    expect(withdrawn.status).toBe('withdrawn');
  });
});

describe('rating', () => {
  it('draws with the caller key and rates under a key derived from note and rater', async () => {
    const assignment = { id: 'cna_1', note: NOTE, expiresAt: '2026-09-02T10:00:00.000Z' };
    const rating = { id: 'cnr_1', noteId: NOTE.id, rating: 'helpful', reasons: ['relevant'], ratedAt: '2026-09-01T11:00:00.000Z' };
    const { crowdsource, calls } = client([json(200, { assignments: [assignment] }), json(201, rating)]);

    const drawn = await crowdsource.communityNotes.drawToRate(
      { raterPrincipalId: 'user_rater', languages: ['es'] },
      { idempotencyKey: 'draw-1' },
    );
    expect(drawn).toEqual([assignment]);
    expect(calls[0]).toMatchObject({ url: 'https://api.crowdsource.oxy.so/v1/community-notes/assignments', idempotencyKey: 'draw-1' });

    const rated = await crowdsource.communityNotes.rate(NOTE.id, { raterPrincipalId: 'user_rater', rating: 'helpful', reasons: ['relevant'] });
    expect(rated).toEqual(rating);
    expect(calls[1]?.url).toBe(`https://api.crowdsource.oxy.so/v1/community-notes/${NOTE.id}/ratings`);
    expect(calls[1]?.idempotencyKey).toMatch(/^community-note-rating\.[0-9a-f]{64}$/);
  });
});

describe('reads', () => {
  it('looks up shown notes for de-duplicated subjects, and asks nothing for none', async () => {
    const { crowdsource, calls } = client([json(200, { notes: [{ ...NOTE, status: 'shown' }] })]);
    expect(await crowdsource.communityNotes.shown([])).toEqual([]);
    const shown = await crowdsource.communityNotes.shown(['post_1', 'post 2', 'post_1']);
    expect(shown).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.crowdsource.oxy.so/v1/community-notes/shown?subjects=post_1,post%202' });
  });

  it("reads a principal's own notes and ratings", async () => {
    const rating = { id: 'cnr_1', noteId: NOTE.id, rating: 'not_helpful', reasons: ['incorrect'], ratedAt: '2026-09-01T11:00:00.000Z' };
    const { crowdsource, calls } = client([json(200, { notes: [NOTE] }), json(200, { ratings: [{ rating, note: NOTE }] })]);
    expect(await crowdsource.communityNotes.writtenBy('user_writer')).toEqual([NOTE]);
    expect(await crowdsource.communityNotes.ratedBy('user_rater')).toEqual([{ rating, note: NOTE }]);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.crowdsource.oxy.so/v1/community-notes/principals/user_writer/notes',
      'https://api.crowdsource.oxy.so/v1/community-notes/principals/user_rater/ratings',
    ]);
  });

  it('refuses a response it does not recognise', async () => {
    const { crowdsource } = client([json(200, { notes: [{ id: 'x' }] })]);
    await expect(crowdsource.communityNotes.writtenBy('user_writer')).rejects.toBeInstanceOf(CrowdSourceTransportError);
  });
});
