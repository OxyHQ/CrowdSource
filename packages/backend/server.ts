import http from 'node:http';

import { createApp } from './src/app';
import { config } from './src/config';
import { closePostgresDatabase, pingPostgres } from './src/db/postgres/database';
import {
  startOutboxDispatcher,
  stopOutboxDispatcher,
} from './src/modules/outbox/outbox.dispatcher';
import { registerOutboxWorkers } from './src/modules/outbox/workers';
import {
  startWebhookDeliveryWorker,
  stopWebhookDeliveryWorker,
} from './src/modules/webhooks/delivery.worker';
import { webhookSecretStorageConfigured } from './src/modules/webhooks/secretCipher';
import {
  startAssignmentExpirySweep,
  stopAssignmentExpirySweep,
} from './src/modules/sortition/assignment.service';
import { setRuntimeReady } from './src/routes/health.routes';
import { logger } from './src/utils/logger';

/**
 * Process bootstrap: connect, listen, drain, exit. Everything the HTTP
 * application needs is built by `createApp`, so this file is the only place
 * with process-level state.
 */

process.on('unhandledRejection', (_reason: unknown) => {
  logger.error({ classification: 'unhandled_rejection' }, 'Unhandled promise rejection');
  if (config.isProduction) {
    process.exit(1);
  }
});

process.on('uncaughtException', (_error: Error) => {
  logger.error({ classification: 'uncaught_exception' }, 'Uncaught exception');
  // The process state is unreliable after this point; never keep serving.
  process.exit(1);
});

const server = http.createServer(createApp());

/**
 * Connect BEFORE listening. A task that accepts traffic without its database
 * answers requests it cannot serve, and the rollout looks healthy while every
 * request fails.
 */
async function start(): Promise<void> {
  /**
   * Reach PostgreSQL once, before anything can serve a request against it.
   *
   * This matters because of how this store fails. Under `FORCE` row security a
   * scoped read on an unreachable or misconfigured database does not error — the whole
   * tenant boundary is evaluated against runtime parameters, and a statement
   * that matches nothing returns ZERO ROWS. Zero rows is an entirely ordinary
   * answer, so a task that never had a working database would serve traffic,
   * pass every check that looks at HTTP status, and tell customers they have no
   * cases. Boot is the last moment that failure is loud.
   */
  await pingPostgres();
  /**
   * The outbox is the durable record of pending moderation work (§12.5), and
   * this loop is what moves it. Registration first, then the timer: a dispatcher
   * running with no handlers would mark every row dispatched and the work would
   * be silently dropped.
   *
   * Both live here and not in `app.ts`, because starting a timer is process
   * state — an application built for a test must not leave one running.
   */
  registerOutboxWorkers();
  startOutboxDispatcher();

  /**
   * Webhook delivery (§10.9). A second loop rather than a step inside the first:
   * the dispatcher turns an internal event into delivery ROWS in one quick pass,
   * while a delivery waits on a retry ladder that reaches twenty-four hours, and
   * putting a slow receiver inside the dispatcher's pass would let one endpoint
   * hold up every other tenant's triage.
   */
  startWebhookDeliveryWorker();

  /**
   * Said once, loudly, at boot rather than discovered at the first registration.
   *
   * The key is deliberately not required — see `config/index.ts` — so this is
   * the only place a deployment learns that webhook management will answer 503
   * until the secret is set. Nothing is degraded silently: no endpoint can be
   * registered without a secret, so no delivery can go out unsigned.
   */
  if (!webhookSecretStorageConfigured()) {
    logger.warn(
      'WEBHOOK_SECRET_ENCRYPTION_KEY is unset: webhook endpoint registration and rotation will answer 503.',
    );
  }

  /**
   * §8.7: an assignment that expires must produce a replacement, or the panel
   * sits one member below its own threshold forever. The sweep only marks rows
   * and writes outbox events — the replacement draw itself is a consumer — so a
   * task that dies mid-sweep costs a minute, not a juror.
   */
  startAssignmentExpirySweep();

  await new Promise<void>((resolve) => {
    server.listen(config.port, resolve);
  });

  setRuntimeReady(true);
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'CrowdSource backend listening');
}

/**
 * Fail readiness first so the load balancer stops sending new requests, then
 * close once in-flight requests finish. A second signal is not honoured: the
 * orchestrator's own kill timer is the escape hatch.
 */
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Shutting down');
  setRuntimeReady(false);
  // Claim nothing new. Anything already leased is re-claimable by another task
  // once the lease expires, so a shutdown mid-handler is a delay rather than a
  // stranded row.
  stopOutboxDispatcher();
  stopWebhookDeliveryWorker();
  stopAssignmentExpirySweep();

  server.close((error) => {
    if (error) {
      logger.error({ classification: 'http_server_close_failed' }, 'HTTP server did not close cleanly');
      process.exit(1);
      return;
    }
    Promise.allSettled([closePostgresDatabase()])
      .then(([postgres]) => {
        if (postgres.status === 'rejected') {
          logger.error(
            { classification: 'postgres_disconnect_failed' },
            'PostgreSQL did not disconnect cleanly',
          );
        }
      })
      .finally(() => {
        process.exit(0);
      });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((_error: unknown) => {
  logger.error({ classification: 'startup_failed' }, 'Failed to start');
  process.exit(1);
});
