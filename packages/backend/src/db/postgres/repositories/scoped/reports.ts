import { and, desc, eq, sql } from 'drizzle-orm';

import { caseReports, reports } from '../../schema/reports';
import type { TenantScopedHandle } from '../../withTenant';

/**
 * Report intake, tenant-scoped.
 *
 * Same rules as `scoped/cases.ts` and they are not repeated here beyond the two
 * that decide correctness: every function takes a `TenantScopedHandle`, and NO
 * query carries a tenant predicate — the policy decides visibility, and a
 * predicate beside it would be a second authority that can disagree.
 */

export interface NewReport {
  readonly reportId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly externalReportId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly envelope: unknown;
  readonly caseId: string;
  readonly contentHash: string;
  readonly status: string;
  readonly receivedAt: Date;
}

export async function insertReport(db: TenantScopedHandle, next: NewReport): Promise<void> {
  await db.insert(reports).values(next);
}

export async function findReportById(db: TenantScopedHandle, reportId: string) {
  const [row] = await db.select().from(reports).where(eq(reports.reportId, reportId)).limit(1);
  return row ?? null;
}

/**
 * The idempotency read: has this exact submission been seen before?
 *
 * Keyed on the caller's own key, NOT on the tenant — the tenant is the policy's
 * business. `payload_hash` is returned rather than compared here so the caller can
 * distinguish a true replay from a key reused with different content, which are
 * different answers (200 versus 409) and must not be collapsed.
 */
export async function findReportByIdempotencyKey(
  db: TenantScopedHandle,
  idempotencyKey: string,
) {
  const [row] = await db
    .select()
    .from(reports)
    .where(eq(reports.idempotencyKey, idempotencyKey))
    .limit(1);

  return row ?? null;
}

export async function updateReportStatus(
  db: TenantScopedHandle,
  reportId: string,
  status: string,
): Promise<number> {
  const rows = await db
    .update(reports)
    .set({ status })
    .where(eq(reports.reportId, reportId))
    .returning({ reportId: reports.reportId });

  return rows.length;
}

export interface NewCaseReport {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly caseId: string;
  readonly reportId: string;
  readonly externalReportId: string;
  readonly allegationCodes: readonly string[];
  readonly merged: boolean;
  readonly linkedAt: Date;
}

export async function insertCaseReport(
  db: TenantScopedHandle,
  link: NewCaseReport,
): Promise<void> {
  await db.insert(caseReports).values({ ...link, allegationCodes: [...link.allegationCodes] });
}

/** Every report linked to a case, oldest link first — the case's own evidence. */
export async function listCaseReports(db: TenantScopedHandle, caseId: string) {
  return await db
    .select()
    .from(caseReports)
    .where(eq(caseReports.caseId, caseId))
    .orderBy(caseReports.linkedAt);
}

/**
 * How many distinct reports a case has drawn — §7's velocity input.
 *
 * `::int` in SQL: postgres.js decodes bigint as a string, so an uncast count
 * arrives as `'3'` and any arithmetic on it concatenates rather than adds.
 */
export async function countCaseReports(db: TenantScopedHandle, caseId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(caseReports)
    .where(eq(caseReports.caseId, caseId));

  return row?.total ?? 0;
}

/** Marks a link as merged in from another case, for the merge audit trail. */
export async function markCaseReportMerged(
  db: TenantScopedHandle,
  caseId: string,
  reportId: string,
): Promise<number> {
  const rows = await db
    .update(caseReports)
    .set({ merged: true })
    .where(and(eq(caseReports.caseId, caseId), eq(caseReports.reportId, reportId)))
    .returning({ reportId: caseReports.reportId });

  return rows.length;
}

/** A tenant's most recent reports, newest first — the console's intake view. */
export async function listRecentReports(db: TenantScopedHandle, limit = 50) {
  return await db.select().from(reports).orderBy(desc(reports.receivedAt)).limit(limit);
}
