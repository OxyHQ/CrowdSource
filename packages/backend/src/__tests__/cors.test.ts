import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app';

/**
 * CORS is enforced by `createOxyCors` from `@oxyhq/core/server`, and these
 * cases exist because its failure is invisible from the server side: the
 * request succeeds, the response is correct, and the BROWSER discards it. No
 * log, no status code, no test that exercises a route will ever notice.
 *
 * The reviewer app is a browser client on a different origin from the API, so
 * every reviewer route reaches this middleware before it reaches its handler.
 */
describe('CORS', () => {
  const app = createApp();

  it('allows the reviewer app', async () => {
    const response = await request(app)
      .options('/v1/reviewer/profile')
      .set('Origin', 'https://crowdsource.oxy.so')
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://crowdsource.oxy.so');
  });

  it('answers a preflight before the route exists, so a 404 cannot mask a CORS failure', async () => {
    const response = await request(app)
      .options('/v1/there-is-no-such-route')
      .set('Origin', 'https://crowdsource.oxy.so')
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(204);
  });

  it('refuses an origin outside the allowlist rather than reflecting it', async () => {
    const response = await request(app)
      .options('/v1/reviewer/profile')
      .set('Origin', 'https://not-oxy.example')
      .set('Access-Control-Request-Method', 'GET');

    // The absence of the header is the denial: a reflected origin here would be
    // an allowlist that allows everything.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('varies on Origin, so a proxy cannot serve one caller the answer meant for another', async () => {
    const response = await request(app)
      .get('/health/live')
      .set('Origin', 'https://crowdsource.oxy.so');

    expect(response.headers['vary']).toContain('Origin');
  });
});
