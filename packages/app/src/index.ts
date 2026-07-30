/**
 * `@oxyhq/crowdsource-app` — the application half of a CrowdSource integration.
 *
 * An application that adopts CrowdSource has to solve the same six problems
 * every other application does: store a report and its promise of delivery
 * atomically, deliver it with retries and a dead-letter path, receive signed
 * decisions without a body parser destroying the signature, deduplicate
 * redeliveries across several tasks, apply a decision without a stale revision
 * overwriting a fresh one, and carry out consequences exactly once and
 * reversibly. None of that has anything to do with what the application's
 * objects are.
 *
 * So all of it is here, and an application supplies four things:
 *
 * ```ts
 * const moderation = createModerationIntegration({
 *   connection,
 *   crowdSource: { enabled: true, serviceKey, webhookSecret, enforcementMode: 'observe' },
 *   reportModel,
 *   subjects: [listingSubjectProvider(), reviewSubjectProvider()],
 *   taxonomy: { version: '2026.07', allegationsFor },
 *   enforcement: commerceEnforcement,
 *   logger,
 * });
 *
 * // BEFORE express.json() — the signature covers the bytes that arrived.
 * app.use('/webhooks', moderation.webhookRouter());
 * app.use(express.json());
 *
 * moderation.dispatcher.start();
 * ```
 *
 * Two invariants are ENFORCED here rather than documented, because both fail
 * silently and neither shows up in a test that only asserts the happy path:
 *
 * 1. Nothing can be enqueued that is not already recorded in the outbox, in the
 *    same transaction. {@link ModerationOutboxTransactionError} is thrown by the
 *    only writer of that collection when its session is not in a transaction.
 * 2. The webhook receiver reads raw bytes. Mounted after a JSON parser it
 *    refuses rather than verifying a signature over a re-serialisation.
 *
 * Types come from `@oxyhq/crowdsource-contracts` and `@oxyhq/crowdsource`. This
 * package re-exports none of them: a `Decision` or a `TaxonomyCode` has exactly
 * one definition.
 */

export { createModerationIntegration } from './integration';
export type { ModerationIntegration } from './integration';

export {
  moderationReportSchemaFields,
  applyModerationReportIndexes,
  MODERATION_LOCAL_STATUSES,
} from './models/report';
export type { ModerationReportSchemaOptions } from './models/report';

export {
  MODERATION_ENFORCEMENT_COLLECTION,
  MODERATION_EVENT_COLLECTION,
  MODERATION_EVENT_RETENTION_SECONDS,
  MODERATION_OUTBOX_COLLECTION,
  MODERATION_OUTBOX_RETENTION_SECONDS,
} from './models';
export type {
  ModerationEnforcementDocument,
  ModerationEventDocument,
  ModerationEventState,
  ModerationModels,
  ModerationOutboxDocument,
} from './models';

export {
  ModerationOutboxTransactionError,
  decisionApplyEventId,
  isRetryableDeliveryError,
  reportSubmitEventId,
} from './outbox/service';
export type {
  ModerationOutboxFailure,
  ModerationOutboxHandler,
  OutboxService,
} from './outbox/service';

export { ModerationOutboxDispatcher } from './outbox/dispatcher';
export { ModerationReconciliationJob } from './reconciliation';
export type { ReconcileModerationReports } from './reconciliation';

export { DuplicateReportError } from './intake';

export {
  CrowdSourceUnavailableError,
  ModerationDeliveryRejectedError,
} from './delivery';

export {
  ModerationDecisionDeferredError,
  ModerationDecisionRejectedError,
} from './decision';

export {
  ModerationSubjectUnsupportedError,
  ModerationTaxonomyError,
  createSubjectRegistry,
  snapshotHash,
} from './evidence';
export type { ModerationReportInput, SubjectRegistry } from './evidence';

export { planEnforcement, primaryAction } from './enforcement/planner';
export type { EnforcementExecutor } from './enforcement/executor';

export { localStatusForDecision } from './reportStatus';

export { createProcessedEventStore } from './inbound';
export type { InboundService, RecordDecisionEventInput } from './inbound';

export type {
  CreateReportInput,
  CreateReportResult,
  CrowdSourceConnectionConfig,
  EnforcementEffect,
  EnforcementOutcome,
  EnforcementPreviousState,
  EnforcementSubject,
  ModerationContextResource,
  ModerationDispatchResult,
  ModerationEnforcementConfig,
  ModerationEnforcementMode,
  ModerationIntegrationConfig,
  ModerationLocalStatus,
  ModerationLogger,
  ModerationMetrics,
  ModerationOutboxEvent,
  ModerationOutboxKind,
  ModerationOutboxPayload,
  ModerationOutboxStatus,
  ModerationReconciliationResult,
  ModerationReportFields,
  ModerationResource,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
  ModerationTaxonomy,
  PlannedEnforcementAction,
  ReportDecisionExtraFields,
} from './types';
