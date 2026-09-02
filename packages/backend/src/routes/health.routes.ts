import { Router } from 'express';

import { pingPostgres } from '../db/postgres/database';

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
 *
 * PostgreSQL is the only runtime store and DATABASE_URL is required at boot.
 * The response names it explicitly so an operator can distinguish a database
 * incident from a process that is merely starting or draining.
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

healthRouter.get('/ready', async (_request, response) => {
  if (!runtimeReady) {
    response.status(503).json({ status: 'not_ready', reason: 'starting_or_draining' });
    return;
  }
  try {
    // A real round trip. Every cheaper proxy — pool state, a boot-time flag —
    // answers a different question than "would a query succeed right now", and
    // this route exists to answer that one.
    await pingPostgres();
  } catch {
    response
      .status(503)
      .json({ status: 'not_ready', reason: 'database_unavailable', store: 'postgresql' });
    return;
  }
  response.status(200).json({ status: 'ready' });
});
