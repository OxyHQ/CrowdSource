import { Schema, type SchemaDefinition } from 'mongoose';
import type { ModerationReportFields } from '../types.js';

/**
 * The moderation half of an application's report schema.
 *
 * The application owns the report: its collection, its own `reportedType` and
 * category enums, whatever verdict field it already had, and any extra columns.
 * What it should NOT own is the shape of the fields this package queries, and in
 * particular the indexes those queries depend on.
 *
 * The alternative — a store port with ten methods for the application to
 * implement — was rejected deliberately. Every one of those methods carries a
 * correctness property that is invisible when it is wrong: the decision-revision
 * guard that stops a stale correction overwriting the current answer, the
 * oldest-first bounded scan reconciliation depends on, the exact meaning of each
 * `localStatus`. Seven applications re-deriving those is seven chances to get one
 * subtly wrong, in a way no test written against the port would catch. So the
 * queries live in this package and the application supplies the model.
 *
 * `ModerationReportStore` in `src/store/types.ts` is that port, and its
 * existence does not reverse this: it is INTERNAL, and this package implements
 * it once per backend. What was rejected is handing it to the adopter, which is
 * still not something to do.
 *
 * ```ts
 * const ReportSchema = new Schema<IReport>(
 *   {
 *     ...moderationReportSchemaFields({
 *       reportedTypes: Object.values(ReportedType),
 *       categories: Object.values(ReportCategory),
 *     }),
 *     // …the application's own fields
 *   },
 *   { timestamps: true },
 * );
 * applyModerationReportIndexes(ReportSchema);
 * ```
 */

export const MODERATION_LOCAL_STATUSES: readonly ModerationReportFields['localStatus'][] =
  Object.freeze(['received', 'queued', 'submitted', 'delivery_failed', 'closed']);

export interface ModerationReportSchemaOptions {
  /**
   * The application's reportable types. Constrains the stored value.
   *
   * This is NOT the set of DELIVERABLE types — a type with no subject provider
   * is still reportable and still stored, it simply never leaves. Registering a
   * provider is what makes a type deliverable, and the two lists are allowed to
   * differ.
   */
  readonly reportedTypes?: readonly string[];
  /** The application's report categories. */
  readonly categories?: readonly string[];
  /** Maximum length of the reporter's free text. */
  readonly detailsMaxLength?: number;
}

/**
 * The paths this package reads and writes, as a Mongoose schema definition.
 *
 * Spread into the application's own schema. Every field is either required at
 * intake or written by exactly one step of the pipeline.
 */
export function moderationReportSchemaFields(
  options: ModerationReportSchemaOptions = {},
): SchemaDefinition {
  return {
    reportedType: {
      type: String,
      required: true,
      ...(options.reportedTypes === undefined ? {} : { enum: [...options.reportedTypes] }),
    },
    reportedId: { type: String, required: true },
    /**
     * The reporting Oxy user id.
     *
     * The Oxy subject IS the identity binding proof, so there is no separate
     * binding step for an application to implement — but it does mean this field
     * must hold an Oxy user id and not an application-local one.
     */
    reporter: { type: String, required: true },
    categories: {
      type: [String],
      required: true,
      ...(options.categories === undefined ? {} : { enum: [...options.categories] }),
    },
    details: { type: String, maxlength: options.detailsMaxLength ?? 2_000 },

    localStatus: {
      type: String,
      required: true,
      enum: [...MODERATION_LOCAL_STATUSES],
      default: 'received',
    },
    /**
     * Why a report is not going anywhere, in words an operator can read.
     *
     * Stored rather than inferred from a missing outbox event. A missing row is
     * also what a lost write looks like, and the two need to be distinguishable
     * months later without re-deriving which types had providers at the time.
     */
    localStatusReason: { type: String, maxlength: 300 },

    crowdSourceReportId: { type: String },
    crowdSourceCaseId: { type: String },
    crowdSourceMerged: { type: Boolean },
    /** SHA-256 of the exact representation that was reviewed. */
    contentSnapshotHash: { type: String },
    submittedAt: { type: Date },
    lastDeliveryError: { type: String, maxlength: 2_000 },

    decisionId: { type: String },
    /**
     * The revision guard.
     *
     * Compared in the update FILTER, so it is the database that refuses a stale
     * write rather than a read-then-write in the application process.
     */
    decisionRevision: { type: Number },
    decisionOutcome: { type: String },
    decisionStatus: { type: String },
    decidedAt: { type: Date },
    enforcedAction: { type: String },
    enforcedAt: { type: Date },
  };
}

/**
 * The indexes the pipeline's queries depend on.
 *
 * Not optional and not tuning. Reconciliation scans `{ localStatus, createdAt }`
 * oldest-first on every sweep, and the decision worker looks a case up by
 * `crowdSourceCaseId` on every inbound decision; without these both become
 * collection scans that grow with the report table.
 *
 * The compound uniqueness of "one report per reporter per object" is the
 * APPLICATION's to declare — some applications allow a reporter to file twice
 * under different categories — so it is not created here. Intake's duplicate
 * check reads `{ reporter, reportedId, reportedType }`, so index that if you do
 * not make it unique.
 */
export function applyModerationReportIndexes(schema: Schema): void {
  schema.index({ localStatus: 1, createdAt: 1 });
  schema.index({ crowdSourceCaseId: 1 });
  schema.index({ reporter: 1, reportedId: 1, reportedType: 1 });
}
