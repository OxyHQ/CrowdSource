import { describe, expect, it } from 'vitest';

import {
  type CatalogueColumn,
  describeTenantColumns,
  tenantColumnShapeOf,
} from '../db/postgres/tenantColumnShape';

/**
 * The predicate the two-way structural exemption rests on.
 *
 * `postgresTableBoundary.realdb.test.ts` compares each exemption's DECLARED shape
 * against what this derives from `information_schema.columns`. That comparison is
 * only as good as this function, and a real server can only exercise the shapes
 * the schema happens to contain — so the cases that decide correctness are here,
 * where a nullable half or an unexpressible combination can be constructed
 * directly.
 *
 * Every fixture below sits on a DIFFERENT side of a distinction the function
 * exists to make. That is deliberate and it is the whole value of the file: a
 * suite of tidy fixtures that all agree would pass just as happily against a
 * function that only checked column PRESENCE and ignored nullability, which is
 * exactly the weaker implementation somebody would write.
 */

function column(name: string, nullable: boolean): CatalogueColumn {
  return { column_name: name, is_nullable: nullable ? 'YES' : 'NO' };
}

const ORGANIZATION_NOT_NULL = column('organization_id', false);
const ORGANIZATION_NULLABLE = column('organization_id', true);
const APPLICATION_NOT_NULL = column('application_id', false);
const APPLICATION_NULLABLE = column('application_id', true);

describe('tenantColumnShapeOf', () => {
  it('reads both columns NOT NULL as the tenant-stamped shape', () => {
    expect(tenantColumnShapeOf([ORGANIZATION_NOT_NULL, APPLICATION_NOT_NULL])).toBe(
      'both_not_null',
    );
  });

  /**
   * The distinction a presence-only check cannot make, in the direction that
   * matters: a row able to sit outside every tenant on a table that claims to be
   * tenant-stamped. `cases.ts` states why that row would be immortal — no policy
   * would ever match it — so this is refused rather than filed under the shape it
   * nearly is.
   */
  it('refuses both columns when either half is nullable', () => {
    expect(tenantColumnShapeOf([ORGANIZATION_NOT_NULL, APPLICATION_NULLABLE])).toBeNull();
    expect(tenantColumnShapeOf([ORGANIZATION_NULLABLE, APPLICATION_NOT_NULL])).toBeNull();
    expect(tenantColumnShapeOf([ORGANIZATION_NULLABLE, APPLICATION_NULLABLE])).toBeNull();
  });

  it('reads an organization-only table', () => {
    expect(tenantColumnShapeOf([ORGANIZATION_NOT_NULL])).toBe('organization_only');
  });

  it('refuses a nullable organization, which no table here is meant to have', () => {
    expect(tenantColumnShapeOf([ORGANIZATION_NULLABLE])).toBeNull();
  });

  /**
   * The pair that `staff_audit_events` turns on.
   *
   * Its `application_id` is nullable — "the application acted on, when the action
   * names one" — while `reviewer_relations.application_id` is required. Both are
   * application-only tables, and a check that stopped at presence would call them
   * the same shape, so the registry could claim either for either and the gate
   * would agree.
   */
  it('tells a required application column from a nullable one', () => {
    expect(tenantColumnShapeOf([APPLICATION_NOT_NULL])).toBe('application_only');
    expect(tenantColumnShapeOf([APPLICATION_NULLABLE])).toBe('application_nullable');
  });

  it('reads a table with neither column', () => {
    expect(tenantColumnShapeOf([])).toBe('neither');
  });

  /**
   * The rows handed in come from a query filtered to the two names, but the
   * function must not depend on that filtering — a caller passing a whole table's
   * columns has to get the same answer, or the gate's correctness would rest on
   * the WHERE clause of a query in another file.
   */
  it('ignores every column that is not one of the two', () => {
    expect(
      tenantColumnShapeOf([
        column('reviewer_id', false),
        column('occurred_at', false),
        APPLICATION_NULLABLE,
        column('roles', true),
      ]),
    ).toBe('application_nullable');

    expect(
      tenantColumnShapeOf([column('pair_key', false), column('co_served_count', false)]),
    ).toBe('neither');
  });
});

describe('describeTenantColumns', () => {
  /**
   * The failure message is part of the gate, not decoration. "declared
   * application_only, observed null" sends somebody to read a migration;
   * "organization_id NOT NULL, application_id NULLABLE" tells them what it says.
   */
  it('names each present column and its nullability', () => {
    expect(describeTenantColumns([ORGANIZATION_NOT_NULL, APPLICATION_NULLABLE])).toBe(
      'organization_id NOT NULL, application_id NULLABLE',
    );
  });

  it('says so plainly when neither column is present', () => {
    expect(describeTenantColumns([column('pair_key', false)])).toBe('neither column present');
  });

  /** Order comes from the function, not from the row order a query happened to return. */
  it('reports a stable order whichever way the rows arrive', () => {
    expect(describeTenantColumns([APPLICATION_NOT_NULL, ORGANIZATION_NOT_NULL])).toBe(
      'organization_id NOT NULL, application_id NOT NULL',
    );
  });
});
