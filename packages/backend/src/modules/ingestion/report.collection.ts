import { Schema } from 'mongoose';

import { defineTenantCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';

/**
 * Reports — an individual allegation delivered by an application (§3).
 *
 * A report is not a case and not a verdict. It is the durable receipt that says
 * "this application told us about this object", and §7.1 hangs the whole
 * delivery guarantee on it: a 202 means the report is stored and a durable retry
 * path exists, never that a synchronous downstream call succeeded.
 */

export interface ReportDocument extends TenantContext {
  reportId: string;
  /** The application's own id for this report. Unique within the application. */
  externalReportId: string;
  /** The caller's retry key. Unique within the application. */
  idempotencyKey: string;
  /**
   * The fingerprint of what was delivered. A second delivery matching it is a
   * retry and gets the same `reportId`; one that differs is a 409 (§10.5).
   */
  payloadHash: string;
  /**
   * The Case Envelope exactly as delivered (§5.6: an immutable inline snapshot).
   * Stored, never re-served through the application API.
   */
  envelope: Record<string, unknown>;
  /**
   * §3.2. Only `received` is written today — `merged` and `closed` belong to the
   * case orchestrator, `invalid` to full envelope validation, and `withdrawn` to
   * the reporter-facing surface. None of those exist yet, so nothing writes them.
   */
  status: 'received' | 'merged' | 'invalid' | 'withdrawn' | 'closed';
  receivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<ReportDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    reportId: { type: String, required: true, unique: true },
    externalReportId: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    payloadHash: { type: String, required: true },
    envelope: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      required: true,
      enum: ['received', 'merged', 'invalid', 'withdrawn', 'closed'],
      default: 'received',
    },
    receivedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'reports' },
);

/**
 * The two constraints of §12.7 that make a retry safe.
 *
 * They are unique INDEXES rather than a read-then-write check because a check
 * races: two concurrent retries of the same delivery both read nothing and both
 * insert. With these, the second insert fails and the service answers with the
 * first report's id.
 *
 * `applicationId` alone is enough of a tenant prefix — it is a random public id,
 * unique across the deployment — so these match §12.7 exactly, and one
 * application's `externalReportId` can never collide with another's.
 */
reportSchema.index({ applicationId: 1, externalReportId: 1 }, { unique: true });
reportSchema.index({ applicationId: 1, idempotencyKey: 1 }, { unique: true });

export const reports = defineTenantCollection('Report', reportSchema);
