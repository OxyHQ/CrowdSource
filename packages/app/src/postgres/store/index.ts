import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { ModerationStore } from '../../store/types.js';
import type { ModerationReportFields } from '../../types.js';
import type { ModerationReportTable } from '../reportColumns.js';
import type { ModerationTables } from '../tables.js';
import { postgresEnforcementStore } from './enforcement.js';
import { postgresEventStore } from './events.js';
import { postgresOutboxStore } from './outbox.js';
import { postgresReportStore } from './reports.js';
import { postgresTransactionRunner, type ModerationPgHandle } from './transaction.js';

/**
 * Everything this package writes, in Postgres.
 *
 * One factory rather than five, because the five members must share one handle: a
 * report and its outbox row commit in the SAME transaction, and a store assembled
 * from two handles would type-check perfectly and quietly lose that.
 *
 * Unlike the Mongo factory, this one CREATES NOTHING. There is no schema to
 * register: the adopter's own migration created the tables, generated from the
 * definitions this package exports, in the adopter's own journal. That asymmetry
 * is deliberate and is the reason no migrations folder ships here — two journals
 * against one `drizzle.__drizzle_migrations` table interleave, and the loser is
 * skipped in silence with exit 0.
 */
export function postgresModerationStore<TReport extends ModerationReportFields>(input: {
  db: ModerationPgHandle;
  /** The application's own report table, built from `moderationReportColumns`. */
  reportTable: ModerationReportTable;
  /** The three tables this package owns, from `moderationTables`. */
  tables: ModerationTables;
}): ModerationStore<TReport, ModerationPgHandle> {
  const { db, reportTable, tables } = input;

  return {
    transaction: postgresTransactionRunner(db),
    outbox: postgresOutboxStore({ db, tables }),
    events: postgresEventStore({ db, tables }),
    enforcement: postgresEnforcementStore({ db, tables }),
    reports: postgresReportStore<TReport>({ db, reportTable }),

    /**
     * ASSERTS the schema, rather than creating it.
     *
     * The Mongo half calls `init()` and builds indexes; there is nothing here to
     * build, so what remains is worth doing for its own sake: confirming the four
     * tables this package queries exist BEFORE the first report is filed rather
     * than at the first delivery.
     *
     * A missing table raises `42P01 undefined_table` and names it. `limit(0)`
     * means Postgres parses and plans each statement — which is what proves the
     * relation resolves — without reading a row.
     *
     * It cannot check COLUMNS. An adopter whose migration is a version behind
     * gets a compile error from `ModerationReportTable` for a missing column and
     * a `42703` from the query for a stale migration; both are loud, and neither
     * is this function's job.
     */
    async ensureSchema() {
      const present: readonly PgTable[] = [
        tables.outbox,
        tables.events,
        tables.enforcements,
        reportTable,
      ];
      for (const table of present) {
        await db.select({ resolves: sql`1` }).from(table).limit(0);
      }
    },
  };
}
