import { OxyServices } from '@oxy.so/core';
import type { Request } from 'express';

import { config } from '../../config';
import { applications } from './tenancy.collections';
import { createTenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import type { ServiceCredentialCaller } from './credential.service';
import { APPLICATION_SCOPES } from './scopes';

/**
 * Authenticating one of Oxy's OWN services, which holds no CrowdSource
 * credential at all.
 *
 * ## Why this exists
 *
 * A CrowdSource credential does two jobs: it proves the caller is who it says,
 * and it names the tenant. For a third party both jobs need a credential —
 * nobody can vouch for them and registration is exactly where trust starts.
 *
 * For Oxy's own services the first job is already done, and better: under oxy
 * ADR 0026 an official service proves what it IS to Oxy — an identity its
 * infrastructure issues and rotates, with no secret anyone typed — and receives
 * a short-lived Oxy service token naming the application. Making Mention ALSO
 * carry a hand-issued CrowdSource key means a human re-stating something the
 * platform can already prove, and then keeping that restatement in a parameter
 * store for the rest of time.
 *
 * So: present an Oxy service token, and CrowdSource resolves the tenant from
 * the binding on the application row. No credential, nothing to rotate, nothing
 * to leak.
 *
 * ## What is NOT relaxed
 *
 * - **The token must be Oxy's.** It is verified by `@oxy.so/core`, against Oxy's
 *   published keys, exactly as an Oxy session is on the console surfaces. A
 *   self-signed token is not a token.
 * - **The application must be BOUND.** A valid Oxy token for an application
 *   nobody linked to a CrowdSource tenant authenticates nothing. Binding is an
 *   explicit act, and removing the row is how a service is cut off.
 * - **The tenant still comes from the stored row**, never from the request. That
 *   is the same rule the credential path follows, and it is why neither path can
 *   name a tenant of its own choosing.
 *
 * ## What it grants
 *
 * Every scope an application credential may hold ({@link APPLICATION_SCOPES}),
 * and nothing beyond it. A first-party service is trusted to use the whole
 * application surface — it is Oxy's own code, deployed by the same people who
 * would otherwise tick the boxes in the console — while the PRIVILEGED scopes
 * stay exactly as unreachable as they are for a credential: they are not in that
 * list, and §13.2 says they are never self-grantable.
 */

let oxyServices: OxyServices | null = null;

/** Oxy's client, built once and only when a token is first presented. */
function client(): OxyServices {
  if (oxyServices) return oxyServices;
  const apiUrl = config.oxy.apiUrl;
  if (!apiUrl) {
    throw new ApiError(
      'service_unavailable',
      'This deployment cannot verify Oxy service tokens: no Oxy API is configured.',
    );
  }
  oxyServices = new OxyServices({ baseURL: apiUrl });
  return oxyServices;
}

/**
 * A JWT has three dot-separated segments; a CrowdSource credential has exactly
 * one separator and a `cred_`-shaped first half.
 *
 * This only DECIDES WHICH VERIFIER RUNS. It is not a security check and must
 * never become one: both paths verify their own token properly, and a malformed
 * token fails whichever it is handed to.
 */
export function looksLikeOxyServiceToken(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * Resolves an Oxy service token to a CrowdSource caller, or throws.
 *
 * Every rejection is the same 401 with the same message, for the reason the
 * credential path gives: telling a caller whether the token was invalid, the
 * application unbound or the tenant suspended hands an attacker a search
 * procedure.
 */
export async function authenticateOxyServiceToken(
  token: string,
  request: Request,
): Promise<ServiceCredentialCaller> {
  const unauthorized = new ApiError(
    'unauthorized',
    'The service credential is missing, malformed, expired or revoked.',
  );

  const verified = await verifyWithOxy(token, request);
  if (!verified) throw unauthorized;

  const application = await applications.findOne({ oxyApplicationId: verified.appId });
  if (!application || application.status !== 'active') throw unauthorized;

  return {
    // Attributable, and distinguishable at a glance from a credential id — an
    // audit row that reads `oxy:…` was not authenticated by anything revocable
    // here, and looking for a credential to revoke would be looking in the
    // wrong system.
    credentialId: `oxy:${verified.appId}`,
    scopes: [...APPLICATION_SCOPES],
    tenant: createTenantContext(application.organizationId, application.applicationId),
  };
}

/**
 * Hands the token to `@oxy.so/core`'s own service-token verification.
 *
 * The SDK exposes it as express middleware, so it is driven here over a
 * throwaway carrier — the alternative is a second implementation of "what is a
 * valid Oxy service token" living in this repo, which is exactly the divergence
 * `oxySession.ts` refuses to allow for sessions.
 */
async function verifyWithOxy(
  token: string,
  request: Request,
): Promise<{ appId: string } | null> {
  // `auth({ optional: true })`, not `serviceAuth()`: the latter WRITES a 403
  // response when the token is not a service token, and this is a resolution
  // step, not a route. Optional auth resolves what it can and calls next, which
  // is exactly the question being asked — "is this a service token, and whose".
  const middleware = client().auth({ optional: true });
  const carrier = Object.create(request) as Request & { serviceApp?: { appId?: unknown } };
  Object.defineProperty(carrier, 'headers', {
    value: { ...request.headers, authorization: `Bearer ${token}` },
    writable: true,
    enumerable: true,
    configurable: true,
  });

  await new Promise<void>((resolve) => {
    void middleware(carrier as never, {} as never, () => resolve());
  });

  const appId = carrier.serviceApp?.appId;
  return typeof appId === 'string' && appId.length > 0 ? { appId } : null;
}
