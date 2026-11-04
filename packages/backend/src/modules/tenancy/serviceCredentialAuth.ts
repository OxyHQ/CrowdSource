import type { Request, RequestHandler } from 'express';

import type { TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { authenticateServiceCredential, type ServiceCredentialCaller } from './credential.service';
import {
  authenticateOxyServiceToken,
  looksLikeOxyServiceToken,
  verifyOxyApplication,
} from './oxyApplicationAuth';
import { isApplicationScope, type Scope } from './scopes';

/**
 * The application-API authentication middleware.
 *
 * The authenticated caller is held in a module-private `WeakMap` keyed by the
 * request, NOT assigned onto the request object. The difference matters: a
 * property on `Request` is writable by any middleware that runs later and
 * readable by any code that guesses the name, so a route could be handed a
 * tenant that some other layer put there. Here the only writer is this file and
 * the only reader is `serviceCredentialCaller`, which throws rather than
 * returning a default when nothing authenticated the request.
 *
 * A `WeakMap` also means the entry disappears with the request rather than
 * keeping it alive.
 */
const authenticatedCallers = new WeakMap<Request, ServiceCredentialCaller>();

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function presentedToken(request: Request): string | null {
  const header = request.get('authorization');
  if (!header) return null;
  const match = BEARER_PATTERN.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Authenticates the service credential and requires `scope`.
 *
 * Authentication and authorization are one middleware because separating them
 * invites a route mounted with the first and not the second — an authenticated
 * caller doing something it was never granted. Naming the scope at the mount
 * point makes what a route needs visible where the route is declared.
 */
export function requireServiceCredential(scope: Scope): RequestHandler {
  return authenticateApplication(scope);
}

/** Identity echo only; data routes must declare their application operation. */
export function requireAnyServiceCredential(): RequestHandler {
  return authenticateApplication();
}

function authenticateApplication(scope?: Scope): RequestHandler {
  return (request, response, next) => {
    const token = presentedToken(request);
    if (!token)
      return next(new ApiError('unauthorized', 'This endpoint requires a service credential.'));
    const complete = async () => {
      const caller = looksLikeOxyServiceToken(token)
        ? await authenticateOxyServiceToken(request)
        : await authenticateServiceCredential(token);
      if (
        scope &&
        (caller.authority === 'first_party'
          ? !isApplicationScope(scope)
          : !caller.scopes.includes(scope))
      ) {
        throw new ApiError('forbidden', `This endpoint requires the '${scope}' authority.`);
      }
      authenticatedCallers.set(request, caller);
      next();
    };
    if (looksLikeOxyServiceToken(token)) {
      verifyOxyApplication()(request, response, (error) => {
        if (error) return next(error);
        void complete().catch(next);
      });
    } else {
      void complete().catch(next);
    }
  };
}

/**
 * The caller the authenticating middleware resolved for this request.
 *
 * Throws when the request was never authenticated. A route reachable without
 * the middleware is a mounting mistake, and it has to fail loudly on the first
 * request rather than quietly serve one tenant's data with no tenant at all.
 */
export function serviceCredentialCaller(request: Request): ServiceCredentialCaller {
  const caller = authenticatedCallers.get(request);
  if (!caller) {
    throw new Error(
      'This route read a service-credential caller but is not mounted behind requireServiceCredential.',
    );
  }
  return caller;
}

/** The tenant this request acts on behalf of, derived from its credential. */
export function requestTenant(request: Request): TenantContext {
  return serviceCredentialCaller(request).tenant;
}

/**
 * The credential that authenticated this request.
 *
 * Written into audit rows (§13.2) so a trail names WHICH of an application's
 * credentials acted, not merely the application. That is the difference between
 * "somebody at this tenant did it" and "the leaked key did it", which is the
 * whole question during a credential incident.
 */
export function requestCredentialId(request: Request): string {
  return serviceCredentialCaller(request).credentialId;
}
