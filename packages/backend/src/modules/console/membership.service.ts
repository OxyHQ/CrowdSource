import { createTenantContext, type TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { isPublicId } from '../../utils/identifiers';
import {
  applications,
  organizations,
  type ApplicationDocument,
  type OrganizationDocument,
} from '../tenancy/tenancy.collections';
import {
  organizationMembers,
  type ConsoleRole,
  type OrganizationMemberDocument,
} from './console.collections';

/**
 * How a console session becomes a tenant.
 *
 * This module is to the console what `credential.service.ts` is to the application
 * API: the ONE place a tenant context comes into existence for a session caller,
 * and therefore the one place to audit when asking "can a caller influence which
 * tenant it acts on?".
 *
 * The answer has to be no, and the shape that makes it no is worth stating
 * precisely, because it looks superficially like the IDOR the tenant rules forbid.
 * A console caller DOES name a resource — `/console/applications/app_…` — and it
 * has to, since one person can be a member of several organizations running several
 * applications each. What it never does is name a TENANT. The sequence is:
 *
 *   1. the path names an application id;
 *   2. the application document is read by that id, and `organizationId` is taken
 *      FROM THE STORED ROW — never from the request;
 *   3. an active membership of that organization is required for the authenticated
 *      Oxy user, or the answer is 404;
 *   4. only then is a `TenantContext` constructed, from the stored row's two ids.
 *
 * So the caller chooses which of ITS OWN tenants to look at, and the database
 * decides which tenants are its own. An `organizationId` in a body or a query
 * string would collapse steps 2 and 3 into a value the caller supplies, which is
 * the IDOR; there is deliberately no code path here that reads one.
 */

/**
 * Roles as a total order, so a capability check is one comparison rather than a
 * chain of equality tests a new role could silently fall through.
 *
 * Spelled out rather than derived from `CONSOLE_ROLES`' order: the `Record` type
 * makes a role added without a rank a compile error, which an index-derived version
 * would not — there, a new role would silently receive whatever rank its position
 * gave it.
 */
const ROLE_RANK: Readonly<Record<ConsoleRole, number>> = Object.freeze({
  owner: 4,
  admin: 3,
  developer: 2,
  viewer: 1,
});

/** True when `held` is at least as capable as `required`. */
export function atLeast(held: ConsoleRole, required: ConsoleRole): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

export interface Membership {
  readonly organizationId: string;
  readonly role: ConsoleRole;
}

export interface MembershipWithOrganization extends Membership {
  readonly name: string;
  readonly slug: string;
  readonly status: OrganizationDocument['status'];
}

/**
 * The organizations this person belongs to.
 *
 * Revoked seats are excluded by the FILTER rather than removed afterwards: a
 * revoked member whose row was merely marked and still returned would show up in
 * whichever caller forgot to check.
 */
export async function membershipsOf(oxyUserId: string): Promise<readonly Membership[]> {
  const rows = await organizationMembers.find({ oxyUserId, status: 'active' });
  return rows.map((row) => ({ organizationId: row.organizationId, role: row.role }));
}

/** The same list, with the organization each seat is in. */
export async function membershipsWithOrganizations(
  oxyUserId: string,
): Promise<readonly MembershipWithOrganization[]> {
  const memberships = await membershipsOf(oxyUserId);
  const resolved: MembershipWithOrganization[] = [];

  for (const membership of memberships) {
    const organization = await organizations.findOne({
      organizationId: membership.organizationId,
    });
    // A seat whose organization is gone is not an error to surface to the member —
    // there is nothing they can do about it — and it must not abort the whole list.
    if (!organization) continue;
    resolved.push({
      ...membership,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
    });
  }

  return resolved;
}

/**
 * Requires an active seat in one organization, and answers 404 when there is none.
 *
 * 404 and not 403, deliberately, and this is the opposite choice from the role
 * check below. A 403 here would confirm that the organization exists, which turns
 * this route into an oracle for enumerating Oxy's customer list. Once membership IS
 * established, a 403 gives away nothing the caller does not already know, so
 * `requireRole` uses it — and an integrator debugging a permission problem needs to
 * be able to tell "I am not in this organization" from "my seat is too small".
 */
export async function requireMembership(
  oxyUserId: string,
  organizationId: string,
): Promise<ConsoleRole> {
  const member = await organizationMembers.findOne({
    organizationId,
    oxyUserId,
    status: 'active',
  });
  if (!member) {
    throw new ApiError('not_found', 'No such organization.');
  }
  await assertOrganizationUsable(organizationId, 'No such organization.');
  return member.role;
}

/**
 * The organization behind a seat must still exist and still be active.
 *
 * Neither check is implied by the membership row, and both are authorization decisions
 * that have to fail CLOSED:
 *
 *  - **Gone.** A membership row outlives the organization it names — nothing cascades a
 *    delete — so a stale seat would otherwise keep granting access to applications whose
 *    owner no longer exists. 404, with the caller's own wording, because a caller must not
 *    learn from the status whether the row or the organization was the missing part.
 *  - **Suspended.** `setApplicationStatus` is the kill switch for traffic and
 *    `setOrganizationStatus` is the one for a customer; provisioning already refuses to
 *    create applications under a suspended organization, and a console that still let its
 *    members issue credentials and rotate secrets would make that half a switch. 403,
 *    because membership IS established and the caller already knows the organization
 *    exists — the capability is what is withdrawn.
 */
async function assertOrganizationUsable(
  organizationId: string,
  absentMessage: string,
): Promise<OrganizationDocument> {
  const organization = await organizations.findOne({ organizationId });
  if (!organization) {
    throw new ApiError('not_found', absentMessage);
  }
  if (organization.status !== 'active') {
    throw new ApiError('forbidden', 'This organization is suspended.');
  }
  return organization;
}

/** Requires the seat to be at least `required`, once membership is established. */
export function requireRole(held: ConsoleRole, required: ConsoleRole): void {
  if (!atLeast(held, required)) {
    throw new ApiError(
      'forbidden',
      `This action requires the '${required}' role; this seat is '${held}'.`,
    );
  }
}

export interface ResolvedApplication {
  readonly tenant: TenantContext;
  readonly role: ConsoleRole;
  readonly application: ApplicationDocument;
}

/**
 * Resolves a path application id into a tenant this caller may act on.
 *
 * The four steps of this module's contract, in order, in one function — so there is
 * no second implementation to keep honest. Every console route that touches
 * tenant-owned data starts here.
 */
export async function resolveApplicationForMember(
  oxyUserId: string,
  applicationId: string,
): Promise<ResolvedApplication> {
  // A malformed id and one belonging to another organization get the same answer;
  // the membership check is what decides, and the shape check only saves a query.
  if (!isPublicId('application', applicationId)) {
    throw new ApiError('not_found', 'No such application.');
  }

  const application = await applications.findOne({ applicationId });
  if (!application) {
    throw new ApiError('not_found', 'No such application.');
  }

  /**
   * The membership lookup is repeated here rather than delegated to
   * `requireMembership`, because the two need different MESSAGES for the same
   * status. A caller who is not a member must not learn whether the application
   * exists, so this path says "no such application" while `requireMembership` says
   * "no such organization" — and wrapping the other function to rewrite its error
   * would launder a genuine database failure into a 404 as well.
   */
  const member = await organizationMembers.findOne({
    organizationId: application.organizationId,
    oxyUserId,
    status: 'active',
  });
  if (!member) {
    throw new ApiError('not_found', 'No such application.');
  }

  // Fails closed on an organization that is gone or suspended — see the function itself.
  // The absent message is the application's, so a non-member learns nothing from either.
  await assertOrganizationUsable(application.organizationId, 'No such application.');

  return {
    // Built from the stored row's own ids. This is the line that makes the
    // difference between scoping by the caller's claim and scoping by the record.
    tenant: createTenantContext(application.organizationId, application.applicationId),
    role: member.role,
    application,
  };
}

/**
 * Grants a seat.
 *
 * The role is a closed vocabulary and the target is an Oxy user id, so there is no
 * request body to spread: the caller names two values and this function writes the
 * document. `owner` is grantable — an organization needs to be able to hand over —
 * and the last-owner protection lives in `revokeMembership`, where losing one
 * actually happens.
 */
export async function grantMembership(input: {
  readonly organizationId: string;
  readonly oxyUserId: string;
  readonly role: ConsoleRole;
  readonly invitedByOxyUserId: string;
}): Promise<OrganizationMemberDocument> {
  const organization = await organizations.findOne({ organizationId: input.organizationId });
  if (!organization) {
    throw new ApiError('not_found', 'No such organization.');
  }

  const now = new Date();
  const existing = await organizationMembers.findOne({
    organizationId: input.organizationId,
    oxyUserId: input.oxyUserId,
  });

  if (existing) {
    /**
     * Re-granting is how a revoked seat comes back and how a role is changed.
     * §10.2's conventions make a repeated write idempotent rather than a 409
     * wherever the outcome is the state the caller asked for, and "this person has
     * this role" is exactly that.
     */
    await organizationMembers.updateOne(
      { organizationId: input.organizationId, oxyUserId: input.oxyUserId },
      {
        role: input.role,
        status: 'active',
        revokedAt: null,
        invitedByOxyUserId: input.invitedByOxyUserId,
        updatedAt: now,
      },
    );
  } else {
    await organizationMembers.insertOne({
      organizationId: input.organizationId,
      oxyUserId: input.oxyUserId,
      role: input.role,
      status: 'active',
      invitedByOxyUserId: input.invitedByOxyUserId,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const stored = await organizationMembers.findOne({
    organizationId: input.organizationId,
    oxyUserId: input.oxyUserId,
  });
  if (!stored) {
    throw new ApiError('service_unavailable', 'The membership could not be stored. Retry.');
  }
  return stored;
}

/**
 * Revokes a seat, refusing to remove the last owner.
 *
 * An organization with no owner is unrecoverable through the console: nobody can
 * issue a credential, invite a member or rotate a secret, and there is no
 * self-service path back because every path requires a seat somebody has to grant.
 * Refusing here is the difference between a mistake and a support ticket that ends
 * in a database write.
 */
export async function revokeMembership(
  organizationId: string,
  oxyUserId: string,
): Promise<void> {
  const member = await organizationMembers.findOne({
    organizationId,
    oxyUserId,
    status: 'active',
  });
  if (!member) {
    throw new ApiError('not_found', 'No such active member of this organization.');
  }

  if (member.role === 'owner') {
    const owners = await organizationMembers.countDocuments({
      organizationId,
      role: 'owner',
      status: 'active',
    });
    if (owners <= 1) {
      throw new ApiError(
        'conflict',
        'This is the last owner of the organization. Grant another owner before revoking this seat.',
      );
    }
  }

  const now = new Date();
  await organizationMembers.updateOne(
    { organizationId, oxyUserId },
    { status: 'revoked', revokedAt: now, updatedAt: now },
  );
}

/** Every seat in one organization, for the members screen. */
export async function membersOf(
  organizationId: string,
): Promise<readonly OrganizationMemberDocument[]> {
  return organizationMembers.find({ organizationId }, { sort: { createdAt: 1 }, limit: 500 });
}
