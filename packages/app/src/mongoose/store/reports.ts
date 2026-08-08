import type { ClientSession, Model } from 'mongoose';
import type {
  ModerationReportRef,
  ModerationReportStore,
} from '../../store/types.js';
import type { ModerationReportFields } from '../../types.js';

/**
 * The application's own report collection, in Mongo.
 *
 * The application still owns the model — its collection, its enums, its extra
 * columns — and this store owns the QUERIES, which is the split
 * `moderationReportSchemaFields` exists for. Every correctness property lives in
 * a query here rather than in seven applications: the decision-revision guard,
 * the oldest-first bounded scan, the exact meaning of each `localStatus`.
 */

/** A report as Mongo returns it: the application's document, plus `_id`. */
type LeanReport<TReport> = TReport & { _id: unknown };

/** Identity and the two fields the decision worker needs. Nothing else. */
type ReportRefRow = { _id: unknown; reportedType: string; reportedId: string };

/**
 * The one place `_id` becomes `id`.
 *
 * Every read goes through it, so `String(document._id)` never appears in the
 * shared half and both backends hand the core the same shape. Removing this
 * mapping is invisible to `tsc` — a `.lean<T>()` type argument is an unchecked
 * cast — and the damage lands far away, so it is covered by a test that asserts
 * the identity itself rather than the delivery it enables.
 */
function withId<TReport extends ModerationReportFields>(
  row: LeanReport<TReport>,
): TReport {
  return Object.assign(row, { id: String(row._id) });
}

function isCastError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'CastError'
  );
}

export function mongooseReportStore<TReport extends ModerationReportFields>(input: {
  model: Model<TReport>;
}): ModerationReportStore<TReport, ClientSession> {
  const { model } = input;

  return {
    async findDuplicate({ reporter, reportedId, reportedType }, session) {
      const row = await model
        .findOne({ reporter, reportedId, reportedType })
        .session(session)
        .lean<LeanReport<TReport> | null>();
      return row === null ? null : withId(row);
    },

    async insert(report, session) {
      const [created] = await model.create(
        [
          {
            /**
             * The application's own columns FIRST, so a field this package owns
             * can never be overwritten by one it knows nothing about. A report
             * whose `localStatus` came from `extra` would be queued with nothing
             * to deliver it, or received with a delivery event that tries anyway.
             */
            ...report.extra,
            reportedType: report.reportedType,
            reportedId: report.reportedId,
            reporter: report.reporter,
            categories: [...report.categories],
            ...(report.details === undefined ? {} : { details: report.details }),
            localStatus: report.localStatus,
            ...(report.localStatusReason === undefined
              ? {}
              : { localStatusReason: report.localStatusReason }),
          },
        ],
        { session },
      );
      return withId(created.toObject<LeanReport<TReport>>());
    },

    async findById(reportId) {
      try {
        const row = await model.findById(reportId).lean<LeanReport<TReport> | null>();
        return row === null ? null : withId(row);
      } catch (error: unknown) {
        /**
         * A malformed id is the same answer as an id nothing matches: there is
         * nothing to deliver. Mongoose raises a `CastError` for a string that is
         * not an ObjectId, and a delivery event can outlive its report, so
         * throwing here would retry a lookup that can never succeed until it
         * dead-letters. Anything that is NOT a cast failure is a real fault and
         * is rethrown.
         */
        if (isCastError(error)) return null;
        throw error;
      }
    },

    async findByCaseId(caseId) {
      const rows = await model
        .find({ crowdSourceCaseId: caseId })
        .select('_id reportedType reportedId')
        .lean<ReportRefRow[]>();
      return rows.map(
        (row): ModerationReportRef => ({
          id: String(row._id),
          reportedType: row.reportedType,
          reportedId: row.reportedId,
        }),
      );
    },

    async applyDecision(reportId, update, maxRevision) {
      const result = await model.updateOne(
        {
          _id: reportId,
          /**
           * The revision guard, in the FILTER. It is the DATABASE that refuses a
           * stale write rather than a read-then-write in this process:
           * deliveries overlap, and an older revision landing last would
           * otherwise overwrite the current answer with a stale one. A report
           * with no stored revision matches; `$lte` rather than `$lt` lets a
           * redelivery of the same revision rewrite.
           */
          $or: [
            { decisionRevision: { $exists: false } },
            { decisionRevision: { $lte: maxRevision } },
          ],
        },
        {
          $set: {
            // The adopter's legacy verdict field FIRST, for the same reason
            // `extra` is spread first on insert: this package's fields win.
            ...update.extra,
            localStatus: update.localStatus,
            decisionId: update.decisionId,
            decisionRevision: update.decisionRevision,
            decisionOutcome: update.decisionOutcome,
            decisionStatus: update.decisionStatus,
            decidedAt: update.decidedAt,
            ...(update.enforcedAction === undefined
              ? {}
              : { enforcedAction: update.enforcedAction }),
            ...(update.enforcedAt === undefined ? {} : { enforcedAt: update.enforcedAt }),
          },
        },
      );
      return result.matchedCount === 1;
    },

    async markSubmitted(reportId, submission) {
      await model.updateOne(
        { _id: reportId },
        {
          $set: {
            localStatus: 'submitted',
            crowdSourceReportId: submission.crowdSourceReportId,
            crowdSourceCaseId: submission.crowdSourceCaseId,
            crowdSourceMerged: submission.crowdSourceMerged,
            contentSnapshotHash: submission.contentSnapshotHash,
            submittedAt: submission.submittedAt,
          },
          // A report that has now landed carries no failure and no reason it
          // was going nowhere; leaving either would describe a state it is no
          // longer in.
          $unset: { lastDeliveryError: '', localStatusReason: '' },
        },
      );
    },

    async markDeliveryFailed(reportId, lastDeliveryError) {
      await model.updateOne(
        { _id: reportId },
        { $set: { localStatus: 'delivery_failed', lastDeliveryError } },
      );
    },

    async close(reportId, localStatusReason) {
      await model.updateOne(
        { _id: reportId },
        { $set: { localStatus: 'closed', localStatusReason } },
      );
    },

    async findPendingOldestFirst(limit) {
      /**
       * `queued` and `delivery_failed` only. `received` is excluded deliberately
       * and the omission is the safety property, not an oversight: those reports
       * have no subject provider, so an event re-derived for one would fail on
       * its first attempt and dead-letter. The index on
       * `{ localStatus, createdAt }` is what keeps this bounded.
       */
      const rows = await model
        .find({ localStatus: { $in: ['queued', 'delivery_failed'] } })
        .select('_id')
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean<{ _id: unknown }[]>();
      return rows.map((row) => String(row._id));
    },

    async countAwaitingDecision(submittedBefore) {
      return await model.countDocuments({
        localStatus: 'submitted',
        submittedAt: { $lt: submittedBefore },
      });
    },

    async countLocalOnly() {
      return await model.countDocuments({ localStatus: 'received' });
    },
  };
}
