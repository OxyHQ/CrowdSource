import { createOptionalOxyAuth, createOxyRateLimit } from '@oxy.so/core/server';
import type { Request, RequestHandler } from 'express';

import { oxyMiddleware } from './oxyService';

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
 * `@oxy.so/core/server` and this file holds the wiring around it.
 *
 * What a session means is NOT decided here. A reviewer profile, an organization
 * membership and a Trust & Safety role are three different authorizations built
 * on top of the same authenticated identity, and each lives with the module that
 * owns it.
 */

/**
 * How a session is verified, stated once and shared with the session rate
 * limiter, which resolves a session itself when nothing has yet. Two sets of
 * options would let whichever ran first decide — the SDK never re-resolves a
 * request that already has a user.
 *
 *  - `loadUser`: the validated session already carries the account, so the
 *    `verified` flag `sessionSaysVerified` reads costs no round trip. Without it
 *    the request holds only an id and the personhood signal is never seen.
 *  - `strictOptionalBearer`: a PRESENTED credential that cannot be verified is
 *    refused rather than downgraded to anonymous, and an Oxy outage is a 503 —
 *    never a 401 that tells a reviewer to sign in again. Those refusals are the
 *    SDK's own answer; an anonymous request still reaches each surface's guard,
 *    which answers in this service's convention.
 */
export const OXY_SESSION_AUTH = { loadUser: true, strictOptionalBearer: true } as const;

const sessionVerifier = oxyMiddleware((oxy) =>
  createOptionalOxyAuth(oxy, { auth: OXY_SESSION_AUTH }),
);

/**
 * Verifies the Oxy session, if one was presented — once per request, whoever
 * mounts it first (`app.ts` on the session surfaces, then each guard).
 *
 * Deliberately does NOT refuse an anonymous request: it populates the identity
 * and the surface behind it decides. Every route pairs it with a guard
 * (`requireReviewerSession`, `requireConsoleSession`, `requireStaffRole`), so
 * there is no route reachable with this alone.
 */
export function verifyOxySession(): RequestHandler {
  return sessionVerifier;
}

/**
 * The shared per-person rate limit for the session surfaces, one per app.
 * Mounted after `verifyOxySession()`, so it keys on the resolved person; it is
 * handed the same options all the same, so it could never resolve a session
 * differently.
 */
export function limitOxySessions(): RequestHandler {
  return oxyMiddleware((oxy) => createOxyRateLimit(oxy, { auth: OXY_SESSION_AUTH }));
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
