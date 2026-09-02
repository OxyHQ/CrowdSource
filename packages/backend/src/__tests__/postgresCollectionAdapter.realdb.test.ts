import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  TenantCollection,
  UnscopedCollection,
  type TenantScopedUpdate,
} from '../db/collections';
import type { TenantContext } from '../db/tenantScope';
import { reviewerProfiles, type ReviewerProfileDocument } from '../modules/reviewer/reviewer.collection';
import { trainingView } from '../modules/reviewer/reviewer.service';
import { reviewerAxesFor } from './support/reviewerAxes';
import { createReviewer } from './support/reviewers';

/**
 * The generic adapter is deliberately smaller than the dedicated repositories,
 * but every operator it still accepts is part of the surviving document-shaped
 * service contract. Exercise the rejection and empty-set branches against real
 * PostgreSQL so coverage cannot be restored by excluding the port's boundary.
 */

interface CaseShape extends TenantContext {
  readonly caseId: string;
  readonly allegationCodes: string[];
}

const context: TenantContext = {
  organizationId: 'org_collection_adapter',
  applicationId: 'app_collection_adapter',
};

const cases = new TenantCollection<CaseShape>('Case');
const reviewerAxis = reviewerAxesFor(import.meta.url)('adapter');

describe('the PostgreSQL collection adapter query boundary', () => {
  it('rejects an unregistered collection or field by name', async () => {
    expect(() => new TenantCollection<TenantContext>('MissingCollection')).toThrow(
      /No PostgreSQL table is registered for 'MissingCollection'/,
    );
    await expect(cases.findOne(context, { missingField: 'value' })).rejects.toThrow(
      /Unknown field 'missingField'/,
    );
  });

  it('implements the complete surviving operator vocabulary, including empty sets', async () => {
    await expect(
      cases.countDocuments(context, {
        $and: [
          { caseId: { $in: [] } },
          { caseId: { $nin: [] } },
          { caseId: { $nin: ['case_elsewhere'] } },
          { caseId: { $ne: null } },
          { caseId: { $ne: 'case_blocked' } },
          {
            caseId: {
              $gt: 'case_a',
              $gte: 'case_a',
              $lt: 'case_z',
              $lte: 'case_z',
              $not: 'case_blocked',
            },
          },
          { allegationCodes: { $all: [] } },
        ],
      }),
    ).resolves.toBe(0);

    await expect(cases.find(context, { allegationCodes: 'allegation_scalar' })).resolves.toEqual(
      [],
    );
    await expect(cases.find(context, { $or: [] })).resolves.toEqual([]);
    await expect(cases.find(context, { $and: [] })).resolves.toEqual([]);
  });

  it('supports anchored prefixes and refuses regular expressions it cannot preserve', async () => {
    await expect(cases.find(context, { caseId: /^case_prefix_with_underscore/ })).resolves.toEqual(
      [],
    );
    await expect(cases.findOne(context, { caseId: /case_unanchored/ })).rejects.toThrow(
      /Unsupported PostgreSQL regular expression filter/,
    );
    await expect(cases.findOne(context, { caseId: /^case_anchored$/i })).rejects.toThrow(
      /Unsupported PostgreSQL regular expression filter/,
    );
  });

  it('rejects malformed boolean, nested and comparison expressions', async () => {
    await expect(cases.findOne(context, { $or: 'not-an-array' })).rejects.toThrow(
      /'\$or' must be an array/,
    );
    await expect(cases.findOne(context, { $and: [null] })).rejects.toThrow(
      /'\$and' entries must be objects/,
    );
    await expect(cases.findOne(context, { '': 'value' })).rejects.toThrow(
      /Unsupported nested PostgreSQL field/,
    );
    await expect(cases.findOne(context, { 'caseId.part.extra': 'value' })).rejects.toThrow(
      /Unsupported nested PostgreSQL field/,
    );
    await expect(cases.findOne(context, { 'caseId.part': 'value' })).rejects.toThrow(
      /Unsupported nested PostgreSQL field/,
    );
    await expect(
      cases.findOne(context, { 'contentSnapshot.1invalid': 'value' }),
    ).rejects.toThrow(/Unsupported nested PostgreSQL field/);
    await expect(
      cases.find(context, { 'contentSnapshot.text': 'absent' }),
    ).resolves.toEqual([]);
    await expect(cases.findOne(context, { caseId: { $unknown: 'value' } })).rejects.toThrow(
      /Unsupported PostgreSQL filter operator '\$unknown'/,
    );
  });
});

describe('the PostgreSQL collection adapter write boundary', () => {
  it('refuses generic upserts, claims, empty patches and set-on-insert', async () => {
    const unscoped = new UnscopedCollection<Readonly<Record<string, unknown>>>('Organization', {
      why: 'This test reaches only the adapter refusal before any unscoped organization read.',
    });

    await expect(cases.upsertOne(context, {}, {})).rejects.toThrow(
      /requires its dedicated PostgreSQL upsert repository/,
    );
    await expect(unscoped.findOneAndUpdate({}, {})).rejects.toThrow(
      /requires its dedicated PostgreSQL claim\/update repository/,
    );
    await expect(cases.updateOne(context, {}, {})).rejects.toThrow(
      /PostgreSQL update cannot be empty/,
    );
    await expect(
      cases.updateOne(context, {}, { setOnInsert: { caseId: 'case_new' } }),
    ).rejects.toThrow(/requires its dedicated PostgreSQL upsert repository/);
  });

  it.each(['inc', 'max', 'addToSet'] as const)(
    'validates the field named by the %s operator',
    async (operator) => {
      const update = {
        [operator]: { missingField: operator === 'addToSet' ? ['value'] : 1 },
      } as unknown as TenantScopedUpdate<CaseShape>;
      await expect(cases.updateOne(context, {}, update)).rejects.toThrow(
        /Unknown field 'missingField'/,
      );
    },
  );

  it('rolls back a reviewer profile whose embedded link is not an object', async () => {
    const fixture = await createReviewer({
      family: reviewerAxis.family,
      languages: [reviewerAxis.language],
    });
    const source = await reviewerProfiles.findOne({ reviewerId: fixture.reviewerId });
    expect(source).not.toBeNull();
    if (source === null) throw new Error('The reviewer fixture vanished before the adapter test.');

    const completeView = trainingView(source);
    expect(completeView.trainingComplete).toBe(true);
    expect(completeView.modules.every((module) => module.completed)).toBe(true);
    expect(completeView.calibrationItems.length).toBeGreaterThan(0);

    const incompleteView = trainingView({ ...source, trainingCompletedModules: [] });
    expect(incompleteView.trainingComplete).toBe(false);
    expect(incompleteView.modules.every((module) => !module.completed)).toBe(true);
    expect(incompleteView.calibrationItems).toEqual([]);

    const reviewerId = `rvw_adapter_${randomUUID().replaceAll('-', '')}`;
    const invalid = {
      ...source,
      reviewerId,
      oxyUserId: `oxy_adapter_${randomUUID().replaceAll('-', '')}`,
      principalLinks: [null],
    } as unknown as ReviewerProfileDocument;

    await expect(reviewerProfiles.insertOne(invalid)).rejects.toThrow(
      /Reviewer principal links must be objects/,
    );
    await expect(reviewerProfiles.findOne({ reviewerId })).resolves.toBeNull();
  });
});
