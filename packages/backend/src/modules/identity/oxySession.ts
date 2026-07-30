import { OxyServices } from '@oxyhq/core';
import { createOptionalOxyAuth } from '@oxyhq/core/server';
import type { Request, RequestHandler } from 'express';

import { config } from '../../config';
import { ApiError } from '../../http/apiError';

/**
 * Oxy session verification, defined ONCE for the whole service.
 *
 * CrowdSource has two caller classes and neither may satisfy the other's routes:
 * a SERVICE CREDENTIAL (applications, and where `applicationId` comes from) and
 * an OXY SESSION. Three surfaces present a session — the reviewer app, the
 * developer console and Trust & Safety — and this module is the only place any of
 * them is verified.
 *
 * That singularity is the point rather than a convenience. An app-local bearer
 * parser, or a second module-level `createOptionalOxyAuth` client with its own
 * failure message, is a second and divergent definition of what a valid Oxy
 * session is; the day the two disagree, one of them is wrong in production and
 * nothing says which. So verification itself belongs entirely to
 * `@oxyhq/core/server` and this file holds the wiring around it.
 *
 * What a session means is NOT decided here. A reviewer profile, an organization
 * membership and a Trust & Safety role are three different authorizations built
 * on top of the same authenticated identity, and each lives with the module that
 * owns it.
 */

let oxyServices: OxyServices | null = null;
let sessionMiddleware: RequestHandler | null = null;

/**
 * The Oxy client, built once and only when a session route is first used.
 *
 * `OXY_API_URL` has no default and the application still boots without it: the
 * application API does not need it, and inventing a default would point session
 * verification at a host nobody chose. A deployment that has not configured it
 * answers `503` on every session surface — the capability is genuinely
 * unavailable — rather than accepting sessions it cannot verify.
 */
function builtSessionMiddleware(): RequestHandler {
  if (sessionMiddleware) return sessionMiddleware;

  const apiUrl = config.oxy.apiUrl;
  if (!apiUrl) {
    throw new ApiError(
      'service_unavailable',
      'This surface is unavailable: this deployment has no Oxy API configured.',
    );
  }

  oxyServices ??= new OxyServices({ baseURL: apiUrl });
  /**
   * The OPTIONAL variant, and then each surface's own guard.
   *
   * `createOxyAuthMiddleware` would be one call, but it writes its own 401 body
   * and never reaches the next handler — so a session surface would answer
   * authentication failures in a different shape from every other failure it can
   * produce. The optional variant does the same session verification and leaves
   * the decision to the caller, which keeps §10.5's error convention true across
   * the whole service while verification stays entirely the shared SDK's.
   */
  sessionMiddleware = createOptionalOxyAuth(oxyServices);
  return sessionMiddleware;
}

/** Test seam: forget the built client so a reconfigured environment is picked up. */
export function resetOxySession(): void {
  oxyServices = null;
  sessionMiddleware = null;
}

/**
 * Verifies the Oxy session, if one was presented.
 *
 * Deliberately does NOT refuse an anonymous request: it populates the identity
 * and the surface behind it decides. Every caller in this service pairs it with a
 * guard in the same middleware array, so there is no route reachable with this
 * alone.
 *
 * Two handlers rather than one wrapping the other. Express middleware signals
 * "stop here" by NOT calling `next`, so wrapping the SDK's handler in a promise
 * that only settles on `next` deadlocks the request the first time it refuses.
 * Deferring to it directly lets it behave exactly as it was written to.
 */
export function verifyOxySession(): RequestHandler {
  return (request, response, next) => {
    let middleware: RequestHandler;
    try {
      middleware = builtSessionMiddleware();
    } catch (error: unknown) {
      next(error);
      return;
    }
    middleware(request, response, next);
  };
}

/**
 * Whether the Oxy session payload says this account is verified.
 *
 * `OxyRequestUser` is an open bag, so the flag is read defensively and any
 * non-boolean — including absent — means false. "We were not told" must never
 * become "verified": §8.2's personhood would otherwise be raised by a session
 * payload nobody validated.
 */
export function sessionSaysVerified(request: Request): boolean {
  const user: unknown = Reflect.get(request, 'user');
  if (typeof user !== 'object' || user === null) return false;
  return Reflect.get(user, 'verified') === true;
}
