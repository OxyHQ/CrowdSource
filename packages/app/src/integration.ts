import type { Router } from 'express';
import { createClientProvider, type CrowdSourceClientProvider } from './client.js';
import { createDecisionWorker } from './decision.js';
import { createDeliveryWorker } from './delivery.js';
import { createEnforcementExecutor, type EnforcementExecutor } from './enforcement/executor.js';
import { assertRestoreDirection } from './enforcement/planner.js';
import { createSubjectRegistry, type SubjectRegistry } from './evidence.js';
import { createInboundService, createProcessedEventStore } from './inbound.js';
import { registerModerationModels, type ModerationModels } from './models/index.js';
import { ModerationOutboxDispatcher, createOutboxRouter } from './outbox/dispatcher.js';
import { createOutboxService, type OutboxService } from './outbox/service.js';
import { createIntake } from './intake.js';
import {
  ModerationReconciliationJob,
  createReconciliation,
  type ReconcileModerationReports,
} from './reconciliation.js';
import { createWebhookRouter } from './webhook.js';
import type {
  CreateReportInput,
  CreateReportResult,
  ModerationIntegrationConfig,
  ModerationReportFields,
} from './types.js';

/**
 * Everything wired together, from one object.
 *
 * A factory rather than a set of module-level singletons, and that is not
 * stylistic. Mongoose's `mongoose.model()` registers on the DEFAULT connection,
 * so a package that used it would put its collections on whichever connection
 * happened to be default rather than the application's; and a module-level
 * client, dispatcher or registry cannot be built twice, which makes two
 * integrations in one test process impossible and makes test isolation depend on
 * module-registry surgery.
 */
export interface ModerationIntegration<
  TReport extends ModerationReportFields,
  TAction extends string,
> {
  /**
   * Store a report and, when there is somewhere to send it, the promise to
   * deliver it — in ONE transaction.
   *
   * Throws `DuplicateReportError` when this reporter already reported this
   * object, and `TypeError` for an identifier that is not a non-empty string.
   */
  createReport(input: CreateReportInput): Promise<CreateReportResult<TReport>>;

  /**
   * The webhook receiver. **Mount this BEFORE `express.json()`** — the signature
   * covers the bytes that arrived, and a parser destroys them.
   *
   * Returns an empty router when no webhook secret is configured: an
   * unconfigured deployment 404s, which is indistinguishable from not having the
   * feature.
   */
  webhookRouter(options?: { path?: string }): Router;

  /**
   * The outbox loop. Safe on every task — every event is claimed under a lease
   * with an owner check, so N tasks share the work.
   */
  readonly dispatcher: ModerationOutboxDispatcher;

  /**
   * The reconciliation sweep on a timer. Start it from a LEADER-elected
   * scheduler only.
   */
  readonly reconciliationJob: ModerationReconciliationJob;

  /** One reconciliation sweep, on demand. */
  readonly reconcile: ReconcileModerationReports;

  /** The reported types that have a subject provider, so a test can pin the set. */
  deliverableTypes(): string[];

  readonly models: ModerationModels;
  readonly outbox: OutboxService;
  readonly registry: SubjectRegistry;
  readonly enforcement: EnforcementExecutor<TAction>;
  readonly client: CrowdSourceClientProvider;
}

export function createModerationIntegration<
  TReport extends ModerationReportFields,
  TAction extends string,
>(
  config: ModerationIntegrationConfig<TReport, TAction>,
): ModerationIntegration<TReport, TAction> {
  /**
   * Refuse an inverted `restoreAction` before anything is wired. It cannot be
   * caught by the type — both directions are `TAction[]` — and it does not fail
   * at runtime; it applies a punishment on an accepted appeal.
   */
  assertRestoreDirection(config.enforcement);

  const models = registerModerationModels({
    connection: config.connection,
    enforcementActions: config.enforcement.actions,
    ...(config.modelPrefix === undefined ? {} : { modelPrefix: config.modelPrefix }),
  });

  const outbox = createOutboxService({ model: models.outbox, logger: config.logger });
  const registry = createSubjectRegistry(config.subjects);
  const client = createClientProvider({
    config: config.crowdSource,
    logger: config.logger,
  });

  const enforcement = createEnforcementExecutor<TAction>({
    model: models.enforcement,
    config: config.enforcement,
    defaultMode: config.crowdSource.enforcementMode,
    logger: config.logger,
    ...(config.metrics === undefined ? {} : { metrics: config.metrics }),
  });

  const deliverReport = createDeliveryWorker<TReport>({
    reportModel: config.reportModel,
    registry,
    taxonomy: config.taxonomy,
    client,
    logger: config.logger,
    ...(config.metrics === undefined ? {} : { metrics: config.metrics }),
  });

  const applyDecision = createDecisionWorker<TReport, TAction>({
    reportModel: config.reportModel,
    executor: enforcement,
    enforcement: config.enforcement,
    logger: config.logger,
    ...(config.reportDecisionExtraFields === undefined
      ? {}
      : { reportDecisionExtraFields: config.reportDecisionExtraFields }),
  });

  const inbound = createInboundService({
    connection: config.connection,
    model: models.event,
    outbox,
  });

  const reconcile = createReconciliation<TReport>({
    connection: config.connection,
    reportModel: config.reportModel,
    outbox,
    logger: config.logger,
    ...(config.crowdSource.staleSubmittedHours === undefined
      ? {}
      : { staleSubmittedHours: config.crowdSource.staleSubmittedHours }),
  });

  const dispatcher = new ModerationOutboxDispatcher({
    outbox,
    handler: createOutboxRouter({ deliverReport, applyDecision }),
    logger: config.logger,
    enabled: config.crowdSource.enabled,
    ...(config.crowdSource.outboxPollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: config.crowdSource.outboxPollIntervalMs }),
    ...(config.crowdSource.outboxBatchSize === undefined
      ? {}
      : { batchSize: config.crowdSource.outboxBatchSize }),
  });

  const reconciliationJob = new ModerationReconciliationJob({
    reconcile,
    logger: config.logger,
    enabled: config.crowdSource.enabled,
    ...(config.crowdSource.reconciliationIntervalMs === undefined
      ? {}
      : { intervalMs: config.crowdSource.reconciliationIntervalMs }),
  });

  return {
    createReport: createIntake<TReport>({
      connection: config.connection,
      reportModel: config.reportModel,
      registry,
      outbox,
    }),

    webhookRouter(options = {}) {
      return createWebhookRouter({
        inbound,
        store: createProcessedEventStore(models.event),
        ...(config.crowdSource.webhookSecret === undefined
          ? {}
          : { secret: config.crowdSource.webhookSecret }),
        ...(config.crowdSource.webhookPreviousSecret === undefined
          ? {}
          : { previousSecret: config.crowdSource.webhookPreviousSecret }),
        logger: config.logger,
        ...(config.metrics === undefined ? {} : { metrics: config.metrics }),
        ...(options.path === undefined ? {} : { path: options.path }),
      });
    },

    dispatcher,
    reconciliationJob,
    reconcile,
    deliverableTypes: () => registry.deliverableTypes(),
    models,
    outbox,
    registry,
    enforcement,
    client,
  };
}
