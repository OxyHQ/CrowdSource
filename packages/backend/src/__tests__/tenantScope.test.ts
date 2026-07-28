import { describe, expect, it } from 'vitest';

import {
  createTenantContext,
  isScopedToTenant,
  tenantScopedDocument,
  tenantScopedFilter,
} from '../db/tenantScope';

const context = createTenantContext('org_1', 'app_example');

describe('tenant scope', () => {
  it('rejects an empty tenant identifier', () => {
    expect(() => createTenantContext('', 'app_1')).toThrow(/organizationId/);
    expect(() => createTenantContext('org_1', '   ')).toThrow(/applicationId/);
  });

  it('applies both tenant keys to a filter', () => {
    expect(tenantScopedFilter(context, { status: 'received' })).toEqual({
      status: 'received',
      organizationId: 'org_1',
      applicationId: 'app_example',
    });
  });

  it('scopes an empty filter rather than returning an unscoped one', () => {
    expect(tenantScopedFilter(context)).toEqual({
      organizationId: 'org_1',
      applicationId: 'app_example',
    });
  });

  /**
   * The whole boundary rests on this: a caller must not be able to choose the
   * tenant. Supplying a tenant key is a programming error and is rejected
   * loudly, rather than silently corrected where the next author would copy the
   * pattern and eventually find a path that is not corrected.
   */
  it('refuses a caller-supplied tenant key on a filter', () => {
    expect(() =>
      tenantScopedFilter(context, { applicationId: 'app_other_tenant' }),
    ).toThrow(/must not set 'applicationId'/);
    expect(() =>
      tenantScopedFilter(context, { organizationId: 'org_someone_else' }),
    ).toThrow(/must not set 'organizationId'/);
  });

  it('refuses a caller-supplied tenant key on a document', () => {
    expect(() =>
      tenantScopedDocument(context, { externalReportId: 'r1', organizationId: 'org_2' }),
    ).toThrow(/must not set 'organizationId'/);
  });

  it('stamps a new document with its owning tenant', () => {
    expect(tenantScopedDocument(context, { externalReportId: 'r1' })).toEqual({
      externalReportId: 'r1',
      organizationId: 'org_1',
      applicationId: 'app_example',
    });
  });

  it('recognises whether a value belongs to a tenant', () => {
    expect(isScopedToTenant(context, { organizationId: 'org_1', applicationId: 'app_example' })).toBe(
      true,
    );
    expect(isScopedToTenant(context, { organizationId: 'org_1', applicationId: 'app_other' })).toBe(
      false,
    );
    expect(isScopedToTenant(context, { organizationId: 'org_1' })).toBe(false);
    expect(isScopedToTenant(context, {})).toBe(false);
  });

  it('freezes the context so it cannot be retargeted after construction', () => {
    expect(Object.isFrozen(context)).toBe(true);
  });
});
