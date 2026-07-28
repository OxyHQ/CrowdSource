import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { API_ERROR_STATUS, ApiError, isApiError } from '../http/apiError';
import { errorHandler, notFoundHandler } from '../http/errorHandler';
import { requestTenant } from '../modules/tenancy/serviceCredentialAuth';
import { newPublicId, isPublicId } from '../utils/identifiers';
import { logger } from '../utils/logger';

/**
 * §10.5 is a contract, not a convention: an integrator's retry logic branches on
 * these codes, so answering the wrong one turns a recoverable delivery into lost
 * moderation work (a 500 invites a retry that a 400 should have stopped, and a
 * 503 is the one code that means "come back").
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** An application that throws whatever a test hands it, through the real handler. */
function appThrowing(error: unknown) {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.get('/boom', () => {
    throw error;
  });
  app.post('/echo', (_request, response) => response.status(200).json({ ok: true }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('ApiError', () => {
  it('maps every code to the status §10.5 assigns it', () => {
    expect(API_ERROR_STATUS).toMatchObject({
      invalid_request: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      payload_too_large: 413,
      unprocessable_envelope: 422,
      rate_limited: 429,
      service_unavailable: 503,
    });
  });

  it('carries details only when given them', () => {
    expect(new ApiError('conflict', 'Reused.').toResponseBody()).toEqual({
      error: { code: 'conflict', message: 'Reused.' },
    });
    expect(new ApiError('conflict', 'Reused.', { field: 'externalReportId' }).toResponseBody()).toEqual(
      { error: { code: 'conflict', message: 'Reused.', details: { field: 'externalReportId' } } },
    );
  });

  it('recognises its own instances and nothing else', () => {
    expect(isApiError(new ApiError('not_found', 'x'))).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
    expect(isApiError({ code: 'not_found', status: 404 })).toBe(false);
  });
});

describe('errorHandler', () => {
  it('answers an ApiError with its own status and body', async () => {
    const response = await request(appThrowing(new ApiError('conflict', 'Already delivered.'))).get(
      '/boom',
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: 'conflict', message: 'Already delivered.' } });
  });

  it('challenges on 401 so a client knows what to present', async () => {
    const response = await request(appThrowing(new ApiError('unauthorized', 'No.'))).get('/boom');

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer realm="crowdsource"');
  });

  it('answers an unexpected failure with 500 and reveals nothing about it', async () => {
    const secret = 'reported text that must never be echoed';
    const response = await request(appThrowing(new Error(secret))).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });

  it('classifies an oversized body as 413 rather than a server fault', async () => {
    const response = await request(appThrowing(new Error('unused')))
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(4_000) }));

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('payload_too_large');
  });

  it('classifies malformed JSON as 400 rather than a server fault', async () => {
    const response = await request(appThrowing(new Error('unused')))
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"unterminated": ');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('classifies an unsupported content encoding as 400', async () => {
    // Driven directly rather than through a crafted request: the property under
    // test is the classification, and body-parser's own trigger for it varies
    // with the platform's zlib.
    const response = await request(
      appThrowing(Object.assign(new Error('unsupported encoding'), { type: 'encoding.unsupported' })),
    ).get('/boom');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('does not treat an error with an unrelated `type` as a body-parser failure', async () => {
    const response = await request(
      appThrowing(Object.assign(new Error('something else'), { type: 'other' })),
    ).get('/boom');

    expect(response.status).toBe(500);
  });

  it('logs a server-side condition and still answers the caller', async () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const response = await request(
      appThrowing(new ApiError('service_unavailable', 'Retry this delivery.')),
    ).get('/boom');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('service_unavailable');
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('does not log an ordinary caller error', async () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await request(appThrowing(new ApiError('conflict', 'Already delivered.'))).get('/boom');

    expect(logged).not.toHaveBeenCalled();
  });

  it('delegates a response that already began instead of sending a second one', async () => {
    const app = express();
    app.get('/partial', (_request, response) => {
      response.status(200);
      response.write('{"partial":');
      throw new ApiError('conflict', 'too late');
    });
    app.use(errorHandler);

    // Writing headers twice would throw inside the handler and take the process
    // with it. Express's default handler destroys the socket instead, so the
    // observable outcome is a failed request that never carries the error body.
    const outcome = await request(app)
      .get('/partial')
      .then((response) => response.text)
      .catch((error: unknown) => String(error));

    expect(outcome).not.toContain('"code":"conflict"');
  });
});

describe('a route mounted without its credential middleware', () => {
  it('fails loudly rather than serving a request with no tenant', async () => {
    const app = express();
    app.get('/unguarded', (request, response) => {
      response.json({ tenant: requestTenant(request) });
    });
    app.use(errorHandler);

    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const response = await request(app).get('/unguarded');

    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalled();
  });
});

describe('the application shell', () => {
  it('answers an unmatched route with the structured 404', async () => {
    const response = await request(createApp()).get('/v1/nothing-here');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });
});

describe('public identifiers', () => {
  it('mints non-sequential, prefixed ids', () => {
    const first = newPublicId('report');
    const second = newPublicId('report');

    expect(first).toMatch(/^rpt_[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
    expect(isPublicId('report', first)).toBe(true);
  });

  it('does not accept one kind of id where another belongs', () => {
    expect(isPublicId('report', newPublicId('credential'))).toBe(false);
    expect(isPublicId('organization', 'org_not-hex')).toBe(false);
    expect(isPublicId('organization', '')).toBe(false);
  });
});
