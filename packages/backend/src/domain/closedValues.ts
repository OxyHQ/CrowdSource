/**
 * Closed storage vocabularies shared by the domain layer and PostgreSQL CHECKs.
 *
 * Keeping each tuple here prevents a TypeScript union, a runtime branch and a
 * database constraint from becoming three independent lists. Values that cross
 * the public API boundary remain owned by `@oxyhq/crowdsource-contracts`.
 */

export const ORGANIZATION_STATUSES = ['active', 'suspended'] as const;
export const APPLICATION_STATUSES = ['active', 'suspended'] as const;
export const CREDENTIAL_STATUSES = ['active', 'revoked'] as const;

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

export const AUDIT_ACTIONS = [
  'report.ingress.accepted',
  'report.ingress.replayed',
  'report.ingress.rejected',
  'report.receipt.read',
  'case.read',
  'decision.read',
  'appeal.filed',
  'appeal.filed.replayed',
  'console.credential.issued',
  'console.credential.revoked',
  'console.webhook.secret.rotated',
  'console.delivery.replayed',
  'console.application.created',
] as const;

export const AUDIT_REASONS = [
  'schema_invalid',
  'application_mismatch',
  'unsafe_resource_url',
  'policy_unknown',
  'payload_conflict',
] as const;

export const CONSOLE_ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export const MEMBER_STATUSES = ['active', 'revoked'] as const;
export const STAFF_ROLES = ['policy', 'appeals', 'evidence', 'security'] as const;

export const STAFF_AUDIT_ACTIONS = [
  'staff.applications.read',
  'staff.escalated.read',
  'staff.metrics.read',
  'staff.deadletter.read',
  'staff.standing.changed',
] as const;

export const APPLICATION_STANDINGS = ['sandbox', 'trusted', 'restricted'] as const;

export const STANDING_REASONS = [
  'initial',
  'promotion_review_passed',
  'evidence_integrity_failed',
  'high_overturn_rate',
  'suspected_abuse',
  'investigation_closed',
] as const;

export const WEBHOOK_ENDPOINT_STATUSES = ['active', 'disabled'] as const;
export const WEBHOOK_DISABLED_REASONS = ['gone', 'operator'] as const;
export const WEBHOOK_ATTEMPT_OUTCOMES = ['succeeded', 'failed'] as const;
export const WEBHOOK_FAILURE_KINDS = [
  'http_status',
  'unsafe_target',
  'upstream_unreachable',
  'secret_unavailable',
  'endpoint_disabled',
] as const;
