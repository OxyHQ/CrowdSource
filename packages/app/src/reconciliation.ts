import type { Connection, Model } from 'mongoose';
import { reportSubmitEventId, type OutboxService } from './outbox/service.js';
import type {
  ModerationLogger,
  ModerationReconciliationResult,
  ModerationReportFields,
} from './types.js';

/**
 * Finding the reports the pipeline lost sight of.
 *
 * The outbox makes delivery durable, not infallible. Four divergences are
 * possible and none of them announces itself:
 *
 * 1. A report that should have a delivery event and does not — one whose event
 *    was dropped by a retention TTL while the deployment was down for longer
 *    than the retention window, or one whose enqueue was lost to an operator's
 *    intervention.
 * 2. A report stuck at `delivery_failed` whose outbox event has been
 *    dead-lettered. That one is not re-queued: something about the payload has
 *    to change first, and re-queueing it would spin. It is COUNTED, because the
 *    count is the alert.
 * 3. A report `submitted` long ago whose case never came back. Nothing to do
 *    locally — the decision is CrowdSource's to publish — but a rising count is
 *    how a broken webhook endpoint or a rotated secret becomes visible before
 *    somebody notices a quiet moderation queue.
 * 4. A report that was never going anywhere: `received`, because its type has no
 *    subject provider, or because it predates the integration. This is the one
 *    divergence that is not a fault, so it is counted and NEVER re-queued —
 *    re-deriving a delivery event for a report nothing can describe would send
 *    it straight to the dead-letter queue and turn a deliberate local-only
 *    report into a recurring alert. Counting it is still worth doing: it is the
 *    only number that makes "reports stored here that no jury will ever see"
 *    visible at all, and that is precisely the cost of accepting them.
 *
 * A sweep only ever RE-DERIVES work from the reports; it never invents any.
 * Everything it enqueues uses the same deterministic event id as the original,
 * so a report that did have an event is untouched rather than delivered twice.
 */

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1_000;
const DEFAULT_STALE_SUBMITTED_HOURS = 72;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1_000;

const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};

export type ReconcileModerationReports = (options?: {
  batchSize?: number;
  now?: Date;
}) => Promise<ModerationReconciliationResult>;

/**
 * One sweep. Bounded, idempotent, safe to run on every task.
 *
 * Reads `queued` and `delivery_failed` reports oldest-first — the index on
 * `{ localStatus, createdAt }` exists for this query — and re-enqueues only
 * those with no outbox event at all.
 */
export function createReconciliation<TReport extends ModerationReportFields>(input: {
  connection: Connection;
  reportModel: Model<TReport>;
  outbox: OutboxService;
  logger: ModerationLogger;
  staleSubmittedHours?: number;
}): ReconcileModerationReports {
  const staleHours = input.staleSubmittedHours ?? DEFAULT_STALE_SUBMITTED_HOURS;

  return async (options = {}) => {
    const batchSize = Math.min(
      Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE),
      MAX_BATCH_SIZE,
    );
    const now = options.now ?? new Date();
    const result: ModerationReconciliationResult = {
      requeued: 0,
      deadLettered: 0,
      awaitingDecision: 0,
      localOnly: 0,
    };

    /**
     * `queued` and `delivery_failed` only. `received` is excluded deliberately
     * and the omission is the safety property, not an oversight: those reports
     * have no subject provider, so an event re-derived for one would fail as
     * `ModerationSubjectUnsupportedError` on its first attempt and dead-letter.
     * They are counted below instead.
     */
    const pending = await input.reportModel
      .find({ localStatus: { $in: ['queued', 'delivery_failed'] } })
      .select('_id')
      .sort({ createdAt: 1 })
      .limit(batchSize)
      .lean<{ _id: unknown }[]>();

    for (const report of pending) {
      const reportId = String(report._id);
      const eventId = reportSubmitEventId(reportId);
      const status = await input.outbox.statusOf(eventId);

      if (status === 'dead_letter') {
        result.deadLettered += 1;
        continue;
      }
      if (status !== null) continue;

      /**
       * A transaction for a single upsert, for consistency with intake rather
       * than for atomicity: the enqueue requires a session precisely so that no
       * path in this package can write an outbox event outside one. A signature
       * that made the session optional would be the crack the next caller slips
       * through.
       */
      const session = await input.connection.startSession();
      try {
        await session.withTransaction(async () => {
          await input.outbox.enqueue(
            { eventId, kind: 'report.submit', payload: { reportId } },
            session,
          );
        }, TRANSACTION_OPTIONS);
        result.requeued += 1;
      } finally {
        await session.endSession();
      }
    }

    result.awaitingDecision = await input.reportModel.countDocuments({
      localStatus: 'submitted',
      submittedAt: { $lt: new Date(now.getTime() - staleHours * 60 * 60 * 1_000) },
    });
    result.localOnly = await input.reportModel.countDocuments({
      localStatus: 'received',
    });

    if (result.requeued > 0 || result.deadLettered > 0) {
      input.logger.warn('[CrowdSource] reconciliation found divergence', { ...result });
    } else if (result.awaitingDecision > 0 || result.localOnly > 0) {
      input.logger.info('[CrowdSource] reports with no decision to apply', {
        awaitingDecision: result.awaitingDecision,
        olderThanHours: staleHours,
        localOnly: result.localOnly,
      });
    }

    return result;
  };
}

/**
 * The reconciliation sweep, on a timer.
 *
 * Start it from a LEADER-elected scheduler only. Unlike the outbox dispatcher,
 * whose per-event lease makes it safe on every task, this sweep scans and counts
 * across the whole collection; running it on every task would multiply that work
 * by the task count for no benefit.
 *
 * Long interval on purpose. It is a safety net for divergences the durable path
 * is supposed to prevent, not a delivery mechanism — a report that needs this
 * sweep to be delivered is already a report something went wrong with.
 */
export class ModerationReconciliationJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;

  constructor(
    private readonly options: {
      reconcile: ReconcileModerationReports;
      logger: ModerationLogger;
      enabled: boolean;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.running) return;
    if (!this.options.enabled) return;
    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.options.logger.info('[CrowdSource] reconciliation job started', { intervalMs });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    const work = this.options
      .reconcile()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.logger.error('[CrowdSource] reconciliation sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    await work;
  }
}
