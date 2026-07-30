import { getOxyUserId } from '@oxyhq/core/server';
import type { Request, RequestHandler } from 'express';

import { ApiError } from '../../http/apiError';
import { verifyOxySession } from '../identity/oxySession';
import { trustSafetyStaff, type StaffRole, type TrustSafetyStaffDocument } from './console.collections';

/**
 * The console authentication and authorization boundary.
 *
 * There are THREE distinct things here and conflating any two of them is the bug
 * this file exists to prevent:
 *
 *  1. **A verified Oxy session** — `verifyOxySession`, shared with the reviewer
 *     surface. It says a real Oxy account made this request and nothing more.
 *  2. **A developer's authority over one tenant** — an organization membership,
 *     resolved per request in `membership.service.ts`. Not established here,
 *     because it depends on WHICH application the route is about.
 *  3. **Trust & Safety staff authority** — a role on a `trust_safety_staff` row.
 *     §10.1 is explicit that this is "sesión Oxy con roles internos y autorización
 *     explícita": the session is necessary and nowhere near sufficient. Every Oxy
 *     account in existence satisfies (1); a handful satisfy (3).
 *
 * A service credential can satisfy NONE of them. It presents a bearer token that
 * `@oxyhq/core/server` does not recognise as an Oxy session, so it never gets past
 * (1) — which is the structural reason a leaked integrator key cannot read the
 * console, rather than a rule somebody has to remember at each route.
 */

const authenticatedUsers = new WeakMap<Request, string>();
const authenticatedStaff = new WeakMap<Request, TrustSafetyStaffDocument>();

/**
 * Requires a verified Oxy session, and nothing else.
 *
 * The tenant is NOT resolved here. It cannot be: a console session belongs to a
 * person, not to an application, and which tenant the request acts on depends on
 * the path. Routes call `resolveApplicationForMember` with the id from their own
 * path, which is where the membership check happens.
 *
 * The identity is held in a module-private `WeakMap` keyed by the request rather
 * than assigned onto it, for the same reason the credential and reviewer
 * middlewares do it: a property on `Request` is writable by any later middleware
 * and readable by anything that guesses the name, so a route could be handed a
 * user id some other layer put there.
 */
export function requireConsoleSession(): RequestHandler[] {
  const resolveUser: RequestHandler = (request, _response, next) => {
    const oxyUserId = getOxyUserId(request);
    if (!oxyUserId) {
      next(new ApiError('unauthorized', 'This endpoint requires an Oxy session.'));
      return;
    }
    authenticatedUsers.set(request, oxyUserId);
    next();
  };

  return [verifyOxySession(), resolveUser];
}

/**
 * Requires a verified Oxy session AND at least one of the named Trust & Safety
 * roles.
 *
 * Returned as ONE middleware array rather than two exported guards, exactly as
 * `requireServiceCredential` folds authentication and scope into one call, and for
 * the same reason: separating them invites a route mounted with the session and not
 * the role. That mistake is invisible in review — the route looks authenticated —
 * and its consequence is a cross-tenant view served to any Oxy account that asks.
 *
 * There is deliberately no exported staff guard that can be mounted alone.
 *
 * Several roles are accepted where a surface genuinely serves more than one job:
 * §13.2 separates the four so that the person who edits a taxonomy is not the person
 * who opens sensitive evidence, NOT so that a read both of them need has to be
 * duplicated behind two routes. A write always names exactly one role.
 */
export function requireStaffRole(...roles: readonly StaffRole[]): RequestHandler[] {
  if (roles.length === 0) {
    // A guard that requires nothing is worse than no guard: it reads as protection.
    throw new Error('requireStaffRole needs at least one role.');
  }

  const resolveStaff: RequestHandler = async (request, _response, next) => {
    try {
      const oxyUserId = consoleUser(request);
      const staff = await trustSafetyStaff.findOne({ oxyUserId, status: 'active' });

      /**
       * 403 and not 404: unlike a tenant resource, the EXISTENCE of the Trust &
       * Safety surface is not a secret — it is documented in §4.3 — and a 404 here
       * would tell an operator whose role was revoked that the route disappeared
       * rather than that their authority did.
       *
       * Absent row and wrong role answer identically. Which roles a given account
       * holds is not something an unauthorised caller should be able to probe for.
       */
      if (!staff || !roles.some((role) => staff.roles.includes(role))) {
        throw new ApiError(
          'forbidden',
          `This endpoint requires one of the Trust & Safety roles: ${roles.join(', ')}.`,
        );
      }

      authenticatedStaff.set(request, staff);
      next();
    } catch (error: unknown) {
      next(error);
    }
  };

  return [...requireConsoleSession(), resolveStaff];
}

/**
 * The Oxy user this request belongs to.
 *
 * Throws when the request was never authenticated. A console route reachable
 * without the middleware is a mounting mistake, and it has to fail on the first
 * request rather than quietly resolve memberships for nobody in particular — which,
 * with an empty user id, would find no memberships and look like an ordinary 404.
 */
export function consoleUser(request: Request): string {
  const oxyUserId = authenticatedUsers.get(request);
  if (!oxyUserId) {
    throw new Error(
      'This route read a console user but is not mounted behind requireConsoleSession.',
    );
  }
  return oxyUserId;
}

/** The staff member this request belongs to. */
export function requestStaff(request: Request): TrustSafetyStaffDocument {
  const staff = authenticatedStaff.get(request);
  if (!staff) {
    throw new Error('This route read a staff member but is not mounted behind requireStaffRole.');
  }
  return staff;
}

/**
 * The staff roles this session holds, or an empty list.
 *
 * Used by `GET /v1/console/session` so the console can decide whether to render its
 * Trust & Safety navigation. It is a courtesy for the interface and NOT the
 * boundary: every T&S route checks its own role, so a client that ignored this and
 * called anyway is refused by the route.
 */
export async function staffRolesOf(oxyUserId: string): Promise<readonly StaffRole[]> {
  const staff = await trustSafetyStaff.findOne({ oxyUserId, status: 'active' });
  return staff?.roles ?? [];
}
