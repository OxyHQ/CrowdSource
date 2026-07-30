import { createHash, randomUUID } from 'node:crypto';
import type { Resource } from '@oxyhq/crowdsource-contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubOxySession } from './support/reviewers';

/**
 * What crosses into a review package, per resource type (§9.1, §7.5, §13.8).
 *
 * ## Why this file exists
 *
 * The projection is the fix for two invariant violations that were live in the
 * response, and it shipped with its per-type branches almost entirely uncovered:
 * every existing test ingested one `text` resource, so eleven of the twelve
 * branches — and the whole asset path — had never run.
 *
 * The two violations, for the record of what this pins:
 *
 *  - **§9.1's application branding.** The package used to ship
 *    `contentSnapshot.resources` RAW, which carries `asset.url` — a URL on the
 *    reporting application's own host. Beyond putting that application's brand in
 *    front of the jury, a reviewer's browser fetching it would tell that host its
 *    content is under review, which attacks the blind-jury invariant rather than
 *    merely leaking a hostname.
 *  - **§7.5's `prohibited`.** `sensitivityClass` on the wire was the raw four-value
 *    triage class, so material §7.5 says never reaches a jury would have rendered
 *    like any other.
 *
 * ## The assertions are key sets, not absences
 *
 * `expect(keys).toEqual([...])` fails when a field is ADDED. A list of
 * `not.toHaveProperty` calls only fails for the fields somebody thought to name,
 * which is the wrong direction for a surface whose whole specification is what it
 * must not carry.
 */

vi.mock('@oxyhq/core/server', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@oxyhq/core/server');
  return { ...actual, createOxyAuthMiddleware: () => stubOxySession() };
});

const { createApp } = await import('../app');
const { cases } = await import('../modules/cases/case.collection');
const { resolvePolicy } = await import('../modules/policy/policy.registry');
const { buildReviewPackage, assignmentWatermark } = await import(
  '../modules/sortition/reviewPackage'
);
const { policyVersionOfToken } = await import('../modules/cases/caseDedupKey');


type AssignmentDocument = Parameters<typeof buildReviewPackage>[0];
const { deliveryBody, provisionTenant, startDatabase, stopDatabase } = await import(
  './support/tenants'
);

const app = createApp();

beforeAll(async () => {
  await startDatabase();
}, 120_000);

afterAll(async () => {
  await stopDatabase();
});

const digestOf = (value: string): string =>
  `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

const FILE_ID = 'file_0123456789abcdef';
const APPLICATION_HOST_URL = 'https://mention.earth/media/original.png';

/**
 * One resource of every type the envelope can carry, so each projection branch
 * runs. Every asset names both a `fileId` and the application's own `url`, which
 * is the shape the leak came from — the projection has to keep the first and drop
 * the second.
 */
const EVERY_RESOURCE_TYPE: readonly Resource[] = [
  { id: 'res_link', type: 'link', role: 'context', data: { url: 'https://example.test/a' }, sha256: digestOf('link') },
  {
    id: 'res_profile',
    type: 'profile',
    role: 'context',
    data: { displayName: 'someone' },
    sha256: digestOf('profile'),
  },
  {
    id: 'res_conversation',
    type: 'conversation',
    role: 'context',
    data: { messageResourceIds: ['res_post'] },
    sha256: digestOf('conversation'),
  },
  {
    id: 'res_listing',
    type: 'listing',
    role: 'context',
    data: { title: 'a listing', price: 10, currency: 'EUR' },
    sha256: digestOf('listing'),
  },
  {
    id: 'res_location',
    type: 'location',
    role: 'context',
    data: { latitude: 41.39, longitude: 2.16 },
    sha256: digestOf('location'),
  },
  { id: 'res_metadata', type: 'metadata', role: 'context', data: { views: 12 }, sha256: digestOf('metadata') },
  {
    id: 'res_custom',
    type: 'custom',
    role: 'context',
    schemaId: 'test.custom.v1',
    payload: { anything: 'here' },
    sha256: digestOf('custom'),
  },
  {
    id: 'res_image',
    type: 'image',
    role: 'evidence',
    asset: { fileId: FILE_ID, url: APPLICATION_HOST_URL, mimeType: 'image/png', sha256: digestOf('image') },
  },
  {
    id: 'res_video',
    type: 'video',
    role: 'evidence',
    asset: {
      fileId: FILE_ID,
      url: APPLICATION_HOST_URL,
      mimeType: 'video/mp4',
      sha256: digestOf('video'),
      durationSeconds: 4,
    },
  },
  {
    id: 'res_audio',
    type: 'audio',
    role: 'evidence',
    asset: {
      fileId: FILE_ID,
      url: APPLICATION_HOST_URL,
      mimeType: 'audio/mpeg',
      sha256: digestOf('audio'),
      durationSeconds: 9,
    },
  },
  {
    id: 'res_document',
    type: 'document',
    role: 'evidence',
    data: { title: 'a.pdf' },
    asset: { fileId: FILE_ID, url: APPLICATION_HOST_URL, mimeType: 'application/pdf', sha256: digestOf('doc') },
  },
];

async function packageForEveryType(
  sensitivity: AssignmentDocument['sensitivityClass'] = 'standard',
): Promise<Awaited<ReturnType<typeof buildReviewPackage>>> {
  const tenant = await provisionTenant();
  const delivered = await request(app)
    .post('/v1/reports')
    .set('authorization', `Bearer ${tenant.token}`)
    .set('idempotency-key', `projection-${randomUUID()}`)
    .send(
      deliveryBody(tenant, `projection-report-${randomUUID()}`, {
        text: 'the reported words',
        extraResources: EVERY_RESOURCE_TYPE,
      }),
    );
  expect(delivered.status).toBe(202);

  const stored = await cases.findOne(tenant.tenant, { caseId: delivered.body.caseId });
  if (stored === null) throw new Error('the report did not produce a case');
  const policy = await resolvePolicy(tenant.tenant, {
    policySetId: stored.policySetId,
    version: policyVersionOfToken(stored.policyVersion, stored.policySetId),
  });

  /**
   * The assignment is built here rather than drawn. `buildReviewPackage` is pure —
   * an assignment, a case and a policy in — so a draw would add a reviewer pool,
   * an outbox drain and a scheduler to a test about which fields cross, and every
   * one of those is a way for this to fail for a reason that is not the projection.
   */
  const assignment: AssignmentDocument = {
    assignmentId: `asg_${randomUUID().replace(/-/g, '')}`,
    organizationId: stored.organizationId,
    applicationId: stored.applicationId,
    caseId: stored.caseId,
    caseRevision: stored.currentRevision,
    drawId: `drw_${randomUUID().replace(/-/g, '')}`,
    incidentId: null,
    reviewerId: `rvw_${randomUUID().replace(/-/g, '')}`,
    slotType: 'reliable_general',
    filledAs: 'reliable_general',
    status: 'offered',
    tokenHash: digestOf('token'),
    sensitivityClass: sensitivity,
    offeredAt: new Date(),
    acceptedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    completedAt: null,
    recusalReason: null,
    replacementAssignmentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return buildReviewPackage(assignment, stored, policy);
}

describe('§9.1: every resource type projects, and the digest never travels', () => {
  it('projects all twelve types and drops sha256 from each', async () => {
    const built = await packageForEveryType();

    expect(built.resources.map((resource) => resource.type).sort()).toEqual(
      [
        'audio',
        'conversation',
        'custom',
        'document',
        'image',
        'link',
        'listing',
        'location',
        'metadata',
        'profile',
        'text',
        'video',
      ].sort(),
    );
    for (const resource of built.resources) {
      expect(resource, `${resource.type} kept the digest`).not.toHaveProperty('sha256');
    }
  });

  it('gives an asset a bare file id and never the application host URL', async () => {
    const built = await packageForEveryType();
    const serialised = JSON.stringify(built);

    // The whole package, not just the asset: a URL surviving anywhere is the leak.
    expect(serialised).not.toContain(APPLICATION_HOST_URL);
    expect(serialised).not.toContain('mention.earth');

    const image = built.resources.find((resource) => resource.type === 'image');
    expect(image).toBeDefined();
    if (image === undefined || !('asset' in image)) throw new Error('no image asset projected');
    expect(image.asset.fileId).toBe(FILE_ID);
    expect(image.asset.retrievable).toBe(true);
    expect(Object.keys(image.asset).sort()).toEqual(['fileId', 'mediaType', 'retrievable']);
  });

  it('carries a video and audio duration through, and a document body', async () => {
    const built = await packageForEveryType();

    const video = built.resources.find((resource) => resource.type === 'video');
    if (video === undefined || !('asset' in video)) throw new Error('no video projected');
    expect(video.asset.durationSeconds).toBe(4);

    const document = built.resources.find((resource) => resource.type === 'document');
    if (document === undefined || !('data' in document)) throw new Error('no document projected');
    expect(document.data).toMatchObject({ title: 'a.pdf' });
  });
});

describe('§7.5: material that never reaches a jury cannot be projected', () => {
  it('refuses to build a package for prohibited material, naming the assignment', async () => {
    await expect(packageForEveryType('prohibited')).rejects.toThrow(
      /which is never shown to a jury/,
    );
  });

  it.each(['standard', 'sensitive', 'restricted'] as const)(
    'projects %s material and carries the class through unchanged',
    async (sensitivity) => {
      const built = await packageForEveryType(sensitivity);
      expect(built.presentation.sensitivityClass).toBe(sensitivity);
      // §13.7's blur decision is derived, not passed through: anything above
      // standard arrives hidden until the reviewer chooses to reveal it.
      expect(built.presentation.blurBeforeReveal).toBe(sensitivity !== 'standard');
    },
  );
});

describe('§13.8: the watermark is server-issued and stable', () => {
  it('is deterministic per assignment and differs between assignments', () => {
    const first = assignmentWatermark('asg_00000000000000000000000000000001');
    const second = assignmentWatermark('asg_00000000000000000000000000000002');

    // Stable across a reload — a watermark that changed per render would make two
    // screenshots of one assignment untraceable to the same seat.
    expect(assignmentWatermark('asg_00000000000000000000000000000001')).toBe(first);
    expect(second).not.toBe(first);
    // Pseudonymous: it is a mark, not the assignment id in disguise.
    expect(first).not.toContain('asg_00000000000000000000000000000001');
  });
});
