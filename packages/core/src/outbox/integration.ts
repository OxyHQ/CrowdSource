import type { Router } from 'express';
import { createClientProvider, type CrowdSourceClientProvider } from './client.js';
import { createDecisionWorker } from './decision.js';
import { createDeliveryWorker } from './delivery.js';
import { createEnforcementExecutor, type EnforcementExecutor } from './enforcement/executor.js';
import { assertRestoreDirection } from './enforcement/planner.js';
import { createSubjectRegistry, type SubjectRegistry } from './evidence.js';
import { createInboundService, createProcessedEventStore } from './inbound.js';
import { ModerationOutboxDispatcher, createOutboxRouter } from './outbox/dispatcher.js';
import { createOutboxService } from './outbox/service.js';
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
 * stylistic: a module-level client, dispatcher or registry cannot be built
 * twice, which makes two integrations in one test process impossible and makes
 * test isolation depend on module-registry surgery. The store is built OUTSIDE
 * and passed in, so the same wiring serves either backend and neither is
 * reachable from here.
 *
 * `TTx` is deliberately absent from the returned interface. It is inferred from
 * the config's store, used only inside this factory, and never surfaces — so a
 * caller holding a `ModerationIntegration` cannot tell which backend built it,
 * which is what lets one test suite run against both.
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

  readonly registry: SubjectRegistry;
  readonly enforcement: EnforcementExecutor<TAction>;
  readonly client: CrowdSourceClientProvider;
}

export function createModerationIntegration<
  TReport extends ModerationReportFields,
  TAction extends string,
  TTx,
>(
  config: ModerationIntegrationConfig<TReport, TAction, TTx>,
): ModerationIntegration<TReport, TAction> {
  /**
   * Refuse an inverted `restoreAction` before anything is wired. It cannot be
   * caught by the type — both directions are `TAction[]` — and it does not fail
   * at runtime; it applies a punishment on an accepted appeal.
   */
  assertRestoreDirection(config.enforcement);

  const store = config.store;
  const outbox = createOutboxService({ store: store.outbox, logger: config.logger });
  const registry = createSubjectRegistry(config.subjects);
  const client = createClientProvider({
    config: config.crowdSource,
    logger: config.logger,
  });

  const enforcement = createEnforcementExecutor<TAction>({
    enforcement: store.enforcement,
    config: config.enforcement,
    defaultMode: config.crowdSource.enforcementMode,
    logger: config.logger,
    ...(config.metrics === undefined ? {} : { metrics: config.metrics }),
  });

  const deliverReport = createDeliveryWorker({
    reports: store.reports,
    registry,
    taxonomy: config.taxonomy,
    client,
    logger: config.logger,
    ...(config.metrics === undefined ? {} : { metrics: config.metrics }),
  });

  const applyDecision = createDecisionWorker({
    reports: store.reports,
    executor: enforcement,
    enforcement: config.enforcement,
    logger: config.logger,
    ...(config.reportDecisionExtraFields === undefined
      ? {}
      : { reportDecisionExtraFields: config.reportDecisionExtraFields }),
  });

  const inbound = createInboundService({
    transaction: store.transaction,
    events: store.events,
    outbox,
  });

  const reconcile = createReconciliation({
    transaction: store.transaction,
    reports: store.reports,
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
    createReport: createIntake({
      transaction: store.transaction,
      reports: store.reports,
      registry,
      outbox,
    }),

    webhookRouter(options = {}) {
      return createWebhookRouter({
        inbound,
        store: createProcessedEventStore(store.events),
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
    registry,
    enforcement,
    client,
  };
}
