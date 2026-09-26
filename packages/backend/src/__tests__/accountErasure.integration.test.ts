import { randomBytes, randomUUID } from 'node:crypto';

import { CaseEnvelopeSchema } from '@crowdsource.you/contracts';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Erasing a deleted Oxy account end to end (`docs/architecture/account-erasure.md`,
 * OxyHQ/Mention#1178): one person seeded into every place this service can
 * hold their id — as a reporter and as a reported author in two tenants, as a
 * community-note writer, rater and subject, as an appellant, in both audit
 * trails, in the console, as a reviewer, and in a webhook body — then erased.
 *
 * The strongest assertion is the last one: after the run, no row in any table
 * except the ledger contains the id at all, read table by table and tenant by
 * tenant. A new place the id can land fails it until erasure decides what
 * happens there.
 */

const { createApp } = await import('../app');
const { getPostgresDatabase } = await import('../db/postgres/database');
const { withTenant } = await import('../db/postgres/withTenant');
const { TENANT_SCOPED_TABLES, UNSCOPED_TABLES } = await import('../db/postgres/tableRegistry');
const schema = await import('../db/postgres/schema');
const { declareReviewerRelation, recordCoService } = await import('../db/postgres/repositories/reviewers');
const { findDueAssignments } = await import('../db/postgres/repositories/sortition');
const { recordAccountErasure, findAccountErasure } = await import('../db/postgres/repositories/accountErasure');
const { withTransaction } = await import('../db/transaction');
const { eraseAccount, processAccountErasure } = await import('../modules/accountErasure/accountErasure.service');
const { principalReporterKey, reporterFingerprint } = await import('../modules/cases/case.service');
const { provisionTenant, sampleEnvelope, startDatabase } = await import('./support/tenants');
const { createReviewer } = await import('./support/reviewers');
const { reviewerAxesFor } = await import('./support/reviewerAxes');
type ProvisionedTenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();
const db = getPostgresDatabase();
const axis = reviewerAxesFor(import.meta.url);

/** Oxy-shaped ids no other suite could have written. */
const PERSON = randomBytes(12).toString('hex');
const OTHER = randomBytes(12).toString('hex');
const EVENT = randomUUID();
const SCOPES = [
  'crowdsource:reports:write',
  'crowdsource:reports:read',
  'crowdsource:cases:read',
  'crowdsource:community-notes:write',
  'crowdsource:community-notes:read',
] as const;

let tenant: ProvisionedTenant;
let sibling: ProvisionedTenant;
let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${(sequence += 1)}`;

function post(path: string, body: unknown, as: ProvisionedTenant = tenant) {
  return request(app)
    .post(`/v1${path}`)
    .set('Authorization', `Bearer ${as.token}`)
    .set('Idempotency-Key', unique('key'))
    .send(body as object);
}

interface Party {
  readonly type: 'oxy_user' | 'local_user';
  readonly id: string;
}

const binding = (ref: string, party: Party) => ({
  principalRef: ref,
  type: party.type,
  externalPrincipalId: party.id,
  ...(party.type === 'oxy_user' ? { bindingProofId: party.id } : {}),
});

/** Files one report and answers its report and case ids. */
async function report(
  as: ProvisionedTenant,
  parties: { reporter: Party; author: Party },
  details: string,
): Promise<{ reportId: string; caseId: string }> {
  const externalReportId = unique('report');
  const base = sampleEnvelope({
    applicationId: as.applicationId,
    externalReportId,
    subjectExternalId: unique('post'),
    text: `material ${externalReportId}`,
  });
  const envelope = CaseEnvelopeSchema.parse({
    ...base,
    principalBindings: [binding('author_1', parties.author), binding('reporter_1', parties.reporter)],
    allegations: [{ code: 'harassment.targeted_abuse', reporterPrincipalRef: 'reporter_1', details }],
  });
  const response = await post('/reports', { externalReportId, envelope }, as);
  expect(response.status).toBe(202);
  return { reportId: response.body.reportId, caseId: response.body.caseId };
}

async function storedReport(as: ProvisionedTenant, reportId: string) {
  return await withTenant(db, as.tenant, async (tx) => {
    const [row] = await tx.select().from(schema.reports).where(eq(schema.reports.reportId, reportId));
    return row;
  });
}

async function storedCase(as: ProvisionedTenant, caseId: string) {
  return await withTenant(db, as.tenant, async (tx) => {
    const [row] = await tx.select().from(schema.cases).where(eq(schema.cases.caseId, caseId));
    return row;
  });
}

/** Rows of `table` whose whole text contains `needle`, under `as` or unscoped. */
async function rowsContaining(table: string, needle: string, as?: ProvisionedTenant): Promise<number> {
  const count = async (handle: typeof db) => {
    const result = await handle.execute(
      sql`select count(*)::int as n from ${sql.identifier(table)} as t where t::text like ${`%${needle}%`}`,
    );
    return Number((result as unknown as { n: number }[])[0]?.n ?? 0);
  };
  return as === undefined ? await count(db) : await withTenant(db, as.tenant, (tx) => count(tx as unknown as typeof db));
}

async function rowsNamingAnywhere(needle: string): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const table of TENANT_SCOPED_TABLES) {
    for (const as of [tenant, sibling]) {
      const n = await rowsContaining(table, needle, as);
      if (n > 0) found[table] = (found[table] ?? 0) + n;
    }
  }
  for (const table of Object.keys(UNSCOPED_TABLES)) {
    if (table === 'account_erasures') continue;
    const n = await rowsContaining(table, needle);
    if (n > 0) found[table] = n;
  }
  return found;
}

const seeded: {
  asReporter?: { reportId: string; caseId: string };
  asAuthor?: { reportId: string; caseId: string };
  inSibling?: { reportId: string; caseId: string };
  unrelated?: { reportId: string; caseId: string };
  ownNote?: string;
  noteAboutPerson?: string;
  othersNote?: string;
  appealId?: string;
  reviewerId?: string;
  bystanderReviewerId?: string;
  assignmentId?: string;
  reviewId?: string;
} = {};

beforeAll(async () => {
  await startDatabase();
  tenant = await provisionTenant(SCOPES);
  sibling = await provisionTenant(SCOPES);
  const person: Party = { type: 'oxy_user', id: PERSON };
  const other: Party = { type: 'oxy_user', id: OTHER };

  // Reports: the person as reporter, as author, under an application that uses
  // the Oxy id as a plain principal id, and one report that never names them.
  seeded.asReporter = await report(tenant, { reporter: person, author: other }, 'the person’s own words');
  seeded.asAuthor = await report(tenant, { reporter: other, author: person }, 'someone else’s words');
  seeded.inSibling = await report(
    sibling,
    { reporter: { type: 'local_user', id: PERSON }, author: { type: 'local_user', id: 'sibling_author' } },
    'the person again',
  );
  seeded.unrelated = await report(tenant, { reporter: other, author: { type: 'local_user', id: 'x' } }, 'unrelated');

  // Community notes: the person's own note, a note about their post, another
  // note they rate, and someone else rating the person's note.
  const note = (body: Record<string, unknown>) =>
    post('/community-notes', {
      externalSubjectId: unique('subject'),
      subjectAuthorPrincipalId: 'someone',
      language: 'eu',
      text: 'Text of a note.',
      sourceUrls: ['https://example.com/source'],
      ...body,
    });
  seeded.ownNote = (await note({ authorPrincipalId: PERSON })).body.id;
  seeded.noteAboutPerson = (await note({ authorPrincipalId: OTHER, subjectAuthorPrincipalId: PERSON })).body.id;
  seeded.othersNote = (await note({ authorPrincipalId: OTHER })).body.id;
  const rating = (rater: string, noteId: string | undefined) =>
    post(`/community-notes/${noteId}/ratings`, { raterPrincipalId: rater, rating: 'helpful', reasons: ['reliable_source'] });
  expect((await post('/community-notes/assignments', { raterPrincipalId: PERSON, languages: ['eu'] })).status).toBe(200);
  expect((await rating(PERSON, seeded.othersNote)).status).toBe(201);
  expect((await post('/community-notes/assignments', { raterPrincipalId: 'rater_b', languages: ['eu'] })).status).toBe(200);
  expect((await rating('rater_b', seeded.ownNote)).status).toBe(201);

  // An appeal the person filed, and the tenant's audit trail naming them.
  seeded.appealId = `apl_${randomUUID().replace(/-/g, '')}`;
  await withTenant(db, tenant.tenant, async (tx) => {
    await tx.insert(schema.appeals).values({
      appealId: seeded.appealId as string,
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      caseId: seeded.asAuthor?.caseId as string,
      supersededRevision: 1,
      supersededDecisionId: 'dec_test',
      openedRevision: 2,
      reason: 'context_missing',
      appellantExternalPrincipalId: PERSON,
      authorContext: { statement: 'the person’s appeal statement' },
      previousRequiredVotes: 3,
      severeAction: false,
      requiredAgreeingVotes: 4,
      idempotencyKey: unique('appeal'),
      payloadHash: 'sha256:test',
      filedAt: new Date(),
      filedByCredentialId: 'csk_test',
    });
    await tx.insert(schema.auditEvents).values({
      auditId: `aud_${randomUUID().replace(/-/g, '')}`,
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      action: 'case.read',
      actorOxyUserId: PERSON,
      occurredAt: new Date(),
    });
  });

  // The console: a membership, an invitation the person sent, a staff role,
  // the operator trail, and a standing change they made.
  await db.insert(schema.organizationMembers).values([
    {
      membershipId: `mem_${randomUUID().replace(/-/g, '')}`,
      organizationId: tenant.organizationId,
      oxyUserId: PERSON,
      roles: ['owner'],
      status: 'active',
    },
    {
      membershipId: `mem_${randomUUID().replace(/-/g, '')}`,
      organizationId: tenant.organizationId,
      oxyUserId: OTHER,
      roles: ['viewer'],
      status: 'active',
      invitedByOxyUserId: PERSON,
    },
  ]);
  await db.insert(schema.trustSafetyStaff).values({ oxyUserId: PERSON, roles: ['policy'], status: 'active' });
  await db.insert(schema.staffAuditEvents).values({
    staffAuditId: `sta_${randomUUID().replace(/-/g, '')}`,
    action: 'staff.metrics.read',
    actorOxyUserId: PERSON,
    roles: ['policy'],
    applicationId: null,
    occurredAt: new Date(),
  });
  await db
    .update(schema.appTrustSnapshots)
    .set({ standingChangedByOxyUserId: PERSON })
    .where(eq(schema.appTrustSnapshots.applicationId, tenant.applicationId));

  // The person as a reviewer: a link to their application account, a declared
  // conflict, a co-service pair, an open seat and a review with notes. And a
  // bystander reviewer who declared a conflict WITH the person's account.
  const { family, language } = axis('erased');
  const reviewer = await createReviewer({
    family,
    languages: [language],
    principalLinks: [{ applicationId: tenant.applicationId, externalPrincipalId: PERSON }],
  });
  await db.update(schema.reviewerProfiles).set({ oxyUserId: PERSON }).where(eq(schema.reviewerProfiles.reviewerId, reviewer.reviewerId));
  seeded.reviewerId = reviewer.reviewerId;
  const bystander = await createReviewer({ family, languages: [language] });
  seeded.bystanderReviewerId = bystander.reviewerId;
  await declareReviewerRelation(db, {
    reviewerId: reviewer.reviewerId,
    applicationId: tenant.applicationId,
    externalPrincipalId: OTHER,
    source: 'declared',
  });
  await declareReviewerRelation(db, {
    reviewerId: bystander.reviewerId,
    applicationId: tenant.applicationId,
    externalPrincipalId: PERSON,
    source: 'declared',
  });
  await withTransaction((tx) =>
    recordCoService(tx, `${reviewer.reviewerId}:${bystander.reviewerId}`, reviewer.reviewerId, bystander.reviewerId, new Date()),
  );
  seeded.assignmentId = `asg_${randomUUID().replace(/-/g, '')}`;
  seeded.reviewId = `rev_${randomUUID().replace(/-/g, '')}`;
  const stamp = {
    organizationId: tenant.organizationId,
    applicationId: tenant.applicationId,
    caseId: seeded.asReporter?.caseId as string,
    caseRevision: 1,
  };
  await db.insert(schema.assignments).values([
    {
      ...stamp,
      assignmentId: seeded.assignmentId,
      drawId: 'drw_test',
      reviewerId: reviewer.reviewerId,
      slotType: 'reliable_general',
      filledAs: 'reliable_general',
      status: 'accepted',
      tokenHash: 'hash',
      sensitivityClass: 'standard',
      offeredAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  ]);
  await db.insert(schema.reviews).values({
    ...stamp,
    caseRevision: 0,
    reviewId: seeded.reviewId,
    assignmentId: `asg_${randomUUID().replace(/-/g, '')}`,
    reviewerId: reviewer.reviewerId,
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    findings: [],
    recommendedActions: [],
    notes: 'the reviewer’s own notes',
    submittedAt: new Date(),
  });

  // Webhook bodies: one naming the person as a note writer, one not.
  const delivery = (authorPrincipalId: string) => ({
    deliveryId: `whd_${randomUUID().replace(/-/g, '')}`,
    organizationId: tenant.organizationId,
    applicationId: tenant.applicationId,
    webhookEndpointId: 'whe_test',
    eventId: randomUUID(),
    eventType: 'community_note.status_changed',
    body: JSON.stringify({ type: 'community_note.status_changed', data: { noteId: 'cnt_x', authorPrincipalId } }),
    status: 'succeeded',
    attemptCount: 1,
    cycleAttemptCount: 1,
    replayCount: 0,
  });
  await db.insert(schema.webhookDeliveries).values([delivery(PERSON), delivery(OTHER)]);

  await recordAccountErasure(db, {
    eventId: EVENT,
    oxyUserId: PERSON,
    source: 'webhook',
    occurredAt: new Date(),
    retained: false,
  });
});

afterAll(async () => {
  // Nothing may leave a due seat behind for another suite's expiry sweep.
  if (seeded.assignmentId) {
    await db.update(schema.assignments).set({ status: 'expired' }).where(eq(schema.assignments.assignmentId, seeded.assignmentId));
  }
});

describe('before the erasure', () => {
  it('found the person in every place the suite seeded', async () => {
    const found = await rowsNamingAnywhere(PERSON);
    expect(Object.keys(found).sort()).toEqual(
      [
        'appeals',
        'app_trust_snapshots',
        'audit_events',
        'cases',
        'community_note_assignments',
        'community_note_ratings',
        'community_notes',
        'organization_members',
        'reports',
        'reviewer_principal_links',
        'reviewer_profiles',
        'reviewer_relations',
        'staff_audit_events',
        'trust_safety_staff',
        'webhook_deliveries',
      ].sort(),
    );
  });
});

describe('the erasure', () => {
  let counts: Record<string, number> = {};

  beforeAll(async () => {
    expect(await processAccountErasure(EVENT)).toBe('completed');
    const row = await findAccountErasure(db, EVENT);
    expect(row).toMatchObject({ status: 'completed', attempts: 1, lastError: null, leaseUntil: null });
    counts = row?.counts ?? {};
  });

  it('leaves no row anywhere but the ledger that contains the id', async () => {
    expect(await rowsNamingAnywhere(PERSON)).toEqual({});
  });

  it('counts what it did, and only counts', () => {
    expect(counts).toMatchObject({
      'reports.rewritten': 3,
      'reports.bindingsAnonymised': 3,
      'reports.reporterDetailsCleared': 2,
      'cases.rewritten': 3,
      'communityNotes.deleted': 1,
      'communityNotes.ratingsOfDeletedNotes': 1,
      'communityNotes.ratingsDeleted': 1,
      'communityNotes.subjectAuthorAnonymised': 1,
      'appeals.appellantAnonymised': 1,
      'auditEvents.actorAnonymised': 1,
      'webhookDeliveries.bodiesAnonymised': 1,
      'reviewers.relationsNamingAccountDeleted': 1,
      'reviewers.linksNamingAccountDeleted': 1,
      'console.membershipsDeleted': 1,
      'console.invitationsAnonymised': 1,
      'console.staffDeleted': 1,
      'console.staffAuditAnonymised': 1,
      'console.standingChangesAnonymised': 1,
      'reviewer.assignmentsVacated': 1,
      'reviewer.relationsDeleted': 1,
      'reviewer.affinitiesDeleted': 1,
      'reviewer.reviewNotesCleared': 1,
      'reviewer.profilesAnonymised': 1,
    });
    expect(JSON.stringify(counts)).not.toContain(PERSON);
  });

  it('keeps the reports as moderation records, without the person or their words', async () => {
    const asReporter = await storedReport(tenant, seeded.asReporter?.reportId as string);
    const envelope = CaseEnvelopeSchema.parse(asReporter?.envelope);
    expect(envelope.principalBindings[1]).toEqual({
      principalRef: 'reporter_1',
      type: 'oxy_user',
      externalPrincipalId: 'erased-account',
      bindingProofId: 'erased-account',
    });
    expect(envelope.allegations[0]).not.toHaveProperty('details');
    expect(envelope.principalBindings[0].externalPrincipalId).toBe(OTHER);

    const asAuthor = CaseEnvelopeSchema.parse((await storedReport(tenant, seeded.asAuthor?.reportId as string))?.envelope);
    expect(asAuthor.principalBindings[0].externalPrincipalId).toBe('erased-account');
    // Another reporter's words about the material stay, and so does the material.
    expect(asAuthor.allegations[0].details).toBe('someone else’s words');
    expect(asAuthor.resources[0]).toMatchObject({ type: 'text' });

    const unrelated = await storedReport(tenant, seeded.unrelated?.reportId as string);
    expect(JSON.stringify(unrelated?.envelope)).toContain('unrelated');
    expect(JSON.stringify(unrelated?.envelope)).toContain(OTHER);
  });

  it('keeps each case counting the same reporters, with the person’s fingerprint replaced', async () => {
    const personal = reporterFingerprint(tenant.applicationId, principalReporterKey(PERSON));
    const asReporter = await storedCase(tenant, seeded.asReporter?.caseId as string);
    expect(asReporter?.reporterFingerprints).toHaveLength(1);
    expect(asReporter?.reporterFingerprints).not.toContain(personal);

    const asAuthor = await storedCase(tenant, seeded.asAuthor?.caseId as string);
    expect(JSON.stringify(asAuthor?.contentSnapshot)).toContain('erased-account');
  });

  it('deletes the person’s notes and ratings, and keeps other people’s notes about them', async () => {
    await withTenant(db, tenant.tenant, async (tx) => {
      const notes = await tx
        .select()
        .from(schema.communityNotes)
        .where(eq(schema.communityNotes.applicationId, tenant.applicationId));
      const byId = new Map(notes.map((note) => [note.noteId, note]));
      expect(byId.has(seeded.ownNote as string)).toBe(false);
      expect(byId.get(seeded.noteAboutPerson as string)?.subjectAuthorPrincipalId).toBe('erased-account');
      expect(byId.get(seeded.othersNote as string)?.text).toBe('Text of a note.');

      const ratings = await tx.select().from(schema.communityNoteRatings);
      expect(ratings.filter((rating) => rating.raterPrincipalId === PERSON)).toHaveLength(0);
      expect(ratings.filter((rating) => rating.noteId === seeded.ownNote)).toHaveLength(0);
      const revisions = await tx
        .select()
        .from(schema.communityNoteStatusRevisions)
        .where(eq(schema.communityNoteStatusRevisions.noteId, seeded.ownNote as string));
      expect(revisions).toHaveLength(0);
    });
  });

  it('keeps the appeal without its appellant or their statement', async () => {
    await withTenant(db, tenant.tenant, async (tx) => {
      const [appeal] = await tx.select().from(schema.appeals).where(eq(schema.appeals.appealId, seeded.appealId as string));
      expect(appeal).toMatchObject({ appellantExternalPrincipalId: 'erased-account', authorContext: null });
    });
  });

  it('takes away console access and keeps the operator trail, actor replaced', async () => {
    const members = await db
      .select()
      .from(schema.organizationMembers)
      .where(eq(schema.organizationMembers.organizationId, tenant.organizationId));
    expect(members.map((member) => member.oxyUserId)).toEqual([OTHER]);
    expect(members[0]?.invitedByOxyUserId).toBe('erased-account');
    expect(await db.select().from(schema.trustSafetyStaff).where(eq(schema.trustSafetyStaff.oxyUserId, PERSON))).toHaveLength(0);
    const [trust] = await db
      .select()
      .from(schema.appTrustSnapshots)
      .where(eq(schema.appTrustSnapshots.applicationId, tenant.applicationId));
    expect(trust?.standingChangedByOxyUserId).toBe('erased-account');
  });

  it('detaches the reviewer, keeps the ballot, and makes the open seat due for the sweep', async () => {
    const [profile] = await db
      .select()
      .from(schema.reviewerProfiles)
      .where(eq(schema.reviewerProfiles.reviewerId, seeded.reviewerId as string));
    expect(profile).toMatchObject({
      oxyUserId: `erased-${seeded.reviewerId}`,
      accountActive: false,
      available: false,
      languages: [],
      categories: [],
      // Kept: a case still being counted reads these to count a cast ballot.
      state: 'community',
    });

    const [review] = await db.select().from(schema.reviews).where(eq(schema.reviews.reviewId, seeded.reviewId as string));
    expect(review).toMatchObject({ outcome: 'violation', notes: null });

    const due = await findDueAssignments(db, new Date(), 1000);
    expect(due.map((seat) => seat.assignmentId)).toContain(seeded.assignmentId);

    const bystanderRelations = await db
      .select()
      .from(schema.reviewerRelations)
      .where(eq(schema.reviewerRelations.reviewerId, seeded.bystanderReviewerId as string));
    expect(bystanderRelations).toHaveLength(0);
    const pairs = await db
      .select()
      .from(schema.reviewerAffinities)
      .where(eq(schema.reviewerAffinities.reviewerIdB, seeded.bystanderReviewerId as string));
    expect(pairs).toHaveLength(0);
  });

  it('rewrites the webhook body that named the person, and no other', async () => {
    const rows = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(and(eq(schema.webhookDeliveries.applicationId, tenant.applicationId), eq(schema.webhookDeliveries.webhookEndpointId, 'whe_test')));
    const writers = rows.map((row) => JSON.parse(row.body).data.authorPrincipalId).sort();
    expect(writers).toEqual(['erased-account', OTHER].sort());
  });

  it('is a no-op the second time, and never claims a completed row again', async () => {
    expect(await eraseAccount(PERSON, EVENT)).toEqual({});
    expect(await processAccountErasure(EVENT)).toBe('skipped');
  });

  it('touches nothing of another person', async () => {
    expect(Object.keys(await rowsNamingAnywhere(OTHER)).length).toBeGreaterThan(3);
    expect(await eraseAccount(randomBytes(12).toString('hex'), randomUUID())).toEqual({});
  });
});
