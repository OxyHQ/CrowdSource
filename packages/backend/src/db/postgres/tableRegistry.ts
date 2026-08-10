/**
 * Which tables the database isolates, and which it deliberately does not.
 *
 * This is `defineTenantCollection` / `defineUnscopedCollection` carried across to
 * Postgres, and the reason it is a registry rather than a convention is the
 * defect that preceded it: `collectionBoundary.test.ts` could not see `Decision`
 * or `Appeal` because its module list was maintained by hand, so two of the most
 * consequential collections in the system sat outside the gate while every test
 * passed.
 *
 * So membership here is TOTAL. `postgresTableBoundary.realdb.test.ts` enumerates
 * the schema directory from the filesystem and fails the build for any table that
 * is in NEITHER list, and for any table in BOTH. Absence is a decision somebody
 * has to make, never a default — a new table cannot become unscoped by nobody
 * noticing it.
 */

/**
 * Tenant-owned. Every one of these carries `organization_id` + `application_id`,
 * row-level security ENABLED and FORCED, a `tenant_isolation` policy naming both
 * runtime parameters, and a `migrator_full_access` policy.
 */
export const TENANT_SCOPED_TABLES = [
  'appeals',
  'audit_events',
  'case_reports',
  'cases',
  'decisions',
  'policy_sets',
  'reports',
  'usage_counters',
  'webhook_attempts',
  'webhook_endpoints',
  'webhook_secrets',
] as const;

/**
 * Which tenant columns a table carries, as a claim the live catalogue can refuse.
 *
 * This is separate from the exemption KIND below, and the separation is the
 * point. A kind is a REASON — why no policy predicate is correct — and two tables
 * can share a reason while carrying different columns. Folding the shape into the
 * kind would force one of two bad outcomes: a kind per shape, which stops being a
 * reason and becomes a restatement of the schema; or a shape literal that is
 * false for some member. Declared separately, each entry states the truth twice
 * and the gate checks the half a database can see.
 */
export const TENANT_COLUMN_SHAPES = [
  /** Both `organization_id` and `application_id`, both `NOT NULL`. */
  'both_not_null',
  /** `organization_id` only; no `application_id` column exists. */
  'organization_only',
  /** `application_id` only and `NOT NULL`; no `organization_id` column exists. */
  'application_only',
  /** `application_id` only and NULLABLE; no `organization_id` column exists. */
  'application_nullable',
  /** Neither column exists. */
  'neither',
] as const;

export type TenantColumnShape = (typeof TENANT_COLUMN_SHAPES)[number];

/**
 * Why a table carries no tenant policy.
 *
 * A discriminated union rather than a sentence, because the string this replaced
 * could not be contradicted by anything. Prose stating "this has no tenant
 * dimension" reads identically whether or not the table carries the two columns,
 * so a misclassification survives indefinitely — and, worse, a table that HAS the
 * columns reads to the next auditor as one that SHOULD have had a policy. A kind
 * that implies a checkable shape turns that into a build failure.
 *
 * The four kinds are the four genuinely different reasons a policy would be
 * wrong, and they are not interchangeable: three of them describe tables that DO
 * carry tenant columns, and each would break something different if a policy
 * keyed on the two runtime parameters were added.
 */
export type UnscopedReason =
  /**
   * Reading the row is what PRODUCES a `TenantContext`, so a policy keyed on the
   * runtime parameters would be CIRCULAR — the parameters cannot be set until
   * after the very read that would be filtered by them.
   *
   * Read off the call sites rather than assumed: `credential.service.ts:106`
   * resolves a presented credential with `findOne({ credentialId })` and no tenant
   * term at all, and `membership.service.ts:83` finds which organizations a person
   * belongs to with `find({ oxyUserId, status: 'active' })`. Each read is what
   * yields the tenant. A policy on these tables would leave the service unable to
   * authenticate anybody.
   */
  | { kind: 'defines_the_tenant'; shape: TenantColumnShape; why: string; readers: readonly string[] }
  /**
   * The row has no tenant dimension at all. A reviewer is a person drawn across
   * every application; a staff member acts across every tenant; a co-service pair
   * spans every panel its two members have sat on.
   *
   * The shape is pinned to a literal, so a table filed here that actually carries
   * a tenant column is unrepresentable in the type.
   */
  | { kind: 'no_tenant_dimension'; shape: 'neither'; why: string; readers: readonly string[] }
  /**
   * The row IS tenant-owned and carries both keys, stamped from its parent inside
   * the parent's own transaction — but the only caller that reads it holds an Oxy
   * session, which carries no tenant to scope by.
   *
   * The exemption is therefore about the READER, not the row, and this is the kind
   * most at risk of being "fixed" later: the data is tenant-attributed and
   * correct, so a policy looks obviously missing. It is not. A policy keyed on the
   * two runtime parameters would make these tables unreadable by their only
   * reader, because that reader can never set them.
   *
   * Shape pinned to a literal: a table filed here that does not carry both
   * columns `NOT NULL` cannot be expressed.
   */
  | { kind: 'tenant_stamped_reached_through_parent'; shape: 'both_not_null'; why: string; readers: readonly string[] }
  /**
   * The row NAMES a tenant without BELONGING to one. The tenant is an attribute of
   * the fact recorded rather than its owner, so no predicate is right: filtering
   * would hide rows from the only readers that need them, and the rows are not any
   * customer's data to isolate in the first place.
   *
   * Deliberately NOT phrased as "read across tenants by design". That would be a
   * claim about a READER, and `staff_audit_events` has no reader in production
   * code today — the sole call site is the append in `staffAudit.collection.ts`,
   * and the only reads live in an integration test. A kind asserting a
   * cross-tenant reader would be false for it now and would silently become true
   * later, which is exactly the sort of statement nobody goes back to check. A
   * property of the ROW stays true either way.
   */
  | { kind: 'tenant_attributed_not_tenant_owned'; shape: TenantColumnShape; why: string; readers: readonly string[] };

/**
 * Exempt, each with the kind of exemption, the tenant columns it claims to carry,
 * and the reason in prose.
 *
 * The gate asserts all three: that the kind is one of the four, that the declared
 * shape matches `information_schema.columns` on a live server, and that the reason
 * is a real sentence.
 *
 * What it CANNOT check is the reader claim — that a tenantless caller is genuinely
 * the only one — which is carried by `why` and by the call sites cited in it, and
 * is human-checkable only. Stating that limit here is deliberate: a gate believed
 * to check more than it does is worse than one whose boundary is written down.
 */
export const UNSCOPED_TABLES: Readonly<Record<string, UnscopedReason>> = {
  // ── defines_the_tenant ────────────────────────────────────────────────────
  organizations: {
    kind: 'defines_the_tenant',
    shape: 'organization_only',
    why: 'An organization IS the tenant root; there is no wider tenant to scope it by, and the row carries no application at all.',
    readers: [
      'src/modules/console/membership.service.ts#assertOrganizationUsable',
      'src/modules/console/membership.service.ts#grantMembership',
      'src/modules/console/membership.service.ts#membershipsWithOrganizations',
      'src/modules/console/trustSafety.routes.ts#namesFor',
      'src/modules/tenancy/provisioning.service.ts#createApplication',
      'src/modules/tenancy/provisioning.service.ts#createOrganization',
      'src/modules/tenancy/provisioning.service.ts#setOrganizationStatus',
    ],
  },
  applications: {
    kind: 'defines_the_tenant',
    shape: 'both_not_null',
    why: 'Credential resolution reads an application before any tenant context exists; its own id is half of every other table’s tenant key.',
    readers: [
      'src/modules/console/console.routes.ts#pathOrganizationId',
      'src/modules/console/membership.service.ts#resolveApplicationForMember',
      'src/modules/console/trustSafety.routes.ts#namesFor',
      'src/modules/tenancy/credential.service.ts#authenticateServiceCredential',
      'src/modules/tenancy/provisioning.service.ts#createApplication',
      'src/modules/tenancy/provisioning.service.ts#issueApplicationCredential',
      'src/modules/tenancy/provisioning.service.ts#setApplicationStatus',
    ],
  },
  application_credentials: {
    kind: 'defines_the_tenant',
    shape: 'both_not_null',
    why: 'A presented credential is looked up by its own id (credential.service.ts:106, no tenant term), and that read is what yields the tenant.',
    readers: [
      'src/modules/tenancy/credential.service.ts#authenticateServiceCredential',
      'src/modules/tenancy/provisioning.service.ts#issueApplicationCredential',
      'src/modules/tenancy/provisioning.service.ts#listApplicationCredentials',
      'src/modules/tenancy/provisioning.service.ts#revokeCredential',
    ],
  },
  organization_members: {
    kind: 'defines_the_tenant',
    shape: 'organization_only',
    why: 'A membership row ESTABLISHES the tenant for a console session (membership.service.ts:83 reads by oxyUserId), so a filter by the tenant it derives would be circular.',
    readers: [
      'src/modules/console/membership.service.ts#grantMembership',
      'src/modules/console/membership.service.ts#membersOf',
      'src/modules/console/membership.service.ts#membershipsOf',
      'src/modules/console/membership.service.ts#requireMembership',
      'src/modules/console/membership.service.ts#resolveApplicationForMember',
      'src/modules/console/membership.service.ts#revokeMembership',
    ],
  },

  // ── no_tenant_dimension ───────────────────────────────────────────────────
  trust_safety_staff: {
    kind: 'no_tenant_dimension',
    shape: 'neither',
    why: 'Trust & Safety staff act ACROSS every tenant by definition (§4.3); the row grants authority rather than belonging to a customer.',
    readers: [
      'src/modules/console/consoleAuth.ts#requireStaffRole',
      'src/modules/console/consoleAuth.ts#staffRolesOf',
      'src/modules/console/staff.service.ts#grantStaffRoles',
      'src/modules/console/staff.service.ts#revokeStaff',
    ],
  },
  reviewer_profiles: {
    kind: 'no_tenant_dimension',
    shape: 'neither',
    why: 'A reviewer is a person drawn across every application, not data owned by one tenant; profiles carry no tenant keys and are never returned to an application-API caller.',
    readers: [
      'src/modules/consensus/consensus.service.ts#evaluateCase',
      'src/modules/reviewer/reviewer.service.ts#completeTrainingModule',
      'src/modules/reviewer/reviewer.service.ts#ensureReviewerProfile',
      'src/modules/reviewer/reviewer.service.ts#mutateProfile',
      'src/modules/reviewer/reviewer.service.ts#recordSubmittedReview',
      'src/modules/reviewer/reviewer.service.ts#submitCalibration',
      'src/modules/reviewer/reviewer.service.ts#updateReviewerPreferences',
      'src/modules/sortition/candidatePool.ts#sampleCandidates',
      'src/modules/sortition/sortition.service.ts#gatherParties',
      'src/modules/sortition/sortition.service.ts#seatedIncumbents',
    ],
  },
  reviewer_affinities: {
    kind: 'no_tenant_dimension',
    shape: 'neither',
    why: 'Co-service is a property of a PAIR of people across every panel they have sat on, and panels span tenants; the pair has no owning application.',
    readers: [
      'src/modules/sortition/sortition.service.ts#bumpAffinities',
      'src/modules/sortition/sortition.service.ts#gatherAffinity',
    ],
  },

  // ── tenant_stamped_reached_through_parent ─────────────────────────────────
  assignments: {
    kind: 'tenant_stamped_reached_through_parent',
    shape: 'both_not_null',
    why: 'An assignment joins a tenant’s case to a reviewer who belongs to none, and is read by an Oxy session carrying no tenant to scope by (sortition.service.ts:177); rows are stamped from the case inside the draw transaction.',
    readers: [
      'src/modules/consensus/consensus.service.ts#evaluateCase',
      'src/modules/sortition/assignment.service.ts#authorizeAssignment',
      'src/modules/sortition/assignment.service.ts#consumeAssignmentForReview',
      'src/modules/sortition/assignment.service.ts#expireDueAssignments',
      'src/modules/sortition/assignment.service.ts#nextAssignment',
      'src/modules/sortition/assignment.service.ts#openAssignment',
      'src/modules/sortition/assignment.service.ts#recuseAssignment',
      'src/modules/sortition/exposure.ts#exposureRows',
      'src/modules/sortition/sortition.service.ts#gatherParties',
      'src/modules/sortition/sortition.service.ts#openPanel',
      'src/modules/sortition/sortition.service.ts#panelAssignments',
      'src/modules/sortition/sortition.service.ts#replayDraw',
      'src/modules/sortition/sortition.worker.ts#handleAssignmentVacated',
      'src/modules/sortition/sortition.worker.ts#handleCaseReadyForReview',
    ],
  },
  sortition_draws: {
    kind: 'tenant_stamped_reached_through_parent',
    shape: 'both_not_null',
    why: 'A draw records reviewers, who belong to no tenant, alongside the case they were drawn for; it is written by the sortition worker and never returned to an application-API caller.',
    readers: [
      'src/modules/sortition/sortition.service.ts#openPanel',
      'src/modules/sortition/sortition.service.ts#recordRefusal',
      'src/modules/sortition/sortition.service.ts#replayDraw',
    ],
  },
  reviews: {
    kind: 'tenant_stamped_reached_through_parent',
    shape: 'both_not_null',
    why: 'A review joins a tenant’s case to a tenantless reviewer, and §4.1’s history reads a reviewer’s own reviews across every application (reviewHistory.ts:192, no tenant term); rows are stamped from the assignment.',
    readers: [
      'src/modules/consensus/consensus.service.ts#evaluateCase',
      'src/modules/review/review.service.ts#submitReview',
      'src/modules/review/reviewHistory.ts#reviewHistoryPage',
    ],
  },
  outbox_events: {
    kind: 'tenant_stamped_reached_through_parent',
    shape: 'both_not_null',
    why: 'The dispatcher claims and publishes across every tenant (outbox.dispatcher.ts is the sole reader); rows are tenant-stamped on write.',
    readers: [
      'src/modules/outbox/outbox.collection.ts#appendOutboxEvent',
      'src/modules/outbox/outbox.dispatcher.ts#claimNext',
      'src/modules/outbox/outbox.dispatcher.ts#markDispatched',
      'src/modules/outbox/outbox.dispatcher.ts#markFailed',
    ],
  },
  webhook_deliveries: {
    kind: 'tenant_stamped_reached_through_parent',
    shape: 'both_not_null',
    why: 'The delivery worker claims due rows across every tenant (claimDueDelivery matches on status and a deadline only); rows are tenant-stamped on write, and their attempts ARE scoped.',
    readers: [
      'src/modules/webhooks/delivery.service.ts#claimDueDelivery',
      'src/modules/webhooks/delivery.service.ts#deliveryCountsAcrossTenants',
      'src/modules/webhooks/delivery.service.ts#deliveryHealthFor',
      'src/modules/webhooks/delivery.service.ts#findTenantDelivery',
      'src/modules/webhooks/delivery.service.ts#listDeadLetteredDeliveriesAcrossTenants',
      'src/modules/webhooks/delivery.service.ts#listTenantDeliveries',
      'src/modules/webhooks/delivery.service.ts#recordAttempt',
      'src/modules/webhooks/delivery.service.ts#recordDelivery',
      'src/modules/webhooks/delivery.service.ts#replayDeadLetteredDelivery',
    ],
  },

  // ── tenant_attributed_not_tenant_owned ────────────────────────────────────
  staff_audit_events: {
    kind: 'tenant_attributed_not_tenant_owned',
    shape: 'application_nullable',
    why: 'The trail of privileged activity. Its application_id is the application ACTED ON and is nullable; the row is the operator’s act, not a customer’s data, and filing it in tenant-scoped audit_events would force a choice between an incomplete trail and filling every customer’s with operator activity.',
    readers: [
      'src/modules/console/staffAudit.collection.ts#appendStaffAuditEvent',
    ],
  },
  reviewer_relations: {
    kind: 'tenant_attributed_not_tenant_owned',
    shape: 'application_only',
    why: 'A reviewer’s declared conflicts follow the PERSON across every application they may be drawn for; application_id names whose principal id space the conflict is written in, not an owner.',
    readers: [
      'src/modules/reviewer/reviewer.service.ts#declareReviewerRelation',
      'src/modules/sortition/sortition.service.ts#gatherParties',
    ],
  },
  reviewer_principal_links: {
    kind: 'tenant_attributed_not_tenant_owned',
    shape: 'application_only',
    why: 'Which application account a reviewer says is theirs (§8.5 self-exclusion). Extracted from ReviewerProfile.principalLinks because the draw queries into it; the row is a fact about a person and application_id names the id space, not an owner.',
    readers: [
      'src/modules/reviewer/reviewer.service.ts#ensureReviewerProfile',
      'src/modules/reviewer/reviewer.service.ts#signalsOf',
      'src/modules/reviewer/reviewer.service.ts#updateReviewerPreferences',
      'src/modules/sortition/exclusions.ts#exclusionFor',
      'src/modules/sortition/sortition.service.ts#gatherParties',
    ],
  },
  app_trust_snapshots: {
    kind: 'tenant_attributed_not_tenant_owned',
    shape: 'both_not_null',
    why: 'CrowdSource’s own opinion OF an application. Trust & Safety compares standing across every application with no filter (§4.3), and the tenant-serving read re-imposes the pair explicitly in applicationTrustFor rather than relying on a policy.',
    readers: [
      'src/modules/trust/applicationTrust.service.ts#applicationCountsByStanding',
      'src/modules/trust/applicationTrust.service.ts#applicationTrustFor',
      'src/modules/trust/applicationTrust.service.ts#createApplicationTrust',
      'src/modules/trust/applicationTrust.service.ts#listApplicationTrust',
      'src/modules/trust/applicationTrust.service.ts#setApplicationStanding',
    ],
  },
};

/** Every table this service declares, in either category. */
export function declaredTableNames(): readonly string[] {
  return [...TENANT_SCOPED_TABLES, ...Object.keys(UNSCOPED_TABLES)];
}
