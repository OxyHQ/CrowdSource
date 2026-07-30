/**
 * Cache keys for the console.
 *
 * Their own module, with no imports, for two reasons. The identity boundary needs
 * to name the namespace it drops on an account switch but has no business pulling
 * the HTTP client into the provider tree to do it. And keys are the thing most
 * worth testing directly — importing them should not require a runtime that can
 * load the Oxy SDK.
 *
 * Every key carries the viewer it belongs to, and the viewer segment sits SECOND,
 * directly under `all`, because `removeQueries({ queryKey: all })` matches by
 * prefix: a key that did not start with `all` would survive the account switch
 * that was supposed to remove it.
 *
 * Below the viewer, keys are nested so an invalidation can be as narrow or as
 * broad as the mutation actually is. Revoking a credential invalidates
 * `credentials(viewer, applicationId)` and nothing else; changing a standing
 * invalidates the Trust & Safety table AND the tenant's own view of that
 * application, because both read the same row.
 */

export const consoleQueryKeys = {
  all: ['console'] as const,

  session: (viewer: string) => ['console', viewer, 'session'] as const,

  organizations: (viewer: string) => ['console', viewer, 'organizations'] as const,
  members: (viewer: string, organizationId: string) =>
    ['console', viewer, 'organization', organizationId, 'members'] as const,
  applications: (viewer: string, organizationId: string) =>
    ['console', viewer, 'organization', organizationId, 'applications'] as const,

  application: (viewer: string, applicationId: string) =>
    ['console', viewer, 'application', applicationId, 'detail'] as const,
  credentials: (viewer: string, applicationId: string) =>
    ['console', viewer, 'application', applicationId, 'credentials'] as const,
  webhookEndpoints: (viewer: string, applicationId: string) =>
    ['console', viewer, 'application', applicationId, 'webhook-endpoints'] as const,
  /**
   * The delivery table is filtered server-side, so the filter is part of the key.
   * A shared key across filters would show a `dead_letter` view populated from a
   * cached unfiltered fetch — the one misreading §10.9's DLQ cannot afford.
   */
  deliveries: (viewer: string, applicationId: string, filterKey: string) =>
    ['console', viewer, 'application', applicationId, 'deliveries', filterKey] as const,
  /** Prefix for every delivery filter of one application — what a replay drops. */
  allDeliveries: (viewer: string, applicationId: string) =>
    ['console', viewer, 'application', applicationId, 'deliveries'] as const,
  cases: (viewer: string, applicationId: string, statusFilter: string) =>
    ['console', viewer, 'application', applicationId, 'cases', statusFilter] as const,
  caseDetail: (viewer: string, applicationId: string, caseId: string) =>
    ['console', viewer, 'application', applicationId, 'case', caseId] as const,
  usage: (viewer: string, applicationId: string, windowDays: number) =>
    ['console', viewer, 'application', applicationId, 'usage', windowDays] as const,
  audit: (viewer: string, applicationId: string) =>
    ['console', viewer, 'application', applicationId, 'audit'] as const,

  trustSafetyApplications: (viewer: string, standingFilter: string) =>
    ['console', viewer, 'trust-safety', 'applications', standingFilter] as const,
  /** Prefix for every standing filter — what a standing change drops. */
  allTrustSafetyApplications: (viewer: string) =>
    ['console', viewer, 'trust-safety', 'applications'] as const,
  deadLetterQueue: (viewer: string) => ['console', viewer, 'trust-safety', 'dead-letter'] as const,
  platformMetrics: (viewer: string) => ['console', viewer, 'trust-safety', 'metrics'] as const,
};
