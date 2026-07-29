import { Schema, type ClientSession } from 'mongoose';

import { defineTenantCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';
import { newPublicId } from '../../utils/identifiers';

/**
 * Audit events (§12.6 `audit_events`, §13.2).
 *
 * §15.3 asks for audit of INGRESS and ACCESS specifically, and those two are
 * where the tenant boundary is either held or broken: ingress is where an
 * application asserts things about itself, access is where it asks for something
 * back. §13.1 calls a cross-tenant leak a critical incident, and an incident you
 * cannot reconstruct afterwards is one you cannot bound.
 *
 * **Nothing here may carry reported material.** Codes, ids and outcomes only. An
 * audit trail is the longest-retained data in the system (§13.6: "extended and
 * immutable"), so a field that occasionally holds a fragment of an envelope is a
 * field that keeps that fragment long after the case it belonged to was deleted
 * — which would quietly defeat the retention rules it sits next to. The schema
 * is `strict`, the value types are scalars, and `reason` is a CODE rather than a
 * message for exactly this reason.
 *
 * Append-only by construction: nothing in this module updates or deletes.
 */

/** What happened. One token per auditable act. */
export const AUDIT_ACTIONS = [
  'report.ingress.accepted',
  'report.ingress.replayed',
  'report.ingress.rejected',
  'report.receipt.read',
  'case.read',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Why an act was refused. A closed vocabulary, because a free-text reason is
 * where an envelope fragment ends up.
 */
export const AUDIT_REASONS = [
  'schema_invalid',
  'application_mismatch',
  'unsafe_resource_url',
  'policy_unknown',
  'payload_conflict',
] as const;
export type AuditReason = (typeof AUDIT_REASONS)[number];

export interface AuditEventDocument extends TenantContext {
  auditId: string;
  action: AuditAction;
  /**
   * The credential that acted, or null when CrowdSource acted on its own behalf
   * (a worker). Never an end user: the application API has no end users, and a
   * reviewer's identity is not written next to a case.
   */
  actorCredentialId: string | null;
  reportId: string | null;
  caseId: string | null;
  externalReportId: string | null;
  reason: AuditReason | null;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const auditEventSchema = new Schema<AuditEventDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    auditId: { type: String, required: true, unique: true },
    action: { type: String, required: true, enum: AUDIT_ACTIONS },
    actorCredentialId: { type: String, default: null },
    reportId: { type: String, default: null },
    caseId: { type: String, default: null },
    externalReportId: { type: String, default: null },
    reason: { type: String, enum: [...AUDIT_REASONS, null], default: null },
    occurredAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'audit_events' },
);

/** The operator's question is always "what happened to this tenant, recently". */
auditEventSchema.index({ applicationId: 1, occurredAt: -1 });
auditEventSchema.index({ applicationId: 1, caseId: 1, occurredAt: -1 });

export const auditEvents = defineTenantCollection('AuditEvent', auditEventSchema);

export interface AuditRecord {
  readonly action: AuditAction;
  readonly actorCredentialId?: string;
  readonly reportId?: string;
  readonly caseId?: string;
  readonly externalReportId?: string;
  readonly reason?: AuditReason;
}

/**
 * Appends one audit event.
 *
 * `session` is optional here and required on the outbox, and the difference is
 * deliberate. An accepted ingress writes its audit row inside the SAME
 * transaction as the report — an accepted report with no trail is the gap this
 * collection exists to close. A REJECTED ingress has no transaction to join:
 * nothing was written, and the refusal is still worth recording.
 */
export async function appendAuditEvent(
  context: TenantContext,
  record: AuditRecord,
  session?: ClientSession,
): Promise<string> {
  const auditId = newPublicId('auditEvent');
  const now = new Date();

  await auditEvents.insertOne(
    context,
    {
      auditId,
      action: record.action,
      actorCredentialId: record.actorCredentialId ?? null,
      reportId: record.reportId ?? null,
      caseId: record.caseId ?? null,
      externalReportId: record.externalReportId ?? null,
      reason: record.reason ?? null,
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
    },
    session,
  );

  return auditId;
}
