import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { setRuntimeReady } from '../routes/health.routes';
import * as database from '../utils/database';

afterEach(() => {
  setRuntimeReady(false);
  vi.restoreAllMocks();
});

describe('createApp', () => {
  it('reports liveness regardless of readiness', async () => {
    const response = await request(createApp()).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'live' });
  });

  it('fails readiness until the runtime marks itself ready', async () => {
    vi.spyOn(database, 'isDatabaseConnected').mockReturnValue(true);
    const app = createApp();

    const beforeReady = await request(app).get('/health/ready');
    expect(beforeReady.status).toBe(503);
    expect(beforeReady.body.reason).toBe('starting_or_draining');

    setRuntimeReady(true);

    const afterReady = await request(app).get('/health/ready');
    expect(afterReady.status).toBe(200);
    expect(afterReady.body).toEqual({ status: 'ready' });
  });

  it('fails readiness when the database is unavailable, but stays live', async () => {
    const connected = vi.spyOn(database, 'isDatabaseConnected').mockReturnValue(false);
    const app = createApp();
    setRuntimeReady(true);

    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.reason).toBe('database_unavailable');
    expect(connected).toHaveBeenCalled();

    // A task that lost its database must be routed around, not killed.
    const live = await request(app).get('/health/live');
    expect(live.status).toBe(200);
  });

  it('answers an unmatched route with a structured 404', async () => {
    const response = await request(createApp()).get('/v1/reports');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});
