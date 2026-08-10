import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APPLICATION_GUC,
  MIGRATOR_ACCESS_POLICY,
  MIGRATOR_ROLE,
  ORGANIZATION_GUC,
  TENANT_ISOLATION_POLICY,
} from '../db/postgres/tenancy';
import {
  TENANT_SCOPED_TABLES,
  UNSCOPED_TABLES,
  declaredTableNames,
} from '../db/postgres/tableRegistry';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './support/postgresTestDatabase';

/**
 * The Postgres tenant boundary gate — the successor to
 * `collectionBoundary.test.ts`, and a deliberate improvement on it.
 *
 * The Mongo gate could not see `Decision` or `Appeal` because the set it
 * inspected came from a hand-maintained import list, so two of the most
 * consequential collections in the system were outside it while every assertion
 * passed. This one takes its input from the FILESYSTEM: every table declared in
 * `db/postgres/schema/` must appear in the registry, so a new table cannot become
 * invisible by nobody adding it to a list.
 *
 * The catalogue assertions matter more than they look. `rlsTenantIsolation`
 * proves isolation BEHAVES correctly, but it proves it for `cases` — and under
 * the migrator/application role split isolation holds WITHOUT `FORCE`, because
 * the application role is a non-owner and is bound either way. That was measured:
 * removing `FORCE` left all eleven isolation tests green and reddened only the
 * `pg_class` assertion. So the FORCE check here is the ONLY thing in the system
 * that can ever catch a table shipped without it, on a property that only starts
 * mattering the day somebody changes an owner. It gets its own mutation test
 * below rather than inheriting confidence from the behavioural suite.
 */

let database: PostgresTestDatabase;

const schemaDirectory = path.resolve(__dirname, '..', 'db', 'postgres', 'schema');

/**
 * Table names taken from the schema SOURCE, not from the barrel and not from the
 * registry — both of which are the thing under test.
 */
function tablesDeclaredInSource(): string[] {
  const names = readdirSync(schemaDirectory)
    .filter((entry) => entry.endsWith('.ts') && entry !== 'index.ts')
    .flatMap((entry) => {
      const source = readFileSync(path.join(schemaDirectory, entry), 'utf8');
      return [...source.matchAll(/pgTable\(\s*'([a-z_]+)'/g)].map((match) => match[1]);
    });

  return [...new Set(names)].sort();
}

const sourceTables = tablesDeclaredInSource();

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe('every table is an explicit decision', () => {
  /**
   * The vacuity floor. A regex that stopped matching would make every assertion
   * below pass while checking no tables whatsoever — the defect this whole file
   * replaces, one layer up.
   */
  it('found the tables in the schema directory', () => {
    expect(sourceTables.length).toBeGreaterThanOrEqual(11);
    expect(sourceTables).toContain('cases');
    expect(sourceTables).toContain('decisions');
    expect(sourceTables).toContain('appeals');
  });

  it('declares each one as tenant-scoped or exempt, and never neither', () => {
    const declared = new Set(declaredTableNames());
    const undeclared = sourceTables.filter((table) => !declared.has(table));

    // Named, so a failure says which table to decide about rather than a count.
    expect(undeclared).toEqual([]);
  });

  it('never declares one as both', () => {
    const both = TENANT_SCOPED_TABLES.filter((table) => table in UNSCOPED_TABLES);
    expect(both).toEqual([]);
  });

  it('does not name a table that no longer exists', () => {
    const inSource = new Set(sourceTables);
    expect(declaredTableNames().filter((table) => !inSource.has(table))).toEqual([]);
  });

  it('makes every exemption state a reason', () => {
    for (const [table, why] of Object.entries(UNSCOPED_TABLES)) {
      expect(why.trim().length, `${table} must say why it is exempt`).toBeGreaterThanOrEqual(30);
    }
  });
});

describe('every tenant-scoped table is actually isolated by the server', () => {
  /**
   * Read from `pg_class` rather than inferred from behaviour. A table shipped
   * without `FORCE` behaves identically for the application role today, so
   * nothing except this can notice it.
   */
  it('has row security ENABLED and FORCED on all of them', async () => {
    const rows = await database.asMigrator<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = ANY(${[...TENANT_SCOPED_TABLES]}) AND relkind = 'r'
      ORDER BY relname
    `;

    // The floor: every declared table must actually be present in the database.
    expect(rows.map((row) => row.relname)).toEqual([...TENANT_SCOPED_TABLES].sort());

    const unprotected = rows
      .filter((row) => !row.relrowsecurity || !row.relforcerowsecurity)
      .map((row) => `${row.relname} (enabled=${row.relrowsecurity}, forced=${row.relforcerowsecurity})`);

    expect(unprotected).toEqual([]);
  });

  it('carries a tenant policy naming BOTH runtime parameters', async () => {
    const policies = await database.asMigrator<{ tablename: string; qual: string }[]>`
      SELECT tablename, qual FROM pg_policies
      WHERE policyname = ${TENANT_ISOLATION_POLICY} AND tablename = ANY(${[...TENANT_SCOPED_TABLES]})
    `;

    expect(policies.map((row) => row.tablename).sort()).toEqual([...TENANT_SCOPED_TABLES].sort());

    // An organization-only policy is the defect a two-tenant fixture cannot see,
    // so it is refused here by name for every table rather than behaviourally for
    // one of them.
    const narrowed = policies
      .filter((row) => !row.qual.includes(ORGANIZATION_GUC) || !row.qual.includes(APPLICATION_GUC))
      .map((row) => row.tablename);

    expect(narrowed).toEqual([]);
  });

  it('carries the migrator policy, so a data migration is not a silent no-op', async () => {
    const policies = await database.asMigrator<{ tablename: string; roles: string }[]>`
      SELECT tablename, roles::text FROM pg_policies
      WHERE policyname = ${MIGRATOR_ACCESS_POLICY} AND tablename = ANY(${[...TENANT_SCOPED_TABLES]})
    `;

    expect(policies.map((row) => row.tablename).sort()).toEqual([...TENANT_SCOPED_TABLES].sort());
    for (const policy of policies) {
      expect(policy.roles).toContain(MIGRATOR_ROLE);
    }
  });

  it('gives the application role DML on every one, through default privileges', async () => {
    const granted = await database.asMigrator<{ table_name: string; n: number }[]>`
      SELECT table_name, count(*)::int AS n
      FROM information_schema.role_table_grants
      WHERE grantee = 'crowdsource_app' AND table_name = ANY(${[...TENANT_SCOPED_TABLES]})
      GROUP BY table_name
      ORDER BY table_name
    `;

    // Four privileges each: SELECT, INSERT, UPDATE, DELETE. The migration issues
    // no GRANT at all, so this is the default-privilege contract from runbook 30
    // §2A being asserted rather than assumed.
    expect(granted.map((row) => row.table_name)).toEqual([...TENANT_SCOPED_TABLES].sort());
    for (const row of granted) {
      expect(row.n, `${row.table_name} must grant all four DML privileges`).toBe(4);
    }
  });
});

describe('the gate can fail', () => {
  /**
   * The mutation test for the FORCE assertion specifically.
   *
   * It does not inherit confidence from `rlsTenantIsolation.realdb.test.ts`,
   * because that suite was measured to stay entirely green with `FORCE` removed —
   * the application role is a non-owner and is bound without it. This assertion
   * is the only witness, so it needs its own proof that it can go red.
   */
  it('notices a tenant table whose FORCE was dropped', async () => {
    const target = 'audit_events';
    try {
      await database.asMigrator.unsafe(`ALTER TABLE "${target}" NO FORCE ROW LEVEL SECURITY`);

      // Assert the mutation landed before believing what it produces.
      const [mutated] = await database.asMigrator<{ relforcerowsecurity: boolean }[]>`
        SELECT relforcerowsecurity FROM pg_class WHERE relname = ${target}
      `;
      expect(mutated.relforcerowsecurity).toBe(false);

      const rows = await database.asMigrator<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname = ANY(${[...TENANT_SCOPED_TABLES]}) AND relkind = 'r'
      `;
      const unprotected = rows.filter((row) => !row.relforcerowsecurity).map((row) => row.relname);

      // The gate's own predicate, run against the mutated catalogue: it must
      // single the table out by name rather than merely counting.
      expect(unprotected).toEqual([target]);
    } finally {
      await database.asMigrator.unsafe(`ALTER TABLE "${target}" FORCE ROW LEVEL SECURITY`);
    }

    const [restored] = await database.asMigrator<{ relforcerowsecurity: boolean }[]>`
      SELECT relforcerowsecurity FROM pg_class WHERE relname = ${target}
    `;
    expect(restored.relforcerowsecurity).toBe(true);
  });

  /**
   * And the registry half: a table present in the source but in neither list must
   * be reported, not skipped. Exercised against a synthetic name so the real
   * registry stays intact.
   */
  it('notices a table that is in neither list', () => {
    const declared = new Set(declaredTableNames());
    const withNewTable = [...sourceTables, 'a_table_nobody_classified'];

    expect(withNewTable.filter((table) => !declared.has(table))).toEqual([
      'a_table_nobody_classified',
    ]);
  });
});
