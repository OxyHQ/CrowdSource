import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Community notes end to end (the community notes ADR): the application API, the assignment
 * door, the rescore the outbox runs after a rating, the status webhook, and
 * tenant isolation — against the real PostgreSQL the suite provisions.
 */

const { createApp } = await import('../app');
const { registerOutboxWorkers } = await import('../modules/outbox/workers');
const { outboxEvents, OUTBOX_EVENT_TYPES } = await import('../modules/outbox/outbox.collection');
const { auditEvents } = await import('../modules/audit/audit.collection');
const { registerWebhookEndpoint } = await import('../modules/webhooks/endpoint.service');
const { webhookDeliveries } = await import('../modules/webhooks/webhook.collections');
const { fanOutWebhookEvent } = await import('../modules/webhooks/fanout');
const { withTransaction } = await import('../db/transaction');
const { withTenantTransaction } = await import('../db/postgres/withTenant');
const { findCommunityNoteRevisions } = await import('../db/postgres/repositories/scoped/communityNotes');
const service = await import('../modules/communityNotes/communityNotes.service');
const { handleCommunityNoteRated } = await import('../modules/communityNotes/communityNotes.worker');
const { drainUntil, provisionApplication, provisionTenant, startDatabase } = await import('./support/tenants');
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();

let tenant: ProvisionedTenant;
let sibling: ProvisionedTenant;
let unscoped: ProvisionedTenant;
let webhookEndpointId: string;
let sequence = 0;

const key = (label: string) => `${label}-${Date.now()}-${(sequence += 1)}`;
const subject = (label: string) => `post_${label}_${Date.now()}_${(sequence += 1)}`;

const noteBody = (overrides: Record<string, unknown> = {}) => ({
  externalSubjectId: subject('note'),
  subjectAuthorPrincipalId: 'subject_author',
  authorPrincipalId: 'writer_1',
  language: 'es-ES',
  text: 'Los murciélagos no son ciegos.',
  sourceUrls: ['https://example.com/bats'],
  ...overrides,
});

function post(path: string, body: unknown, as: ProvisionedTenant = tenant, idempotencyKey: string | null = key('k')) {
  const call = request(app).post(`/v1${path}`).set('Authorization', `Bearer ${as.token}`);
  if (idempotencyKey) call.set('Idempotency-Key', idempotencyKey);
  return call.send(body as object);
}

function get(path: string, as: ProvisionedTenant = tenant) {
  return request(app).get(`/v1${path}`).set('Authorization', `Bearer ${as.token}`);
}

const writeKey = (idempotencyKey: string) => ({ idempotencyKey, credentialId: 'csk_test' });

beforeAll(async () => {
  await startDatabase();
  const scopes = ['crowdsource:community-notes:write', 'crowdsource:community-notes:read'] as const;
  tenant = await provisionTenant(scopes);
  sibling = await provisionApplication(tenant.organizationId, scopes);
  unscoped = await provisionTenant(['crowdsource:reports:write']);
  registerOutboxWorkers();
  const registered = await registerWebhookEndpoint(tenant.tenant, {
    url: 'https://receiver.invalid/community-notes',
    eventTypes: ['community_note.status_changed'],
  });
  webhookEndpointId = registered.endpoint.webhookEndpointId;
});

describe('the application API surface', () => {
  it('requires the community-notes scopes, an idempotency key and a valid body', async () => {
    expect((await post('/community-notes', noteBody(), unscoped)).status).toBe(403);
    expect((await get('/community-notes/shown?subjects=post_1', unscoped)).status).toBe(403);

    const noKey = await post('/community-notes', noteBody(), tenant, null);
    expect(noKey.status).toBe(400);
    const badKey = await request(app)
      .post('/v1/community-notes')
      .set('Authorization', `Bearer ${tenant.token}`)
      .set('Idempotency-Key', 'has spaces')
      .send(noteBody());
    expect(badKey.status).toBe(400);

    const invalid = await post('/community-notes', noteBody({ text: '' }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_request');
  });
});

describe('writing and withdrawing a note', () => {
  it('writes a note, answers a retry with the same note, and refuses a different body under that key', async () => {
    const idempotencyKey = key('write');
    const body = noteBody();
    const created = await post('/community-notes', body, tenant, idempotencyKey);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ externalSubjectId: body.externalSubjectId, status: 'needs_ratings' });
    expect(created.body).not.toHaveProperty('authorPrincipalId');
    expect(created.body).not.toHaveProperty('subjectAuthorPrincipalId');

    const replayed = await post('/community-notes', body, tenant, idempotencyKey);
    expect(replayed.status).toBe(200);
    expect(replayed.body.id).toBe(created.body.id);

    const conflicting = await post('/community-notes', { ...body, text: 'Otro texto' }, tenant, idempotencyKey);
    expect(conflicting.status).toBe(409);

    const audit = await auditEvents.find(tenant.tenant, { action: 'community_note.written', subjectId: created.body.id });
    expect(audit).toHaveLength(1);
  });

  it('refuses a second note by the same writer on the same subject', async () => {
    const body = noteBody({ authorPrincipalId: 'writer_twice' });
    expect((await post('/community-notes', body)).status).toBe(201);
    const second = await post('/community-notes', { ...body, text: 'Una reescritura' });
    expect(second.status).toBe(409);
  });

  it('caps notes per writer per day', async () => {
    for (let index = 0; index < service.NOTES_PER_AUTHOR_PER_DAY; index += 1) {
      expect((await post('/community-notes', noteBody({ authorPrincipalId: 'prolific' }))).status).toBe(201);
    }
    const capped = await post('/community-notes', noteBody({ authorPrincipalId: 'prolific' }));
    expect(capped.status).toBe(429);
  });

  it('lets only the writer withdraw, once, and announces it', async () => {
    const created = await post('/community-notes', noteBody({ authorPrincipalId: 'withdrawer' }));
    const noteId = created.body.id as string;

    expect((await post(`/community-notes/${noteId}/withdraw`, { authorPrincipalId: 'someone_else' })).status).toBe(404);
    expect((await post('/community-notes/not-an-id/withdraw', { authorPrincipalId: 'withdrawer' })).status).toBe(404);

    const withdrawn = await post(`/community-notes/${noteId}/withdraw`, { authorPrincipalId: 'withdrawer' });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe('withdrawn');

    const again = await post(`/community-notes/${noteId}/withdraw`, { authorPrincipalId: 'withdrawer' });
    expect(again.status).toBe(200);
    const announced = await outboxEvents.find({
      type: OUTBOX_EVENT_TYPES.communityNoteStatusChanged,
      'payload.communityNoteId': noteId,
    });
    expect(announced).toHaveLength(1);

    const mine = { webhookEndpointId, eventType: 'community_note.status_changed' };
    await drainUntil(
      async () =>
        (await webhookDeliveries.find(mine)).some((delivery) => JSON.parse(delivery.body).data.noteId === noteId),
      'a withdrawal delivery',
    );
    const delivery = (await webhookDeliveries.find(mine)).find((row) => JSON.parse(row.body).data.noteId === noteId);
    const payload = JSON.parse(delivery?.body ?? '{}');
    expect(payload.data).toEqual({
      noteId,
      externalSubjectId: created.body.externalSubjectId,
      authorPrincipalId: 'withdrawer',
      previousStatus: 'needs_ratings',
      status: 'withdrawn',
    });
    expect(JSON.stringify(payload)).not.toContain(created.body.text);
  });
});

describe('the assignment door', () => {
  it('draws only notes the rater may rate, and a retry returns the same batch', async () => {
    const own = await post('/community-notes', noteBody({ authorPrincipalId: 'door_rater', language: 'ca' }));
    const onOwnSubject = await post(
      '/community-notes',
      noteBody({ subjectAuthorPrincipalId: 'door_rater', authorPrincipalId: 'door_writer_1', language: 'ca' }),
    );
    const otherLanguage = await post('/community-notes', noteBody({ authorPrincipalId: 'door_writer_2', language: 'ja' }));
    const eligible = await post('/community-notes', noteBody({ authorPrincipalId: 'door_writer_3', language: 'ca-ES' }));

    const idempotencyKey = key('assign');
    const drawn = await post('/community-notes/assignments', { raterPrincipalId: 'door_rater', languages: ['ca'] }, tenant, idempotencyKey);
    expect(drawn.status).toBe(200);
    const noteIds = drawn.body.assignments.map((assignment: { note: { id: string } }) => assignment.note.id);
    expect(noteIds).toContain(eligible.body.id);
    expect(noteIds).not.toContain(own.body.id);
    expect(noteIds).not.toContain(onOwnSubject.body.id);
    expect(noteIds).not.toContain(otherLanguage.body.id);

    const replayed = await post('/community-notes/assignments', { raterPrincipalId: 'door_rater', languages: ['ca'] }, tenant, idempotencyKey);
    expect(replayed.body.assignments.map((assignment: { id: string }) => assignment.id)).toEqual(
      drawn.body.assignments.map((assignment: { id: string }) => assignment.id),
    );

    const fresh = await post('/community-notes/assignments', { raterPrincipalId: 'door_rater', languages: ['ca'] });
    expect(fresh.body.assignments.map((assignment: { note: { id: string } }) => assignment.note.id)).not.toContain(eligible.body.id);

    expect((await post('/community-notes/assignments', { raterPrincipalId: 'door_rater', languages: [] })).status).toBe(400);
  });

  it('refuses a rating without an assignment, and accepts one with it — once', async () => {
    const note = await post('/community-notes', noteBody({ authorPrincipalId: 'rated_writer', language: 'eu' }));
    const noteId = note.body.id as string;
    const rating = { raterPrincipalId: 'eu_rater', rating: 'helpful', reasons: ['reliable_source'] };

    expect((await post(`/community-notes/${noteId}/ratings`, rating)).status).toBe(403);
    expect((await post('/community-notes/cnt_00000000000000000000000000000000/ratings', rating)).status).toBe(404);
    expect((await post('/community-notes/nope/ratings', rating)).status).toBe(404);
    expect((await post(`/community-notes/${noteId}/ratings`, { ...rating, reasons: ['incorrect'] })).status).toBe(400);

    await post('/community-notes/assignments', { raterPrincipalId: 'eu_rater', languages: ['eu'] });

    const idempotencyKey = key('rate');
    const created = await post(`/community-notes/${noteId}/ratings`, rating, tenant, idempotencyKey);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ noteId, rating: 'helpful', reasons: ['reliable_source'] });

    const replayed = await post(`/community-notes/${noteId}/ratings`, rating, tenant, idempotencyKey);
    expect(replayed.status).toBe(200);
    expect(replayed.body.id).toBe(created.body.id);

    const conflicting = await post(
      `/community-notes/${noteId}/ratings`,
      { ...rating, rating: 'not_helpful', reasons: ['incorrect'] },
      tenant,
      idempotencyKey,
    );
    expect(conflicting.status).toBe(409);

    const twice = await post(`/community-notes/${noteId}/ratings`, rating);
    expect(twice.status).toBe(409);

    const rated = await outboxEvents.find({ type: OUTBOX_EVENT_TYPES.communityNoteRated, 'payload.communityNoteId': noteId });
    expect(rated).toHaveLength(1);
  });

  it('refuses a rating on an expired assignment, and reissues the note later', async () => {
    const note = await post('/community-notes', noteBody({ authorPrincipalId: 'slow_writer', language: 'gl' }));
    const noteId = note.body.id as string;
    const issuedAt = new Date(Date.now() - 2 * service.ASSIGNMENT_TTL_MS);
    const first = await service.issueCommunityNoteAssignments(
      tenant.tenant,
      { raterPrincipalId: 'slow_rater', languages: ['gl'] },
      writeKey(key('old')),
      issuedAt,
    );
    expect(first.map((assignment) => assignment.note.id)).toContain(noteId);

    const late = await post(`/community-notes/${noteId}/ratings`, {
      raterPrincipalId: 'slow_rater',
      rating: 'not_helpful',
      reasons: ['not_needed'],
    });
    expect(late.status).toBe(409);

    const reissued = await post('/community-notes/assignments', { raterPrincipalId: 'slow_rater', languages: ['gl'] });
    expect(reissued.body.assignments.map((assignment: { note: { id: string } }) => assignment.note.id)).toContain(noteId);
    const onTime = await post(`/community-notes/${noteId}/ratings`, {
      raterPrincipalId: 'slow_rater',
      rating: 'not_helpful',
      reasons: ['not_needed'],
    });
    expect(onTime.status).toBe(201);
  });

  it('refuses a rating on a withdrawn note', async () => {
    const note = await post('/community-notes', noteBody({ authorPrincipalId: 'regretful', language: 'oc' }));
    const noteId = note.body.id as string;
    await post('/community-notes/assignments', { raterPrincipalId: 'oc_rater', languages: ['oc'] });
    await post(`/community-notes/${noteId}/withdraw`, { authorPrincipalId: 'regretful' });
    const rated = await post(`/community-notes/${noteId}/ratings`, {
      raterPrincipalId: 'oc_rater',
      rating: 'helpful',
      reasons: ['relevant'],
    });
    expect(rated.status).toBe(409);
  });
});

describe('scoring, the shown lookup and the status webhook', () => {
  const left = Array.from({ length: 6 }, (_, index) => `bridge_left_${index}`);
  const right = Array.from({ length: 6 }, (_, index) => `bridge_right_${index}`);
  const notes: Record<string, { id: string; externalSubjectId: string }> = {};

  beforeAll(async () => {
    const write = async (label: string) => {
      const written = await service.writeCommunityNote(
        tenant.tenant,
        noteBody({ authorPrincipalId: `author_${label}`, language: 'nl', text: `Context ${label}` }),
        writeKey(key(label)),
      );
      notes[label] = { id: written.note.noteId, externalSubjectId: written.note.externalSubjectId };
    };
    for (const label of ['bridging', 'left_0', 'left_1', 'right_0', 'right_1']) await write(label);

    const verdict = (label: string, camp: 'left' | 'right'): boolean =>
      label === 'bridging' || label.startsWith(camp);

    for (const [camp, raters] of [['left', left], ['right', right]] as const) {
      for (const rater of raters) {
        const assignments = await service.issueCommunityNoteAssignments(
          tenant.tenant,
          { raterPrincipalId: rater, languages: ['nl'], limit: 10 },
          writeKey(key(rater)),
        );
        for (const [label, note] of Object.entries(notes)) {
          if (!assignments.some((assignment) => assignment.note.id === note.id)) continue;
          const helpful = verdict(label, camp);
          await service.rateCommunityNote(
            tenant.tenant,
            note.id,
            helpful
              ? { raterPrincipalId: rater, rating: 'helpful', reasons: ['full_explanation'] }
              : { raterPrincipalId: rater, rating: 'not_helpful', reasons: ['opinion_or_biased'] },
            writeKey(key(`${rater}-${label}`)),
          );
        }
      }
    }
  });

  it('shows the note both camps found helpful, and only that one', async () => {
    const bridging = notes.bridging as { id: string; externalSubjectId: string };
    await drainUntil(async () => {
      const shown = await get(`/community-notes/shown?subjects=${bridging.externalSubjectId}`);
      return shown.body.notes?.length === 1;
    }, 'the bridging note to be shown');

    const subjects = Object.values(notes).map((note) => note.externalSubjectId).join(',');
    const shown = await get(`/community-notes/shown?subjects=${subjects}`);
    expect(shown.status).toBe(200);
    expect(shown.body.notes.map((note: { id: string }) => note.id)).toEqual([bridging.id]);

    const revisions = await withTransaction((session) =>
      withTenantTransaction(session, tenant.tenant, (tx) => findCommunityNoteRevisions(tx, bridging.id)),
    );
    const last = revisions.at(-1);
    expect(last).toMatchObject({ status: 'shown', algorithmVersion: 'mf-1' });
    expect(last?.noteIntercept).toBeGreaterThan(0.4);
  });

  it('announces the note becoming shown', async () => {
    const bridging = notes.bridging as { id: string };
    const mine = { webhookEndpointId, eventType: 'community_note.status_changed' };
    const shownDelivery = async () =>
      (await webhookDeliveries.find(mine)).find((row) => {
        const data = JSON.parse(row.body).data;
        return data.noteId === bridging.id && data.status === 'shown';
      });
    await drainUntil(async () => (await shownDelivery()) !== undefined, 'a shown delivery');
    expect(JSON.parse((await shownDelivery())?.body ?? '{}').data.previousStatus).toBe('needs_ratings');
  });

  it('is a no-op to rescore again, and the worker refuses an event with no note', async () => {
    expect(await service.rescoreCommunityNotes(tenant.tenant)).toBe(0);
    await expect(
      handleCommunityNoteRated({
        eventId: 'evt_x',
        organizationId: tenant.organizationId,
        applicationId: tenant.applicationId,
        type: OUTBOX_EVENT_TYPES.communityNoteRated,
        payload: {},
        status: 'pending',
        attempts: 0,
        availableAt: new Date(),
        dispatchedAt: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(/communityNoteId/);
  });

  it('refuses to fan out a status event that names no note or no revision', async () => {
    const orphan = (payload: Record<string, unknown>) => ({
      eventId: `evt_orphan_${(sequence += 1)}`,
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      type: OUTBOX_EVENT_TYPES.communityNoteStatusChanged,
      payload,
      status: 'pending' as const,
      attempts: 0,
      availableAt: new Date(),
      dispatchedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(fanOutWebhookEvent(orphan({ communityNoteRevision: 2 }))).rejects.toThrow(/could not be read/);
    await expect(fanOutWebhookEvent(orphan({ communityNoteId: notes.bridging?.id }))).rejects.toThrow(/could not be read/);
  });

  it('builds no status change for a note or revision that does not exist', async () => {
    const bridging = notes.bridging as { id: string };
    expect(await service.communityNoteStatusChange(tenant.tenant, 'cnt_missing', 2)).toBeNull();
    expect(await service.communityNoteStatusChange(tenant.tenant, bridging.id, 99)).toBeNull();
  });

  it("lists a writer's notes and a rater's ratings, and nobody else's", async () => {
    const written = await get('/community-notes/principals/author_bridging/notes');
    expect(written.status).toBe(200);
    expect(written.body.notes.map((note: { id: string }) => note.id)).toEqual([notes.bridging?.id]);

    const ratings = await get(`/community-notes/principals/${left[0]}/ratings`);
    expect(ratings.status).toBe(200);
    expect(ratings.body.ratings).toHaveLength(Object.keys(notes).length);
    expect(ratings.body.ratings[0]).toHaveProperty('note.text');

    expect((await get('/community-notes/principals/bad%20id/notes')).status).toBe(400);
  });

  it('validates the subjects of a lookup', async () => {
    expect((await get('/community-notes/shown')).status).toBe(400);
    expect((await get(`/community-notes/shown?subjects=${Array.from({ length: 51 }, (_, i) => `s${i}`).join(',')}`)).status).toBe(400);
    expect((await get('/community-notes/shown?subjects=bad%20id')).status).toBe(400);
  });

  it("never shows one application's notes to another, even in the same organization", async () => {
    const bridging = notes.bridging as { id: string; externalSubjectId: string };
    const shown = await get(`/community-notes/shown?subjects=${bridging.externalSubjectId}`, sibling);
    expect(shown.body.notes).toEqual([]);
    const rated = await post(
      `/community-notes/${bridging.id}/ratings`,
      { raterPrincipalId: 'intruder', rating: 'helpful', reasons: ['relevant'] },
      sibling,
    );
    expect(rated.status).toBe(404);
  });
});
