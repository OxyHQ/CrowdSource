import { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  defineTenantCollection,
  defineUnscopedCollection,
  registeredCollectionNames,
  unscopedCollectionReasons,
} from '../db/collections';
import { duplicateKeyViolation } from '../db/transaction';
import type { TenantContext } from '../db/tenantScope';

/**
 * The access layer itself, exercised without a database.
 *
 * Registration and error classification are pure enough to test in isolation;
 * what the collections DO with a tenant is tested against a real replica set in
 * the integration suites, because a mocked driver would agree with any claim
 * made about a unique index or a transaction.
 */

interface Sample extends TenantContext {
  label: string;
}

const sampleSchema = new Schema<Sample>({
  organizationId: { type: String, required: true },
  applicationId: { type: String, required: true },
  label: { type: String, required: true },
});

describe('collection registration', () => {
  it('registers tenant-owned and unscoped collections under their names', () => {
    defineTenantCollection('SampleScoped', sampleSchema);
    defineUnscopedCollection('SampleUnscoped', sampleSchema, {
      why: 'A fixture, declared here only to exercise registration.',
    });

    expect(registeredCollectionNames()).toEqual(
      expect.arrayContaining(['SampleScoped', 'SampleUnscoped']),
    );
    expect(unscopedCollectionReasons().get('SampleUnscoped')).toContain('fixture');
    // The map is a copy: a caller cannot edit the exemption list it is shown.
    unscopedCollectionReasons().delete('SampleUnscoped');
    expect(unscopedCollectionReasons().has('SampleUnscoped')).toBe(true);
  });

  /**
   * Vitest reuses a worker process while resetting the module registry, so a
   * model name can be declared twice against the same Mongoose instance. If that
   * threw, whether the suite ran at all would depend on file order.
   */
  it('tolerates a model being declared twice', () => {
    expect(() => defineTenantCollection('SampleRedeclared', sampleSchema)).not.toThrow();
    expect(() => defineTenantCollection('SampleRedeclared', sampleSchema)).not.toThrow();
  });
});

describe('duplicateKeyViolation', () => {
  it('names the fields of the offending index', () => {
    const error = Object.assign(new Error('E11000 duplicate key'), {
      code: 11000,
      keyPattern: { applicationId: 1, externalReportId: 1 },
    });

    expect(duplicateKeyViolation(error)).toEqual({
      indexFields: ['applicationId', 'externalReportId'],
    });
  });

  it('still reports a duplicate key that carries no usable key pattern', () => {
    expect(duplicateKeyViolation(Object.assign(new Error('E11000'), { code: 11000 }))).toEqual({
      indexFields: [],
    });
    expect(
      duplicateKeyViolation(Object.assign(new Error('E11000'), { code: 11000, keyPattern: null })),
    ).toEqual({ indexFields: [] });
  });

  it('does not mistake anything else for one', () => {
    expect(duplicateKeyViolation(null)).toBeNull();
    expect(duplicateKeyViolation('E11000 duplicate key')).toBeNull();
    expect(duplicateKeyViolation(new Error('write conflict'))).toBeNull();
    expect(duplicateKeyViolation(Object.assign(new Error('x'), { code: 112 }))).toBeNull();
  });
});
