import type { OxyServiceAppContext } from '@oxy.so/core/server';
import type { Request, RequestHandler } from 'express';

import { createTenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { oxyServiceServer } from '../identity/oxyService';
import type { ServiceCredentialCaller } from './credential.service';
import { applications, organizations } from './tenancy.collections';

/** Canonical receiver identity; never an authority decision about the caller. */
export const CROWDSOURCE_SERVICE_AUDIENCE = 'oxy-service:6a6947b30fe72510b411252f';

/** Token shape only selects a verifier; each verifier authenticates independently. */
export function looksLikeOxyServiceToken(token: string): boolean {
  return token.split('.').length === 3;
}

/** Run the shared service verifier on the real request and response. */
export function verifyOxyApplication(): RequestHandler {
  return (request, response, next) => {
    try {
      const verifier = oxyServiceServer().middleware.service({
        expectedAudience: CROWDSOURCE_SERVICE_AUDIENCE,
      });
      void Promise.resolve(verifier(request, response, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}

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
