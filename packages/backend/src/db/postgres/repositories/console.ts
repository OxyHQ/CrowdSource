import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { organizationMembers, staffAuditEvents, trustSafetyStaff } from '../schema/console';
import type { PgHandle } from '../withTenant';

/**
 * The console's own tables, as PostgreSQL repositories.
 *
 * Same convention as `tenancy.ts` and for the same reason: a `PgHandle` first, so
 * the tenant-scoped slice passes a transaction to the same shape of function
 * rather than introducing a second one. Nothing calls these in production yet, and
 * `consoleRepositories.realdb.test.ts` is what makes them statements that have
 * genuinely run.
 *
 * Three tables, three different exemption kinds, and the repositories make the
 * difference visible rather than uniform:
 *
 *  - `organization_members` DEFINES a tenant. `findActiveMembershipsByUser` takes
 *    an Oxy user id and NO tenant, because that read is what produces the set of
 *    tenants a console session may act on.
 *  - `trust_safety_staff` has no tenant dimension at all; nothing in its signature
 *    could accept one.
 *  - `staff_audit_events` NAMES an application without belonging to it, and its
 *    `applicationId` is nullable — most staff actions name none. `appendStaffAudit`
 *    takes `string | null` rather than an optional parameter, so a caller with no
 *    application has to say so.
 */

export interface NewOrganizationMember {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly oxyUserId: string;
  readonly roles: readonly string[];
  readonly status: string;
}

export async function insertOrganizationMember(
  db: PgHandle,
  member: NewOrganizationMember,
): Promise<void> {
  await db.insert(organizationMembers).values({ ...member, roles: [...member.roles] });
}

/**
 * Every organization this person is an ACTIVE member of.
 *
 * The read that establishes a console session's tenants. It is keyed on the Oxy
 * account alone, which is the only term the caller's credential supplies — and is
 * the reason a policy on this table would be circular.
 */
export async function findActiveMembershipsByUser(db: PgHandle, oxyUserId: string) {
  return await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.oxyUserId, oxyUserId), eq(organizationMembers.status, 'active')));
}

export async function findOrganizationMember(
  db: PgHandle,
  organizationId: string,
  oxyUserId: string,
) {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.oxyUserId, oxyUserId),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Updates a membership's roles and/or status.
 *
 * `Partial` rather than two functions, because the grant path sets both at once
 * and splitting it would make a single logical change two statements — which on a
 * table whose unique key is `(organization_id, oxy_user_id)` is two chances for a
 * concurrent revoke to land between them.
 */
export async function updateOrganizationMember(
  db: PgHandle,
  organizationId: string,
  oxyUserId: string,
  patch: { readonly roles?: readonly string[]; readonly status?: string },
): Promise<number> {
  const rows = await db
    .update(organizationMembers)
    .set({
      ...(patch.roles === undefined ? {} : { roles: [...patch.roles] }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
    })
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.oxyUserId, oxyUserId),
      ),
    )
    .returning({ membershipId: organizationMembers.membershipId });

  return rows.length;
}

/**
 * How many ACTIVE members of an organization hold a given role.
 *
 * The last-owner guard reads this. `roles` is a `text[]`, so membership of the
 * array is `= ANY(...)` rather than equality — the column holds a set, and testing
 * it as a scalar would answer only for single-role members.
 */
export async function countActiveMembersWithRole(
  db: PgHandle,
  organizationId: string,
  role: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.status, 'active'),
        sql`${role} = any(${organizationMembers.roles})`,
      ),
    );

  return row?.total ?? 0;
}

/** An organization's members, oldest first, bounded — the console's list. */
export async function listOrganizationMembers(
  db: PgHandle,
  organizationId: string,
  limit = 500,
) {
  return await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(asc(organizationMembers.createdAt))
    .limit(limit);
}

export interface NewTrustSafetyStaff {
  readonly oxyUserId: string;
  readonly roles: readonly string[];
  readonly status: string;
}

export async function insertTrustSafetyStaff(
  db: PgHandle,
  staff: NewTrustSafetyStaff,
): Promise<void> {
  await db.insert(trustSafetyStaff).values({ ...staff, roles: [...staff.roles] });
}

export async function findTrustSafetyStaff(db: PgHandle, oxyUserId: string) {
  const [row] = await db
    .select()
    .from(trustSafetyStaff)
    .where(eq(trustSafetyStaff.oxyUserId, oxyUserId))
    .limit(1);

  return row ?? null;
}

export async function updateTrustSafetyStaff(
  db: PgHandle,
  oxyUserId: string,
  patch: {
    readonly roles?: readonly string[];
    readonly status?: string;
    readonly revokedAt?: Date | null;
  },
): Promise<number> {
  const rows = await db
    .update(trustSafetyStaff)
    .set({
      ...(patch.roles === undefined ? {} : { roles: [...patch.roles] }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.revokedAt === undefined ? {} : { revokedAt: patch.revokedAt }),
    })
    .where(eq(trustSafetyStaff.oxyUserId, oxyUserId))
    .returning({ oxyUserId: trustSafetyStaff.oxyUserId });

  return rows.length;
}

export interface NewStaffAuditEvent {
  readonly staffAuditId: string;
  readonly action: string;
  readonly actorOxyUserId: string;
  readonly roles: readonly string[];
  /** The application acted on, or NULL — most staff actions name none. */
  readonly applicationId: string | null;
  readonly occurredAt: Date;
}

/**
 * Appends to the staff trail.
 *
 * The only write this table has, and — measured by the reader census — the only
 * production call site it has AT ALL: nothing reads it back outside a test. That
 * is recorded rather than repaired here; an audit trail with no reader is a
 * finding for whoever owns Trust & Safety, and this repository deliberately does
 * not grow a read to make the shape look more complete than it is.
 */
export async function appendStaffAuditEvent(
  db: PgHandle,
  event: NewStaffAuditEvent,
): Promise<void> {
  await db.insert(staffAuditEvents).values({ ...event, roles: [...event.roles] });
}

/**
 * The investigator's read, which does not exist in production yet.
 *
 * Deliberately NOT exported for production use — it exists so the realdb suite can
 * prove the trail is readable and correctly ordered, which is a different claim
 * from "something reads it". Naming it plainly is better than a test reaching for
 * the table directly and quietly becoming the only description of how it is meant
 * to be queried.
 */
export async function listStaffAuditByActor(
  db: PgHandle,
  actorOxyUserId: string,
  limit = 100,
) {
  return await db
    .select()
    .from(staffAuditEvents)
    .where(eq(staffAuditEvents.actorOxyUserId, actorOxyUserId))
    .orderBy(desc(staffAuditEvents.occurredAt))
    .limit(limit);
}
