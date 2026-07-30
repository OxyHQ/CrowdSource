/**
 * React Query bindings for the Console API.
 *
 * Three rules hold across every hook below, and each exists because of a failure
 * that otherwise looks like nothing is wrong.
 *
 * **Every response passes through a projection.** `ingest` scans the raw payload
 * for fields this surface must never show — logging PATHS, never values — and then
 * projects it onto the app's own types. A component never sees a wire object.
 *
 * **Every query is keyed on the viewer and gated on their access token.** See
 * `viewer.ts`: cold boot is slow, `isAuthenticated: false` means UNDETERMINED
 * until it resolves, and a person can switch Oxy accounts without reloading.
 *
 * **Every mutation invalidates what it actually changed, and nothing more.**
 * React Query is the single cache authority here (the linked client's GET cache is
 * off), so an invalidation this module forgets is a screen showing a revoked
 * credential as active until something else happens to refetch. Narrow keys make
 * that precise rather than a blanket drop that refetches six tables to update one
 * row.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { createScopedLogger } from '@/lib/logger';

import {
  getApplication,
  getApplications,
  getAudit,
  getCaseDetail,
  getCases,
  getCredentials,
  getDeadLetterQueue,
  getDeliveries,
  getMembers,
  getOrganizations,
  getPlatformMetrics,
  getSession,
  getTrustSafetyApplications,
  getUsage,
  getWebhookEndpoints,
  postApplication,
  postCredential,
  postCredentialRevoke,
  postDeliveryReplay,
  postMember,
  postMemberRevoke,
  postOrganization,
  postSecretRotation,
  postStanding,
} from './client';
import { isSettledAnswer } from './errors';
import {
  projectApplicationDetail,
  projectApplications,
  projectAuditEvents,
  projectCaseDetail,
  projectCasePage,
  projectCreatedApplication,
  projectCreatedOrganization,
  projectCredentials,
  projectDeadLetterQueue,
  projectDeliveries,
  projectDelivery,
  projectIssuedCredential,
  projectMembers,
  projectOrganizations,
  projectPlatformMetrics,
  projectRotatedSecret,
  projectSession,
  projectTrustSafetyApplication,
  projectTrustSafetyApplications,
  projectUsage,
  projectWebhookEndpoints,
  scanForForbiddenFields,
} from './projections';
import { consoleQueryKeys } from './query-keys';
import type {
  ApplicationDetail,
  ApplicationSummary,
  AuditEvent,
  CaseDetail,
  CaseListPage,
  CreateOrganizationInput,
  CreatedApplication,
  CreatedOrganization,
  ConsoleSession,
  DeadLetteredDelivery,
  GrantMemberInput,
  IssueCredentialInput,
  IssuedCredential,
  OrganizationMember,
  OrganizationSummary,
  PlatformMetrics,
  RotatedSecret,
  ServiceCredential,
  SetStandingInput,
  TrustSafetyApplication,
  UsageSummary,
  WebhookDelivery,
  WebhookEndpoint,
} from './types';
import { useConsoleViewer } from './use-console-viewer';
import { UNRESOLVED_VIEWER_KEY } from './viewer';

const logger = createScopedLogger('ConsoleApi');

/**
 * Projects a payload and raises the alarm if the server sent a field this surface
 * must never show.
 *
 * The projection is the enforcement — the field is dropped whether or not anyone
 * is watching. This warning exists so a backend regression is visible while it is
 * still cheap to fix, and it reports paths only because the values are exactly the
 * material that must not reach a log.
 */
function ingest<T>(payload: unknown, project: (payload: unknown) => T, source: string): T {
  const forbiddenPaths = scanForForbiddenFields(payload);
  if (forbiddenPaths.length > 0) {
    logger.warn('Payload carried fields the console must not show; dropped', {
      source,
      // Paths only. Never values.
      paths: forbiddenPaths,
    });
  }
  return project(payload);
}

/** An answer is not a transient failure; retrying one wastes everybody's time. */
function consoleQueryRetry(failureCount: number, error: unknown): boolean {
  if (isSettledAnswer(error)) {
    return false;
  }
  return failureCount < 2;
}

/** The cache key segment for the current viewer, resolved or not. */
function useViewerKey(): { key: string; canQuery: boolean } {
  const viewer = useConsoleViewer();
  return { key: viewer.key ?? UNRESOLVED_VIEWER_KEY, canQuery: viewer.canQuery };
}

// --- session and tenancy -----------------------------------------------------

/**
 * The one request the console makes at boot.
 *
 * It decides which organizations are rendered and whether the Trust & Safety
 * navigation exists at all. Its `staffRoles` are a courtesy for the interface and
 * never the boundary: every Trust & Safety route checks its own role, so a client
 * that ignored this list and called anyway is refused by the route.
 */
export function useConsoleSession(): UseQueryResult<ConsoleSession, Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<ConsoleSession, Error>({
    queryKey: consoleQueryKeys.session(key),
    queryFn: async () => ingest(await getSession(), projectSession, 'session'),
    enabled: canQuery,
    retry: consoleQueryRetry,
  });
}

export function useOrganizations(): UseQueryResult<OrganizationSummary[], Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<OrganizationSummary[], Error>({
    queryKey: consoleQueryKeys.organizations(key),
    queryFn: async () => ingest(await getOrganizations(), projectOrganizations, 'organizations'),
    enabled: canQuery,
    retry: consoleQueryRetry,
  });
}

export function useCreateOrganization(): UseMutationResult<
  CreatedOrganization,
  Error,
  CreateOrganizationInput
> {
  const queryClient = useQueryClient();
  const { key } = useViewerKey();
  return useMutation({
    mutationFn: async (input) =>
      ingest(await postOrganization(input), projectCreatedOrganization, 'createOrganization'),
    onSuccess: () => {
      // The new organization changes the list AND the session's memberships — the
      // creator becomes its owner in the same request, and the rail reads that
      // list. Invalidating only the list would leave the switcher one behind.
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.organizations(key) });
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.session(key) });
    },
  });
}

export function useOrganizationMembers(
  organizationId: string | null,
): UseQueryResult<OrganizationMember[], Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<OrganizationMember[], Error>({
    queryKey: consoleQueryKeys.members(key, organizationId ?? ''),
    queryFn: async () => ingest(await getMembers(organizationId ?? ''), projectMembers, 'members'),
    enabled: canQuery && organizationId !== null,
    retry: consoleQueryRetry,
  });
}

/**
 * Grants a seat, or changes an existing one.
 *
 * The API treats a repeat POST for the same account as a role CHANGE (and revives
 * a revoked seat), which is why this one mutation covers both and the screen does
 * not offer a separate "change role" call that would need its own endpoint.
 */
export function useGrantMember(
  organizationId: string,
): UseMutationResult<void, Error, GrantMemberInput> {
  const queryClient = useQueryClient();
  const { key } = useViewerKey();
  return useMutation({
    mutationFn: async (input) => {
      await postMember(organizationId, input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.members(key, organizationId) });
      // A seat granted to the signed-in account changes their own memberships.
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.session(key) });
    },
  });
}

export function useRevokeMember(
  organizationId: string,
): UseMutationResult<void, Error, { oxyUserId: string }> {
  const queryClient = useQueryClient();
  const { key } = useViewerKey();
  return useMutation({
    mutationFn: async ({ oxyUserId }) => {
      await postMemberRevoke(organizationId, oxyUserId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.members(key, organizationId) });
      // Revoking your OWN seat removes the organization from the rail.
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.session(key) });
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.organizations(key) });
    },
  });
}

export function useApplications(
  organizationId: string | null,
): UseQueryResult<ApplicationSummary[], Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<ApplicationSummary[], Error>({
    queryKey: consoleQueryKeys.applications(key, organizationId ?? ''),
    queryFn: async () =>
      ingest(await getApplications(organizationId ?? ''), projectApplications, 'applications'),
    enabled: canQuery && organizationId !== null,
    retry: consoleQueryRetry,
  });
}

export function useCreateApplication(
  organizationId: string,
): UseMutationResult<CreatedApplication, Error, { name: string }> {
  const queryClient = useQueryClient();
  const { key } = useViewerKey();
  return useMutation({
    mutationFn: async (input) =>
      ingest(await postApplication(organizationId, input), projectCreatedApplication, 'createApp'),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: consoleQueryKeys.applications(key, organizationId),
      });
      // `applicationCount` on the organization row moved.
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.organizations(key) });
    },
  });
}

export function useApplication(
  applicationId: string | null,
): UseQueryResult<ApplicationDetail, Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<ApplicationDetail, Error>({
    queryKey: consoleQueryKeys.application(key, applicationId ?? ''),
    queryFn: async () =>
      ingest(await getApplication(applicationId ?? ''), projectApplicationDetail, 'application'),
    enabled: canQuery && applicationId !== null,
    retry: consoleQueryRetry,
  });
}

// --- credentials -------------------------------------------------------------

export function useCredentials(
  applicationId: string | null,
): UseQueryResult<ServiceCredential[], Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<ServiceCredential[], Error>({
    queryKey: consoleQueryKeys.credentials(key, applicationId ?? ''),
    queryFn: async () =>
      ingest(await getCredentials(applicationId ?? ''), projectCredentials, 'credentials'),
    enabled: canQuery && applicationId !== null,
    retry: consoleQueryRetry,
  });
}

/**
 * Issues a credential.
 *
 * The result carries the only copy of the token that will ever exist, so it is
 * returned to the CALLER and never written to the cache — a cached one-time secret
 * is a secret that reappears when a screen remounts. The screen holds it in
 * component state, shows it once and drops it.
 */
export function useIssueCredential(
  applicationId: string,
): UseMutationResult<IssuedCredential, Error, IssueCredentialInput> {
  const queryClient = useQueryClient();
  const { key } = useViewerKey();
  return useMutation({
    mutationFn: async (input) =>
      ingest(await postCredential(applicationId, input), projectIssuedCredential, 'issue'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.credentials(key, applicationId) });
    },
  });
}

export function useRevokeCredential(
  applicationId: string,
): UseMutationResult<void, Error, { credentialId: string }> {
  const queryClient = useQueryClient();
  const { key } = useViewerKey();
  return useMutation({
    mutationFn: async ({ credentialId }) => {
      await postCredentialRevoke(applicationId, credentialId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.credentials(key, applicationId) });
    },
  });
}

// --- webhooks ----------------------------------------------------------------

export function useWebhookEndpoints(
  applicationId: string | null,
): UseQueryResult<WebhookEndpoint[], Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<WebhookEndpoint[], Error>({
    queryKey: consoleQueryKeys.webhookEndpoints(key, applicationId ?? ''),
    queryFn: async () =>
      ingest(
        await getWebhookEndpoints(applicationId ?? ''),
        projectWebhookEndpoints,
        'webhookEndpoints',
      ),
    enabled: canQuery && applicationId !== null,
    retry: consoleQueryRetry,
  });
}

/**
 * Rotates an endpoint's signing secret.
 *
 * Same one-time-secret handling as an issued credential: the value goes to the
 * caller, not the cache. The endpoint list is invalidated because the rotation
 * moves `updatedAt` and, on an endpoint that was disabled for signature failures,
 * its status.
 */
export function useRotateSecret(
  applicationId: string,
): UseMutationResult<
  RotatedSecret,
  Error,
  { webhookEndpointId: string; overlapSeconds: number }
> {
  const queryClient = useQueryClient();
  const { key } = useViewerKey();
  return useMutation({
    mutationFn: async ({ webhookEndpointId, overlapSeconds }) =>
      ingest(
        await postSecretRotation(applicationId, webhookEndpointId, { overlapSeconds }),
        projectRotatedSecret,
        'rotateSecret',
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: consoleQueryKeys.webhookEndpoints(key, applicationId),
      });
    },
  });
}

export function useDeliveries(
  applicationId: string | null,
  filters: { status?: string; webhookEndpointId?: string },
): UseQueryResult<WebhookDelivery[], Error> {
  const { key, canQuery } = useViewerKey();
  // The filter is part of the key because the server applies it. A shared key
  // would serve a cached unfiltered page as a dead-letter view.
  const filterKey = `${filters.status ?? 'all'}|${filters.webhookEndpointId ?? 'all'}`;
  return useQuery<WebhookDelivery[], Error>({
    queryKey: consoleQueryKeys.deliveries(key, applicationId ?? '', filterKey),
    queryFn: async () =>
      ingest(await getDeliveries(applicationId ?? '', filters), projectDeliveries, 'deliveries'),
    enabled: canQuery && applicationId !== null,
    retry: consoleQueryRetry,
  });
}

/**
 * §10.9's manual replay.
 *
 * Invalidates EVERY delivery filter of this application, not just the one on
 * screen: a replayed delivery leaves `dead_letter` and enters `pending`, so the
 * view it came from and the view it went to both changed. The endpoint list moves
 * too — its health counts are derived from these rows.
 */
export function useReplayDelivery(
  applicationId: string,
): UseMutationResult<WebhookDelivery, Error, { deliveryId: string }> {
  const queryClient = useQueryClient();
  const { key } = useViewerKey();
  return useMutation({
    mutationFn: async ({ deliveryId }) =>
      ingest(await postDeliveryReplay(applicationId, deliveryId), projectDelivery, 'replay'),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: consoleQueryKeys.allDeliveries(key, applicationId),
      });
      queryClient.invalidateQueries({
        queryKey: consoleQueryKeys.webhookEndpoints(key, applicationId),
      });
      // The cross-tenant queue lists the same row. Harmless when the viewer is
      // not staff: there is no such query in the cache to invalidate.
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.deadLetterQueue(key) });
    },
  });
}

// --- cases, usage, audit -----------------------------------------------------

/**
 * One page of cases.
 *
 * A plain `useQuery` per cursor rather than `useInfiniteQuery`: this is a table
 * with a "next page" control, not a feed, and an operator reading a table wants
 * the page they asked for rather than an ever-growing scroll they cannot get back
 * to the top of. The cursor is component state, so going back is re-rendering the
 * previous key — which is already cached.
 */
export function useCases(
  applicationId: string | null,
  filters: { status?: string; cursor?: string },
): UseQueryResult<CaseListPage, Error> {
  const { key, canQuery } = useViewerKey();
  const filterKey = `${filters.status ?? 'all'}|${filters.cursor ?? 'first'}`;
  return useQuery<CaseListPage, Error>({
    queryKey: consoleQueryKeys.cases(key, applicationId ?? '', filterKey),
    queryFn: async () =>
      ingest(await getCases(applicationId ?? '', filters), projectCasePage, 'cases'),
    enabled: canQuery && applicationId !== null,
    retry: consoleQueryRetry,
  });
}

export function useCaseDetail(
  applicationId: string | null,
  caseId: string | null,
): UseQueryResult<CaseDetail, Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<CaseDetail, Error>({
    queryKey: consoleQueryKeys.caseDetail(key, applicationId ?? '', caseId ?? ''),
    queryFn: async () =>
      ingest(await getCaseDetail(applicationId ?? '', caseId ?? ''), projectCaseDetail, 'case'),
    enabled: canQuery && applicationId !== null && caseId !== null,
    retry: consoleQueryRetry,
  });
}

export function useUsage(
  applicationId: string | null,
  windowDays: number,
): UseQueryResult<UsageSummary, Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<UsageSummary, Error>({
    queryKey: consoleQueryKeys.usage(key, applicationId ?? '', windowDays),
    queryFn: async () =>
      ingest(await getUsage(applicationId ?? '', windowDays), projectUsage, 'usage'),
    enabled: canQuery && applicationId !== null,
    retry: consoleQueryRetry,
  });
}

export function useAuditTrail(
  applicationId: string | null,
  filters: { caseId?: string },
): UseQueryResult<AuditEvent[], Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<AuditEvent[], Error>({
    queryKey: consoleQueryKeys.audit(key, applicationId ?? ''),
    queryFn: async () =>
      ingest(await getAudit(applicationId ?? '', filters), projectAuditEvents, 'audit'),
    enabled: canQuery && applicationId !== null,
    retry: consoleQueryRetry,
  });
}

// --- Trust & Safety ----------------------------------------------------------

export function useTrustSafetyApplications(filters: {
  standing?: string;
}): UseQueryResult<TrustSafetyApplication[], Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<TrustSafetyApplication[], Error>({
    queryKey: consoleQueryKeys.trustSafetyApplications(key, filters.standing ?? 'all'),
    queryFn: async () =>
      ingest(
        await getTrustSafetyApplications(filters),
        projectTrustSafetyApplications,
        'trustSafetyApplications',
      ),
    enabled: canQuery,
    retry: consoleQueryRetry,
  });
}

/**
 * Moves an application's standing.
 *
 * The returned row is the ANSWER, including whether global reputation effects were
 * actually granted — the server decides that, and a request for them at a standing
 * that forbids them is accepted and simply not honoured. So the row is what the
 * screen reports back, never the values that were sent.
 *
 * The tenant's own view of the same application is invalidated too: a developer
 * looking at their overview while an operator restricts them should see the new
 * standing on their next refetch rather than a stale `trusted`.
 */
export function useSetStanding(): UseMutationResult<
  TrustSafetyApplication,
  Error,
  { applicationId: string; input: SetStandingInput }
> {
  const queryClient = useQueryClient();
  const { key } = useViewerKey();
  return useMutation({
    mutationFn: async ({ applicationId, input }) =>
      ingest(
        await postStanding(applicationId, input),
        projectTrustSafetyApplication,
        'setStanding',
      ),
    onSuccess: (row) => {
      queryClient.invalidateQueries({
        queryKey: consoleQueryKeys.allTrustSafetyApplications(key),
      });
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.platformMetrics(key) });
      queryClient.invalidateQueries({
        queryKey: consoleQueryKeys.application(key, row.applicationId),
      });
    },
  });
}

export function useDeadLetterQueue(): UseQueryResult<DeadLetteredDelivery[], Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<DeadLetteredDelivery[], Error>({
    queryKey: consoleQueryKeys.deadLetterQueue(key),
    queryFn: async () =>
      ingest(await getDeadLetterQueue(), projectDeadLetterQueue, 'deadLetterQueue'),
    enabled: canQuery,
    retry: consoleQueryRetry,
  });
}

export function usePlatformMetrics(): UseQueryResult<PlatformMetrics, Error> {
  const { key, canQuery } = useViewerKey();
  return useQuery<PlatformMetrics, Error>({
    queryKey: consoleQueryKeys.platformMetrics(key),
    queryFn: async () =>
      ingest(await getPlatformMetrics(), projectPlatformMetrics, 'platformMetrics'),
    enabled: canQuery,
    retry: consoleQueryRetry,
  });
}
