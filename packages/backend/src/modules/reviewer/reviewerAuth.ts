import type { Request, RequestHandler } from 'express';
import { getOxyUserId } from '@oxyhq/core/server';

import { ApiError } from '../../http/apiError';
import { sessionSaysVerified, verifyOxySession } from '../identity/oxySession';
import { ensureReviewerProfile } from './reviewer.service';
import type { ReviewerProfileDocument } from './reviewer.collection';

/**
 * The reviewer authorization boundary.
 *
 * CrowdSource has two caller classes and NEITHER may satisfy the other's routes.
 * An application presents a service credential, which is CrowdSource's own and
 * is where `applicationId` comes from. A reviewer presents an Oxy session, which
 * carries no tenant at all — a reviewer is drawn across every application, so
 * there is nothing for it to carry.
 *
 * Session verification itself is NOT here: it is `../identity/oxySession`, which
 * is the single definition of a valid Oxy session for every surface in the
 * service. What this file owns is what a verified session MEANS to the reviewer
 * API — a reviewer profile — and nothing else.
 *
 * The authenticated reviewer is held in a module-private `WeakMap` keyed by the
 * request rather than assigned onto it, for the same reason the credential
 * middleware does it: a property on `Request` is writable by any later
 * middleware and readable by anything that guesses the name, so a route could be
 * handed a reviewer some other layer put there.
 */

const authenticatedReviewers = new WeakMap<Request, ReviewerProfileDocument>();

/**
 * Authenticates the Oxy session and resolves the reviewer's profile.
 *
 * The profile is created on first sight, as §8.1's `applicant`. There is no
 * separate registration step to forget, and a person who has authenticated but
 * done nothing else is exactly what `applicant` means.
 */
export function requireReviewerSession(): RequestHandler[] {
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

  return [verifyOxySession(), resolveReviewer];
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
