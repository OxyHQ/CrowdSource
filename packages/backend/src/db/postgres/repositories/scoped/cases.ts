import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';

import { cases } from '../../schema/cases';
import type { TenantScopedHandle } from '../../withTenant';

/**
 * The moderation case, as a TENANT-SCOPED repository.
 *
 * Every function takes a `TenantScopedHandle` — the branded type only
 * `withTenant` can mint — so passing the pool is a COMPILE error rather than a
 * silent empty result. The Mongo wrapper this replaces takes a `TenantContext` as
 * its first argument for the same purpose; here the context lives in the
 * transaction, and the brand is what proves the caller opened one.
 *
 * NOTE WHAT IS ABSENT FROM EVERY QUERY BELOW: a tenant predicate. There is no
 * `where organization_id = …` anywhere in this file, and that is the whole point
 * of the migration — the DATABASE decides visibility through `tenant_isolation`,
 * not a filter a query could forget. `db/tenantScope.ts` has to state that rule in
 * application code because Mongo cannot enforce it; here the rule is the server's.
 *
 * The consequence for anyone editing this file: adding an `organization_id` term
 * to a query here would not be defence in depth, it would be a second authority
 * that can disagree with the policy. Do not.
 */

export interface NewCase {
  readonly caseId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly subjectExternalId: string;
  readonly status: string;
  readonly openedAt: Date;
}

/**
 * Inserts a case.
 *
 * The tenant columns are supplied EXPLICITLY rather than derived from the runtime
 * parameters, and that is deliberate: `tenant_isolation` has no `WITH CHECK` of
 * its own beyond the read predicate, so an insert carrying the wrong pair would be
 * refused by the policy — which is the correct failure and a loud one. Deriving
 * the values from `current_setting` inside this function would make the insert
 * always agree with the session and lose that check.
 */
export async function insertCase(db: TenantScopedHandle, next: NewCase): Promise<void> {
  await db.insert(cases).values(next);
}

export async function findCaseById(db: TenantScopedHandle, caseId: string) {
  const [row] = await db.select().from(cases).where(eq(cases.caseId, caseId)).limit(1);
  return row ?? null;
}

/** Several cases by id — the review-history hydrate, one statement rather than N. */
export async function findCasesByIds(db: TenantScopedHandle, caseIds: readonly string[]) {
  if (caseIds.length === 0) return [];
  return await db.select().from(cases).where(inArray(cases.caseId, [...caseIds]));
}

/**
 * A compare-and-swap on status.
 *
 * The `from` predicate is what makes a triage transition idempotent under replay:
 * the second delivery of the same event matches nothing and the caller publishes
 * no second jury. So the returned count is LOAD-BEARING — it is not "did the row
 * exist", it is "did I win the transition" — and it is the one update in this
 * layer where a matched-row count and a modified-row count would genuinely differ
 * if the predicate were dropped.
 *
 * Counted off `RETURNING` for the reason the tenancy repository states: a
 * non-returning drizzle/postgres.js update reports `length` 0 whether or not it
 * applied.
 */
export async function transitionCaseStatus(
  db: TenantScopedHandle,
  caseId: string,
  from: readonly string[],
  to: string,
): Promise<number> {
  const rows = await db
    .update(cases)
    .set({ status: to })
    .where(and(eq(cases.caseId, caseId), inArray(cases.status, [...from])))
    .returning({ caseId: cases.caseId });

  return rows.length;
}

/** How many cases this tenant opened since `from` — the console's headline. */
export async function countCasesSince(db: TenantScopedHandle, from: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(cases)
    .where(gte(cases.createdAt, from));

  return row?.total ?? 0;
}

/**
 * The case explorer's page, keyset-paginated newest first.
 *
 * The cursor comparison is written out rather than expressed as a row comparison,
 * because SQL row comparison with a NULL member yields NULL rather than true and
 * would drop rows. Two cases created in the same millisecond are ordinary under
 * load, so the `case_id` tie-break is what stops one of them being skipped.
 */
export async function listCasesPage(
  db: TenantScopedHandle,
  options: {
    readonly status?: string;
    readonly cursor?: { readonly createdAt: Date; readonly caseId: string };
    readonly limit?: number;
  } = {},
) {
  const limit = options.limit ?? 50;
  const terms = [
    ...(options.status === undefined ? [] : [eq(cases.status, options.status)]),
    ...(options.cursor === undefined
      ? []
      : [
          or(
            lt(cases.createdAt, options.cursor.createdAt),
            and(
              eq(cases.createdAt, options.cursor.createdAt),
              lt(cases.caseId, options.cursor.caseId),
            ),
          ),
        ]),
  ];

  return await db
    .select()
    .from(cases)
    .where(terms.length === 0 ? undefined : and(...terms))
    .orderBy(desc(cases.createdAt), desc(cases.caseId))
    .limit(limit);
}
