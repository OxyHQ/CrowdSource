import { Router } from 'express';

import { isDatabaseConnected } from '../utils/database';

/**
 * Liveness and readiness.
 *
 * `/health/live` answers "is the process running"; `/health/ready` answers "may
 * the load balancer send traffic here". They are separate because a task that
 * has begun draining, or one that has lost its database, must fail readiness
 * while still answering liveness — otherwise the orchestrator kills it instead
 * of routing around it.
 *
 * Readiness re-reads the connection state on every request rather than caching
 * a boot-time result, so a database that drops later is reflected immediately.
 */

let runtimeReady = false;

/** Flipped by the process bootstrap once the server accepts connections. */
export function setRuntimeReady(ready: boolean): void {
  runtimeReady = ready;
}

export const healthRouter: Router = Router();

healthRouter.get('/live', (_request, response) => {
  response.status(200).json({ status: 'live' });
});

healthRouter.get('/ready', (_request, response) => {
  if (!runtimeReady) {
    response.status(503).json({ status: 'not_ready', reason: 'starting_or_draining' });
    return;
  }
  if (!isDatabaseConnected()) {
    response.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
    return;
  }
  response.status(200).json({ status: 'ready' });
});
