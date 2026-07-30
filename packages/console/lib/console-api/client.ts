/**
 * The Console API client.
 *
 * Authentication is NOT handled here. `createLinkedClient` returns an HTTP client
 * bound to the one Oxy session `OxyProvider` owns: its bearer stays in lockstep
 * with that session and its 401 path re-mints from the device secret. The app
 * therefore has no token provider, no `Authorization` header and no auth routes
 * of its own — which is the ecosystem rule, and also the reason neither console
 * surface can be reached with anything but a real Oxy session.
 *
 * GET caching is off (the linked-client default): React Query is the single cache
 * authority for this backend. A second, invisible cache underneath it is how a
 * revoked credential comes back as active.
 *
 * Every function returns `unknown`. Nothing in the app consumes a response
 * without passing it through a projection in `projections.ts` first.
 */

import { API_URL } from '@/config';
import { REQUEST_TIMEOUT_MS } from '@/lib/constants';
import { oxyServices } from '@/lib/oxyServices';

import {
  ConsoleApiUnavailableError,
  ConsoleApiUnreachableError,
  ConsoleConflictError,
  ConsoleForbiddenError,
  ConsoleRateLimitedError,
  ConsoleRequestRejectedError,
  ConsoleResourceMissingError,
  ConsoleServiceUnavailableError,
  httpStatusOf,
} from './errors';
import type {
  CreateOrganizationInput,
  GrantMemberInput,
  IssueCredentialInput,
  SetStandingInput,
} from './types';

const linkedClient = oxyServices.createLinkedClient({ baseURL: API_URL, enableCache: false });

/** Every endpoint this app depends on, named in one place. */
export const CONSOLE_ENDPOINTS = {
  session: 'GET /v1/console/session',
  organizations: 'GET /v1/console/organizations',
  createOrganization: 'POST /v1/console/organizations',
  members: 'GET /v1/console/organizations/{organizationId}/members',
  grantMember: 'POST /v1/console/organizations/{organizationId}/members',
  revokeMember: 'POST /v1/console/organizations/{organizationId}/members/{oxyUserId}/revoke',
  applications: 'GET /v1/console/organizations/{organizationId}/applications',
  createApplication: 'POST /v1/console/organizations/{organizationId}/applications',
  application: 'GET /v1/console/applications/{applicationId}',
  credentials: 'GET /v1/console/applications/{applicationId}/credentials',
  issueCredential: 'POST /v1/console/applications/{applicationId}/credentials',
  revokeCredential:
    'POST /v1/console/applications/{applicationId}/credentials/{credentialId}/revoke',
  webhookEndpoints: 'GET /v1/console/applications/{applicationId}/webhook-endpoints',
  rotateSecret:
    'POST /v1/console/applications/{applicationId}/webhook-endpoints/{webhookEndpointId}/rotate-secret',
  deliveries: 'GET /v1/console/applications/{applicationId}/deliveries',
  replayDelivery: 'POST /v1/console/applications/{applicationId}/deliveries/{deliveryId}/replay',
  cases: 'GET /v1/console/applications/{applicationId}/cases',
  caseDetail: 'GET /v1/console/applications/{applicationId}/cases/{caseId}',
  usage: 'GET /v1/console/applications/{applicationId}/usage',
  audit: 'GET /v1/console/applications/{applicationId}/audit',
  trustSafetyApplications: 'GET /v1/trust-safety/applications',
  setStanding: 'POST /v1/trust-safety/applications/{applicationId}/standing',
  deadLetterQueue: 'GET /v1/trust-safety/deliveries/dead-letter',
  platformMetrics: 'GET /v1/trust-safety/metrics',
} as const;

export type ConsoleEndpoint = (typeof CONSOLE_ENDPOINTS)[keyof typeof CONSOLE_ENDPOINTS];

/** See `errors.ts` for why a 404 cannot be read without the call site's help. */
type NotFoundMeaning = 'unavailable' | 'missing';

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  endpoint: ConsoleEndpoint;
  notFound: NotFoundMeaning;
  /** Which 403 copy applies. Defaults to the tenant surface. */
  forbidden?: 'tenant' | 'trust-safety';
  /** Named in the conflict a 409 reports. */
  conflict?: string;
  body?: unknown;
}

async function request({
  method,
  path,
  endpoint,
  notFound,
  forbidden = 'tenant',
  conflict,
  body,
}: RequestSpec): Promise<unknown> {
  try {
    return await linkedClient.client.request<unknown>({
      method,
      url: path,
      data: body,
      // ONE retry authority. The SDK's HttpService retries on its own schedule
      // and React Query retries on top of it, which multiplies out to a screen
      // that spins for the better part of a minute against a backend that is
      // simply not there. React Query owns the policy (see
      // `components/providers/constants.ts`); the transport just reports.
      retry: false,
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === undefined) {
      // No HTTP status at all: the request never reached the API.
      throw new ConsoleApiUnreachableError(endpoint, error);
    }
    if (status === 404) {
      throw notFound === 'unavailable'
        ? new ConsoleApiUnavailableError(endpoint)
        : new ConsoleResourceMissingError();
    }
    if (status === 403) {
      throw new ConsoleForbiddenError(forbidden);
    }
    if (status === 409) {
      throw new ConsoleConflictError(conflict ?? endpoint);
    }
    if (status === 400) {
      throw new ConsoleRequestRejectedError(endpoint);
    }
    if (status === 429) {
      throw new ConsoleRateLimitedError();
    }
    if (status === 503) {
      throw new ConsoleServiceUnavailableError(endpoint);
    }
    // 401 included: the SDK has already tried to re-mint from the device secret
    // and failed, which means the session is gone. The root layout's redirect is
    // the answer to that, not a message on this screen.
    throw error;
  }
}

/** Path segments are always encoded: an id reaches this module from a URL. */
function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Builds a query string from the parameters that are actually set. */
function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).flatMap(([key, value]) =>
    value === undefined || value === '' ? [] : [`${key}=${encodeURIComponent(String(value))}`],
  );
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

// --- session and tenancy -----------------------------------------------------

export function getSession(): Promise<unknown> {
  return request({
    method: 'GET',
    path: '/v1/console/session',
    endpoint: CONSOLE_ENDPOINTS.session,
    notFound: 'unavailable',
  });
}

export function getOrganizations(): Promise<unknown> {
  return request({
    method: 'GET',
    path: '/v1/console/organizations',
    endpoint: CONSOLE_ENDPOINTS.organizations,
    notFound: 'unavailable',
  });
}

export function postOrganization(body: CreateOrganizationInput): Promise<unknown> {
  return request({
    method: 'POST',
    path: '/v1/console/organizations',
    endpoint: CONSOLE_ENDPOINTS.createOrganization,
    notFound: 'unavailable',
    conflict: 'slug-taken',
    body,
  });
}

export function getMembers(organizationId: string): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/organizations/${segment(organizationId)}/members`,
    endpoint: CONSOLE_ENDPOINTS.members,
    notFound: 'missing',
  });
}

export function postMember(organizationId: string, body: GrantMemberInput): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/console/organizations/${segment(organizationId)}/members`,
    endpoint: CONSOLE_ENDPOINTS.grantMember,
    notFound: 'missing',
    body,
  });
}

export function postMemberRevoke(organizationId: string, oxyUserId: string): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/console/organizations/${segment(organizationId)}/members/${segment(oxyUserId)}/revoke`,
    endpoint: CONSOLE_ENDPOINTS.revokeMember,
    notFound: 'missing',
    conflict: 'last-owner',
  });
}

export function getApplications(organizationId: string): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/organizations/${segment(organizationId)}/applications`,
    endpoint: CONSOLE_ENDPOINTS.applications,
    notFound: 'missing',
  });
}

export function postApplication(organizationId: string, body: { name: string }): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/console/organizations/${segment(organizationId)}/applications`,
    endpoint: CONSOLE_ENDPOINTS.createApplication,
    notFound: 'missing',
    body,
  });
}

export function getApplication(applicationId: string): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/applications/${segment(applicationId)}`,
    endpoint: CONSOLE_ENDPOINTS.application,
    notFound: 'missing',
  });
}

// --- credentials -------------------------------------------------------------

export function getCredentials(applicationId: string): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/applications/${segment(applicationId)}/credentials`,
    endpoint: CONSOLE_ENDPOINTS.credentials,
    notFound: 'missing',
  });
}

export function postCredential(
  applicationId: string,
  body: IssueCredentialInput,
): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/console/applications/${segment(applicationId)}/credentials`,
    endpoint: CONSOLE_ENDPOINTS.issueCredential,
    notFound: 'missing',
    body,
  });
}

export function postCredentialRevoke(
  applicationId: string,
  credentialId: string,
): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/console/applications/${segment(applicationId)}/credentials/${segment(credentialId)}/revoke`,
    endpoint: CONSOLE_ENDPOINTS.revokeCredential,
    notFound: 'missing',
  });
}

// --- webhooks ----------------------------------------------------------------

export function getWebhookEndpoints(applicationId: string): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/applications/${segment(applicationId)}/webhook-endpoints`,
    endpoint: CONSOLE_ENDPOINTS.webhookEndpoints,
    notFound: 'missing',
  });
}

export function postSecretRotation(
  applicationId: string,
  webhookEndpointId: string,
  body: { overlapSeconds: number },
): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/console/applications/${segment(applicationId)}/webhook-endpoints/${segment(webhookEndpointId)}/rotate-secret`,
    endpoint: CONSOLE_ENDPOINTS.rotateSecret,
    notFound: 'missing',
    body,
  });
}

export function getDeliveries(
  applicationId: string,
  filters: { status?: string; webhookEndpointId?: string },
): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/applications/${segment(applicationId)}/deliveries${query(filters)}`,
    endpoint: CONSOLE_ENDPOINTS.deliveries,
    notFound: 'missing',
  });
}

export function postDeliveryReplay(applicationId: string, deliveryId: string): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/console/applications/${segment(applicationId)}/deliveries/${segment(deliveryId)}/replay`,
    endpoint: CONSOLE_ENDPOINTS.replayDelivery,
    notFound: 'missing',
    conflict: 'not-dead-lettered',
  });
}

// --- cases, usage, audit -----------------------------------------------------

export function getCases(
  applicationId: string,
  filters: { status?: string; cursor?: string },
): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/applications/${segment(applicationId)}/cases${query(filters)}`,
    endpoint: CONSOLE_ENDPOINTS.cases,
    notFound: 'missing',
  });
}

export function getCaseDetail(applicationId: string, caseId: string): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/applications/${segment(applicationId)}/cases/${segment(caseId)}`,
    endpoint: CONSOLE_ENDPOINTS.caseDetail,
    notFound: 'missing',
  });
}

export function getUsage(applicationId: string, windowDays: number): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/applications/${segment(applicationId)}/usage${query({ windowDays })}`,
    endpoint: CONSOLE_ENDPOINTS.usage,
    notFound: 'missing',
  });
}

export function getAudit(applicationId: string, filters: { caseId?: string }): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/console/applications/${segment(applicationId)}/audit${query(filters)}`,
    endpoint: CONSOLE_ENDPOINTS.audit,
    notFound: 'missing',
  });
}

// --- Trust & Safety ----------------------------------------------------------
//
// A different authorization from everything above, and the 403 copy says so.
// Hiding the navigation is a courtesy; these routes are the boundary.

export function getTrustSafetyApplications(filters: { standing?: string }): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/trust-safety/applications${query(filters)}`,
    endpoint: CONSOLE_ENDPOINTS.trustSafetyApplications,
    notFound: 'unavailable',
    forbidden: 'trust-safety',
  });
}

export function postStanding(applicationId: string, body: SetStandingInput): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/trust-safety/applications/${segment(applicationId)}/standing`,
    endpoint: CONSOLE_ENDPOINTS.setStanding,
    notFound: 'missing',
    forbidden: 'trust-safety',
    body,
  });
}

export function getDeadLetterQueue(): Promise<unknown> {
  return request({
    method: 'GET',
    path: '/v1/trust-safety/deliveries/dead-letter',
    endpoint: CONSOLE_ENDPOINTS.deadLetterQueue,
    notFound: 'unavailable',
    forbidden: 'trust-safety',
  });
}

export function getPlatformMetrics(): Promise<unknown> {
  return request({
    method: 'GET',
    path: '/v1/trust-safety/metrics',
    endpoint: CONSOLE_ENDPOINTS.platformMetrics,
    notFound: 'unavailable',
    forbidden: 'trust-safety',
  });
}
