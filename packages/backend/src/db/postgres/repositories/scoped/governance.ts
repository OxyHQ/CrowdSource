import { and, desc, eq, sql } from 'drizzle-orm';

import { auditEvents, policySets, usageCounters } from '../../schema/governance';
import type { TenantScopedHandle } from '../../withTenant';

/**
 * Policy sets, the tenant audit trail and the usage meter, tenant-scoped.
 *
 * `TenantScopedHandle` first, no tenant predicate in any query — see
 * `scoped/cases.ts`.
 *
 * `audit_events` here is the TENANT's trail and is scoped. Do not confuse it with
 * `staff_audit_events`, which records operator activity, belongs to no tenant, and
 * lives in the unscoped `repositories/console.ts`. Filing a staff action in this
 * table would force a choice between an incomplete trail and filling every
 * customer's with operator activity.
 */

export interface NewPolicySet {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly policySetId: string;
  readonly version: string;
  readonly status: string;
  readonly title: string;
  readonly locale: string | null;
  readonly rules: unknown;
  readonly publishedAt: Date | null;
}

/**
 * `locale` is `string | null` and NOT optional, so a caller with no locale has to
 * say so. On Mongo the field could be ABSENT rather than null on older documents,
 * and a backfill reading `doc.locale` gets `undefined` — writing the string
 * `"undefined"` into a nullable text column produces a locale nobody can explain
 * and nothing rejects. A required parameter is what makes that impossible here.
 */
export async function insertPolicySet(db: TenantScopedHandle, next: NewPolicySet): Promise<void> {
  await db.insert(policySets).values(next);
}

export async function findPolicySetVersion(
  db: TenantScopedHandle,
  policySetId: string,
  version: string,
) {
  const [row] = await db
    .select()
    .from(policySets)
    .where(and(eq(policySets.policySetId, policySetId), eq(policySets.version, version)))
    .limit(1);

  return row ?? null;
}

/** Every version of a policy set, newest published first. */
export async function listPolicySetVersions(db: TenantScopedHandle, policySetId: string) {
  return await db
    .select()
    .from(policySets)
    .where(eq(policySets.policySetId, policySetId))
    .orderBy(desc(policySets.createdAt));
}

export async function updatePolicySetStatus(
  db: TenantScopedHandle,
  policySetId: string,
  version: string,
  patch: { readonly status: string; readonly publishedAt?: Date | null },
): Promise<number> {
  const rows = await db
    .update(policySets)
    .set({
      status: patch.status,
      ...(patch.publishedAt === undefined ? {} : { publishedAt: patch.publishedAt }),
    })
    .where(and(eq(policySets.policySetId, policySetId), eq(policySets.version, version)))
    .returning({ policySetId: policySets.policySetId });

  return rows.length;
}

export interface NewAuditEvent {
  readonly auditId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly action: string;
  readonly actorCredentialId: string | null;
  readonly actorOxyUserId: string | null;
  readonly reportId: string | null;
  readonly caseId: string | null;
  readonly externalReportId: string | null;
  readonly reason: string | null;
  readonly subjectId: string | null;
  readonly occurredAt: Date;
}

/**
 * Every nullable field is REQUIRED in the parameter type, `| null` rather than
 * optional. An audit row that silently omitted its actor because a caller left the
 * key off is worse than one that names nobody on purpose — the first is a gap you
 * cannot tell from the second afterwards.
 */
export async function appendAuditEvent(db: TenantScopedHandle, event: NewAuditEvent): Promise<void> {
  await db.insert(auditEvents).values(event);
}

/** One case's trail, newest first. */
export async function listAuditEventsForCase(
  db: TenantScopedHandle,
  caseId: string,
  limit = 100,
) {
  return await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.caseId, caseId))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(limit);
}

/**
 * The usage meter, incremented per accepted report.
 *
 * An UPSERT rather than read-then-write: two reports accepted in the same
 * millisecond both read the same counter and both write it back, losing one. The
 * conflict target is the row's natural key, and `reports_received` is incremented
 * from the STORED value in SQL rather than from a value JavaScript computed.
 *
 * `day` is `text`, not a date — the Mongoose file states the reason and it is
 * carried over deliberately rather than re-derived.
 */
export async function incrementUsageCounter(
  db: TenantScopedHandle,
  owner: { readonly organizationId: string; readonly applicationId: string },
  day: string,
  by = 1,
): Promise<void> {
  await db
    .insert(usageCounters)
    .values({ ...owner, day, reportsReceived: by })
    .onConflictDoUpdate({
      target: [usageCounters.applicationId, usageCounters.day],
      set: { reportsReceived: sql`${usageCounters.reportsReceived} + ${by}` },
    });
}

export async function findUsageCounter(db: TenantScopedHandle, day: string) {
  const [row] = await db.select().from(usageCounters).where(eq(usageCounters.day, day)).limit(1);
  return row ?? null;
}
