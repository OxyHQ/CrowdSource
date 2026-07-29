import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { SsrfRejection } from '@oxyhq/core/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  currentWebhookTransport,
  resetWebhookTransport,
  setWebhookTransport,
} from '../modules/webhooks/delivery.worker';
import { readBoundedBody, safeFetchTransport } from '../modules/webhooks/transport';

/**
 * The outbound hop, and the seam that must never become the production path.
 *
 * The delivery worker takes an injectable transport, because no test can reach
 * a real endpoint through `safeFetch` — every address a test could bind is one
 * `safeFetch` refuses, which is the whole point of it. That seam is a risk: a
 * default quietly replaced would leave SSRF defence in a test double. So the
 * default is PINNED here, and the SSRF refusal is driven through the real
 * production transport rather than described.
 */

describe('the transport a delivery actually uses', () => {
  it('is the safeFetch-backed one by default', () => {
    expect(currentWebhookTransport()).toBe(safeFetchTransport);
  });

  it('is restored after a test replaces it', () => {
    setWebhookTransport(async () => ({ status: 200, body: '', retryAfter: undefined }));
    expect(currentWebhookTransport()).not.toBe(safeFetchTransport);

    resetWebhookTransport();
    expect(currentWebhookTransport()).toBe(safeFetchTransport);
  });
});

describe('the production transport refuses an internal target', () => {
  /**
   * Literal addresses, so the refusal is decided without DNS and the assertion
   * is about the guard rather than about a resolver. The cloud metadata service
   * is the one that matters most: an endpoint pointed at it would hand a tenant
   * this task's IAM credentials.
   */
  it.each([
    ['https://169.254.169.254/latest/meta-data/', 'the cloud metadata service'],
    ['https://127.0.0.1/hook', 'loopback'],
    ['https://10.0.0.5/hook', 'a private range'],
    ['https://[::1]/hook', 'IPv6 loopback'],
  ])('rejects %s (%s)', async (url) => {
    await expect(
      safeFetchTransport({ url, body: '{}', headers: {} }),
    ).rejects.toBeInstanceOf(SsrfRejection);
  });
});

describe('reading a response body', () => {
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/huge') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        // Far more than any preview limit: the reader must stop on its own.
        response.end('y'.repeat(200_000));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  /**
   * A real `IncomingMessage`, not a stand-in. `safeFetch` hands the caller a
   * live socket and says the caller owns it, so what is under test is exactly
   * that ownership: take a bounded prefix and destroy the rest.
   *
   * The request goes straight through `node:http` rather than through
   * `safeFetch`, which would refuse the loopback address the server has to bind.
   */
  function fetchRaw(path: string): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = http.get(`${origin}${path}`, resolve);
      request.on('error', reject);
    });
  }

  it('returns the whole body when it fits', async () => {
    expect(await readBoundedBody(await fetchRaw('/small'), 512, 2_000)).toBe('{"ok":true}');
  });

  it('stops at the limit instead of buffering whatever a receiver sends', async () => {
    const body = await readBoundedBody(await fetchRaw('/huge'), 512, 5_000);
    expect(body).toHaveLength(512);
  });

  it('leaves the stream destroyed, so a socket is not held open', async () => {
    const response = await fetchRaw('/small');
    await readBoundedBody(response, 512, 2_000);
    expect(response.destroyed).toBe(true);
  });

  it('returns what it has when the read deadline fires, rather than throwing', async () => {
    // Zero milliseconds: the deadline destroys the stream immediately, which is
    // the trickle-attack shape. A status was already read, so this is not a
    // failed delivery and must not become one.
    await expect(readBoundedBody(await fetchRaw('/huge'), 512, 0)).resolves.toBeTypeOf('string');
  });
});
