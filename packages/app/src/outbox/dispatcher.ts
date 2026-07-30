import type { ModerationLogger, ModerationOutboxEvent } from '../types.js';
import type { ModerationOutboxHandler, OutboxService } from './service.js';

/**
 * The loop that drains the moderation outbox.
 *
 * A bounded interval, one batch in flight at a time, an abort signal that stops
 * claiming new work but lets the event already being handled reach a durable
 * state.
 *
 * It is NOT leader-gated, and that is a property of the claim rather than an
 * oversight. Every event is taken under a lease with an owner check, so N tasks
 * draining the same collection simply share the work — and a task dying
 * mid-delivery has its lease expire and its event reclaimed, which a single
 * leader would not give us.
 *
 * `enabled` gates the LOOP, never the durable record. Reports taken while the
 * integration is off keep their outbox rows and deliver when it is switched on;
 * running the loop instead would count attempts against a deployment that has
 * nowhere to send anything and dead-letter the backlog it was supposed to
 * preserve.
 */

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export class ModerationOutboxDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private running = false;

  constructor(
    private readonly options: {
      outbox: OutboxService;
      handler: ModerationOutboxHandler;
      logger: ModerationLogger;
      enabled: boolean;
      pollIntervalMs?: number;
      batchSize?: number;
    },
  ) {}

  start(): void {
    if (this.running) return;
    if (!this.options.enabled) {
      this.options.logger.info(
        '[CrowdSource] outbox dispatcher not started: the integration is disabled',
      );
      return;
    }
    const intervalMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.running = true;
    this.abortController = new AbortController();
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.options.logger.info('[CrowdSource] outbox dispatcher started', {
      intervalMs,
      batchSize: this.options.batchSize,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    const controller = this.abortController;
    controller?.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    if (this.abortController === controller) {
      this.abortController = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.inFlight) return this.inFlight;
    const work = this.options.outbox
      .dispatch({
        handler: this.options.handler,
        ...(this.options.batchSize === undefined
          ? {}
          : { batchSize: this.options.batchSize }),
        ...(this.abortController === null
          ? {}
          : { signal: this.abortController.signal }),
      })
      .then(({ processed, failed, deadLettered }) => {
        if (processed > 0 || failed > 0) {
          this.options.logger.info('[CrowdSource] outbox batch complete', {
            processed,
            failed,
            deadLettered,
          });
        }
      })
      .catch((error: unknown) => {
        // Claim/database failures happen outside the per-event retry block. Keep
        // the interval alive and avoid an unhandled rejection.
        this.options.logger.error('[CrowdSource] outbox tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    return work;
  }
}

/** Route an event to the worker that owns its kind. */
export function createOutboxRouter(handlers: {
  deliverReport: (event: ModerationOutboxEvent) => Promise<void>;
  applyDecision: (event: ModerationOutboxEvent) => Promise<void>;
}): ModerationOutboxHandler {
  return async (event: ModerationOutboxEvent): Promise<void> => {
    switch (event.kind) {
      case 'report.submit':
        await handlers.deliverReport(event);
        return;
      case 'decision.apply':
        await handlers.applyDecision(event);
        return;
    }
  };
}
