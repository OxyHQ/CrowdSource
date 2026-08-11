import { and, desc, eq, sql } from 'drizzle-orm';

import { appTrustSnapshots } from '../schema/infrastructure';
import { type PgHandle } from '../withTenant';

/**
 * Application trust standing, as a PostgreSQL repository.
 *
 * Ten call sites, all in `applicationTrust.service.ts`, and six functions —
 * `findByApplicationId` serves four of them, and the three `countDocuments` calls
 * are one `GROUP BY`.
 *
 * NOTHING CALLS THIS IN PRODUCTION YET. `appTrustRepository.realdb.test.ts` is
 * what makes these statements ones that have genuinely run.
 *
 * The table is exempt from the tenant filter because Trust & Safety reads across
 * every application — which is exactly why the tenant-serving read below states
 * its filter explicitly rather than relying on one. `applicationId` is the PRIMARY
 * KEY here, not a separate surrogate, so "one trust row per application" needs no
 * constraint of its own.
 */

export type AppTrustRow = typeof appTrustSnapshots.$inferSelect;

/**
 * One application's row, unfiltered by tenant.
 *
 * Four of the ten call sites are this read, and three of them are Trust & Safety
 * paths that legitimately cross tenants. The fourth — the tenant-serving one —
 * uses `findForTenant` below instead, and the two are kept separate rather than
 * folded into one optional parameter: an optional tenant filter is a filter
 * somebody forgets to pass, and the failure is silent disclosure rather than an
 * error.
 */
export async function findByApplicationId(
  db: PgHandle,
  applicationId: string,
): Promise<AppTrustRow | null> {
  const [row] = await db
    .select()
    .from(appTrustSnapshots)
    .where(eq(appTrustSnapshots.applicationId, applicationId))
    .limit(1);

  return row ?? null;
}

/**
 * One application's row, filtered by BOTH halves of the tenant pair.
 *
 * `organization_id` is not redundant beside a primary-key lookup. The pair is the
 * tenant identity, and a caller holding a `TenantContext` for organization A must
 * not read the row of an application that belongs to B even if it can name it —
 * which is precisely the check a primary-key-only read would skip.
 */
export async function findForTenant(
  db: PgHandle,
  organizationId: string,
  applicationId: string,
): Promise<AppTrustRow | null> {
  const [row] = await db
    .select()
    .from(appTrustSnapshots)
    .where(
      and(
        eq(appTrustSnapshots.applicationId, applicationId),
        eq(appTrustSnapshots.organizationId, organizationId),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Creates the sandbox default for a new application, or leaves the existing row
 * alone.
 *
 * `ON CONFLICT … DO NOTHING` rather than the Mongo site's read-then-insert. That
 * pair races: two concurrent provisioning retries both read nothing and both
 * insert, and on Mongo the loser surfaced a duplicate-key error from a path whose
 * whole purpose is to be idempotent. Here the loser writes nothing and returns.
 *
 * No statement FAILS, which matters because this may run inside the provisioning
 * transaction: a caught duplicate would abort it (`25P02`), taking the
 * application row with it.
 *
 * The conflict target is the primary key, which is `application_id` — one trust
 * row per application, by construction.
 */
export async function insertSandboxDefaultIfAbsent(
  db: PgHandle,
  row: typeof appTrustSnapshots.$inferInsert,
): Promise<void> {
  await db.insert(appTrustSnapshots).values(row).onConflictDoNothing({
    target: appTrustSnapshots.applicationId,
  });
}

/** Everything a standing change writes. */
export interface StandingPatch {
  readonly standing: string;
  readonly globalReputationEffectsAllowed: boolean;
  readonly lastStandingReason: string;
  readonly standingChangedAt: Date;
  readonly standingChangedByOxyUserId: string | null;
}

/**
 * Moves an application's standing, returning the row AFTER the write.
 *
 * `returning()` collapses the Mongo site's update-then-read into one statement.
 * That is not only a saved round trip: between those two Mongo calls another
 * operator's change could land, and the caller would return a row that never
 * reflected its own write. Here the returned row is the one this statement
 * produced.
 *
 * A missing application yields `null` rather than an error, and the caller keeps
 * raising its own 404 — the repository does not know what an absent row means to
 * the surface above it.
 */
export async function updateStanding(
  db: PgHandle,
  applicationId: string,
  patch: StandingPatch,
): Promise<AppTrustRow | null> {
  const [row] = await db
    .update(appTrustSnapshots)
    .set(patch)
    .where(eq(appTrustSnapshots.applicationId, applicationId))
    .returning();

  return row ?? null;
}

/**
 * Every application's standing, for the Trust & Safety surface (§4.3).
 *
 * The one read here that is not tenant-filtered, and its only caller is a route
 * behind a staff role. `updated_at` is `NOT NULL`, so the `DESC` needs no
 * `NULLS LAST` — stated because an ordering that silently misplaces null rows is
 * the house bug and the next reader should not have to check the column.
 */
export async function listByStanding(
  db: PgHandle,
  standing: string | undefined,
  limit: number,
): Promise<AppTrustRow[]> {
  return db
    .select()
    .from(appTrustSnapshots)
    .where(standing === undefined ? undefined : eq(appTrustSnapshots.standing, standing))
    .orderBy(desc(appTrustSnapshots.updatedAt))
    .limit(limit);
}

/**
 * How many applications sit in each standing — the T&S dashboard's headline.
 *
 * One `GROUP BY` where Mongo issued three `countDocuments`, and the caller
 * supplies the standings it wants counted so a standing nobody is in reads ZERO
 * rather than being absent. `GROUP BY` omits an empty group; `countDocuments`
 * returns 0. A dashboard rendering `undefined` for "restricted" says "unknown"
 * where the truth is "none", and on this particular screen that is the difference
 * between "no application is restricted" and "we are not measuring it".
 *
 * `count(*)` arrives from postgres.js as a STRING — `int8` is decoded as text —
 * while drizzle types it `number`. `Number(…)` at the boundary is load-bearing,
 * not defensive.
 */
export async function countByStanding(
  db: PgHandle,
  standings: readonly string[],
): Promise<Record<string, number>> {
  const rows = await db
    .select({ standing: appTrustSnapshots.standing, count: sql<number>`count(*)` })
    .from(appTrustSnapshots)
    .groupBy(appTrustSnapshots.standing);

  const counts: Record<string, number> = {};
  for (const standing of standings) counts[standing] = 0;

  /**
   * Only the standings the caller asked about are reported. A row whose
   * `standing` is outside the requested set is counted by the database and
   * dropped here rather than added to the result — otherwise the record grows a
   * key the caller's type does not have, which TypeScript cannot catch on a
   * `Record<string, number>` and which reaches the dashboard as an unlabelled
   * column.
   */
  for (const row of rows) {
    if (standings.includes(row.standing)) counts[row.standing] = Number(row.count);
  }
  return counts;
}
