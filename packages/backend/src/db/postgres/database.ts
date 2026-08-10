import { createDatabase, type OxyDatabase } from '@oxyhq/db';

import { config } from '../../config';
import * as schema from './schema';

/**
 * The one PostgreSQL handle the running service uses.
 *
 * Built with `createDatabase<BackendSchema>` and the same options shape
 * `src/__tests__/support/postgresTestDatabase.ts` builds its handle with, and
 * that correspondence is the point rather than a tidiness preference. Every
 * repository under `db/postgres/repositories/` has been proven against a real
 * server through the harness's handle — as the unprivileged application role,
 * under `FORCE`, with a tenant set. A runtime handle constructed differently is
 * a handle those proofs do not describe, and the ways it could differ (a
 * superuser connection string, a pool that outlives a transaction, a missing
 * schema) all fail by RETURNING ROWS or by returning NONE, never by erroring.
 *
 * `BackendSchema` is declared HERE and imported by the harness, not the reverse.
 * The type the service runs on must be the type the tests bind to, and a
 * production module importing a type from a test-support file is how that
 * eventually stops being true.
 */

export type BackendSchema = typeof schema;

/**
 * How many server-side connections one task may hold.
 *
 * Lower than the Mongo pool above it (50) on purpose: a PostgreSQL connection
 * is a backend PROCESS rather than a socket, the instance is shared with every
 * other Oxy database, and `max_connections` is a cluster-wide budget that a
 * service cannot overdraw without taking its neighbours down with it. Several
 * tasks multiply this.
 */
const POOL_MAX = 10;

/**
 * A ceiling on any single statement, and it is not tuning.
 *
 * `/health/ready` issues a query, so a statement with no bound turns an
 * unreachable database into a readiness probe that HANGS — and a task that
 * never answers its probe is not marked unhealthy, it is marked slow. The
 * harness carries the same reasoning at two seconds; production is given more
 * room because a real network is slower than a loopback container, but it is
 * still bounded, because "answered nothing" and "was never going to answer"
 * have to stay distinguishable.
 */
const STATEMENT_TIMEOUT_MS = 15_000;

let handle: OxyDatabase<BackendSchema> | undefined;

/**
 * The handle, built on first use.
 *
 * Lazy rather than built at import time so that importing any module in this
 * tree does not open a socket — the test suite imports the whole service, and a
 * connection opened by an import is one nothing closes.
 */
export function getPostgresDatabase(): OxyDatabase<BackendSchema> {
  handle ??= createDatabase<BackendSchema>({
    databaseUrl: config.databaseUrl,
    schema,
    client: {
      max: POOL_MAX,
      connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    },
  }).db;
  return handle;
}

/**
 * Prove the database is actually reachable, by reaching it.
 *
 * A real round trip rather than a cached flag or a look at pool state, because
 * the question readiness has to answer is whether a query would succeed, and
 * every cheaper proxy for that answers a different question. Mongo can be asked
 * `readyState` because the driver maintains one; postgres.js opens connections
 * lazily, so "the pool exists" is true before anything has ever connected.
 *
 * Throws rather than returning a boolean: the boot path wants the failure to
 * propagate and stop the process, and a caller that wants a verdict instead can
 * catch — which is one `try` in one place, rather than a boolean every caller
 * has to remember to check.
 */
export async function pingPostgres(): Promise<void> {
  await getPostgresDatabase().$client`select 1`;
}

/**
 * Close the pool, if one was ever opened.
 *
 * Called from the shutdown path beside the Mongo disconnect. Safe to call when
 * nothing was built: a task that fails before its first query has no pool, and
 * a shutdown that threw on that would turn a clean exit into a crash.
 */
export async function closePostgresDatabase(): Promise<void> {
  const open = handle;
  handle = undefined;
  if (open !== undefined) {
    await open.$client.end();
  }
}
