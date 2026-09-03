
import {
  defineTenantCollection,
  type TransactionSession,
} from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';
import { AUDIT_ACTIONS, AUDIT_REASONS } from '../../domain/closedValues';
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
export { AUDIT_ACTIONS } from '../../domain/closedValues';
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Why an act was refused. A closed vocabulary, because a free-text reason is
 * where an envelope fragment ends up.
 */
export { AUDIT_REASONS } from '../../domain/closedValues';
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

export const auditEvents = defineTenantCollection<AuditEventDocument>('AuditEvent');

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
  session?: TransactionSession,
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
