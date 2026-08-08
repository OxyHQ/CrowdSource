/**
 * The Postgres schema, asserted against a REAL migrated database.
 *
 * Every check here reads the Postgres catalogue rather than the TypeScript that
 * was meant to produce it, which is the only way three particular classes of
 * defect are visible at all:
 *
 * - a **derived** column name. Two of `@oxyhq/db`'s builders take no name
 *   argument, so those SQL names come from `DATABASE_CASING`; its derivation
 *   mangles digit- and capital-adjacent names, and the result is a working
 *   column called something nobody chose. The exact name sets below are what
 *   would catch it.
 * - a **missing TTL replacement**. Postgres does not reap. A table that carried
 *   `expireAfterSeconds` and has no sweep registry entry grows forever, with no
 *   error and no failing test — so the registry is asserted, and the index its
 *   sweep needs is asserted against `pg_index`, which no fake can answer.
 * - an **unclassified id column**. `no constraint` and `nobody has looked at
 *   this` are indistinguishable without a ledger, and the ledger this package
 *   ships is what stops the first adopter writing eight reasons by guessing.
 *
 * This is also the ONE file allowed to import both storage halves: the Postgres
 * table names and the local-status tuple are spelled out on the Postgres side so
 * that importing them can never pull `mongoose` into a Postgres-only deployment,
 * and something has to prove the two spellings still agree.
 */

import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, executeRows, sqlColumnName, type OxyDatabase } from '@oxyhq/db';
import {
  findIdColumnViolations,
  findSchemaInvariantViolations,
  findUnsupportedExpiryColumns,
} from '@oxyhq/db/assert';
import { runMigrations } from '@oxyhq/db/migrate';
import { createTestDatabase, dropTestDatabase } from '@oxyhq/db/testing';
import {
  MODERATION_ENFORCEMENT_COLLECTION,
  MODERATION_EVENT_COLLECTION,
  MODERATION_OUTBOX_COLLECTION,
} from '../mongoose/models.js';
import { MODERATION_LOCAL_STATUSES } from '../mongoose/report.js';
import {
  moderationExpirySweepTargets,
  moderationIdColumnsWithoutForeignKey,
} from '../postgres/registries.js';
import * as schema from './support/postgres/schema.js';

/**
 * The counts this task lands, stated EXACTLY rather than as a lower bound.
 *
 * A floor pulled from the air is a floor that never rises, and a traversal that
 * silently examined nothing clears it. These two numbers are the whole schema:
 * five tables (three this package owns, the application's report table, and its
 * widgets) and the 71 columns across them.
 */
const TABLE_COUNT = 5;
const COLUMN_COUNT = 71;

const MIGRATIONS_FOLDER = resolve(__dirname, 'support/postgres/migrations');

/** Every column name, per table, as the catalogue must hold it. */
const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  moderation_outbox: [
    'attempts',
    'available_at',
    'created_at',
    'expires_at',
    'id',
    'kind',
    'last_error',
    'lease_owner',
    'lease_until',
    'payload',
    'processed_at',
    'status',
    'updated_at',
  ],
  moderation_events: [
    'case_id',
    'created_at',
    'expires_at',
    'id',
    'payload',
    'queued_at',
    'received_at',
    'state',
    'type',
    'updated_at',
  ],
  moderation_enforcements: [
    'action',
    'applied',
    'applied_at',
    'case_id',
    'created_at',
    'decision_id',
    'decision_revision',
    'mode',
    'outcome',
    'previous_state',
    'reason',
    'recommended_action',
    'recorded_as',
    'skipped_reason',
    'subject_id',
    'subject_type',
    'updated_at',
  ],
  moderation_reports: [
    'categories',
    'content_snapshot_hash',
    'created_at',
    'crowdsource_case_id',
    'crowdsource_merged',
    'crowdsource_report_id',
    'decided_at',
    'decision_id',
    'decision_outcome',
    'decision_revision',
    'decision_status',
    'details',
    'enforced_action',
    'enforced_at',
    'id',
    'last_delivery_error',
    'legacy_status',
    'local_status',
    'local_status_reason',
    'reported_id',
    'reported_type',
    'reporter',
    'submitted_at',
    'updated_at',
  ],
};

const PACKAGE_TABLES = [schema.moderationOutbox, schema.moderationEvents, schema.moderationEnforcements];
const ALL_TABLES = [...PACKAGE_TABLES, schema.reports, schema.widgets];

type Schema = typeof schema;

let databaseUrl: string | null = null;
let client: postgres.Sql | null = null;
let db: OxyDatabase<Schema> | null = null;

beforeAll(async () => {
  databaseUrl = await createTestDatabase({
    adminUrl: process.env.CROWDSOURCE_APP_TEST_POSTGRES_URL,
    migrate: async (url) =>
      await runMigrations({
        databaseUrl: url,
        migrationsFolder: MIGRATIONS_FOLDER,
        // Nothing in the moderation tables needs an extension: no PostGIS, no
        // pg_trgm. `CREATE EXTENSION` is a privileged statement on RDS, so a
        // package that needed one would make itself an infrastructure change.
        extensions: [],
        run: 'all',
        dryRun: false,
        logger: { info: () => undefined, debug: () => undefined },
      }),
  });
  const built = createDatabase<Schema>({ databaseUrl, schema });
  db = built.db;
  client = built.client;
});

afterAll(async () => {
  await client?.end();
  client = null;
  db = null;
  if (databaseUrl !== null) {
    await dropTestDatabase(databaseUrl);
    databaseUrl = null;
  }
});

function database(): OxyDatabase<Schema> {
  if (db === null) throw new Error('the throwaway database was not created');
  return db;
}

describe('the migrated schema', () => {
  it('breaks none of the shared invariants', async () => {
    expect(
      await findSchemaInvariantViolations(database(), {
        minimumTables: TABLE_COUNT,
        minimumColumns: COLUMN_COUNT,
      }),
    ).toEqual([]);
  });

  it('holds exactly the columns the definitions declare, under the names they declare', async () => {
    const rows = await executeRows<{ table_name: string; column_name: string }>(
      database(),
      sql`select table_name, column_name from information_schema.columns
          where table_schema = 'public'`,
    );

    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      const names = byTable.get(row.table_name) ?? [];
      names.push(row.column_name);
      byTable.set(row.table_name, names);
    }

    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      expect(byTable.get(table)?.sort(), `columns of ${table}`).toEqual([...expected]);
    }
  });

  it('names its tables and statuses the same as the Mongo half', () => {
    /**
     * Both halves spell these out independently — importing either direction
     * would pull a driver into the other backend's path — so agreement is a gate
     * rather than a construction. A rename on one side alone is what this
     * catches, and the cost of missing it is two deployments of one package that
     * cannot be read side by side.
     */
    const tableNames = Object.keys(EXPECTED_COLUMNS);
    expect(tableNames).toContain(MODERATION_OUTBOX_COLLECTION);
    expect(tableNames).toContain(MODERATION_EVENT_COLLECTION);
    expect(tableNames).toContain(MODERATION_ENFORCEMENT_COLLECTION);

    const localStatusCheck = [...MODERATION_LOCAL_STATUSES].sort();
    expect(localStatusCheck).toEqual([
      'closed',
      'delivery_failed',
      'queued',
      'received',
      'submitted',
    ]);
  });
});

describe('the registry fragments an adopter merges', () => {
  it('classifies every id-shaped column, the adopter’s own included', () => {
    expect(
      findIdColumnViolations({
        tables: ALL_TABLES,
        deferred: [],
        withoutForeignKey: [
          ...moderationIdColumnsWithoutForeignKey({
            tables: schema.moderation,
            reportTable: schema.reports,
          }),
          /**
           * The APPLICATION's own entry, alongside the package's eight. This is
           * how the fragment is meant to compose — and `widgets.owner_id` is the
           * same shape as `subject_id`: an id in a store this schema does not
           * model.
           */
          {
            column: 'widgets.owner_id',
            reason: 'An Oxy account id — no local table to reference.',
          },
        ],
        minimumTables: TABLE_COUNT,
      }),
    ).toEqual([]);
  });

  it('has an index behind every swept column', async () => {
    /**
     * Against the REAL catalogue, because the question is whether a leading
     * btree exists — `pg_index` is the only thing that knows, and a fake would
     * answer whatever it was built to answer. Without the index the sweep's
     * `expires_at <= now()` is a sequential scan on a schedule: exactly the cost
     * Mongo's TTL index hid, now paid rather than never.
     */
    expect(
      await findUnsupportedExpiryColumns(
        database(),
        moderationExpirySweepTargets(schema.moderation),
      ),
    ).toEqual([]);
  });

  it('registers a sweep target for every table that carried a TTL index', () => {
    /**
     * `sqlColumnName`, not `column.name`. The second is the TypeScript PROPERTY
     * name, and these two columns are declared through `timestamptz()`, which
     * takes no name — so `.name` answers `expiresAt` while the database holds
     * `expires_at`. This assertion was written the wrong way first and failed
     * for exactly that reason, which is the trap `@oxyhq/db`'s casing module
     * exists to close: in a catalogue query the same mistake silently matches
     * nothing.
     */
    const swept = moderationExpirySweepTargets(schema.moderation).map((target) =>
      sqlColumnName(target.column),
    );
    // The outbox and the event log, and no others: enforcement rows are the audit
    // trail of what was done to somebody's content and are never reaped.
    expect(swept).toEqual(['expires_at', 'expires_at']);
    expect(moderationExpirySweepTargets(schema.moderation)).toHaveLength(2);
  });
});
