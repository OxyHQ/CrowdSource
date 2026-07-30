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
 *
 * **§13.2's step-up authentication is NOT implemented**, and the trail is what stands
 * in for it. The clause asks that irreversible and export actions require a second,
 * stronger authentication — which needs a capability from Oxy's identity layer that
 * this service cannot invent, and inventing a local one would be a second definition
 * of what authentication means here. So the irreversible console actions are recorded
 * rather than gated, an `admin` seat is what authorizes them, and the gap is stated
 * here instead of being implied by its absence.
 */

/** What happened. One token per auditable act. */
export const AUDIT_ACTIONS = [
  'report.ingress.accepted',
  'report.ingress.replayed',
  'report.ingress.rejected',
  'report.receipt.read',
  'case.read',
  'decision.read',
  /**
   * §9.8's appeal, recorded as an act and nothing more. The reason and the
   * author's context are deliberately not here: an audit row outlives the case
   * (§13.6), so a field that ever held case content would keep it after the
   * material it described was deleted.
   */
  'appeal.filed',
  'appeal.filed.replayed',
  /**
   * Console writes (§13.2: "las acciones irreversibles o de exportación requieren
   * step up authentication y audit reason").
   *
   * These are the acts that change how an application behaves in production, and each
   * is irreversible in the sense that matters: a revoked credential cannot be
   * un-revoked and a rotated secret cannot be un-rotated. Without a trail, "who broke
   * our integration at 3am" has no answer, and §13.1's insider-abuse row has no
   * evidence to work from.
   *
   * A membership change is deliberately absent: a seat is ORGANIZATION-scoped and this
   * collection is APPLICATION-scoped, so recording one would mean inventing an
   * application for it to belong to. See `console.routes.ts` for what stands in.
   *
   * Step-up authentication is NOT implemented — see the module doc above.
   */
  'console.credential.issued',
  'console.credential.revoked',
  'console.webhook.secret.rotated',
  'console.delivery.replayed',
  'console.application.created',
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
   * (a worker) or when a console member acted.
   */
  actorCredentialId: string | null;
  /**
   * The console member who acted, for the `console.*` actions.
   *
   * A person, which the credential field deliberately never holds — and the
   * distinction is the point: "the leaked key did it" and "this member of your team
   * did it" are different incidents with different responses. Two nullable fields
   * rather than one polymorphic actor, so a query for one can never accidentally
   * match the other.
   *
   * This is NOT a reviewer identity. A reviewer's Oxy id is never written next to a
   * case (§8.7, §9.1) and nothing here does: a console member is a tenant's own staff
   * acting on the tenant's own configuration, which is exactly what §13.2 requires an
   * audit reason for.
   */
  actorOxyUserId: string | null;
  reportId: string | null;
  caseId: string | null;
  externalReportId: string | null;
  reason: AuditReason | null;
  /**
   * The object the act was about, when it is not a report or a case — a credential
   * id, a webhook endpoint id, a delivery id, an application id.
   *
   * An id and never a value: no secret, no URL, no name. `subjectId` rather than one
   * field per kind because the alternative is a schema that grows a nullable column
   * for every future console action.
   */
  subjectId: string | null;
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
    actorOxyUserId: { type: String, default: null },
    reportId: { type: String, default: null },
    caseId: { type: String, default: null },
    externalReportId: { type: String, default: null },
    reason: { type: String, enum: [...AUDIT_REASONS, null], default: null },
    subjectId: { type: String, default: null },
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
  readonly actorOxyUserId?: string;
  readonly reportId?: string;
  readonly caseId?: string;
  readonly externalReportId?: string;
  readonly reason?: AuditReason;
  readonly subjectId?: string;
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
      actorOxyUserId: record.actorOxyUserId ?? null,
      reportId: record.reportId ?? null,
      caseId: record.caseId ?? null,
      externalReportId: record.externalReportId ?? null,
      reason: record.reason ?? null,
      subjectId: record.subjectId ?? null,
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
    },
    session,
  );

  return auditId;
}
