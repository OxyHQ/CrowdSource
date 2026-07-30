/**
 * Registering the endpoint decisions arrive on, and rotating its secret.
 *
 * The behaviour worth testing here is not the happy path — it is the two places
 * where the server's semantics are easy for a client to misrepresent, because a
 * client that gets either wrong loses a secret that cannot be regenerated:
 *
 *   * a registration that UPDATED an existing URL mints no secret, and the
 *     absence of `secret` has to survive to the caller rather than becoming an
 *     empty object or a throw;
 *   * a rotation with an immediate cutover has no previous secret, and `null`
 *     has to be distinguishable from "the server did not tell us".
 */

import { describe, expect, it } from 'vitest';

import { CrowdSource } from '../client.js';
import { formatServiceKey } from '../credential.js';
import { CrowdSourceApiError, CrowdSourceTransportError } from '../errors.js';

const SERVICE_KEY = formatServiceKey({
  applicationId: 'app_0123456789abcdef0123456789abcdef',
  credentialId: 'csk_fedcba9876543210fedcba9876543210',
  secret: 'secret-value',
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function client(responses: readonly Response[]): { crowdsource: CrowdSource; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get('authorization'),
      body: request.body === null ? null : ((await request.json()) as unknown),
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('no stubbed response left');
    return next;
  };

  return {
    crowdsource: new CrowdSource({
      serviceKey: SERVICE_KEY,
      baseUrl: 'https://api.crowdsource.oxy.so',
      fetch: fetchImpl,
    }),
    calls,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ENDPOINT = {
  webhookEndpointId: 'whe_0123456789abcdef0123456789abcdef',
  url: 'https://example.com/webhooks/crowdsource',
  eventTypes: ['case.decided'],
  status: 'active',
  disabledReason: null,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
};

describe('webhookEndpoints.register', () => {
  it('sends url and eventTypes to /v1/webhook-endpoints with the credential', async () => {
    const { crowdsource, calls } = client([
      json(201, {
        ...ENDPOINT,
        secret: { version: 1, value: 'whsec_abc', signingStartsAt: '2026-07-30T00:00:00.000Z' },
      }),
    ]);

    const registered = await crowdsource.webhookEndpoints.register({
      url: 'https://example.com/webhooks/crowdsource',
      eventTypes: ['case.decided'],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.crowdsource.oxy.so/v1/webhook-endpoints');
    expect(calls[0]?.authorization).toBe(
      'Bearer csk_fedcba9876543210fedcba9876543210.secret-value',
    );
    expect(calls[0]?.body).toEqual({
      url: 'https://example.com/webhooks/crowdsource',
      eventTypes: ['case.decided'],
    });

    // There is no applicationId on this surface, in either direction.
    expect(JSON.stringify(calls[0]?.body)).not.toContain('app_');

    expect(registered.webhookEndpointId).toBe(ENDPOINT.webhookEndpointId);
    expect(registered.secret?.value).toBe('whsec_abc');
    expect(registered.secret?.version).toBe(1);
  });

  it('carries the absence of a secret through when an existing URL was updated', async () => {
    // 200 and no `secret`: the endpoint already existed. The running process is
    // still verifying with the secret it has, and this must not look like a
    // secret it can store.
    const { crowdsource } = client([json(200, { ...ENDPOINT, updatedAt: '2026-07-31T00:00:00.000Z' })]);

    const registered = await crowdsource.webhookEndpoints.register({
      url: 'https://example.com/webhooks/crowdsource',
      eventTypes: ['case.decided', 'case.closed'],
    });

    expect('secret' in registered).toBe(false);
    expect(registered.secret).toBeUndefined();
  });

  it('normalises a missing disabledReason to null rather than undefined', async () => {
    const { disabledReason: _omitted, ...withoutReason } = ENDPOINT;
    const { crowdsource } = client([json(200, withoutReason)]);

    const registered = await crowdsource.webhookEndpoints.register({
      url: ENDPOINT.url,
      eventTypes: ['case.decided'],
    });

    expect(registered.disabledReason).toBeNull();
  });

  it('keeps a status this version of the client has never heard of', async () => {
    const { crowdsource } = client([json(200, { ...ENDPOINT, status: 'quarantined_by_a_newer_server' })]);

    const registered = await crowdsource.webhookEndpoints.register({
      url: ENDPOINT.url,
      eventTypes: ['case.decided'],
    });

    // §10.11: a newer server must not break an older client.
    expect(registered.status).toBe('quarantined_by_a_newer_server');
  });

  it('refuses a body it cannot recognise instead of returning a half-built endpoint', async () => {
    const { crowdsource } = client([json(201, { webhookEndpointId: 'whe_1' })]);

    await expect(
      crowdsource.webhookEndpoints.register({ url: ENDPOINT.url, eventTypes: ['case.decided'] }),
    ).rejects.toBeInstanceOf(CrowdSourceTransportError);
  });

  it('surfaces a missing scope as a non-retryable API error', async () => {
    const { crowdsource } = client([
      json(403, { error: { code: 'forbidden', message: 'crowdsource:webhooks:manage required.' } }),
    ]);

    const failure = await crowdsource.webhookEndpoints
      .register({ url: ENDPOINT.url, eventTypes: ['case.decided'] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CrowdSourceApiError);
    expect((failure as CrowdSourceApiError).retryable).toBe(false);
  });
});

describe('webhookEndpoints.rotateSecret', () => {
  it('posts to the rotate-secret route and returns both secrets', async () => {
    const { crowdsource, calls } = client([
      json(200, {
        webhookEndpointId: ENDPOINT.webhookEndpointId,
        secret: { version: 2, value: 'whsec_new', signingStartsAt: '2026-07-30T01:00:00.000Z' },
        previousSecret: { version: 1, expiresAt: '2026-07-30T09:00:00.000Z' },
      }),
    ]);

    const rotated = await crowdsource.webhookEndpoints.rotateSecret(ENDPOINT.webhookEndpointId, {
      overlapSeconds: 28_800,
    });

    expect(calls[0]?.url).toBe(
      `https://api.crowdsource.oxy.so/v1/webhook-endpoints/${ENDPOINT.webhookEndpointId}/rotate-secret`,
    );
    expect(calls[0]?.body).toEqual({ overlapSeconds: 28_800 });
    expect(rotated.secret.value).toBe('whsec_new');
    expect(rotated.previousSecret?.expiresAt).toBe('2026-07-30T09:00:00.000Z');
  });

  it('omits overlapSeconds entirely when the caller did not choose one', async () => {
    const { crowdsource, calls } = client([
      json(200, {
        webhookEndpointId: ENDPOINT.webhookEndpointId,
        secret: { version: 2, value: 'whsec_new', signingStartsAt: '2026-07-30T01:00:00.000Z' },
        previousSecret: null,
      }),
    ]);

    await crowdsource.webhookEndpoints.rotateSecret(ENDPOINT.webhookEndpointId);

    // Not `{ overlapSeconds: undefined }` — the server picks the default, and a
    // present-but-undefined field is a different request.
    expect(calls[0]?.body).toEqual({});
  });

  it('reports an immediate cutover as null rather than undefined', async () => {
    const { crowdsource } = client([
      json(200, {
        webhookEndpointId: ENDPOINT.webhookEndpointId,
        secret: { version: 3, value: 'whsec_now', signingStartsAt: '2026-07-30T02:00:00.000Z' },
        previousSecret: null,
      }),
    ]);

    const rotated = await crowdsource.webhookEndpoints.rotateSecret(ENDPOINT.webhookEndpointId, {
      overlapSeconds: 0,
    });

    expect(rotated.previousSecret).toBeNull();
  });

  it('percent-encodes the endpoint id rather than interpolating it raw', async () => {
    const { crowdsource, calls } = client([
      json(200, {
        webhookEndpointId: 'a/b',
        secret: { version: 1, value: 'v', signingStartsAt: '2026-07-30T00:00:00.000Z' },
        previousSecret: null,
      }),
    ]);

    await crowdsource.webhookEndpoints.rotateSecret('a/b');

    expect(calls[0]?.url).toContain('/v1/webhook-endpoints/a%2Fb/rotate-secret');
  });
});
