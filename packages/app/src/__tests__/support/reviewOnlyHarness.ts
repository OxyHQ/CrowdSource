import mongoose, { Schema, type Connection } from 'mongoose';
import {
  applyModerationReportIndexes,
  moderationReportSchemaFields,
} from '../../mongoose/report.js';
import { registerModerationModels } from '../../mongoose/models.js';
import { mongooseModerationStore } from '../../mongoose/store/index.js';
import { mongooseEnforcementFacade, mongooseEventsFacade } from './harness.js';
import {
  REVIEW_ONLY,
  reviewOnlyIntegration,
  type ReviewOnlyHarness,
  type ReviewOnlyReport,
} from './reviewOnlyApplication.js';

/**
 * A SECOND fictional application: one with nothing to enforce with.
 *
 * The main harness's application has levers — it restricts, flags and restores —
 * and most of this package's behaviour is only visible on one that does not. An
 * application with no `apply` at all still plans, still claims, still records
 * and still closes its reports, and every one of those is a property somebody
 * would otherwise discover by adopting the package and finding nothing happens.
 *
 * This file is its MONGO half: the connection, the report model and the row
 * reads. Everything above the store — the enforcement table, the subject
 * provider, the sandbox, the integration — is in `reviewOnlyApplication.ts`, so
 * the two backends share one application rather than resembling each other.
 */

let counter = 0;

export async function createReviewOnlyHarness(): Promise<ReviewOnlyHarness> {
  const uri = process.env.CROWDSOURCE_APP_TEST_MONGODB_URI;
  if (uri === undefined) throw new Error('vitest.globalSetup.ts did not run.');

  counter += 1;
  const connection: Connection = mongoose.createConnection(uri, {
    dbName: `crowdsource_review_only_${process.pid}_${counter}`,
  });
  await connection.asPromise();

  const ReportSchema = new Schema<ReviewOnlyReport>(
    {
      ...moderationReportSchemaFields({
        reportedTypes: ['account', 'message'],
        categories: ['harassment'],
      }),
    },
    { timestamps: true },
  );
  applyModerationReportIndexes(ReportSchema);
  const reports = connection.model<ReviewOnlyReport>('Report', ReportSchema);

  const store = mongooseModerationStore<ReviewOnlyReport>({
    connection,
    reportModel: reports,
    enforcementActions: REVIEW_ONLY.actions,
  });
  const { sandbox, moderation } = reviewOnlyIntegration({ store });

  // One call for the three collections this package owns and the application's
  // own report model.
  await store.ensureSchema();

  const models = registerModerationModels({
    connection,
    enforcementActions: REVIEW_ONLY.actions,
  });

  return {
    sandbox,
    moderation,
    async close() {
      await moderation.dispatcher.stop();
      moderation.reconciliationJob.stop();
      await connection.dropDatabase();
      await connection.close();
    },
    async readReport(id) {
      if (!mongoose.isValidObjectId(id)) return null;
      const row = await reports
        .findById(id)
        .lean<(ReviewOnlyReport & { _id: unknown }) | null>();
      return row === null ? null : Object.assign(row, { id: String(row._id) });
    },
    events: mongooseEventsFacade(models.event),
    enforcement: mongooseEnforcementFacade(models.enforcement),
  };
}

