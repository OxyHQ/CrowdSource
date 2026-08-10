import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { config } from '../config';
import * as postgres from '../db/postgres/database';
import { setRuntimeReady } from '../routes/health.routes';
import * as database from '../utils/database';

afterEach(() => {
  setRuntimeReady(false);
  vi.restoreAllMocks();
});

/** Both configured stores healthy — the state every other case departs from. */
function bothStoresHealthy() {
  vi.spyOn(database, 'isDatabaseConnected').mockReturnValue(true);
  return vi.spyOn(postgres, 'pingPostgres').mockResolvedValue(undefined);
}

describe('createApp', () => {
  it('reports liveness regardless of readiness', async () => {
    const response = await request(createApp()).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'live' });
  });

  it('fails readiness until the runtime marks itself ready', async () => {
    bothStoresHealthy();
    const app = createApp();

    const beforeReady = await request(app).get('/health/ready');
    expect(beforeReady.status).toBe(503);
    expect(beforeReady.body.reason).toBe('starting_or_draining');

    setRuntimeReady(true);

    const afterReady = await request(app).get('/health/ready');
    expect(afterReady.status).toBe(200);
    expect(afterReady.body).toEqual({ status: 'ready' });
  });

  it('fails readiness when MongoDB is unavailable, but stays live', async () => {
    bothStoresHealthy();
    const connected = vi.spyOn(database, 'isDatabaseConnected').mockReturnValue(false);
    const app = createApp();
    setRuntimeReady(true);

    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.reason).toBe('database_unavailable');
    expect(ready.body.store).toBe('mongodb');
    expect(connected).toHaveBeenCalled();

    // A task that lost its database must be routed around, not killed.
    const live = await request(app).get('/health/live');
    expect(live.status).toBe(200);
  });

  /**
   * The direction the previous version of this route could not fail in.
   *
   * It asserted MongoDB alone, so once traffic is served from PostgreSQL a
   * PostgreSQL outage would have read as `ready` while every request failed.
   */
  it('fails readiness when PostgreSQL is unavailable, but stays live', async () => {
    bothStoresHealthy();
    const ping = vi
      .spyOn(postgres, 'pingPostgres')
      .mockRejectedValue(new Error('connection refused'));
    const app = createApp();
    setRuntimeReady(true);

    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.reason).toBe('database_unavailable');
    expect(ready.body.store).toBe('postgresql');
    expect(ping).toHaveBeenCalled();

    const live = await request(app).get('/health/live');
    expect(live.status).toBe(200);
  });

  /**
   * The case the MongoDB retirement turns on, and it is the reason the probe
   * says "while configured" rather than naming a store unconditionally.
   *
   * When `MONGODB_URI` leaves the task definition, `isDatabaseConnected` goes
   * false on every task. A probe that still required MongoDB would fail every
   * ALB health check within about ninety seconds, ECS would replace the tasks in
   * a loop, and the service would never stabilise — while every deploy involved
   * reported success, because nothing that was deployed failed. Removing the
   * variable is what stops it being required; no code change has to be timed
   * against a rollout.
   */
  it('does not require MongoDB once it is no longer configured', async () => {
    bothStoresHealthy();
    const connected = vi.spyOn(database, 'isDatabaseConnected').mockReturnValue(false);
    vi.spyOn(config, 'mongoUri', 'get').mockReturnValue(undefined);
    const app = createApp();
    setRuntimeReady(true);

    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });
    expect(connected).not.toHaveBeenCalled();
  });

  it('answers an unmatched route with a structured 404', async () => {
    const response = await request(createApp()).get('/v1/reports');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});
