import type { OxyServiceAppContext } from '@oxy.so/core/server';
import type { Request, RequestHandler } from 'express';

import { createTenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { oxyMiddleware } from '../identity/oxyService';
import type { ServiceCredentialCaller } from './credential.service';
import { applications, organizations } from './tenancy.collections';

/** Token shape only selects a verifier; each verifier authenticates independently. */
export function looksLikeOxyServiceToken(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * The shared service verifier, built once. Its audience is the server's own
 * (`expectedAudience`, `identity/oxyService.ts`), never repeated here.
 */
export const verifyOxyApplication: RequestHandler = oxyMiddleware((oxy) =>
  oxy.middleware.service(),
);

/** A verified identity still needs an active stored tenant binding on every call. */
export async function authenticateOxyServiceToken(
  request: Request & {
    serviceApp?: OxyServiceAppContext;
    serviceActingAs?: { authority?: string; scopes?: readonly string[] };
  },
): Promise<ServiceCredentialCaller> {
  const unauthorized = new ApiError(
    'unauthorized',
    'The Oxy service identity is inactive or unbound.',
  );
  const verified = request.serviceApp;
  if (!verified) throw unauthorized;

  // Shared middleware confirms both lanes live, narrows external scopes and
  // validates any acting-as proof. This adapter only binds the product tenant.
  const scopes =
    verified.authority === 'first_party'
      ? undefined
      : verified.scopes.filter(
          (scope) => !request.serviceActingAs || request.serviceActingAs.scopes?.includes(scope),
        );

  const application = await applications.findOne({ oxyApplicationId: verified.appId });
  if (application?.status !== 'active') throw unauthorized;
  const organization = await organizations.findOne({ organizationId: application.organizationId });
  if (organization?.status !== 'active' || !organization.oxyAccountId) throw unauthorized;
  const identity = {
    credentialId: `oxy:${verified.credentialId}`,
    tenant: createTenantContext(application.organizationId, application.applicationId),
  };
  return verified.authority === 'first_party'
    ? { ...identity, authority: 'first_party' }
    : { ...identity, authority: 'external', scopes: scopes ?? [] };
}
