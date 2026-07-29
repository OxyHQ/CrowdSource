import type { Request, RequestHandler } from 'express';
import { OxyServices } from '@oxyhq/core';
import { createOptionalOxyAuth, getOxyUserId } from '@oxyhq/core/server';

import { config } from '../../config';
import { ApiError } from '../../http/apiError';
import { ensureReviewerProfile } from './reviewer.service';
import type { ReviewerProfileDocument } from './reviewer.collection';

/**
 * The reviewer authentication boundary.
 *
 * CrowdSource has two caller classes and NEITHER may satisfy the other's routes.
 * An application presents a service credential, which is CrowdSource's own and
 * is where `applicationId` comes from. A reviewer presents an Oxy session, which
 * is verified by `@oxyhq/core/server` and carries no tenant at all — a reviewer
 * is drawn across every application, so there is nothing for it to carry.
 *
 * Session verification is the shared SDK's, not this service's. There is no
 * local bearer parser and no `AuthRequest` type here: an app-local token check
 * is a second, divergent definition of what a valid Oxy session is, and the day
 * the two disagree is the day one of them is wrong in production.
 *
 * The authenticated reviewer is held in a module-private `WeakMap` keyed by the
 * request rather than assigned onto it, for the same reason the credential
 * middleware does it: a property on `Request` is writable by any later
 * middleware and readable by anything that guesses the name, so a route could be
 * handed a reviewer some other layer put there.
 */

const authenticatedReviewers = new WeakMap<Request, ReviewerProfileDocument>();

let oxyServices: OxyServices | null = null;
let sessionMiddleware: RequestHandler | null = null;

/**
 * The Oxy client, built once and only when a reviewer route is first used.
 *
 * `OXY_API_URL` has no default and the application still boots without it: the
 * application API does not need it, and inventing a default would point session
 * verification at a host nobody chose. A deployment that has not configured it
 * answers `503` on the reviewer surface — the capability is genuinely
 * unavailable — rather than accepting sessions it cannot verify.
 */
function oxySessionMiddleware(): RequestHandler {
  if (sessionMiddleware) return sessionMiddleware;

  const apiUrl = config.oxy.apiUrl;
  if (!apiUrl) {
    throw new ApiError(
      'service_unavailable',
      'The reviewer API is unavailable: this deployment has no Oxy API configured.',
    );
  }

  oxyServices ??= new OxyServices({ baseURL: apiUrl });
  /**
   * The OPTIONAL variant, and then our own guard.
   *
   * `createOxyAuthMiddleware` would be one call, but it writes its own 401 body
   * and never reaches the next handler — so the reviewer API would answer
   * authentication failures in a different shape from every other failure it can
   * produce. The optional variant does the same session verification and leaves
   * the decision here, which keeps §10.5's error convention true across the
   * whole service while session verification stays entirely the shared SDK's.
   */
  sessionMiddleware = createOptionalOxyAuth(oxyServices);
  return sessionMiddleware;
}

/** Test seam: forget the built client so a reconfigured environment is picked up. */
export function resetReviewerAuth(): void {
  oxyServices = null;
  sessionMiddleware = null;
}

/**
 * Whether the Oxy session payload says this account is verified.
 *
 * `OxyRequestUser` is an open bag, so the flag is read defensively and any
 * non-boolean — including absent — means false. §8.2's personhood must never
 * treat "we were not told" as "verified"; see `personhood.ts` for why the flag
 * is one signal among several rather than the gate.
 */
function sessionSaysVerified(request: Request): boolean {
  const user: unknown = Reflect.get(request, 'user');
  if (typeof user !== 'object' || user === null) return false;
  return Reflect.get(user, 'verified') === true;
}

/**
 * Authenticates the Oxy session and resolves the reviewer's profile.
 *
 * The profile is created on first sight, as §8.1's `applicant`. There is no
 * separate registration step to forget, and a person who has authenticated but
 * done nothing else is exactly what `applicant` means.
 */
export function requireReviewerSession(): RequestHandler[] {
  /**
   * Two handlers rather than one wrapping the other.
   *
   * Express middleware signals "stop here" by NOT calling `next`, so wrapping
   * one in a promise that only settles on `next` deadlocks the request the first
   * time the inner handler refuses. Chaining them lets the SDK's middleware
   * behave exactly as it was written to.
   */
  const verifySession: RequestHandler = (request, response, next) => {
    let middleware: RequestHandler;
    try {
      middleware = oxySessionMiddleware();
    } catch (error: unknown) {
      next(error);
      return;
    }
    middleware(request, response, next);
  };

  const resolveReviewer: RequestHandler = async (request, _response, next) => {
    try {
      const oxyUserId = getOxyUserId(request);
      if (!oxyUserId) {
        throw new ApiError('unauthorized', 'This endpoint requires an Oxy session.');
      }

      const profile = await ensureReviewerProfile({
        oxyUserId,
        oxyAccountVerified: sessionSaysVerified(request),
      });

      authenticatedReviewers.set(request, profile);
      next();
    } catch (error: unknown) {
      next(error);
    }
  };

  return [verifySession, resolveReviewer];
}

/**
 * The reviewer this request belongs to.
 *
 * Throws when the request was never authenticated. A reviewer route reachable
 * without the middleware is a mounting mistake, and it has to fail on the first
 * request rather than quietly serve case material to nobody in particular.
 */
export function requestReviewer(request: Request): ReviewerProfileDocument {
  const profile = authenticatedReviewers.get(request);
  if (!profile) {
    throw new Error(
      'This route read a reviewer but is not mounted behind requireReviewerSession.',
    );
  }
  return profile;
}
