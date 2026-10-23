import { createHmac, randomUUID } from 'node:crypto';

import type { Resource } from '@crowdsource.you/contracts';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

/**
 * Oxy file references for a case's evidence (oxy ADR 0043;
 * `docs/architecture/evidence-files.md`), end to end against real PostgreSQL:
 * the ownership check at ingress, the reference worker, the file-events
 * receiver, the review package's withholding, and the nightly reconciliation.
 *
 * Oxy Files itself is the in-memory double of `support/oxyFiles.ts`, which
 * answers as the Oxy API does for one of Oxy's own applications.
 */

const SECRET = 'whsec_evidence_files_test';
process.env.OXY_FILES_WEBHOOK_SECRET = SECRET;

const { createApp } = await import('../app');
const { config } = await import('../config');
const { getPostgresDatabase } = await import('../db/postgres/database');
const repository = await import('../db/postgres/repositories/evidenceFiles');
const { caseEvidenceFiles, oxyFileEvents, oxyFileReconciliations } = await import(
  '../db/postgres/schema/evidence'
);
const { applications } = await import('../modules/tenancy/tenancy.collections');
const { withheldReason } = await import('../modules/evidence/evidenceFiles');
const references = await import('../modules/evidence/evidenceReferences');
const { postgresControl } = await import('./support/postgresControl');
const { installOxyFiles } = await import('./support/oxyFiles');
const { deliveryBody, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);

type Tenant = Awaited<ReturnType<typeof provisionTenant>>;

const app = createApp();
const db = getPostgresDatabase();
const oxyFiles = installOxyFiles();

beforeAll(async () => {
  await startDatabase();
}, 120_000);

afterAll(async () => {
  await stopDatabase();
});

beforeEach(() => {
  oxyFiles.failing.clear();
  oxyFiles.hideOwners = false;
});

const fileId = (label: string) => `file_${label}_${randomUUID().replace(/-/g, '')}`;

function image(id: string, file: string, sha256: string): Resource {
  return {
    id,
    type: 'image',
    role: 'evidence',
    asset: { fileId: file, mimeType: 'image/png', sha256 },
  };
}

function deliver(tenant: Tenant, extraResources: Resource[], externalReportId?: string) {
  const reportId = externalReportId ?? `evidence-${randomUUID()}`;
  return request(app)
    .post('/v1/reports')
    .set('authorization', `Bearer ${tenant.token}`)
    .set('idempotency-key', `key-${reportId}`)
    .send(
      deliveryBody(tenant, reportId, {
        subjectExternalId: `post_${reportId}`,
        extraResources,
      }),
    );
}

async function rowsOf(caseId: string) {
  return db.select().from(caseEvidenceFiles).where(eq(caseEvidenceFiles.caseId, caseId));
}

async function rowOf(caseId: string, file: string) {
  const [row] = (await rowsOf(caseId)).filter((candidate) => candidate.fileId === file);
  if (!row) throw new Error(`no evidence row for ${file}`);
  return row;
}

/** A tenant, a case with one owned image, and its reference registered. */
async function caseWithImage(): Promise<{ tenant: Tenant; caseId: string; file: string }> {
  const tenant = await provisionTenant();
  const file = fileId('img');
  const sha256 = await oxyFiles.putForTenant(tenant.tenant, file, file);
  const response = await deliver(tenant, [image('res_image', file, sha256)]);
  expect(response.status).toBe(202);
  await references.drainEvidenceReferences();
  return { tenant, caseId: response.body.caseId as string, file };
}

function signed(event: object, secret = SECRET) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return request(app)
    .post('/webhooks/oxy/file-events')
    .set('content-type', 'application/json')
    .set('oxy-signature', `t=${t},v1=${signature}`)
    .send(body);
}

function fileEvent(
  file: string,
  type: string,
  status: string,
  visibility = 'unlisted',
  occurredAt = new Date(),
) {
  return {
    id: `fev_${randomUUID()}`,
    type,
    occurredAt: occurredAt.toISOString(),
    file: { id: file, ownerKind: 'account', visibility, status },
    references: [],
  };
}

async function auditsFor(caseId: string, action: string) {
  return postgresControl.collection('audit_events').find({ caseId, action }).toArray();
}

// ── 1. Ingress ──────────────────────────────────────────────────────────────

describe('submitting evidence: only the tenant’s own, active, declared bytes', () => {
  it('accepts a file the organization’s Oxy account owns, and owes it a reference', async () => {
    const tenant = await provisionTenant();
    const file = fileId('owned');
    const sha256 = await oxyFiles.putForTenant(tenant.tenant, file, 'owned bytes');

    const response = await deliver(tenant, [image('res_image', file, sha256)]);
    expect(response.status).toBe(202);

    const [row] = await rowsOf(response.body.caseId);
    expect(row).toMatchObject({
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      fileId: file,
      fileStatus: 'active',
      referenceState: 'pending',
    });
  });

  it('accepts a file the tenant’s BOUND Oxy application owns', async () => {
    const tenant = await provisionTenant();
    const oxyApplicationId = `oxy-app-${randomUUID()}`;
    await applications.updateOne({ applicationId: tenant.applicationId }, { oxyApplicationId });
    const file = fileId('app');
    const sha256 = oxyFiles.put(file, { application: oxyApplicationId }, 'app bytes');

    const response = await deliver(tenant, [image('res_image', file, sha256)]);
    expect(response.status).toBe(202);
  });

  it.each([
    ['another account’s file', 'other'],
    ['another application’s file', 'other-app'],
    ['a file Oxy does not know', 'missing'],
    ['a file in trash', 'trash'],
  ] as const)('refuses %s with one indistinguishable 422, audited', async (_name, kind) => {
    const tenant = await provisionTenant();
    const file = fileId(kind);
    let sha256 = `sha256:${'0'.repeat(64)}`;
    if (kind === 'other') sha256 = oxyFiles.put(file, { account: 'someone-else' }, file);
    if (kind === 'other-app') sha256 = oxyFiles.put(file, { application: 'another-app' }, file);
    if (kind === 'trash') {
      sha256 = await oxyFiles.putForTenant(tenant.tenant, file, file);
      const stored = oxyFiles.files.get(file);
      if (!stored) throw new Error('unreachable');
      oxyFiles.files.set(file, { ...stored, status: 'trash' });
    }

    const externalReportId = `refused-${randomUUID()}`;
    const response = await deliver(tenant, [image('res_image', file, sha256)], externalReportId);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('unprocessable_envelope');
    expect(response.body.error.message).toBe(
      'resources.1.asset.fileId is not an active Oxy file owned by this application or its organization.',
    );
    const refusals = await postgresControl
      .collection('audit_events')
      .find({ externalReportId, action: 'report.ingress.rejected' })
      .toArray();
    expect(refusals.map((row) => row.reason)).toEqual(['evidence_unverified']);
    const stored = await postgresControl.collection('reports').find({ externalReportId }).toArray();
    expect(stored).toHaveLength(0);
  });

  it('refuses a file whose stored SHA-256 is not the one declared', async () => {
    const tenant = await provisionTenant();
    const file = fileId('digest');
    await oxyFiles.putForTenant(tenant.tenant, file, 'the real bytes');

    const response = await deliver(tenant, [image('res_image', file, `sha256:${'a'.repeat(64)}`)]);

    expect(response.status).toBe(422);
    expect(response.body.error.message).toBe(
      'resources.1.asset.sha256 is not the SHA-256 of the Oxy file resources.1.asset.fileId names.',
    );
  });

  it('fails closed with a 503 when Oxy cannot be asked, storing nothing', async () => {
    const tenant = await provisionTenant();
    const file = fileId('down');
    const sha256 = await oxyFiles.putForTenant(tenant.tenant, file, file);
    oxyFiles.failing.add('metadata');

    const externalReportId = `down-${randomUUID()}`;
    const response = await deliver(tenant, [image('res_image', file, sha256)], externalReportId);

    expect(response.status).toBe(503);
    expect(
      await postgresControl.collection('reports').find({ externalReportId }).toArray(),
    ).toHaveLength(0);
  });

  it('fails closed with a 503 when Oxy does not reveal owners to this service', async () => {
    const tenant = await provisionTenant();
    const file = fileId('hidden');
    const sha256 = await oxyFiles.putForTenant(tenant.tenant, file, file);
    oxyFiles.hideOwners = true;

    const response = await deliver(tenant, [image('res_image', file, sha256)]);
    expect(response.status).toBe(503);
  });

  it('asks Oxy nothing for a report with no evidence files', async () => {
    const tenant = await provisionTenant();
    const before = oxyFiles.calls.metadata;
    oxyFiles.failing.add('metadata');

    const response = await deliver(tenant, []);

    expect(response.status).toBe(202);
    expect(oxyFiles.calls.metadata).toBe(before);
  });

  it('answers a retry of a stored report as a replay even after its file is gone', async () => {
    const tenant = await provisionTenant();
    const file = fileId('replay');
    const sha256 = await oxyFiles.putForTenant(tenant.tenant, file, file);
    const externalReportId = `replay-${randomUUID()}`;

    const first = await deliver(tenant, [image('res_image', file, sha256)], externalReportId);
    expect(first.status).toBe(202);

    oxyFiles.files.delete(file);
    const retry = await deliver(tenant, [image('res_image', file, sha256)], externalReportId);

    expect(retry.status).toBe(202);
    expect(retry.body.reportId).toBe(first.body.reportId);
    expect(retry.body.caseId).toBe(first.body.caseId);
  });

  it('gives a merged report’s case no second set of rows', async () => {
    const tenant = await provisionTenant();
    const file = fileId('merge');
    const sha256 = await oxyFiles.putForTenant(tenant.tenant, file, file);
    const subject = `merged_${randomUUID()}`;
    const body = (externalReportId: string, reporter: string) =>
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: subject,
        reporterExternalId: reporter,
        extraResources: [image('res_image', file, sha256)],
      });

    const first = await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${tenant.token}`)
      .set('idempotency-key', `merge-a-${subject}`)
      .send(body(`merge-a-${subject}`, 'reporter_a'));
    const second = await request(app)
      .post('/v1/reports')
      .set('authorization', `Bearer ${tenant.token}`)
      .set('idempotency-key', `merge-b-${subject}`)
      .send(body(`merge-b-${subject}`, 'reporter_b'));

    expect(second.body.caseId).toBe(first.body.caseId);
    expect(second.body.merged).toBe(true);
    expect(await rowsOf(first.body.caseId)).toHaveLength(1);
  });
});

// ── 2. References ───────────────────────────────────────────────────────────

describe('the reference worker', () => {
  it('registers a case’s reference at Oxy, entity type case', async () => {
    const { caseId, file } = await caseWithImage();

    expect(oxyFiles.holds(file, caseId)).toBe(true);
    expect(await rowOf(caseId, file)).toMatchObject({
      referenceState: 'registered',
      referenceAttempts: 0,
      referenceClaim: null,
    });
  });

  it('withholds and audits a file Oxy refuses CrowdSource a reference to', async () => {
    const tenant = await provisionTenant();
    const file = fileId('private');
    const sha256 = await oxyFiles.putForTenant(tenant.tenant, file, file);
    oxyFiles.refused.add(file);
    const response = await deliver(tenant, [image('res_image', file, sha256)]);
    const caseId = response.body.caseId as string;

    await references.drainEvidenceReferences();

    expect((await rowOf(caseId, file)).referenceState).toBe('refused');
    expect(await repository.withheldEvidenceFileIds(db, caseId)).toEqual([file]);
    const audits = await auditsFor(caseId, 'evidence.withheld');
    expect(audits.map((row) => [row.subjectId, row.reason])).toEqual([
      [file, 'file_unreferenceable'],
    ]);
  });

  it('keeps an owed reference owed when Oxy fails, with a backoff and a class', async () => {
    const tenant = await provisionTenant();
    const file = fileId('retry');
    const sha256 = await oxyFiles.putForTenant(tenant.tenant, file, file);
    const response = await deliver(tenant, [image('res_image', file, sha256)]);
    const caseId = response.body.caseId as string;
    oxyFiles.failing.add('add');

    const now = new Date();
    await references.runEvidenceReferencePass(now);

    const failed = await rowOf(caseId, file);
    expect(failed.referenceState).toBe('pending');
    expect(failed.referenceError).toBe('http_503');
    expect(failed.referenceAttempts).toBe(1);
    expect(failed.referenceClaim).toBeNull();
    expect(failed.referenceDueAt.getTime()).toBeGreaterThan(now.getTime());

    oxyFiles.failing.clear();
    await references.runEvidenceReferencePass(new Date(failed.referenceDueAt.getTime() + 1));
    expect((await rowOf(caseId, file)).referenceState).toBe('registered');
    expect(oxyFiles.holds(file, caseId)).toBe(true);
  });

  it('never writes a claimed add over a removal a file event asked for meanwhile', async () => {
    const tenant = await provisionTenant();
    const file = fileId('race');
    const sha256 = await oxyFiles.putForTenant(tenant.tenant, file, file);
    const response = await deliver(tenant, [image('res_image', file, sha256)]);
    const caseId = response.body.caseId as string;

    const claim = randomUUID();
    const now = new Date();
    const claimed = await repository.claimDueEvidenceReferences(db, {
      claim,
      now,
      leaseUntil: new Date(now.getTime() + 60_000),
      limit: 1000,
    });
    expect(claimed.some((row) => row.caseId === caseId)).toBe(true);

    expect((await signed(fileEvent(file, 'file.deleted', 'deleted'))).status).toBe(200);

    const written = await repository.finishEvidenceReference(db, {
      caseId,
      fileId: file,
      claim,
      claimedState: 'pending',
      now: new Date(),
      outcome: { kind: 'done', referenceState: 'registered' },
    });
    expect(written).toBeUndefined();
    const row = await rowOf(caseId, file);
    expect(row.referenceState).toBe('removal_pending');
    expect(row.referenceClaim).toBeNull();
  });

  it('backs off to at most an hour', () => {
    expect(references.referenceRetryDelayMs(1)).toBe(30_000);
    expect(references.referenceRetryDelayMs(2)).toBe(60_000);
    expect(references.referenceRetryDelayMs(40)).toBe(references.REFERENCE_RETRY_MAX_MS);
  });
});

// ── 3. File events ──────────────────────────────────────────────────────────

describe('POST /webhooks/oxy/file-events', () => {
  it('echoes Oxy’s endpoint challenge, which carries no signature', async () => {
    const response = await request(app)
      .post('/webhooks/oxy/file-events')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ type: 'webhook.challenge', challenge: 'abc123' }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ challenge: 'abc123' });
  });

  it('refuses a body signed with another secret, changing nothing', async () => {
    const { caseId, file } = await caseWithImage();

    const response = await signed(fileEvent(file, 'file.blocked', 'blocked'), 'whsec_wrong');

    expect(response.status).toBe(401);
    expect((await rowOf(caseId, file)).fileStatus).toBe('active');
  });

  it('refuses a body that is not JSON', async () => {
    const response = await request(app)
      .post('/webhooks/oxy/file-events')
      .set('content-type', 'text/plain')
      .send('hello');
    expect(response.status).toBe(415);
  });

  it('answers 503 to a signed event while no secret is configured, so Oxy retries', async () => {
    const oxy = config.oxy as { filesWebhookSecret?: string };
    oxy.filesWebhookSecret = undefined;
    try {
      const response = await signed(fileEvent(fileId('x'), 'file.blocked', 'blocked'));
      expect(response.status).toBe(503);
    } finally {
      oxy.filesWebhookSecret = SECRET;
    }
  });

  it('withholds a blocked file from the jury and audits it; an unblock shows it again', async () => {
    const { caseId, file } = await caseWithImage();
    const blockedAt = new Date();

    const blocked = await signed(fileEvent(file, 'file.blocked', 'blocked', 'unlisted', blockedAt));
    expect(blocked.status).toBe(200);
    expect(blocked.body).toEqual({ received: true, duplicate: false });
    expect(await repository.withheldEvidenceFileIds(db, caseId)).toEqual([file]);
    expect(
      (await auditsFor(caseId, 'evidence.withheld')).map((row) => [row.subjectId, row.reason]),
    ).toEqual([[file, 'file_blocked']]);
    // Blocked keeps the reference: it is what brings the unblock.
    expect((await rowOf(caseId, file)).referenceState).toBe('registered');

    const unblocked = await signed(
      fileEvent(file, 'file.unblocked', 'active', 'unlisted', new Date(blockedAt.getTime() + 1000)),
    );
    expect(unblocked.status).toBe(200);
    expect(await repository.withheldEvidenceFileIds(db, caseId)).toEqual([]);
    expect(await auditsFor(caseId, 'evidence.restored')).toHaveLength(1);
  });

  it('withholds a lost file from the jury as file_unavailable', async () => {
    const { caseId, file } = await caseWithImage();

    const lost = await signed(fileEvent(file, 'file.lost', 'lost'));
    expect(lost.status).toBe(200);
    expect(await repository.withheldEvidenceFileIds(db, caseId)).toEqual([file]);
    expect(
      (await auditsFor(caseId, 'evidence.withheld')).map((row) => [row.subjectId, row.reason]),
    ).toEqual([[file, 'file_unavailable']]);
  });

  it('records each event once: a redelivery is acknowledged and changes nothing', async () => {
    const { caseId, file } = await caseWithImage();
    const event = fileEvent(file, 'file.trashed', 'trash');

    expect((await signed(event)).body.duplicate).toBe(false);
    const again = await signed(event);

    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(await auditsFor(caseId, 'evidence.withheld')).toHaveLength(1);
    const [ledger] = await db
      .select()
      .from(oxyFileEvents)
      .where(eq(oxyFileEvents.eventId, event.id));
    expect(ledger).toMatchObject({ type: 'file.trashed', fileId: file, rowsChanged: 1 });
  });

  it('ignores an event older than the last one applied', async () => {
    const { caseId, file } = await caseWithImage();
    const now = Date.now();

    await signed(fileEvent(file, 'file.trashed', 'trash', 'unlisted', new Date(now)));
    await signed(fileEvent(file, 'file.restored', 'active', 'unlisted', new Date(now - 60_000)));

    expect((await rowOf(caseId, file)).fileStatus).toBe('trash');
  });

  it('withholds a file made private, and shows it again when it is not', async () => {
    const { caseId, file } = await caseWithImage();
    const now = Date.now();

    await signed(fileEvent(file, 'file.visibility_changed', 'active', 'private', new Date(now)));
    expect((await auditsFor(caseId, 'evidence.withheld')).map((row) => row.reason)).toEqual([
      'file_private',
    ]);

    await signed(
      fileEvent(file, 'file.visibility_changed', 'active', 'public', new Date(now + 1000)),
    );
    expect(await repository.withheldEvidenceFileIds(db, caseId)).toEqual([]);
  });

  it('treats a deletion as final and removes CrowdSource’s reference at Oxy', async () => {
    const { caseId, file } = await caseWithImage();
    const now = Date.now();

    await signed(fileEvent(file, 'file.deleted', 'deleted', 'unlisted', new Date(now)));
    expect((await rowOf(caseId, file)).referenceState).toBe('removal_pending');

    await references.drainEvidenceReferences();
    expect((await rowOf(caseId, file)).referenceState).toBe('removed');
    expect(oxyFiles.holds(file, caseId)).toBe(false);

    // Nothing revives a tombstone.
    await signed(fileEvent(file, 'file.restored', 'active', 'unlisted', new Date(now + 1000)));
    expect((await rowOf(caseId, file)).fileStatus).toBe('deleted');
    expect((await auditsFor(caseId, 'evidence.withheld')).map((row) => row.reason)).toEqual([
      'file_deleted',
    ]);
  });

  it('withholds a status it does not know, failing closed', async () => {
    const { caseId, file } = await caseWithImage();
    await signed(fileEvent(file, 'file.restored', 'quarantined'));
    expect((await rowOf(caseId, file)).fileStatus).toBe('unknown');
    expect((await auditsFor(caseId, 'evidence.withheld')).map((row) => row.reason)).toEqual([
      'file_unavailable',
    ]);
  });

  it('reaches every case that names the file, in every tenant, each in its own trail', async () => {
    const first = await provisionTenant();
    const file = fileId('shared');
    const sha256 = await oxyFiles.putForTenant(first.tenant, file, file);
    const firstCase = (await deliver(first, [image('res_image', file, sha256)])).body
      .caseId as string;

    // The same file id under a second tenant's case, as a stamped row: two
    // tenants cannot both own one file, but the receiver must not assume so.
    const second = await provisionTenant();
    const secondCase = `case_${randomUUID().replace(/-/g, '')}`;
    await db.transaction((tx) =>
      repository.insertCaseEvidenceFiles(tx, {
        organizationId: second.organizationId,
        applicationId: second.applicationId,
        caseId: secondCase,
        fileIds: [file],
        now: new Date(),
      }),
    );

    await signed(fileEvent(file, 'file.blocked', 'blocked'));

    expect(await repository.withheldEvidenceFileIds(db, firstCase)).toEqual([file]);
    expect(await repository.withheldEvidenceFileIds(db, secondCase)).toEqual([file]);
    const firstTrail = await auditsFor(firstCase, 'evidence.withheld');
    const secondTrail = await auditsFor(secondCase, 'evidence.withheld');
    expect(firstTrail.map((row) => row.applicationId)).toEqual([first.applicationId]);
    expect(secondTrail.map((row) => row.applicationId)).toEqual([second.applicationId]);
  });
});

// ── 4. The SQL and the rule agree ───────────────────────────────────────────

describe('withheldEvidenceFileIds is withheldReason, in SQL', () => {
  it('agrees on every combination of status, visibility and reference state', async () => {
    const tenant = await provisionTenant();
    const caseId = `case_${randomUUID().replace(/-/g, '')}`;
    const statuses = ['active', 'trash', 'blocked', 'deleted', 'unknown'] as const;
    const visibilities = [null, 'public', 'unlisted', 'private'] as const;
    const states = ['pending', 'registered', 'refused', 'removal_pending', 'removed'] as const;

    const rows = statuses.flatMap((fileStatus) =>
      visibilities.flatMap((fileVisibility) =>
        states.map((referenceState) => ({
          organizationId: tenant.organizationId,
          applicationId: tenant.applicationId,
          caseId,
          fileId: `${fileStatus}-${fileVisibility}-${referenceState}`,
          fileStatus,
          fileVisibility,
          referenceState,
          referenceAttempts: 0,
          // Far in the future, so no worker pass in this run claims them.
          referenceDueAt: new Date('2100-01-01T00:00:00.000Z'),
        })),
      ),
    );
    await db.insert(caseEvidenceFiles).values(rows);

    const expected = rows.filter((row) => withheldReason(row) !== null).map((row) => row.fileId);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(rows.length);
    expect((await repository.withheldEvidenceFileIds(db, caseId)).sort()).toEqual(expected.sort());

    await db.delete(caseEvidenceFiles).where(eq(caseEvidenceFiles.caseId, caseId));
  });
});

// ── 5. Reconciliation ───────────────────────────────────────────────────────

describe('the nightly reconciliation', () => {
  it('sends every held or owed reference, and none refused or removed; then waits a night', async () => {
    const { caseId, file } = await caseWithImage();
    const refusedTenant = await provisionTenant();
    const refusedFile = fileId('refused');
    const sha256 = await oxyFiles.putForTenant(refusedTenant.tenant, refusedFile, refusedFile);
    oxyFiles.refused.add(refusedFile);
    const refusedCase = (await deliver(refusedTenant, [image('res_image', refusedFile, sha256)]))
      .body.caseId as string;
    await references.drainEvidenceReferences();

    // Oxy lost the reference: the reconciliation puts it back.
    oxyFiles.references.delete(`${file} case ${caseId}`);
    await db.delete(oxyFileReconciliations).where(eq(oxyFileReconciliations.entityType, 'case'));

    const owner = randomUUID();
    const outcome = await references.reconcileEvidenceReferences({ dryRun: false, owner });

    expect(outcome.ran).toBe(true);
    const sent = oxyFiles.reconciled.at(-1);
    expect(sent?.entityType).toBe('case');
    expect(sent?.dryRun).toBe(false);
    expect(sent?.items).toContainEqual({ fileId: file, entityId: caseId });
    expect(sent?.items).not.toContainEqual({ fileId: refusedFile, entityId: refusedCase });
    expect(oxyFiles.holds(file, caseId)).toBe(true);

    const [row] = await db
      .select()
      .from(oxyFileReconciliations)
      .where(eq(oxyFileReconciliations.entityType, 'case'));
    expect(row.leaseOwner).toBeNull();
    expect(row.lastDryRun).toBe(false);
    expect(row.lastError).toBeNull();
    expect(row.lastCounts?.added).toBeGreaterThanOrEqual(1);

    // One run a night, whichever task asks.
    expect((await references.reconcileEvidenceReferences({ dryRun: false })).ran).toBe(false);
  });

  it('changes nothing on a dry run, and records a failure for the next check to retry', async () => {
    const { caseId, file } = await caseWithImage();
    oxyFiles.references.delete(`${file} case ${caseId}`);
    const tomorrow = new Date(Date.now() + references.RECONCILIATION_MIN_INTERVAL_MS + 60_000);

    const dry = await references.reconcileEvidenceReferences({ dryRun: true, now: tomorrow });
    expect(dry.ran).toBe(true);
    expect(oxyFiles.holds(file, caseId)).toBe(false);

    oxyFiles.failing.add('reconcile');
    const later = new Date(tomorrow.getTime() + references.RECONCILIATION_MIN_INTERVAL_MS + 60_000);
    const failed = await references.reconcileEvidenceReferences({ dryRun: false, now: later });
    expect(failed).toMatchObject({ ran: true, error: 'http_409' });
    const [row] = await db
      .select()
      .from(oxyFileReconciliations)
      .where(eq(oxyFileReconciliations.entityType, 'case'));
    expect(row.lastError).toBe('http_409');
    expect(row.leaseOwner).toBeNull();

    // A failed run did not complete, so the next check runs again.
    oxyFiles.failing.clear();
    const retried = await references.reconcileEvidenceReferences({ dryRun: false, now: later });
    expect(retried.ran).toBe(true);
    expect(oxyFiles.holds(file, caseId)).toBe(true);
  });

  it('does not run while another task holds the lease', async () => {
    await db
      .delete(oxyFileReconciliations)
      .where(inArray(oxyFileReconciliations.entityType, ['case']));
    const now = new Date();
    expect(
      await repository.claimReconciliation(db, {
        entityType: 'case',
        owner: 'other-task',
        now,
        leaseMs: references.RECONCILIATION_LEASE_MS,
        minIntervalMs: references.RECONCILIATION_MIN_INTERVAL_MS,
      }),
    ).toBe(true);

    expect((await references.reconcileEvidenceReferences({ dryRun: false, now })).ran).toBe(false);
    await db.delete(oxyFileReconciliations).where(eq(oxyFileReconciliations.entityType, 'case'));
  });
});
