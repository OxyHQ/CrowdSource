import type { TenantColumnShape } from './tableRegistry';

/**
 * Deriving a table's ACTUAL tenant-column shape from the live catalogue.
 *
 * Split out of the gate for the reason `driverEscapes.ts` is split out of
 * `collectionBoundary.test.ts`: the comparison is the load-bearing part, and a
 * predicate that lives inside the assertion it feeds can only be mutation-tested
 * by breaking the schema. Here it is a pure function over rows, so the cases that
 * matter — a column missing, a column nullable that should not be — can be
 * exercised directly and cheaply, and the real-server assertion is left to prove
 * only that the catalogue is read correctly.
 *
 * The shapes this can return are exactly `TenantColumnShape`. Anything else a
 * table might do with these two columns — carrying `organization_id` as NULLABLE,
 * or carrying both with one of them nullable — is deliberately NOT a member:
 * every such combination is a table nobody has thought about, and returning
 * `null` makes the gate report it rather than quietly filing it under the nearest
 * fit.
 */

/** One row of `information_schema.columns`, narrowed to what this needs. */
export interface CatalogueColumn {
  readonly column_name: string;
  /** `information_schema` spells this `'YES'` / `'NO'`, not a boolean. */
  readonly is_nullable: string;
}

const ORGANIZATION_COLUMN = 'organization_id';
const APPLICATION_COLUMN = 'application_id';

function find(columns: readonly CatalogueColumn[], name: string): CatalogueColumn | undefined {
  return columns.find((column) => column.column_name === name);
}

/** True when `information_schema` reports the column as `NOT NULL`. */
function isNotNull(column: CatalogueColumn): boolean {
  return column.is_nullable === 'NO';
}

/**
 * The shape these columns describe, or `null` when they describe none of them.
 *
 * `null` is a REFUSAL, not an absence of opinion: it means the table carries a
 * combination the vocabulary cannot express, which is a table whose tenant
 * columns nobody has decided about. The gate prints the offending columns rather
 * than a count, so the failure names what to fix.
 */
export function tenantColumnShapeOf(
  columns: readonly CatalogueColumn[],
): TenantColumnShape | null {
  const organization = find(columns, ORGANIZATION_COLUMN);
  const application = find(columns, APPLICATION_COLUMN);

  if (organization === undefined && application === undefined) return 'neither';

  if (organization !== undefined && application !== undefined) {
    // Both present. Only the all-NOT NULL form is expressible: a nullable half
    // means rows can exist outside a tenant on a table that otherwise claims to
    // be tenant-attributed, and that is a decision, not a detail.
    return isNotNull(organization) && isNotNull(application) ? 'both_not_null' : null;
  }

  if (application === undefined) {
    // Organization only. There is no `organization_nullable` counterpart on
    // purpose: nothing in this service carries a nullable organization, so the
    // member would be a vocabulary entry no table uses and nothing would refuse.
    //
    // Written as `application === undefined` rather than the more natural
    // `organization !== undefined` so the remaining branch NARROWS: the
    // both-undefined and both-defined cases have already returned, and this shape
    // lets the compiler prove the last one rather than being told.
    return organization !== undefined && isNotNull(organization) ? 'organization_only' : null;
  }

  return isNotNull(application) ? 'application_only' : 'application_nullable';
}

/**
 * A one-line description of what a table actually carries, for a failure message.
 *
 * The gate prints this beside the declared shape, because "declared
 * `application_only`, observed `null`" sends somebody to read the migration while
 * "observed organization_id NOT NULL, application_id NULLABLE" tells them what it
 * says.
 */
export function describeTenantColumns(columns: readonly CatalogueColumn[]): string {
  // `flatMap` rather than filter-then-map, so the narrowing is the compiler's
  // rather than a type assertion papering over the same reasoning.
  const present = [ORGANIZATION_COLUMN, APPLICATION_COLUMN].flatMap((name) => {
    const column = find(columns, name);
    if (column === undefined) return [];
    return [`${name} ${isNotNull(column) ? 'NOT NULL' : 'NULLABLE'}`];
  });

  return present.length === 0 ? 'neither column present' : present.join(', ');
}
