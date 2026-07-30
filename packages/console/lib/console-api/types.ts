/**
 * Console API data shapes, as this app consumes them (PLAN §4.2, §4.3).
 *
 * Two rules govern this file.
 *
 * **The vocabularies are the server's, copied deliberately.** The status,
 * standing, scope and outcome lists below are `const` arrays rather than bare
 * `type` unions because `projections.ts` needs them at RUNTIME to reject a value
 * it does not recognise. They are copies, so
 * `__tests__/vocabularies.test.ts` reads the backend and the contracts package
 * and asserts each one is still equal — a new case status shipping server-side
 * shows up as a failing test here rather than as a filter chip that 400s.
 * Importing the contracts package at runtime instead would pull Zod into a web
 * bundle to obtain a string array.
 *
 * **What is absent is the design.** There is no reviewer id, no juror record, no
 * reporter fingerprint and no resource payload anywhere in these types, because
 * there is nowhere for a screen to read one from. The backend's
 * `caseExplorer.service.ts` states the reasoning per field;
 * `projections.ts` is the enforcement.
 */

/** Organization seats, most capable first. */
export const CONSOLE_ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type ConsoleRole = (typeof CONSOLE_ROLES)[number];

/** Trust & Safety staff roles. Holding none means the surface does not exist. */
export const STAFF_ROLES = ['policy', 'appeals', 'evidence', 'security'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ORGANIZATION_STATUSES = ['active', 'suspended'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/**
 * An application's own status, distinct from its trust STANDING.
 *
 * Suspension stops the application entirely; standing decides what a running one may
 * do. The two are frequently confused, which is why the overview shows both and labels
 * them separately.
 */
export const APPLICATION_STATUSES = ['active', 'suspended'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const MEMBER_STATUSES = ['active', 'revoked'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const APPLICATION_STANDINGS = ['sandbox', 'trusted', 'restricted'] as const;
export type ApplicationStanding = (typeof APPLICATION_STANDINGS)[number];

/**
 * Why standing was last moved — a closed vocabulary, never free text.
 *
 * The console offers exactly these when an operator changes a standing, and the
 * reason it cannot offer a text box is the same reason the server refuses one:
 * the value is kept indefinitely and shown on an operator screen, and a free
 * field next to a case is where a fragment of reported material eventually lands.
 */
export const STANDING_REASONS = [
  'initial',
  'promotion_review_passed',
  'evidence_integrity_failed',
  'high_overturn_rate',
  'suspected_abuse',
  'investigation_closed',
] as const;
export type StandingReason = (typeof STANDING_REASONS)[number];

/** The scopes a tenant may grant itself. Privileged scopes are not among them. */
export const APPLICATION_SCOPES = [
  'crowdsource:reports:write',
  'crowdsource:reports:read',
  'crowdsource:cases:read',
  'crowdsource:appeals:write',
  'crowdsource:enforcement:write',
  'crowdsource:webhooks:manage',
  'crowdsource:policies:manage',
  'crowdsource:schemas:manage',
] as const;
export type ApplicationScope = (typeof APPLICATION_SCOPES)[number];

export const CREDENTIAL_STATUSES = ['active', 'revoked'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const WEBHOOK_ENDPOINT_STATUSES = ['active', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

/** Why an endpoint was disabled: the receiver said 410, or an operator did it. */
export const WEBHOOK_DISABLED_REASONS = ['gone', 'operator'] as const;
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];

export const DELIVERY_STATUSES = ['pending', 'delivering', 'succeeded', 'dead_letter'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** §3.2 case states. */
export const CASE_STATUSES = [
  'received',
  'triaged',
  'awaiting_review',
  'under_review',
  'awaiting_consensus',
  'decided',
  'escalated',
  'appealed',
  'superseded',
  'closed',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const DECISION_STATUSES = ['provisional', 'final', 'superseded', 'corrected'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/**
 * §9.6 outcomes.
 *
 * `inconclusive` is its own outcome. A jury that reviewed the case and did not
 * reach the threshold has said something different from a jury that agreed
 * nothing was wrong, and no code in this app maps one to the other — not in a
 * type, not in a label and not in a colour (see `presentation.ts`).
 */
export const DECISION_OUTCOMES = [
  'violation',
  'no_violation',
  'insufficient_context',
  'inconclusive',
  'content_unavailable',
  'duplicate',
  'escalated',
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const CONTEXT_SUFFICIENCIES = ['sufficient', 'insufficient'] as const;
export type ContextSufficiency = (typeof CONTEXT_SUFFICIENCIES)[number];

// --- session and tenancy -----------------------------------------------------

export interface ConsoleMembership {
  organizationId: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  role: ConsoleRole;
}

export interface ConsoleSession {
  /**
   * The signed-in Oxy account.
   *
   * This is the ONE identity the console displays, and it is the viewer's own —
   * not a reviewer's, not a reporter's. It is also what every cache key is
   * scoped to, so an account switch cannot leave one tenant's data on screen for
   * the next person.
   */
  oxyUserId: string;
  memberships: ConsoleMembership[];
  /** Empty for every account that is not Trust & Safety staff. */
  staffRoles: StaffRole[];
}

export interface OrganizationSummary extends ConsoleMembership {
  applicationCount: number;
}

export interface CreatedOrganization {
  organizationId: string;
  name: string;
  slug: string;
  role: ConsoleRole;
}

export interface OrganizationMember {
  oxyUserId: string;
  role: ConsoleRole;
  status: MemberStatus;
  /** Who granted the seat, or null for a seat that predates the record. */
  invitedByOxyUserId: string | null;
  createdAt: string;
}

export interface ApplicationSummary {
  applicationId: string;
  name: string;
  status: ApplicationStatus;
  standing: ApplicationStanding;
  globalReputationEffectsAllowed: boolean;
  createdAt: string;
}

export interface CreatedApplication {
  applicationId: string;
  name: string;
  status: ApplicationStatus;
  standing: ApplicationStanding;
}

/**
 * §11.13's trust signals.
 *
 * The three quality figures are `null` because nothing measures them yet. They
 * are NOT zero, and the difference matters: zero is the worst possible score and
 * absent is no score at all. Every screen renders an absent value as absent.
 */
export interface ApplicationTrust {
  standing: ApplicationStanding;
  globalReputationEffectsAllowed: boolean;
  evidenceIntegrity: number | null;
  identityBindingReliability: number | null;
  policyQuality: number | null;
  lastStandingReason: string;
  standingChangedAt: string | null;
  updatedAt: string;
}

export interface ApplicationQuota {
  reportsPerDay: number;
  webhookEndpoints: number;
  globalReputationEffects: boolean;
}

export interface ApplicationDetail {
  applicationId: string;
  organizationId: string;
  name: string;
  status: ApplicationStatus;
  createdAt: string;
  /** The viewer's seat in the owning organization — what gates every write. */
  role: ConsoleRole;
  trust: ApplicationTrust;
  quota: ApplicationQuota;
}

// --- credentials -------------------------------------------------------------

export interface ServiceCredential {
  credentialId: string;
  scopes: string[];
  status: CredentialStatus;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * A freshly issued credential — the ONE response that carries a token.
 *
 * Only its SHA-256 is stored, so nothing, including the service itself, can
 * serve `token` again. It is never written to a cache, never persisted and never
 * logged; the screen holds it in component state for the sitting and drops it.
 */
export interface IssuedCredential {
  credentialId: string;
  scopes: string[];
  token: string;
  createdAt: string;
}

// --- webhooks ----------------------------------------------------------------

export interface WebhookHealth {
  pending: number;
  delivering: number;
  succeeded: number;
  deadLetter: number;
}

export interface WebhookEndpoint {
  webhookEndpointId: string;
  url: string;
  eventTypes: string[];
  status: WebhookEndpointStatus;
  disabledReason: WebhookDisabledReason | null;
  createdAt: string;
  updatedAt: string;
  health: WebhookHealth;
}

/**
 * The result of a rotation.
 *
 * `signingStartsAt` is when deliveries begin carrying the new signature, and it
 * is surfaced rather than summarised because it is what makes the overlap a
 * procedure an integrator can follow instead of a race they have to guess at.
 */
export interface RotatedSecret {
  webhookEndpointId: string;
  secret: {
    version: number;
    /** Shown once. Never re-served, never cached. */
    value: string;
    signingStartsAt: string;
  };
  previousSecret: {
    version: number;
    expiresAt: string;
  } | null;
}

export interface WebhookDelivery {
  deliveryId: string;
  webhookEndpointId: string;
  eventId: string;
  eventType: string;
  status: DeliveryStatus;
  attemptCount: number;
  cycleAttemptCount: number;
  lastResponseStatus: number | null;
  deadLetterReason: string | null;
  nextAttemptAt: string | null;
  succeededAt: string | null;
  deadLetteredAt: string | null;
  replayCount: number;
  createdAt: string;
  updatedAt: string;
}

// --- cases and decisions -----------------------------------------------------

export interface CaseListEntry {
  caseId: string;
  status: CaseStatus;
  subject: { externalId: string; type: string };
  policyVersion: string;
  allegationCodes: string[];
  /** A count. Never the fingerprints it was counted from. */
  reportCount: number;
  sensitivityClass: string | null;
  currentRevision: number;
  decidedRevision: number;
  outcome: DecisionOutcome | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseListPage {
  cases: CaseListEntry[];
  nextCursor: string | null;
}

/** Resource METADATA. The payload never leaves the server. */
export interface CaseResourceMetadata {
  id: string;
  type: string;
  role: string;
  language: string | null;
  /** The digest an integrator reconciles against their own record. */
  sha256: string | null;
}

export interface CaseReportLink {
  reportId: string;
  externalReportId: string;
  allegationCodes: string[];
  merged: boolean;
  linkedAt: string;
}

export interface DecisionFinding {
  code: string;
  resourceIds: string[];
  severity: string;
  scope: string;
  context: string | null;
  attribution: string | null;
  policyRuleIds: string[];
}

export interface DecisionRecommendedAction {
  action: string;
  targetResourceIds: string[];
}

/**
 * The panel that produced a decision, in aggregate.
 *
 * Size, decisive votes, winning votes and agreement are published by the
 * application API and by §10.7's webhook envelope, so they appear here too. What
 * cannot appear is any per-juror record: there is no field for one, and the
 * server never sends one.
 */
export interface DecisionJury {
  size: number;
  decisiveVotes: number;
  winningVotes: number;
  agreement: number;
  specialistPresent: boolean;
}

export interface DecisionPolicyVersions {
  taxonomy: string;
  application: string;
  oxyConduct: string;
}

export interface CaseDecision {
  id: string;
  caseId: string;
  revision: number;
  status: DecisionStatus;
  outcome: DecisionOutcome;
  contextSufficiency: ContextSufficiency;
  confidence: number;
  findings: DecisionFinding[];
  recommendedActions: DecisionRecommendedAction[];
  jury: DecisionJury;
  policyVersions: DecisionPolicyVersions;
  /** null on the first revision, which supersedes nothing. */
  supersedesDecisionId: string | null;
  publishedAt: string;
}

export interface CaseDetail {
  caseId: string;
  status: CaseStatus;
  subject: { externalId: string; type: string; primaryResourceId: string };
  policy: { policySetId: string; version: string };
  taxonomyVersion: string;
  allegationCodes: string[];
  reportCount: number;
  sensitivityClass: string | null;
  currentRevision: number;
  resources: CaseResourceMetadata[];
  reports: CaseReportLink[];
  /** §9.9's full history, oldest revision first. A decision is never edited. */
  decisions: CaseDecision[];
  createdAt: string;
  updatedAt: string;
}

// --- usage and audit ---------------------------------------------------------

export interface UsageSummary {
  window: { from: string; to: string; days: number };
  counts: {
    reportsReceived: number;
    casesCreated: number;
    decisionsPublished: number;
  };
  /** Newest day first, as served. */
  daily: { day: string; reportsReceived: number }[];
  quota: ApplicationQuota;
  atDailyLimit: boolean;
}

export interface AuditEvent {
  auditId: string;
  action: string;
  /** Which credential acted, or null for an event with no credential actor. */
  actorCredentialId: string | null;
  reportId: string | null;
  caseId: string | null;
  externalReportId: string | null;
  reason: string | null;
  occurredAt: string;
}

// --- Trust & Safety ----------------------------------------------------------

export interface TrustSafetyApplication {
  applicationId: string;
  organizationId: string;
  organizationName: string | null;
  applicationName: string | null;
  standing: ApplicationStanding;
  globalReputationEffectsAllowed: boolean;
  evidenceIntegrity: number | null;
  identityBindingReliability: number | null;
  policyQuality: number | null;
  lastStandingReason: string;
  standingChangedAt: string | null;
  /** The operator who last moved it. Staff-visible, never tenant-visible. */
  standingChangedByOxyUserId: string | null;
  updatedAt: string;
}

export interface DeadLetteredDelivery {
  deliveryId: string;
  organizationId: string;
  applicationId: string;
  webhookEndpointId: string;
  eventId: string;
  eventType: string;
  attemptCount: number;
  lastResponseStatus: number | null;
  deadLetterReason: string | null;
  deadLetteredAt: string | null;
  replayCount: number;
}

export interface PlatformMetrics {
  applicationsByStanding: Record<ApplicationStanding, number>;
  deliveries: {
    pending: number;
    delivering: number;
    succeeded: number;
    deadLetter: number;
    /** null — not zero — when nothing has been attempted. */
    successRate: number | null;
  };
  /**
   * The §16.4 metrics this deployment cannot compute yet.
   *
   * Rendered as an explicit list of unavailable figures. Hiding it, or showing
   * those metrics as zero, is the exact failure the field exists to prevent.
   */
  unavailable: string[];
}

// --- request bodies ----------------------------------------------------------

export interface CreateOrganizationInput {
  name: string;
  slug: string;
}

export interface GrantMemberInput {
  oxyUserId: string;
  role: ConsoleRole;
}

export interface IssueCredentialInput {
  scopes: ApplicationScope[];
  expiresInDays?: number;
}

export interface SetStandingInput {
  standing: ApplicationStanding;
  reason: StandingReason;
  /**
   * A REQUEST, not a grant. Asking for effects at a standing that forbids them
   * is accepted and simply not granted — the server decides, and the row it
   * returns is the answer.
   */
  globalReputationEffectsAllowed?: boolean;
}

/**
 * An organization slug, as the server validates it.
 *
 * Checked client-side so a typo is a message under the field rather than a 400
 * from a request that already told the server a name. The regex is the server's,
 * and `vocabularies.test.ts` asserts it still matches the one in the API.
 */
export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
