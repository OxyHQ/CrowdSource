import type { TablesRelationalConfig } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { ModerationTransactionRunner } from '../../store/types.js';

/**
 * The drizzle handle this package's Postgres stores talk to.
 *
 * Deliberately the BASE `PgDatabase` rather than a `PostgresJsDatabase`: the
 * stores must accept both the pool handle an adopter builds and the `tx` handed
 * to a `db.transaction` callback, and those are different types. Written this
 * way, one signature serves both and no store needs to know which it holds.
 *
 * ## The generic that has to be `Record<string, unknown>`, and the error you get
 *
 * `TablesRelationalConfig` and `Record<string, unknown>` are the only spellings
 * that accept both. The narrow one a reader reaches for first —
 * `Record<string, never>` for the schema — accepts NEITHER (`TS2345`, the schema
 * generic is invariant).
 *
 * The consequence lands on the ADOPTER, so it is worth stating: a handle built
 * with NO schema (`drizzle(client)`, or `PostgresJsDatabase<Record<string, never>>`)
 * is not assignable either, and the compiler explains it as
 * `Seems like the schema generic is missing - did you forget to add it to your DB
 * type?` — an error about `query`, on a store call that never touches the
 * relational query builder. Pass your schema to `drizzle()` (or use
 * `createDatabase({ databaseUrl, schema })` from `@oxyhq/db`) and it resolves.
 * Both directions are verified in this package's own type-check.
 */
export type ModerationPgHandle = PgDatabase<
  PgQueryResultHKT,
  Record<string, unknown>,
  TablesRelationalConfig
>;

/**
 * The transaction runner, in Postgres.
 *
 * READ COMMITTED, explicitly, and not `repeatable read`. Neither multi-statement
 * transaction this package runs — a report insert plus an outbox upsert, an event
 * update plus an outbox upsert — reads-then-decides in a way snapshot isolation
 * protects, so `repeatable read` would import `40001` serialization failures and
 * a retry loop for no benefit.
 *
 * What it deliberately does NOT promise: intake's duplicate-check-then-insert is
 * not serialized by either backend. Mongo's snapshot isolation does not prevent
 * that phantom either, and the "one report per reporter per object" unique index
 * is explicitly the application's. The two backends are equally advisory here.
 *
 * The failure this runner exists to make impossible is subtler than Mongo's. A
 * store call given `db` instead of `tx` inside the callback runs on a DIFFERENT
 * pooled connection and commits on its own — no error, no warning, and the
 * atomicity the outbox exists for is simply gone. `postgresOutboxStore.enqueue`
 * refuses a handle that is not a transaction for exactly that reason.
 */
export function postgresTransactionRunner(
  db: ModerationPgHandle,
): ModerationTransactionRunner<ModerationPgHandle> {
  return {
    async run<T>(operation: (tx: ModerationPgHandle) => Promise<T>): Promise<T> {
      return await db.transaction(async (tx) => await operation(tx), {
        isolationLevel: 'read committed',
      });
    },
  };
}
