import { ApiError } from '../../http/apiError';
import {
  STAFF_ROLES,
  trustSafetyStaff,
  type StaffRole,
  type TrustSafetyStaffDocument,
} from './console.collections';

/**
 * Granting and revoking Trust & Safety roles.
 *
 * **A domain service with no HTTP surface, and that is the security design rather
 * than an omission.** §13.2 requires that privileged authority is not
 * self-grantable, and the way to guarantee that is for there to be no route — not
 * a route with a good check on it. Every route in this codebase is one review away
 * from a mounting mistake; a function with no transport is not.
 *
 * So the first staff member is created out of band, deliberately, by an operator
 * with database access, and the Trust & Safety console is unusable until one exists.
 * That is the correct failure mode for a surface that can see across every tenant:
 * a deployment where nobody has the role shows an empty, refused surface, whereas a
 * deployment with a self-service grant route is one authorization bug away from
 * handing any Oxy account a cross-tenant view.
 *
 * The same reasoning `provisioning.service.ts` states for tenant creation, applied
 * to the more dangerous of the two.
 */

export async function grantStaffRoles(
  oxyUserId: string,
  roles: readonly StaffRole[],
): Promise<TrustSafetyStaffDocument> {
  const unique = [...new Set(roles)];
  if (unique.length === 0) {
    throw new ApiError('invalid_request', 'A staff member requires at least one role.');
  }
  for (const role of unique) {
    if (!STAFF_ROLES.some((known) => known === role)) {
      throw new ApiError('invalid_request', `Unknown Trust & Safety role '${role}'.`);
    }
  }

  const now = new Date();
  const existing = await trustSafetyStaff.findOne({ oxyUserId });

  if (existing) {
    // Re-granting replaces the whole set rather than adding to it: "this person
    // holds these roles" has to be expressible, or removing one role means
    // revoking the person and starting again.
    await trustSafetyStaff.updateOne(
      { oxyUserId },
      { roles: unique, status: 'active', revokedAt: null, updatedAt: now },
    );
  } else {
    await trustSafetyStaff.insertOne({
      oxyUserId,
      roles: unique,
      status: 'active',
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const stored = await trustSafetyStaff.findOne({ oxyUserId });
  if (!stored) {
    throw new ApiError('service_unavailable', 'The staff record could not be stored. Retry.');
  }
  return stored;
}

/**
 * Revokes every Trust & Safety role from one account.
 *
 * There is no "last staff member" protection, unlike an organization's last owner.
 * The situations are not symmetric: an organization with no owner is unrecoverable
 * through any self-service path, while a deployment with no staff is recovered the
 * same way its first staff member was created. Refusing here would mean an operator
 * cannot revoke a compromised account at 3am because it happens to be the only one.
 */
export async function revokeStaff(oxyUserId: string): Promise<void> {
  const now = new Date();
  const modified = await trustSafetyStaff.updateOne(
    { oxyUserId, status: 'active' },
    { status: 'revoked', roles: [], revokedAt: now, updatedAt: now },
  );
  if (modified === 0) {
    throw new ApiError('not_found', 'No active staff record for that account.');
  }
}
