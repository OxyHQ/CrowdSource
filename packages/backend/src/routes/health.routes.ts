import { Router } from 'express';

import { config } from '../config';
import { pingPostgres } from '../db/postgres/database';
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
 *
 * ## It asserts EVERY store this deployment is configured for, not one
 *
 * A probe that names one store is wrong in both directions, and this route was
 * an instance: it checked MongoDB alone. That is a problem in each direction at
 * once during the PostgreSQL cutover. Once traffic is served from PostgreSQL, a
 * PostgreSQL outage would read as `ready` while every request fails. And in the
 * other direction — the one that is imminent rather than hypothetical — the
 * shared MongoDB instance is being retired, at which point `isDatabaseConnected`
 * goes false on every task, each fails its ALB health check within about ninety
 * seconds, ECS replaces them in a loop, and the service never stabilises. The
 * whole rolling outage reports success, because nothing deployed failed.
 *
 * So each store is required only WHILE CONFIGURED. `MONGODB_URI` carries no
 * default (see `config/index.ts`), so its absence is a real signal rather than a
 * fallback value that cannot answer the question — which means removing it from
 * the task definition is what stops MongoDB being required, with no code change
 * that has to be timed against a rollout. `DATABASE_URL` is required to boot, so
 * PostgreSQL is always asserted.
 *
 * The reason is NAMED in the response. "Not ready" tells an operator nothing at
 * three in the morning; `database_unavailable` on `postgresql` versus on
 * `mongodb` is the difference between two incidents with different first moves.
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
  if (config.mongoUri !== undefined && !isDatabaseConnected()) {
    response
      .status(503)
      .json({ status: 'not_ready', reason: 'database_unavailable', store: 'mongodb' });
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
