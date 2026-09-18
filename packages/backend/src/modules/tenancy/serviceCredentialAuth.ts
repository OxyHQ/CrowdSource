import type { Request, RequestHandler } from 'express';

import type { TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { authenticateServiceCredential, type ServiceCredentialCaller } from './credential.service';
import { authenticateOxyServiceToken, looksLikeOxyServiceToken } from './oxyApplicationAuth';
import type { Scope } from './scopes';

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
  return async (request, _response, next) => {
    try {
      const token = presentedToken(request);
      if (!token) {
        throw new ApiError('unauthorized', 'This endpoint requires a service credential.');
      }

      /**
       * Two ways to be an application here, and the token says which.
       *
       * A CrowdSource credential is `credentialId:secret`; an Oxy service token
       * is a JWT. Oxy's own services present the latter and hold no credential
       * at all (`oxyApplicationAuth.ts`), which is what removes the hand-issued
       * key from every first-party integration. A third party is unaffected:
       * it presents a credential and takes the path below exactly as before.
       *
       * The shape only picks the verifier. Each path verifies its own token in
       * full, and a malformed one fails whichever it reached.
       */
      const caller = looksLikeOxyServiceToken(token)
        ? await authenticateOxyServiceToken(token, request)
        : await authenticateServiceCredential(token);
      if (!caller.scopes.includes(scope)) {
        // 403, not 401: the credential is valid, the capability is not granted
        // (§10.5). Answering 401 would send an integrator to rotate a working
        // credential instead of adding the scope.
        throw new ApiError('forbidden', `This endpoint requires the '${scope}' scope.`);
      }

      authenticatedCallers.set(request, caller);
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}

/**
 * The caller `requireServiceCredential` authenticated for this request.
 *
 * Throws when the request was never authenticated. A route reachable without
 * the middleware is a mounting mistake, and it has to fail loudly on the first
 * request rather than quietly serve one tenant's data with no tenant at all.
 */
/**
 * Authenticates without requiring any scope.
 *
 * For the one question that is not about data: "who am I here". A caller that
 * has authenticated already knows it is entitled to that answer, and demanding a
 * data scope to learn one's own application id would mean an integrator needs
 * `reports:read` to find out where its reports would go.
 *
 * Deliberately NOT exported as a general-purpose "authenticate only" middleware:
 * a route mounted with authentication and no authorization is the mistake
 * `requireServiceCredential` exists to prevent, and the one caller here is an
 * identity echo that reads nothing.
 */
export function requireAnyServiceCredential(): RequestHandler {
  return async (request, _response, next) => {
    try {
      const token = presentedToken(request);
      if (!token) {
        throw new ApiError('unauthorized', 'This endpoint requires a service credential.');
      }
      const caller = looksLikeOxyServiceToken(token)
        ? await authenticateOxyServiceToken(token, request)
        : await authenticateServiceCredential(token);
      authenticatedCallers.set(request, caller);
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}

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
