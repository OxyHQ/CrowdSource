import { Schema } from 'mongoose';

import { defineUnscopedCollection } from '../../db/collections';

/**
 * Who may use the console, and as what (§12.6 `organization_members`, §13.2).
 *
 * These two collections answer the question the rest of the console module is
 * built on: **a request arrives carrying a verified Oxy identity — which tenant,
 * if any, is it allowed to act on, and is it staff?**
 *
 * Both are declared UNSCOPED, and the reason is the same one that exempts
 * `organizations` and `applications`: the tenant context a filter would use is
 * derived FROM these rows. A membership lookup scoped by the tenant it is about
 * to establish would be circular, and a caller-supplied tenant would not be an
 * isolation boundary at all. The rule that replaces the filter is a rule about
 * reachability: nothing outside `src/modules/console/` imports this file, and no
 * route returns a row from it that was not resolved from the caller's own
 * authenticated identity.
 *
 * Schemas are `strict` (Mongoose's default) so an unknown field is dropped rather
 * than stored: a write path that is ever handed a request body cannot smuggle a
 * field through it.
 */

/**
 * What a member of an organization may do (§4.4's "aplicación cliente" row, split
 * into the seats a real team needs).
 *
 * Ordered from most to least capable, and the order is load-bearing — see
 * `atLeast` in `membership.service.ts`. Four seats rather than two because the
 * capabilities that matter here are genuinely different in kind: issuing a
 * credential and rotating a webhook secret are irreversible acts against
 * production traffic, while reading a case explorer is not, and a team that can
 * only choose between "everything" and "nothing" ends up giving everyone
 * everything.
 */
export const CONSOLE_ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type ConsoleRole = (typeof CONSOLE_ROLES)[number];

export const MEMBER_STATUSES = ['active', 'revoked'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface OrganizationMemberDocument {
  organizationId: string;
  /**
   * The Oxy user id, which is the ONLY identity the console knows a person by.
   *
   * There is no CrowdSource-side console account: no password, no separate
   * profile, nothing to keep in sync. A member is an Oxy account that somebody
   * with an `admin` seat named. Note this is deliberately NOT a reviewer id —
   * the two identities must never be joined, because a reviewer id that also
   * meant something on a tenant's member list would let an operator reading one
   * learn the other (§8.7).
   */
  oxyUserId: string;
  role: ConsoleRole;
  status: MemberStatus;
  /** Who granted this seat, for the §13.2 audit question "who let them in?". */
  invitedByOxyUserId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const organizationMemberSchema = new Schema<OrganizationMemberDocument>(
  {
    organizationId: { type: String, required: true },
    oxyUserId: { type: String, required: true },
    role: { type: String, required: true, enum: CONSOLE_ROLES },
    status: { type: String, required: true, enum: MEMBER_STATUSES, default: 'active' },
    invitedByOxyUserId: { type: String, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'organization_members' },
);

/**
 * One seat per person per organization, enforced rather than assumed.
 *
 * Without it, two concurrent invitations of the same person produce two rows with
 * two different roles, and every later authorization check answers whichever one
 * MongoDB happened to return first — a permission level that varies by request.
 */
organizationMemberSchema.index({ organizationId: 1, oxyUserId: 1 }, { unique: true });
/** The console's first query on every request: which tenants is this person in. */
organizationMemberSchema.index({ oxyUserId: 1, status: 1 });

export const organizationMembers = defineUnscopedCollection(
  'OrganizationMember',
  organizationMemberSchema,
  {
    why: 'A membership row is what ESTABLISHES the tenant for a console session; a filter by the tenant it derives would be circular.',
  },
);

/**
 * Trust & Safety roles (§13.2: "los operadores internos usan roles separados para
 * policy, appeals, evidence y security").
 *
 * Separate roles rather than one "staff" flag, because the four differ in what
 * they expose and §13.1 names insider abuse as a standing risk with "RBAC,
 * just-in-time access, append-only audit" as the control. The person who edits a
 * taxonomy has no reason to open sensitive evidence, and a single flag would give
 * them both.
 */
export const STAFF_ROLES = ['policy', 'appeals', 'evidence', 'security'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface TrustSafetyStaffDocument {
  oxyUserId: string;
  roles: StaffRole[];
  status: MemberStatus;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const trustSafetyStaffSchema = new Schema<TrustSafetyStaffDocument>(
  {
    oxyUserId: { type: String, required: true, unique: true },
    roles: { type: [String], required: true, enum: STAFF_ROLES, default: [] },
    status: { type: String, required: true, enum: MEMBER_STATUSES, default: 'active' },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'trust_safety_staff' },
);

export const trustSafetyStaff = defineUnscopedCollection(
  'TrustSafetyStaff',
  trustSafetyStaffSchema,
  {
    why: 'Staff act ACROSS every tenant by definition (§4.3), so there is no tenant to scope the row by.',
  },
);
