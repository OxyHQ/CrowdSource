import { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defineTenantCollection } from '../db/collections';
import type { TenantContext } from '../db/tenantScope';
import {
  provisionApplication,
  provisionTenant,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * The tenant-scoped WRITE surface, against a real replica set.
 *
 * Phase 1 proved that reads are scoped. Phase 2 added updates and upserts, which
 * are where the boundary is easiest to lose: a raw Mongo update accepts
 * `$set: { applicationId: … }` and would move a document between tenants —
 * exactly the mass-assignment hole `tenantScopedDocument` closes on insert,
 * reopened on the update path. The restricted update spec is what closes it, and
 * these are the tests that say so.
 */

interface Widget extends TenantContext {
  widgetId: string;
  label: string;
  count: number;
  ceiling: number;
  tags: string[];
}

const widgetSchema = new Schema<Widget>({
  organizationId: { type: String, required: true },
  applicationId: { type: String, required: true },
  widgetId: { type: String, required: true },
  label: { type: String, required: true },
  count: { type: Number, required: true, default: 0 },
  ceiling: { type: Number, required: true, default: 0 },
  tags: { type: [String], required: true, default: [] },
});
widgetSchema.index({ applicationId: 1, widgetId: 1 }, { unique: true });

const widgets = defineTenantCollection('WidgetFixture', widgetSchema);

let alpha: ProvisionedTenant;
let alphaSibling: ProvisionedTenant;

beforeAll(async () => {
  await startDatabase();
  await widgets.ensureIndexes();
  alpha = await provisionTenant();
  alphaSibling = await provisionApplication(alpha.organizationId);
});

afterAll(async () => {
  await stopDatabase();
});

const widgetId = () => `w_${Math.random().toString(36).slice(2)}`;

describe('the restricted update spec', () => {
  it('applies every operator it declares', async () => {
    const id = widgetId();
    await widgets.insertOne(alpha.tenant, {
      widgetId: id,
      label: 'first',
      count: 0,
      ceiling: 5,
      tags: ['a'],
    });

    await widgets.updateOne(
      alpha.tenant,
      { widgetId: id },
      {
        set: { label: 'second' },
        inc: { count: 3 },
        max: { ceiling: 12 },
        addToSet: { tags: ['b', 'a'] },
      },
    );

    const stored = await widgets.findOne(alpha.tenant, { widgetId: id });
    expect(stored).toMatchObject({ label: 'second', count: 3, ceiling: 12 });
    // `$addToSet` is what makes a replayed merge idempotent: the duplicate 'a'
    // does not accumulate.
    expect(stored?.tags.sort()).toEqual(['a', 'b']);
  });

  it('keeps the LARGER value under $max, however the writes are ordered', async () => {
    const id = widgetId();
    await widgets.insertOne(alpha.tenant, {
      widgetId: id,
      label: 'x',
      count: 0,
      ceiling: 90,
      tags: [],
    });

    await widgets.updateOne(alpha.tenant, { widgetId: id }, { max: { ceiling: 30 } });

    expect((await widgets.findOne(alpha.tenant, { widgetId: id }))?.ceiling).toBe(90);
  });

  /**
   * The security property. A caller that could name a tenant key in an update
   * could move a document into another tenant, which is the isolation boundary
   * failing silently rather than loudly.
   */
  it.each(['set', 'setOnInsert', 'inc', 'max', 'addToSet'] as const)(
    'refuses a tenant key inside %s',
    async (operator) => {
      await expect(
        widgets.updateOne(alpha.tenant, { widgetId: widgetId() }, {
          [operator]: { applicationId: alphaSibling.applicationId },
        }),
      ).rejects.toThrow(/must not set 'applicationId'/);
    },
  );

  it('refuses an update that names no operator at all', async () => {
    await expect(widgets.updateOne(alpha.tenant, { widgetId: widgetId() }, {})).rejects.toThrow(
      /at least one operator/,
    );
  });

  it('cannot reach a document belonging to another application', async () => {
    const id = widgetId();
    await widgets.insertOne(alpha.tenant, {
      widgetId: id,
      label: 'alpha only',
      count: 0,
      ceiling: 0,
      tags: [],
    });

    expect(
      await widgets.updateOne(alphaSibling.tenant, { widgetId: id }, { set: { label: 'taken' } }),
    ).toBe(0);
    expect((await widgets.findOne(alpha.tenant, { widgetId: id }))?.label).toBe('alpha only');
  });
});

describe('upsertOne', () => {
  it('creates the document, stamped with the tenant from the filter', async () => {
    const id = widgetId();

    const created = await widgets.upsertOne(
      alpha.tenant,
      { widgetId: id },
      { setOnInsert: { label: 'made by upsert', ceiling: 1, tags: [] }, inc: { count: 1 } },
    );

    // MongoDB builds an upsert's base document from the query's equality
    // clauses, and `tenantScopedFilter` guarantees those carry the tenant. The
    // assertion is what makes that a checked property rather than a belief.
    expect(created).toMatchObject({
      widgetId: id,
      label: 'made by upsert',
      count: 1,
      organizationId: alpha.organizationId,
      applicationId: alpha.applicationId,
    });
  });

  it('updates on the second call instead of creating a second document', async () => {
    const id = widgetId();
    const spec = {
      setOnInsert: { label: 'once', ceiling: 0, tags: [] },
      inc: { count: 1 },
    };

    const first = await widgets.upsertOne(alpha.tenant, { widgetId: id }, spec);
    const second = await widgets.upsertOne(alpha.tenant, { widgetId: id }, spec);

    expect(second.count).toBe(2);
    expect(second.label).toBe(first.label);
    expect(await widgets.countDocuments(alpha.tenant, { widgetId: id })).toBe(1);
  });

  it('never finds another application document, and creates its own instead', async () => {
    const id = widgetId();
    await widgets.upsertOne(
      alpha.tenant,
      { widgetId: id },
      { setOnInsert: { label: 'alpha', ceiling: 0, tags: [] } },
    );

    const sibling = await widgets.upsertOne(
      alphaSibling.tenant,
      { widgetId: id },
      { setOnInsert: { label: 'sibling', ceiling: 0, tags: [] } },
    );

    expect(sibling.label).toBe('sibling');
    expect(sibling.applicationId).toBe(alphaSibling.applicationId);
    expect((await widgets.findOne(alpha.tenant, { widgetId: id }))?.label).toBe('alpha');
  });
});

describe('find', () => {
  it('returns only documents of the calling tenant, sorted and limited', async () => {
    const prefix = `sorted_${Date.now()}`;
    for (const [index, label] of ['c', 'a', 'b'].entries()) {
      await widgets.insertOne(alpha.tenant, {
        widgetId: `${prefix}_${label}`,
        label,
        count: index,
        ceiling: 0,
        tags: [prefix],
      });
    }
    await widgets.insertOne(alphaSibling.tenant, {
      widgetId: `${prefix}_sibling`,
      label: 'a',
      count: 0,
      ceiling: 0,
      tags: [prefix],
    });

    const found = await widgets.find(
      alpha.tenant,
      { tags: prefix },
      { sort: { label: 1 }, limit: 2 },
    );

    expect(found.map((widget) => widget.label)).toEqual(['a', 'b']);
    expect(found.every((widget) => widget.applicationId === alpha.applicationId)).toBe(true);
  });

  it('returns everything matching when no options are given', async () => {
    const tag = `unbounded_${Date.now()}`;
    await widgets.insertOne(alpha.tenant, {
      widgetId: widgetId(),
      label: 'only',
      count: 0,
      ceiling: 0,
      tags: [tag],
    });

    expect(await widgets.find(alpha.tenant, { tags: tag })).toHaveLength(1);
    expect(await widgets.find(alphaSibling.tenant, { tags: tag })).toHaveLength(0);
  });
});
