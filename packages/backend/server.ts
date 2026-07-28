import http from 'node:http';

import { createApp } from './src/app';
import { config } from './src/config';
import { setRuntimeReady } from './src/routes/health.routes';
import { connectToDatabase, disconnectFromDatabase } from './src/utils/database';
import { logger } from './src/utils/logger';
import { assertTransactionalTopology } from './src/utils/mongoTopology';

/**
 * Process bootstrap: connect, listen, drain, exit. Everything the HTTP
 * application needs is built by `createApp`, so this file is the only place
 * with process-level state.
 */

process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
  if (config.isProduction) {
    process.exit(1);
  }
});

process.on('uncaughtException', (error: Error) => {
  logger.error({ err: error }, 'Uncaught exception');
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
  await connectToDatabase();
  // Refuse a deployment that could never honour the outbox, rather than
  // discovering it at the first transactional write.
  await assertTransactionalTopology();

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

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'HTTP server did not close cleanly');
      process.exit(1);
      return;
    }
    disconnectFromDatabase()
      .catch((disconnectError: unknown) => {
        logger.error({ err: disconnectError }, 'MongoDB did not disconnect cleanly');
      })
      .finally(() => {
        process.exit(0);
      });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((error: unknown) => {
  logger.error({ err: error }, 'Failed to start');
  process.exit(1);
});
