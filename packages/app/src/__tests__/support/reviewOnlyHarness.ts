import { CrowdSource } from '@oxyhq/crowdsource';
import { createCrowdSourceSandbox, type CrowdSourceSandbox } from '@oxyhq/crowdsource-testing';
import mongoose, { Schema, type Connection } from 'mongoose';
import { createModerationIntegration, type ModerationIntegration } from '../../integration.js';
import {
  applyModerationReportIndexes,
  moderationReportSchemaFields,
} from '../../mongoose/report.js';
import { registerModerationModels } from '../../mongoose/models.js';
import { mongooseModerationStore } from '../../mongoose/store/index.js';
import type { ModerationEnforcementConfig, ModerationReportFields } from '../../types.js';
import type { HarnessEnforcement, HarnessEvents } from './backend.js';
import { mongooseEnforcementFacade, mongooseEventsFacade } from './harness.js';

/**
 * A SECOND fictional application: one with nothing to enforce with.
 *
 * The main harness's application has levers — it restricts, flags and restores —
 * and most of this package's behaviour is only visible on one that does not. An
 * application with no `apply` at all still plans, still claims, still records
 * and still closes its reports, and every one of those is a property somebody
 * would otherwise discover by adopting the package and finding nothing happens.
 *
 * It lives in `support/` rather than in the test file for the same reason the
 * main harness does: nothing about a driver belongs in a test body, and Task 11
 * gives this factory a Postgres twin.
 */

export type ReviewOnlyAction = 'none' | 'review';
export type ReviewOnlyReport = ModerationReportFields;

/**
 * The whole enforcement config for an application with nothing to enforce with.
 *
 * Three fields. No `apply`, no `severityFallback`, no `precedence`, no `absorb`,
 * no `reversibleActions`, no `reverses` — and `restoreAction: null`, which the
 * type REQUIRES so that "there is nothing to restore" is a written decision
 * rather than a key somebody forgot.
 */
export const REVIEW_ONLY: ModerationEnforcementConfig<ReviewOnlyAction> = {
  actions: ['review', 'none'],
  noneAction: 'none',
  reviewAction: 'review',
  restoreAction: null,
};

let counter = 0;

/**
 * The signing secret this application's webhook receiver is configured with.
 *
 * Shared with the test file's simulator: a receiver and a simulator that
 * disagree about the secret produce `400 malformed_event`, which reads as a
 * delivery problem rather than a fixture one.
 */
export const REVIEW_ONLY_WEBHOOK_SECRET = 'whsec_test_0123456789abcdef0123456789abcdef';

/**
 * Its own small façade rather than the shared `Harness`, because it is a
 * different application: no widgets, no enforcement lever, its own report model.
 * It reads rows through the SAME façade builders, which is what keeps the
 * assertions in the test file free of a driver.
 */
export interface ReviewOnlyHarness {
  sandbox: CrowdSourceSandbox;
  moderation: ModerationIntegration<ReviewOnlyReport, ReviewOnlyAction>;
  readReport(id: string): Promise<ReviewOnlyReport | null>;
  events: HarnessEvents;
  enforcement: HarnessEnforcement;
  close(): Promise<void>;
}

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

  const sandbox = createCrowdSourceSandbox({ webhookSecret: REVIEW_ONLY_WEBHOOK_SECRET });
  const store = mongooseModerationStore<ReviewOnlyReport>({
    connection,
    reportModel: reports,
    enforcementActions: REVIEW_ONLY.actions,
  });
  const moderation = createModerationIntegration({
    store,
    crowdSource: {
      enabled: true,
      serviceKey: sandbox.serviceKey,
      baseUrl: sandbox.baseUrl,
      webhookSecret: REVIEW_ONLY_WEBHOOK_SECRET,
      // `automatic` deliberately: the point is that an application with no
      // primitive applies nothing even when the mode permits everything.
      enforcementMode: 'automatic',
      outboxPollIntervalMs: 50,
    },
    subjects: [
      {
        reportedType: 'account',
        subjectType: 'identity.profile',
        async snapshot(reportedId) {
          return {
            subject: { externalId: reportedId, type: 'identity.profile' },
            content: { type: 'profile', data: { displayName: 'a reported account' } },
          };
        },
      },
    ],
    taxonomy: {
      version: '2026.07',
      allegationsFor: () => ['harassment.targeted_abuse'],
    },
    enforcement: REVIEW_ONLY,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  moderation.client.get = () =>
    new CrowdSource({
      serviceKey: sandbox.serviceKey,
      baseUrl: sandbox.baseUrl,
      fetch: sandbox.fetch,
    });

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

