/**
 * What a seat and a staff role let a person do, as pure functions.
 *
 * Named `roles.ts` and not `authorization.ts` deliberately: `auth-invariants.test.ts`
 * scans every source file for the word "Authorization" to prove this app never builds
 * that header, and a module path carrying the word would be a permanent false positive
 * on the sharpest check in the package — the kind that gets a pattern loosened.
 *
 * **None of this is enforcement.** Every rule below is a mirror of a check the API
 * already makes: `requireRole(role, 'admin')` on every console write,
 * `requireStaffRole('security')` on a standing change. The API answers 403 to a
 * client that ignores all of it, which is why the Trust & Safety navigation being
 * hidden is a courtesy rather than a boundary.
 *
 * What these functions ARE for is not offering an operator a control that is going
 * to fail. A viewer shown an enabled "Issue credential" button learns their seat
 * is read-only by filling in a form and receiving a 403, which is a worse way to
 * find out than the button not being there.
 *
 * They live in their own module, pure and import-light, so the audience split can
 * be exercised in a unit test rather than by rendering the app with a fabricated
 * session.
 */

import { CONSOLE_ROLES, type ConsoleRole, type StaffRole } from './types';

/**
 * Whether `role` is at least as capable as `minimum`.
 *
 * Derived from the ORDER of `CONSOLE_ROLES` (owner > admin > developer > viewer)
 * rather than from a second table of ranks, so the vocabulary and the ordering
 * cannot disagree — and `vocabularies.test.ts` already asserts that array against
 * the server's.
 */
export function roleAtLeast(role: ConsoleRole, minimum: ConsoleRole): boolean {
  return CONSOLE_ROLES.indexOf(role) <= CONSOLE_ROLES.indexOf(minimum);
}

/**
 * Whether this seat may change production behaviour.
 *
 * `admin` and above, matching `requireRole(role, 'admin')` on every console write.
 * `developer` holds no write capability yet — the surfaces it is meant for (custom
 * schemas, policy sets) are not built — and that is visible here rather than
 * implied by its absence.
 */
export function canAdminister(role: ConsoleRole): boolean {
  return roleAtLeast(role, 'admin');
}

/**
 * Whether the Trust & Safety navigation exists for this session.
 *
 * Any staff role at all. The individual routes are narrower — `security` and
 * `policy` can read the trust table and the metrics, only `security` can see the
 * dead-letter queue or move a standing — so a staff member with `appeals` or
 * `evidence` reaches the section and is refused by the route. That is the correct
 * shape: the section is where staff work, and the API decides which part of it
 * answers.
 */
export function hasTrustSafetyAccess(staffRoles: readonly StaffRole[]): boolean {
  return staffRoles.length > 0;
}

/** Reading the cross-tenant trust table and the platform metrics. */
export function canReadTrustSafety(staffRoles: readonly StaffRole[]): boolean {
  return staffRoles.includes('security') || staffRoles.includes('policy');
}

/**
 * Moving an application's standing, and reading the cross-tenant dead-letter
 * queue.
 *
 * `security` only. Standing decides whether an application may ingest at all and
 * whether its decisions may ever move an Oxy Trust figure, and §11.13 puts a
 * technical review, an identity verification and a quality period behind the
 * promotion. A `policy` operator adjusting a taxonomy has no business granting it.
 */
export function canOperateSecurity(staffRoles: readonly StaffRole[]): boolean {
  return staffRoles.includes('security');
}
