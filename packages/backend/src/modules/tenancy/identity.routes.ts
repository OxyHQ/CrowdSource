import { Router } from 'express';

import { requestTenant, requireAnyServiceCredential } from './serviceCredentialAuth';

/**
 * `GET /v1/applications/me` — which application this caller is.
 *
 * ## Why an endpoint for something the caller "already knows"
 *
 * A CrowdSource service key carries the application id inside it, so a client
 * holding one has never needed to ask. A first-party service authenticating with
 * an Oxy token holds nothing of the sort: Oxy vouches for WHO is calling, and
 * which CrowdSource tenant that maps to is this service's own record
 * (`oxyApplicationAuth.ts`).
 *
 * The report envelope names its application (§5.1), and the server refuses one
 * that disagrees with the authenticated tenant — so a client that cannot name
 * itself cannot file a report. Asking here is how it learns, once, from the only
 * party that actually knows.
 *
 * ## Why it needs no scope
 *
 * Every other application route names the capability it needs, and that is the
 * rule. This one is not about data: it returns the caller's own identity, which
 * it has already proven. Requiring `reports:read` to discover where one's
 * reports would go would be asking for a capability to learn a fact about
 * oneself.
 *
 * The answer is the tenant the SERVER resolved, never anything from the request.
 * A caller cannot use this to ask about somebody else, because there is nothing
 * here to ask with.
 */
export const identityRouter = Router();

identityRouter.get('/applications/me', requireAnyServiceCredential(), (request, response) => {
  const tenant = requestTenant(request);
  response.status(200).json({
    applicationId: tenant.applicationId,
    organizationId: tenant.organizationId,
  });
});
