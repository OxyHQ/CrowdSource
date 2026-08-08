/**
 * An application that can REVIEW but cannot ENFORCE.
 *
 * Not a stub and not an unfinished integration: some applications have no
 * platform-level sanction primitive at all. An end-to-end encrypted messenger is
 * the clearest case — the server cannot read the material, so it cannot label
 * it, and its block/restrict relations are written by one user about their own
 * inbox rather than by the platform about an account. There is nothing for a
 * decision worker to carry out, and writing those relations on a user's behalf
 * because a field said `violation` would be a product decision made by a queue.
 *
 * So the supported shape is: plan, claim, record — and apply nothing. What must
 * NOT happen is the record quietly claiming otherwise, which is what these tests
 * pin. `enforcedAction` says what the application decided; `enforcedAt` says an
 * effect landed. An application with no primitive must never get the second.
 *
 * Credit: `allo` raised this as a possible wrong assumption in the extension
 * points, and it was.
 */

import { CrowdSource } from '@oxyhq/crowdsource';
import {
  createCrowdSourceSandbox,
  WebhookSimulator,
  type CrowdSourceSandbox,
} from '@oxyhq/crowdsource-testing';
import mongoose, { Schema, type Connection, type Model } from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';
import { createModerationIntegration, type ModerationIntegration } from '../integration.js';
import {
  applyModerationReportIndexes,
  moderationReportSchemaFields,
} from '../mongoose/report.js';
import { registerModerationModels, type ModerationModels } from '../mongoose/models.js';
import { mongooseModerationStore } from '../mongoose/store/index.js';
import { planEnforcement } from '../enforcement/planner.js';
import { decision } from './support/decisions.js';
import type { ModerationEnforcementConfig, ModerationReportFields } from '../types.js';
import { startWebhookApp, type RunningWebhookApp } from './support/webhookApp.js';

const WEBHOOK_SECRET = 'whsec_test_0123456789abcdef0123456789abcdef';

type ReviewOnlyAction = 'none' | 'review';

interface ReviewOnlyReport extends ModerationReportFields {
  _id: mongoose.Types.ObjectId;
}

/**
 * The whole enforcement config for an application with nothing to enforce with.
 *
 * Three fields. No `apply`, no `severityFallback`, no `precedence`, no `absorb`,
 * no `reversibleActions`, no `reverses` — and `restoreAction: null`, which the
 * type REQUIRES so that "there is nothing to restore" is a written decision
 * rather than a key somebody forgot.
 */
const REVIEW_ONLY: ModerationEnforcementConfig<ReviewOnlyAction> = {
  actions: ['review', 'none'],
  noneAction: 'none',
  reviewAction: 'review',
  restoreAction: null,
};

let connection: Connection | null = null;
let app: RunningWebhookApp | null = null;
let counter = 0;

afterEach(async () => {
  await app?.close();
  app = null;
  if (connection) {
    await connection.dropDatabase();
    await connection.close();
    connection = null;
  }
});

interface Wired {
  sandbox: CrowdSourceSandbox;
  reports: Model<ReviewOnlyReport>;
  moderation: ModerationIntegration<ReviewOnlyReport, ReviewOnlyAction>;
  /** The three collections, for assertions about what the pipeline wrote. */
  models: ModerationModels;
}

async function wireReviewOnlyApp(): Promise<Wired> {
  const uri = process.env.CROWDSOURCE_APP_TEST_MONGODB_URI;
  if (uri === undefined) throw new Error('vitest.globalSetup.ts did not run.');

  counter += 1;
  connection = mongoose.createConnection(uri, {
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

  const sandbox = createCrowdSourceSandbox({ webhookSecret: WEBHOOK_SECRET });
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
      webhookSecret: WEBHOOK_SECRET,
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

  return {
    sandbox,
    reports,
    moderation,
    models: registerModerationModels({
      connection,
      enforcementActions: REVIEW_ONLY.actions,
    }),
  };
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe('an application with no enforcement primitive', () => {
  it('needs three fields and no apply', () => {
    // The compiler is the assertion here: this object satisfies the interface.
    expect(REVIEW_ONLY.apply).toBeUndefined();
    expect(REVIEW_ONLY.severityFallback).toBeUndefined();
    expect(REVIEW_ONLY.precedence).toBeUndefined();
    expect(REVIEW_ONLY.restoreAction).toBeNull();
  });

  it('still plans exactly one real action for every outcome', () => {
    // The plan is never empty, so there is always something to record.
    for (const outcome of ['violation', 'no_violation', 'inconclusive', 'duplicate'] as const) {
      const plan = planEnforcement(
        decision({ outcome, findings: outcome === 'violation' ? undefined : [] }),
        REVIEW_ONLY,
      );
      expect(plan).toHaveLength(1);
      expect(plan[0].reason).not.toHaveLength(0);
    }
  });

  it('plans an explicit nothing for no_violation rather than a restore it cannot do', () => {
    const plan = planEnforcement(
      decision({ outcome: 'no_violation', findings: [], recommendedActions: [] }),
      REVIEW_ONLY,
    );
    expect(plan[0].action).toBe('none');
    expect(plan[0].reason).toContain('nothing to restore');
  });

  it('does not wake a human for a recommendation that asks for no effect', () => {
    /**
     * With no `recommendationToAction` at all, `no_action` must still mean
     * nothing rather than falling through to review — otherwise every cleared
     * case queues a human and buries the ones that need looking at.
     */
    const plan = planEnforcement(
      decision({
        outcome: 'no_violation',
        findings: [],
        recommendedActions: [{ action: 'no_action' }],
      }),
      REVIEW_ONLY,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['none']);
  });

  it('sends a recommendation it cannot carry out to review, recorded with its origin', () => {
    const plan = planEnforcement(
      decision({ recommendedActions: [{ action: 'remove' }] }),
      REVIEW_ONLY,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['review']);
    expect(plan[0].recommendedAction).toBe('remove');
  });

  it('falls back to review for a violation with no recommendation and no severity table', () => {
    expect(
      planEnforcement(decision({ recommendedActions: [] }), REVIEW_ONLY).map(
        (entry) => entry.action,
      ),
    ).toEqual(['review']);
  });

  it('records the decision, and never claims an effect it did not have', async () => {
    const wired = await wireReviewOnlyApp();
    app = await startWebhookApp(wired.moderation);

    const { report } = await wired.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'account',
      reportedId: 'oxy-reported-account',
      categories: ['harassment'],
    });

    wired.moderation.dispatcher.start();
    await eventually(async () => {
      const row = await wired.reports.findById(report._id).lean();
      expect(row?.localStatus).toBe('submitted');
    });

    const caseId = (await wired.reports.findById(report._id).lean())?.crowdSourceCaseId;
    if (caseId === undefined) throw new Error('the report was never given a case id');

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: app.url });
    await simulator.deliver(
      wired.sandbox.eventFor(wired.sandbox.decide(caseId, { outcome: 'violation' })),
    );

    await eventually(async () => {
      const row = await wired.reports.findById(report._id).lean();
      expect(row?.decisionOutcome).toBe('violation');
    });
    await wired.moderation.dispatcher.stop();

    const decided = await wired.reports.findById(report._id).lean();
    // What the application DECIDED is recorded…
    expect(decided?.enforcedAction).toBe('review');
    // …and what it did is not claimed, because it did nothing.
    expect(decided?.enforcedAt).toBeUndefined();
    expect(decided?.localStatus).toBe('closed');

    // The audit row exists and is honest about why nothing happened.
    const enforcement = await wired.models.enforcement.findOne({}).lean();
    expect(enforcement?.action).toBe('review');
    expect(enforcement?.applied).toBe(false);
    expect(enforcement?.mode).toBe('automatic');
    expect(enforcement?.skippedReason).toContain('no enforcement primitive');
  });

  it('keeps the idempotency claim, so a redelivered decision is still recorded once', async () => {
    const wired = await wireReviewOnlyApp();
    app = await startWebhookApp(wired.moderation);

    const { report } = await wired.moderation.createReport({
      reporter: 'oxy-reporter',
      reportedType: 'account',
      reportedId: 'oxy-reported-account',
      categories: ['harassment'],
    });

    wired.moderation.dispatcher.start();
    await eventually(async () => {
      const row = await wired.reports.findById(report._id).lean();
      expect(row?.localStatus).toBe('submitted');
    });
    const caseId = (await wired.reports.findById(report._id).lean())?.crowdSourceCaseId;
    if (caseId === undefined) throw new Error('the report was never given a case id');

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: app.url });
    const event = wired.sandbox.eventFor(
      wired.sandbox.decide(caseId, { outcome: 'violation' }),
    );
    await simulator.deliver(event);
    await simulator.deliver(event);

    await eventually(async () => {
      expect(
        await wired.models.enforcement.countDocuments({}),
      ).toBeGreaterThan(0);
    });
    await wired.moderation.dispatcher.stop();

    /**
     * One row, because the claim is keyed on `decisionId + revision + action`
     * and that machinery is the package's regardless of whether the application
     * can act. An application with no primitive still gets exactly-once
     * bookkeeping.
     */
    expect(await wired.models.enforcement.countDocuments({})).toBe(1);
    expect(await wired.models.event.countDocuments({})).toBe(1);
  });
});
