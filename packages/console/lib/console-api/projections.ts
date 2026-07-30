/**
 * The privacy boundary, in code.
 *
 * The console's rules about what it may show are a table in `README.md` and a set
 * of paragraphs in the backend's `caseExplorer.service.ts`. A layout that happens
 * not to render a forbidden field is not enforcement: the next screen, the next
 * debugging session or the next `JSON.stringify` puts it back. So a wire payload
 * never enters app state as-is. It is PROJECTED onto this app's own types, field
 * by field, by the functions below — an allowlist, so a field the backend starts
 * sending is dropped by construction rather than by omission.
 *
 * Two layers, doing different jobs:
 *
 *  1. The `project*` functions build each object explicitly. This is the
 *     enforcement. There is no path by which `reviewerId`, `agreeingReviewerIds`,
 *     `reporterFingerprints` or a resource's `data` survives, because nothing
 *     copies them.
 *  2. `scanForForbiddenFields` walks the RAW payload and reports the PATHS of any
 *     field this surface must never show. This is the alarm: a backend that
 *     starts sending juror records is a contract breach that should be visible in
 *     development rather than silently absorbed. It reports paths only — never
 *     values — because those values are the material that must not reach logs.
 *
 * The whole module is import-free apart from types and errors, so the rules can
 * be exercised without a runtime capable of loading the Oxy SDK.
 */

import { MalformedPayloadError } from './errors';
import {
  APPLICATION_STANDINGS,
  APPLICATION_STATUSES,
  CASE_STATUSES,
  CONSOLE_ROLES,
  CONTEXT_SUFFICIENCIES,
  CREDENTIAL_STATUSES,
  DECISION_OUTCOMES,
  DECISION_STATUSES,
  DELIVERY_STATUSES,
  MEMBER_STATUSES,
  ORGANIZATION_STATUSES,
  STAFF_ROLES,
  WEBHOOK_DISABLED_REASONS,
  WEBHOOK_ENDPOINT_STATUSES,
  type ApplicationDetail,
  type ApplicationQuota,
  type ApplicationSummary,
  type ApplicationTrust,
  type AuditEvent,
  type CaseDecision,
  type CaseDetail,
  type CaseListEntry,
  type CaseListPage,
  type CaseReportLink,
  type CaseResourceMetadata,
  type ConsoleMembership,
  type ConsoleSession,
  type CreatedApplication,
  type CreatedOrganization,
  type DeadLetteredDelivery,
  type DecisionFinding,
  type DecisionJury,
  type DecisionPolicyVersions,
  type DecisionRecommendedAction,
  type IssuedCredential,
  type OrganizationMember,
  type OrganizationSummary,
  type PlatformMetrics,
  type RotatedSecret,
  type ServiceCredential,
  type TrustSafetyApplication,
  type UsageSummary,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookHealth,
} from './types';

/**
 * Field names this surface must never receive, one group per rule in `README.md`.
 * Matched case-insensitively against object KEYS at any depth.
 *
 * Written as whole-key patterns rather than substrings so a legitimate field is
 * never caught by accident: `jury` is ALLOWED (the aggregate figures are
 * published by the application API and by §10.7's envelope) while `jurors` is
 * not; `decisiveVotes` is allowed while a bare `votes` is not; `reportCount` is
 * allowed while `reporterFingerprints` is not. A pattern that is too eager gets
 * disabled by whoever trips over it, which would cost the alarm entirely.
 *
 * `oxyUserId` is deliberately absent. It is a CONTRACT field of
 * `GET /v1/console/session`, of an organization member, and of the operator who
 * last moved a standing — the viewer's own identity and the seats they administer,
 * which is the one identity the console exists to manage. What must never appear
 * is a REVIEWER's or a REPORTER's identity, and those have their own patterns
 * below and no field in any projected type.
 */
export const FORBIDDEN_FIELD_PATTERNS: readonly RegExp[] = [
  // A reviewer's identity, in any form, and any count of who sat on a panel.
  /^reviewers?$/i,
  /^reviewer_?(id|ids|oxy_?user_?id|handle|username|name)$/i,
  /^agreeing_?reviewer_?ids$/i,
  /^(jurors|juror_?ids|panel_?members|co_?reviewers|assignees|assigned_?reviewers)$/i,
  // An individual vote or review record.
  /^reviews?$/i,
  /^review_?records?$/i,
  /^(vote|votes|ballot|ballots|tally)$/i,
  /^assignments?$/i,
  // A reporter's identity or their salted fingerprint.
  /^reporters?$/i,
  /^reporter_?(id|ids|fingerprint|fingerprints|handle|username|name|reputation)$/i,
  // Reported content. Metadata and digests are what a developer needs; the
  // payload would make the console a second, longer-lived copy of the most
  // sensitive data in the system.
  /^content_?snapshot$/i,
  /^(data|payload|body|content|text|snapshot|raw)$/i,
  // Internal queue position and pool routing, both of which a tenant could game.
  /^priority(_?score)?$/i,
  /^review_?pool$/i,
  // Cross-application correlation, which would tell one tenant its case is
  // linked to another's.
  /^incident_?id$/i,
  // Stored credential digests. `token` and `secret.value` are NOT here: a
  // one-time secret in its issuing response is the one place either legitimately
  // appears.
  /^(secret_?hash|token_?hash|credential_?hash|password_?hash)$/i,
];

const MAX_SCAN_NODES = 5000;
const MAX_SCAN_DEPTH = 12;

/**
 * Walks a raw payload and returns the dotted PATHS of every field this surface
 * must not show. Values are never read, never returned and never logged.
 *
 * Bounded on both node count and depth: a hostile or merely enormous payload must
 * not be able to spend the main thread here. Truncation is reported as its own
 * path so a silent stop can never read as a clean scan.
 */
export function scanForForbiddenFields(payload: unknown): string[] {
  const found: string[] = [];
  let visited = 0;
  let truncated = false;

  const walk = (node: unknown, path: string, depth: number): void => {
    if (truncated || node === null || typeof node !== 'object') {
      return;
    }
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_NODES) {
      truncated = true;
      return;
    }
    visited += 1;

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
        found.push(childPath);
      }
      walk(value, childPath, depth + 1);
    }
  };

  walk(payload, '', 0);
  if (truncated) {
    found.push('<scan-truncated>');
  }
  return found;
}

// --- typed readers -----------------------------------------------------------
// Deliberately small and explicit. Their only job is to make the projections
// below total: every field is read by name, with a type check, or the payload is
// rejected by path.

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedPayloadError(path || '<root>', 'an object');
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new MalformedPayloadError(`${path}.${key}`, 'a string');
  }
  return value;
}

function readNullableString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MalformedPayloadError(`${path}.${key}`, 'a finite number');
  }
  return value;
}

/**
 * A number that may legitimately be absent.
 *
 * `null` and NOT 0. Every caller of this reader is a figure nothing measures yet
 * (`evidenceIntegrity`, `policyQuality`) or one that has no meaning before the
 * first event (`successRate`), and zero is the worst possible score rather than
 * the absence of one.
 */
function readNullableNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function readArray<T>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  project: (item: Record<string, unknown>, itemPath: string) => T,
): T[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) =>
    project(asRecord(item, `${path}.${key}[${index}]`), `${path}.${key}[${index}]`),
  );
}

/**
 * A value from a closed vocabulary, or a rejection naming the path.
 *
 * Rejecting is the right failure. A status or an outcome this app does not know
 * is one it cannot render truthfully, and the alternative — passing an unknown
 * code through — is how `inconclusive` eventually gets drawn in the same colour
 * as `no_violation`. `__tests__/vocabularies.test.ts` asserts each list still
 * equals the server's, so a new code is a failing test in CI long before it is a
 * rejected payload in a browser.
 */
function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): T {
  const value = source[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new MalformedPayloadError(`${path}.${key}`, `one of ${allowed.join(' | ')}`);
  }
  return value as T;
}

function readNullableEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): T | null {
  return source[key] === null || source[key] === undefined
    ? null
    : readEnum(source, key, path, allowed);
}

// --- session and tenancy -----------------------------------------------------

function projectMembership(source: Record<string, unknown>, path: string): ConsoleMembership {
  return {
    organizationId: readString(source, 'organizationId', path),
    name: readString(source, 'name', path),
    slug: readString(source, 'slug', path),
    status: readEnum(source, 'status', path, ORGANIZATION_STATUSES),
    role: readEnum(source, 'role', path, CONSOLE_ROLES),
  };
}

export function projectSession(payload: unknown): ConsoleSession {
  const source = asRecord(payload, '');
  const path = 'session';
  return {
    oxyUserId: readString(source, 'oxyUserId', path),
    memberships: readArray(source, 'memberships', path, projectMembership),
    // Every element must be a role this app knows: an unrecognised string here
    // would either hide a surface a staff member is entitled to or show one they
    // are not, and both are worse than a rejected payload.
    staffRoles: readStringArray(source, 'staffRoles').map((role, index) =>
      readEnum({ role }, 'role', `${path}.staffRoles[${index}]`, STAFF_ROLES),
    ),
  };
}

export function projectOrganizations(payload: unknown): OrganizationSummary[] {
  const source = asRecord(payload, '');
  return readArray(source, 'organizations', 'organizations', (item, itemPath) => ({
    ...projectMembership(item, itemPath),
    applicationCount: readNumber(item, 'applicationCount', itemPath),
  }));
}

export function projectCreatedOrganization(payload: unknown): CreatedOrganization {
  const source = asRecord(payload, '');
  const path = 'organization';
  return {
    organizationId: readString(source, 'organizationId', path),
    name: readString(source, 'name', path),
    slug: readString(source, 'slug', path),
    role: readEnum(source, 'role', path, CONSOLE_ROLES),
  };
}

function projectMember(source: Record<string, unknown>, path: string): OrganizationMember {
  return {
    oxyUserId: readString(source, 'oxyUserId', path),
    role: readEnum(source, 'role', path, CONSOLE_ROLES),
    status: readEnum(source, 'status', path, MEMBER_STATUSES),
    invitedByOxyUserId: readNullableString(source, 'invitedByOxyUserId'),
    createdAt: readString(source, 'createdAt', path),
  };
}

export function projectMembers(payload: unknown): OrganizationMember[] {
  return readArray(asRecord(payload, ''), 'members', 'members', projectMember);
}

export function projectApplications(payload: unknown): ApplicationSummary[] {
  return readArray(asRecord(payload, ''), 'applications', 'applications', (item, itemPath) => ({
    applicationId: readString(item, 'applicationId', itemPath),
    name: readString(item, 'name', itemPath),
    status: readEnum(item, 'status', itemPath, APPLICATION_STATUSES),
    standing: readEnum(item, 'standing', itemPath, APPLICATION_STANDINGS),
    globalReputationEffectsAllowed: readBoolean(item, 'globalReputationEffectsAllowed'),
    createdAt: readString(item, 'createdAt', itemPath),
  }));
}

export function projectCreatedApplication(payload: unknown): CreatedApplication {
  const source = asRecord(payload, '');
  const path = 'application';
  return {
    applicationId: readString(source, 'applicationId', path),
    name: readString(source, 'name', path),
    status: readEnum(source, 'status', path, APPLICATION_STATUSES),
    standing: readEnum(source, 'standing', path, APPLICATION_STANDINGS),
  };
}

function projectTrust(source: Record<string, unknown>, path: string): ApplicationTrust {
  return {
    standing: readEnum(source, 'standing', path, APPLICATION_STANDINGS),
    globalReputationEffectsAllowed: readBoolean(source, 'globalReputationEffectsAllowed'),
    evidenceIntegrity: readNullableNumber(source, 'evidenceIntegrity'),
    identityBindingReliability: readNullableNumber(source, 'identityBindingReliability'),
    policyQuality: readNullableNumber(source, 'policyQuality'),
    lastStandingReason: readString(source, 'lastStandingReason', path),
    standingChangedAt: readNullableString(source, 'standingChangedAt'),
    updatedAt: readString(source, 'updatedAt', path),
  };
}

function projectQuota(source: Record<string, unknown>, path: string): ApplicationQuota {
  return {
    reportsPerDay: readNumber(source, 'reportsPerDay', path),
    webhookEndpoints: readNumber(source, 'webhookEndpoints', path),
    globalReputationEffects: readBoolean(source, 'globalReputationEffects'),
  };
}

export function projectApplicationDetail(payload: unknown): ApplicationDetail {
  const source = asRecord(payload, '');
  const path = 'application';
  return {
    applicationId: readString(source, 'applicationId', path),
    organizationId: readString(source, 'organizationId', path),
    name: readString(source, 'name', path),
    status: readEnum(source, 'status', path, APPLICATION_STATUSES),
    createdAt: readString(source, 'createdAt', path),
    role: readEnum(source, 'role', path, CONSOLE_ROLES),
    trust: projectTrust(asRecord(source.trust, `${path}.trust`), `${path}.trust`),
    quota: projectQuota(asRecord(source.quota, `${path}.quota`), `${path}.quota`),
  };
}

// --- credentials -------------------------------------------------------------

export function projectCredentials(payload: unknown): ServiceCredential[] {
  return readArray(asRecord(payload, ''), 'credentials', 'credentials', (item, itemPath) => ({
    credentialId: readString(item, 'credentialId', itemPath),
    scopes: readStringArray(item, 'scopes'),
    status: readEnum(item, 'status', itemPath, CREDENTIAL_STATUSES),
    expiresAt: readNullableString(item, 'expiresAt'),
    revokedAt: readNullableString(item, 'revokedAt'),
    createdAt: readString(item, 'createdAt', itemPath),
  }));
}

/**
 * The one projection that copies a secret.
 *
 * `token` exists in this response and nowhere else, ever: only its SHA-256 is
 * stored, so nothing — including the service — can serve it again. The screen
 * holds the result in component state for the sitting and never writes it to the
 * query cache, to storage or to a log.
 */
export function projectIssuedCredential(payload: unknown): IssuedCredential {
  const source = asRecord(payload, '');
  const path = 'credential';
  return {
    credentialId: readString(source, 'credentialId', path),
    scopes: readStringArray(source, 'scopes'),
    token: readString(source, 'token', path),
    createdAt: readString(source, 'createdAt', path),
  };
}

// --- webhooks ----------------------------------------------------------------

function projectHealth(source: Record<string, unknown>, path: string): WebhookHealth {
  return {
    pending: readNumber(source, 'pending', path),
    delivering: readNumber(source, 'delivering', path),
    succeeded: readNumber(source, 'succeeded', path),
    deadLetter: readNumber(source, 'deadLetter', path),
  };
}

export function projectWebhookEndpoints(payload: unknown): WebhookEndpoint[] {
  return readArray(asRecord(payload, ''), 'endpoints', 'endpoints', (item, itemPath) => ({
    webhookEndpointId: readString(item, 'webhookEndpointId', itemPath),
    url: readString(item, 'url', itemPath),
    eventTypes: readStringArray(item, 'eventTypes'),
    status: readEnum(item, 'status', itemPath, WEBHOOK_ENDPOINT_STATUSES),
    disabledReason: readNullableEnum(item, 'disabledReason', itemPath, WEBHOOK_DISABLED_REASONS),
    createdAt: readString(item, 'createdAt', itemPath),
    updatedAt: readString(item, 'updatedAt', itemPath),
    health: projectHealth(asRecord(item.health, `${itemPath}.health`), `${itemPath}.health`),
  }));
}

export function projectRotatedSecret(payload: unknown): RotatedSecret {
  const source = asRecord(payload, '');
  const path = 'rotation';
  const secret = asRecord(source.secret, `${path}.secret`);
  const previous = source.previousSecret;
  return {
    webhookEndpointId: readString(source, 'webhookEndpointId', path),
    secret: {
      version: readNumber(secret, 'version', `${path}.secret`),
      value: readString(secret, 'value', `${path}.secret`),
      signingStartsAt: readString(secret, 'signingStartsAt', `${path}.secret`),
    },
    previousSecret:
      typeof previous === 'object' && previous !== null && !Array.isArray(previous)
        ? {
            version: readNumber(
              previous as Record<string, unknown>,
              'version',
              `${path}.previousSecret`,
            ),
            expiresAt: readString(
              previous as Record<string, unknown>,
              'expiresAt',
              `${path}.previousSecret`,
            ),
          }
        : null,
  };
}

/**
 * A delivery as the console shows it.
 *
 * `body` is absent, and it is the field worth naming: it holds the exact signed
 * bytes of the event. What an integrator debugging a delivery needs is the status,
 * the attempt count and the reason it stopped — and the server already withholds
 * the bytes, so this projection is the second lock rather than the first.
 */
function projectDeliveryRow(source: Record<string, unknown>, path: string): WebhookDelivery {
  return {
    deliveryId: readString(source, 'deliveryId', path),
    webhookEndpointId: readString(source, 'webhookEndpointId', path),
    eventId: readString(source, 'eventId', path),
    eventType: readString(source, 'eventType', path),
    status: readEnum(source, 'status', path, DELIVERY_STATUSES),
    attemptCount: readNumber(source, 'attemptCount', path),
    cycleAttemptCount: readNumber(source, 'cycleAttemptCount', path),
    lastResponseStatus: readNullableNumber(source, 'lastResponseStatus'),
    deadLetterReason: readNullableString(source, 'deadLetterReason'),
    nextAttemptAt: readNullableString(source, 'nextAttemptAt'),
    succeededAt: readNullableString(source, 'succeededAt'),
    deadLetteredAt: readNullableString(source, 'deadLetteredAt'),
    replayCount: readNumber(source, 'replayCount', path),
    createdAt: readString(source, 'createdAt', path),
    updatedAt: readString(source, 'updatedAt', path),
  };
}

export function projectDeliveries(payload: unknown): WebhookDelivery[] {
  return readArray(asRecord(payload, ''), 'deliveries', 'deliveries', projectDeliveryRow);
}

export function projectDelivery(payload: unknown): WebhookDelivery {
  return projectDeliveryRow(asRecord(payload, ''), 'delivery');
}

// --- cases and decisions -----------------------------------------------------

function projectCaseRow(source: Record<string, unknown>, path: string): CaseListEntry {
  const subject = asRecord(source.subject, `${path}.subject`);
  return {
    caseId: readString(source, 'caseId', path),
    status: readEnum(source, 'status', path, CASE_STATUSES),
    subject: {
      externalId: readString(subject, 'externalId', `${path}.subject`),
      type: readString(subject, 'type', `${path}.subject`),
    },
    policyVersion: readString(source, 'policyVersion', path),
    allegationCodes: readStringArray(source, 'allegationCodes'),
    reportCount: readNumber(source, 'reportCount', path),
    sensitivityClass: readNullableString(source, 'sensitivityClass'),
    currentRevision: readNumber(source, 'currentRevision', path),
    decidedRevision: readNumber(source, 'decidedRevision', path),
    outcome: readNullableEnum(source, 'outcome', path, DECISION_OUTCOMES),
    createdAt: readString(source, 'createdAt', path),
    updatedAt: readString(source, 'updatedAt', path),
  };
}

export function projectCasePage(payload: unknown): CaseListPage {
  const source = asRecord(payload, '');
  return {
    cases: readArray(source, 'cases', 'cases', projectCaseRow),
    nextCursor: readNullableString(source, 'nextCursor'),
  };
}

/**
 * Resource METADATA, with the payload absent.
 *
 * An explicit field list and not a delete of `data`: a snapshot resource is a
 * discriminated union whose payload field differs by type, so a blocklist would
 * have to be updated every time the contract gains a resource kind — silently,
 * with the new payload reaching a screen until somebody noticed. A whitelist
 * ships nothing new by default, which is the direction a privacy projection has
 * to fail in.
 */
function projectResource(source: Record<string, unknown>, path: string): CaseResourceMetadata {
  return {
    id: readString(source, 'id', path),
    type: readString(source, 'type', path),
    role: readString(source, 'role', path),
    language: readNullableString(source, 'language'),
    sha256: readNullableString(source, 'sha256'),
  };
}

function projectReportLink(source: Record<string, unknown>, path: string): CaseReportLink {
  return {
    reportId: readString(source, 'reportId', path),
    externalReportId: readString(source, 'externalReportId', path),
    allegationCodes: readStringArray(source, 'allegationCodes'),
    merged: readBoolean(source, 'merged'),
    linkedAt: readString(source, 'linkedAt', path),
  };
}

function projectFinding(source: Record<string, unknown>, path: string): DecisionFinding {
  return {
    code: readString(source, 'code', path),
    resourceIds: readStringArray(source, 'resourceIds'),
    severity: readString(source, 'severity', path),
    scope: readString(source, 'scope', path),
    context: readNullableString(source, 'context'),
    attribution: readNullableString(source, 'attribution'),
    policyRuleIds: readStringArray(source, 'policyRuleIds'),
  };
}

function projectRecommendedAction(
  source: Record<string, unknown>,
  path: string,
): DecisionRecommendedAction {
  return {
    action: readString(source, 'action', path),
    targetResourceIds: readStringArray(source, 'targetResourceIds'),
  };
}

/**
 * The panel, in aggregate only.
 *
 * These five figures are published by the application API and by §10.7's webhook
 * envelope, so an integrator already holds them; showing them is what lets an
 * operator see that a decision was close without learning anything about who was
 * on the panel. There is no field here for a juror, and adding one would require
 * editing this function — which is the reviewable change this shape exists to
 * force.
 */
function projectJury(source: Record<string, unknown>, path: string): DecisionJury {
  return {
    size: readNumber(source, 'size', path),
    decisiveVotes: readNumber(source, 'decisiveVotes', path),
    winningVotes: readNumber(source, 'winningVotes', path),
    agreement: readNumber(source, 'agreement', path),
    specialistPresent: readBoolean(source, 'specialistPresent'),
  };
}

function projectPolicyVersions(
  source: Record<string, unknown>,
  path: string,
): DecisionPolicyVersions {
  return {
    taxonomy: readString(source, 'taxonomy', path),
    application: readString(source, 'application', path),
    oxyConduct: readString(source, 'oxyConduct', path),
  };
}

function projectDecision(source: Record<string, unknown>, path: string): CaseDecision {
  return {
    id: readString(source, 'id', path),
    caseId: readString(source, 'caseId', path),
    revision: readNumber(source, 'revision', path),
    status: readEnum(source, 'status', path, DECISION_STATUSES),
    outcome: readEnum(source, 'outcome', path, DECISION_OUTCOMES),
    contextSufficiency: readEnum(source, 'contextSufficiency', path, CONTEXT_SUFFICIENCIES),
    confidence: readNumber(source, 'confidence', path),
    findings: readArray(source, 'findings', path, projectFinding),
    recommendedActions: readArray(source, 'recommendedActions', path, projectRecommendedAction),
    jury: projectJury(asRecord(source.jury, `${path}.jury`), `${path}.jury`),
    policyVersions: projectPolicyVersions(
      asRecord(source.policyVersions, `${path}.policyVersions`),
      `${path}.policyVersions`,
    ),
    supersedesDecisionId: readNullableString(source, 'supersedesDecisionId'),
    publishedAt: readString(source, 'publishedAt', path),
  };
}

export function projectCaseDetail(payload: unknown): CaseDetail {
  const source = asRecord(payload, '');
  const path = 'case';
  const subject = asRecord(source.subject, `${path}.subject`);
  const policy = asRecord(source.policy, `${path}.policy`);
  return {
    caseId: readString(source, 'caseId', path),
    status: readEnum(source, 'status', path, CASE_STATUSES),
    subject: {
      externalId: readString(subject, 'externalId', `${path}.subject`),
      type: readString(subject, 'type', `${path}.subject`),
      primaryResourceId: readString(subject, 'primaryResourceId', `${path}.subject`),
    },
    policy: {
      policySetId: readString(policy, 'policySetId', `${path}.policy`),
      version: readString(policy, 'version', `${path}.policy`),
    },
    taxonomyVersion: readString(source, 'taxonomyVersion', path),
    allegationCodes: readStringArray(source, 'allegationCodes'),
    reportCount: readNumber(source, 'reportCount', path),
    sensitivityClass: readNullableString(source, 'sensitivityClass'),
    currentRevision: readNumber(source, 'currentRevision', path),
    resources: readArray(source, 'resources', path, projectResource),
    reports: readArray(source, 'reports', path, projectReportLink),
    decisions: readArray(source, 'decisions', path, projectDecision),
    createdAt: readString(source, 'createdAt', path),
    updatedAt: readString(source, 'updatedAt', path),
  };
}

// --- usage and audit ---------------------------------------------------------

export function projectUsage(payload: unknown): UsageSummary {
  const source = asRecord(payload, '');
  const path = 'usage';
  const window = asRecord(source.window, `${path}.window`);
  const counts = asRecord(source.counts, `${path}.counts`);
  return {
    window: {
      from: readString(window, 'from', `${path}.window`),
      to: readString(window, 'to', `${path}.window`),
      days: readNumber(window, 'days', `${path}.window`),
    },
    counts: {
      reportsReceived: readNumber(counts, 'reportsReceived', `${path}.counts`),
      casesCreated: readNumber(counts, 'casesCreated', `${path}.counts`),
      decisionsPublished: readNumber(counts, 'decisionsPublished', `${path}.counts`),
    },
    daily: readArray(source, 'daily', path, (item, itemPath) => ({
      day: readString(item, 'day', itemPath),
      reportsReceived: readNumber(item, 'reportsReceived', itemPath),
    })),
    quota: projectQuota(asRecord(source.quota, `${path}.quota`), `${path}.quota`),
    atDailyLimit: readBoolean(source, 'atDailyLimit'),
  };
}

export function projectAuditEvents(payload: unknown): AuditEvent[] {
  return readArray(asRecord(payload, ''), 'events', 'events', (item, itemPath) => ({
    auditId: readString(item, 'auditId', itemPath),
    action: readString(item, 'action', itemPath),
    actorCredentialId: readNullableString(item, 'actorCredentialId'),
    reportId: readNullableString(item, 'reportId'),
    caseId: readNullableString(item, 'caseId'),
    externalReportId: readNullableString(item, 'externalReportId'),
    reason: readNullableString(item, 'reason'),
    occurredAt: readString(item, 'occurredAt', itemPath),
  }));
}

// --- Trust & Safety ----------------------------------------------------------

function projectTrustSafetyRow(
  source: Record<string, unknown>,
  path: string,
): TrustSafetyApplication {
  return {
    applicationId: readString(source, 'applicationId', path),
    organizationId: readString(source, 'organizationId', path),
    organizationName: readNullableString(source, 'organizationName'),
    applicationName: readNullableString(source, 'applicationName'),
    standing: readEnum(source, 'standing', path, APPLICATION_STANDINGS),
    globalReputationEffectsAllowed: readBoolean(source, 'globalReputationEffectsAllowed'),
    evidenceIntegrity: readNullableNumber(source, 'evidenceIntegrity'),
    identityBindingReliability: readNullableNumber(source, 'identityBindingReliability'),
    policyQuality: readNullableNumber(source, 'policyQuality'),
    lastStandingReason: readString(source, 'lastStandingReason', path),
    standingChangedAt: readNullableString(source, 'standingChangedAt'),
    standingChangedByOxyUserId: readNullableString(source, 'standingChangedByOxyUserId'),
    updatedAt: readString(source, 'updatedAt', path),
  };
}

export function projectTrustSafetyApplications(payload: unknown): TrustSafetyApplication[] {
  return readArray(
    asRecord(payload, ''),
    'applications',
    'trustSafetyApplications',
    projectTrustSafetyRow,
  );
}

export function projectTrustSafetyApplication(payload: unknown): TrustSafetyApplication {
  return projectTrustSafetyRow(asRecord(payload, ''), 'trustSafetyApplication');
}

export function projectDeadLetterQueue(payload: unknown): DeadLetteredDelivery[] {
  return readArray(asRecord(payload, ''), 'deliveries', 'deadLetter', (item, itemPath) => ({
    deliveryId: readString(item, 'deliveryId', itemPath),
    organizationId: readString(item, 'organizationId', itemPath),
    applicationId: readString(item, 'applicationId', itemPath),
    webhookEndpointId: readString(item, 'webhookEndpointId', itemPath),
    eventId: readString(item, 'eventId', itemPath),
    eventType: readString(item, 'eventType', itemPath),
    attemptCount: readNumber(item, 'attemptCount', itemPath),
    lastResponseStatus: readNullableNumber(item, 'lastResponseStatus'),
    deadLetterReason: readNullableString(item, 'deadLetterReason'),
    deadLetteredAt: readNullableString(item, 'deadLetteredAt'),
    replayCount: readNumber(item, 'replayCount', itemPath),
  }));
}

export function projectPlatformMetrics(payload: unknown): PlatformMetrics {
  const source = asRecord(payload, '');
  const path = 'metrics';
  const byStanding = asRecord(source.applicationsByStanding, `${path}.applicationsByStanding`);
  const deliveries = asRecord(source.deliveries, `${path}.deliveries`);
  return {
    applicationsByStanding: {
      sandbox: readNumber(byStanding, 'sandbox', `${path}.applicationsByStanding`),
      trusted: readNumber(byStanding, 'trusted', `${path}.applicationsByStanding`),
      restricted: readNumber(byStanding, 'restricted', `${path}.applicationsByStanding`),
    },
    deliveries: {
      pending: readNumber(deliveries, 'pending', `${path}.deliveries`),
      delivering: readNumber(deliveries, 'delivering', `${path}.deliveries`),
      succeeded: readNumber(deliveries, 'succeeded', `${path}.deliveries`),
      deadLetter: readNumber(deliveries, 'deadLetter', `${path}.deliveries`),
      successRate: readNullableNumber(deliveries, 'successRate'),
    },
    // Carried through verbatim, because the dashboard's job is to NAME what it
    // cannot compute. Dropping this list would turn six absent metrics into six
    // metrics nobody knows are missing.
    unavailable: readStringArray(source, 'unavailable'),
  };
}
