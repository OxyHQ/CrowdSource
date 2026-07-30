import mongoose, { Schema, type Connection, type Model } from 'mongoose';
import type { Decision, TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import {
  applyModerationReportIndexes,
  moderationReportSchemaFields,
} from '../../models/report';
import { createModerationIntegration } from '../../integration';
import type { ModerationIntegration } from '../../integration';
import type {
  EnforcementEffect,
  ModerationEnforcementConfig,
  ModerationLogger,
  ModerationReportFields,
  ModerationSubjectProvider,
} from '../../types';

/**
 * A fictional application, wired the way an adopter wires one.
 *
 * Deliberately not a mock of this package's own pieces: the connection is a real
 * replica set, the report model is a real Mongoose model composed from the
 * exported schema fields, and the enforcement effects are real writes to a real
 * collection. What is fictional is only the application's domain — a `widget`
 * with a body and a status — because that is the part every adopter replaces.
 */

export interface TestWidget {
  _id: mongoose.Types.ObjectId;
  body: string;
  ownerId: string;
  status: 'draft' | 'published' | 'restricted';
  flagged: boolean;
}

export interface TestReport extends ModerationReportFields {
  _id: mongoose.Types.ObjectId;
  /** A legacy verdict field, so the extra-fields escape hatch is exercised. */
  legacyStatus: string;
}

export type TestAction = 'restrict' | 'restore' | 'flag' | 'unflag' | 'review' | 'none';

export const TEST_ACTIONS: readonly TestAction[] = [
  'restrict',
  'restore',
  'flag',
  'unflag',
  'review',
  'none',
];

export interface Harness {
  connection: Connection;
  widgets: Model<TestWidget>;
  reports: Model<TestReport>;
  moderation: ModerationIntegration<TestReport, TestAction>;
  logs: { level: string; message: string; context?: Record<string, unknown> }[];
  close(): Promise<void>;
}

export const recordingLogger = (
  sink: Harness['logs'],
): ModerationLogger => ({
  info: (message, context) => void sink.push({ level: 'info', message, ...(context ? { context } : {}) }),
  warn: (message, context) => void sink.push({ level: 'warn', message, ...(context ? { context } : {}) }),
  error: (message, context) => void sink.push({ level: 'error', message, ...(context ? { context } : {}) }),
});

const CATEGORY_TO_ALLEGATION: Readonly<Record<string, TaxonomyCode>> = Object.freeze({
  spam: 'integrity.spam',
  harassment: 'harassment.targeted_abuse',
  other: 'other.unclassifiable',
});

export function testTaxonomy(): {
  version: string;
  allegationsFor(categories: readonly string[]): readonly TaxonomyCode[];
} {
  return {
    version: '2026.07',
    allegationsFor(categories) {
      const codes = new Set<TaxonomyCode>();
      for (const category of categories) {
        codes.add(CATEGORY_TO_ALLEGATION[category] ?? 'other.unclassifiable');
      }
      return Array.from(codes).sort();
    },
  };
}

export function widgetSubjectProvider(
  widgets: Model<TestWidget>,
): ModerationSubjectProvider {
  return {
    reportedType: 'widget',
    subjectType: 'custom.test.widget',
    async snapshot(reportedId) {
      if (!mongoose.isValidObjectId(reportedId)) return null;
      const widget = await widgets.findById(reportedId).lean<TestWidget | null>();
      if (!widget) return null;
      return {
        subject: {
          externalId: String(widget._id),
          type: 'custom.test.widget',
          author: { oxyUserId: widget.ownerId },
        },
        content: { type: 'text', data: { text: widget.body } },
      };
    },
  };
}

/**
 * A second deliverable noun with no enforcement lever, mirroring Moovo's
 * customer/delivery types. It is DELIVERABLE — a jury can review it — but no
 * action in the table can act on it, which is exactly the case `recordedAs`
 * exists for.
 */
export function doodadSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: 'doodad',
    subjectType: 'custom.test.doodad',
    async snapshot(reportedId) {
      return {
        subject: { externalId: reportedId, type: 'custom.test.doodad' },
        content: { type: 'text', data: { text: 'a reported doodad' } },
      };
    },
  };
}

export function testEnforcement(
  widgets: Model<TestWidget>,
): ModerationEnforcementConfig<TestAction> {
  return {
    actions: TEST_ACTIONS,
    noneAction: 'none',
    reviewAction: 'review',
    restoreAction: 'restore',
    recommendationToAction: {
      remove: 'restrict',
      remove_or_restrict: 'restrict',
      hide: 'restrict',
      label: 'flag',
      allow_with_label: 'flag',
      age_gate: 'flag',
      reduce_distribution: 'flag',
      allow: 'none',
      no_action: 'none',
      no_global_effect: 'none',
      restore: 'restore',
      suspend_user: 'review',
      escalate: 'review',
      legal_queue: 'review',
    },
    severityFallback: {
      critical: 'review',
      high: 'restrict',
      medium: 'flag',
      low: 'review',
    },
    absorb: { restrict: ['flag', 'none', 'restore'] },
    precedence: ['restrict', 'restore', 'flag', 'unflag', 'review', 'none'],
    reversibleActions: ['restore', 'unflag'],
    reverses: { restore: 'restrict', unflag: 'flag' },

    async apply({ action, subject, previousState }): Promise<EnforcementEffect<TestAction>> {
      if (action === 'none' || action === 'review') {
        return { changed: false, reason: `Action '${action}' has no effect by definition` };
      }
      if (subject.type !== 'widget') {
        /**
         * A subject type with no lever of its own. `recordedAs` corrects the
         * label so the report does not read "decided: restore" about an object
         * that was never restricted — the plan could not know, and this is the
         * only place that does.
         */
        return {
          changed: false,
          reason: `No '${action}' effect for a ${subject.type}`,
          recordedAs: 'none',
        };
      }
      if (!mongoose.isValidObjectId(subject.id)) {
        return { changed: false, reason: 'The reported widget no longer exists' };
      }
      const widget = await widgets.findById(subject.id).lean<TestWidget | null>();
      if (!widget) return { changed: false, reason: 'The reported widget no longer exists' };

      switch (action) {
        case 'restrict': {
          if (widget.status === 'restricted') {
            return { changed: false, reason: 'The widget was already restricted' };
          }
          await widgets.updateOne({ _id: subject.id }, { $set: { status: 'restricted' } });
          return { changed: true, previousState: { status: widget.status } };
        }
        case 'restore': {
          if (widget.status !== 'restricted') {
            return { changed: false, reason: 'The widget was not restricted' };
          }
          const restoreTo = previousState?.status;
          await widgets.updateOne(
            { _id: subject.id },
            { $set: { status: typeof restoreTo === 'string' ? restoreTo : 'published' } },
          );
          return { changed: true, previousState: { status: 'restricted' } };
        }
        case 'flag': {
          if (widget.flagged) return { changed: false, reason: 'Already flagged' };
          await widgets.updateOne({ _id: subject.id }, { $set: { flagged: true } });
          return { changed: true, previousState: { flagged: false } };
        }
        case 'unflag': {
          if (previousState === undefined) {
            return { changed: false, reason: 'The flag was not set by moderation' };
          }
          if (!widget.flagged) return { changed: false, reason: 'Not flagged' };
          await widgets.updateOne({ _id: subject.id }, { $set: { flagged: false } });
          return { changed: true, previousState: { flagged: true } };
        }
      }
    },
  };
}

function legacyStatusFor(decision: Decision): { legacyStatus: string } {
  switch (decision.outcome) {
    case 'violation':
      return { legacyStatus: 'resolved' };
    case 'no_violation':
      return { legacyStatus: 'dismissed' };
    default:
      return { legacyStatus: 'reviewed' };
  }
}

let databaseCounter = 0;

export async function createHarness(
  options: {
    enabled?: boolean;
    serviceKey?: string;
    baseUrl?: string;
    webhookSecret?: string;
    enforcementMode?: 'observe' | 'manual' | 'automatic';
    subjects?: readonly ModerationSubjectProvider[];
  } = {},
): Promise<Harness> {
  const uri = process.env.CROWDSOURCE_APP_TEST_MONGODB_URI;
  if (uri === undefined) {
    throw new Error(
      'CROWDSOURCE_APP_TEST_MONGODB_URI is unset: vitest.globalSetup.ts did not run.',
    );
  }

  databaseCounter += 1;
  const connection = mongoose.createConnection(uri, {
    dbName: `crowdsource_app_test_${process.pid}_${databaseCounter}`,
  });
  await connection.asPromise();

  const WidgetSchema = new Schema<TestWidget>({
    body: { type: String, required: true },
    ownerId: { type: String, required: true },
    status: { type: String, required: true, default: 'published' },
    flagged: { type: Boolean, required: true, default: false },
  });
  const widgets = connection.model<TestWidget>('Widget', WidgetSchema);

  const ReportSchema = new Schema<TestReport>(
    {
      ...moderationReportSchemaFields({
        reportedTypes: ['widget', 'gizmo', 'doodad'],
        categories: ['spam', 'harassment', 'other'],
      }),
      legacyStatus: { type: String, required: true, default: 'pending' },
    },
    { timestamps: true },
  );
  applyModerationReportIndexes(ReportSchema);
  const reports = connection.model<TestReport>('Report', ReportSchema);

  // The unique indexes are the mechanism under test in several files, so they
  // must exist before the first write rather than whenever mongoose gets round
  // to it.
  await Promise.all([widgets.init(), reports.init()]);

  const logs: Harness['logs'] = [];
  const moderation = createModerationIntegration<TestReport, TestAction>({
    connection,
    crowdSource: {
      enabled: options.enabled ?? true,
      ...(options.serviceKey === undefined ? {} : { serviceKey: options.serviceKey }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.webhookSecret === undefined
        ? {}
        : { webhookSecret: options.webhookSecret }),
      enforcementMode: options.enforcementMode ?? 'automatic',
      outboxPollIntervalMs: 50,
    },
    reportModel: reports,
    subjects: options.subjects ?? [widgetSubjectProvider(widgets), doodadSubjectProvider()],
    taxonomy: testTaxonomy(),
    enforcement: testEnforcement(widgets),
    logger: recordingLogger(logs),
    reportDecisionExtraFields: legacyStatusFor,
  });

  await moderation.models.enforcement.init();
  await moderation.models.event.init();
  await moderation.models.outbox.init();

  return {
    connection,
    widgets,
    reports,
    moderation,
    logs,
    async close() {
      await moderation.dispatcher.stop();
      moderation.reconciliationJob.stop();
      await connection.dropDatabase();
      await connection.close();
    },
  };
}
