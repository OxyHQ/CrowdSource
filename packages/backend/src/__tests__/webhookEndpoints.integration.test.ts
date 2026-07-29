import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { config } from '../config';
import {
  signingSecretAt,
  validSecretsAt,
  DEFAULT_SECRET_OVERLAP_SECONDS,
  MAX_SECRET_OVERLAP_SECONDS,
} from '../modules/webhooks/endpoint.service';
import { signWebhookPayload, verifyWebhookSignature, webhookTimestamp } from '../modules/webhooks/signature';
import { provisionTenant, startDatabase, stopDatabase, type ProvisionedTenant } from './support/tenants';

/**
 * `POST /v1/webhook-endpoints` and `.../rotate-secret` (§10.2), and the rotation
 * overlap those two exist for.
 *
 * The overlap is the property worth attacking. A rotation that invalidates the
 * outgoing secret at the instant it is called breaks every integrator who has
 * not yet deployed the new one — and because our signature header carries a
 * single `v1=`, we cannot send both signatures the way a multi-signature scheme
 * does. So the OUTGOING secret keeps signing until the window closes. These
 * tests state that as an observable fact about what a receiver can verify, at a
 * given instant, with a given secret in hand.
 */

const app = createApp();
let tenant: ProvisionedTenant;
let other: ProvisionedTenant;

const RAW_BODY = '{"id":"evt_test","type":"report.received"}';

beforeAll(async () => {
  await startDatabase();
  [tenant, other] = await Promise.all([
    provisionTenant(['crowdsource:webhooks:manage']),
    provisionTenant(['crowdsource:webhooks:manage']),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await stopDatabase();
});

let urlCounter = 0;
function freshUrl(): string {
  urlCounter += 1;
  return `https://hooks.example.com/crowdsource/${Date.now()}-${urlCounter}`;
}

function register(
  who: ProvisionedTenant,
  body: Record<string, unknown>,
): request.Test {
  return request(app)
    .post('/v1/webhook-endpoints')
    .set('Authorization', `Bearer ${who.token}`)
    .send(body);
}

function rotate(
  who: ProvisionedTenant,
  webhookEndpointId: string,
  body: Record<string, unknown> = {},
): request.Test {
  return request(app)
    .post(`/v1/webhook-endpoints/${webhookEndpointId}/rotate-secret`)
    .set('Authorization', `Bearer ${who.token}`)
    .send(body);
}

/** Registers an endpoint and returns what the integrator was handed. */
async function registerEndpoint(
  who: ProvisionedTenant = tenant,
  eventTypes: string[] = ['report.received'],
): Promise<{ webhookEndpointId: string; secret: string; url: string }> {
  const url = freshUrl();
  const response = await register(who, { url, eventTypes });
  expect(response.status).toBe(201);
  return {
    webhookEndpointId: response.body.webhookEndpointId,
    secret: response.body.secret.value,
    url,
  };
}

describe('registration', () => {
  it('creates an endpoint and shows its secret exactly once', async () => {
    const url = freshUrl();
    const created = await register(tenant, { url, eventTypes: ['report.received', 'case.decided'] });

    expect(created.status).toBe(201);
    expect(created.body.url).toBe(url);
    // Sorted and deduplicated: two registrations differing only in the order
    // they listed the same events are the same subscription.
    expect(created.body.eventTypes).toEqual(['case.decided', 'report.received']);
    expect(created.body.status).toBe('active');
    expect(created.body.secret.version).toBe(1);
    expect(typeof created.body.secret.value).toBe('string');
    expect(created.body.secret.signingStartsAt).toBeTypeOf('string');
  });

  it('never carries an applicationId in or out — the credential decides the tenant', async () => {
    const created = await register(tenant, {
      url: freshUrl(),
      eventTypes: ['report.received'],
    });

    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain(tenant.applicationId);
  });

  it('re-registering the same URL updates it and does NOT mint a new secret', async () => {
    const { webhookEndpointId, url } = await registerEndpoint();

    const again = await register(tenant, { url, eventTypes: ['case.closed'] });

    expect(again.status).toBe(200);
    expect(again.body.webhookEndpointId).toBe(webhookEndpointId);
    expect(again.body.eventTypes).toEqual(['case.closed']);
    /**
     * The important half. §10.2 gives registration no idempotency key, so a
     * deploy script that POSTs on every boot must not invalidate the secret the
     * integrator is running with.
     */
    expect(again.body.secret).toBeUndefined();
  });

  it.each([
    ['http://hooks.example.com/hook', 'plaintext http'],
    ['https://127.0.0.1/hook', 'loopback'],
    ['https://169.254.169.254/hook', 'the metadata service'],
    ['https://localhost/hook', 'a reserved name'],
    ['https://user:pass@hooks.example.com/hook', 'embedded credentials'],
    ['not-a-url', 'a value that is not a URL'],
  ])('refuses %s (%s)', async (url) => {
    const response = await register(tenant, { url, eventTypes: ['report.received'] });
    expect(response.status).toBe(400);
  });

  it('refuses an unknown event type rather than subscribing to silence', async () => {
    const response = await register(tenant, {
      url: freshUrl(),
      eventTypes: ['case.decided', 'case.exploded'],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('case.exploded');
  });

  it('refuses an empty subscription', async () => {
    expect((await register(tenant, { url: freshUrl(), eventTypes: [] })).status).toBe(400);
  });

  it('requires the webhooks:manage scope', async () => {
    const unscoped = await provisionTenant(['crowdsource:reports:write']);
    const response = await register(unscoped, {
      url: freshUrl(),
      eventTypes: ['report.received'],
    });
    expect(response.status).toBe(403);
  });

  it('requires a credential at all', async () => {
    const response = await request(app)
      .post('/v1/webhook-endpoints')
      .send({ url: freshUrl(), eventTypes: ['report.received'] });
    expect(response.status).toBe(401);
  });
});

describe('without a configured encryption key', () => {
  /**
   * §13.4 needs somewhere to put the secret. When there is nowhere, the
   * operation is REFUSED rather than completed with an unprotected secret or a
   * missing one — an endpoint that existed without a secret could never be
   * delivered to, and the failure would surface days later as silence.
   */
  it('refuses to register, naming the variable, with 503', async () => {
    vi.spyOn(config, 'webhookSecretEncryptionKey', 'get').mockReturnValue(undefined);

    const response = await register(tenant, {
      url: freshUrl(),
      eventTypes: ['report.received'],
    });

    expect(response.status).toBe(503);
    expect(response.body.error.message).toContain('WEBHOOK_SECRET_ENCRYPTION_KEY');
  });
});

describe('tenant isolation', () => {
  it('will not rotate another tenant’s endpoint, and says only "no such endpoint"', async () => {
    const { webhookEndpointId } = await registerEndpoint(tenant);

    const response = await rotate(other, webhookEndpointId);

    expect(response.status).toBe(404);
    // Not "forbidden": confirming the id exists somewhere is itself a leak.
    expect(response.body.error.message).toBe('No such webhook endpoint.');
  });

  it('gives two tenants separate endpoints for the same URL', async () => {
    const url = freshUrl();
    const mine = await register(tenant, { url, eventTypes: ['report.received'] });
    const theirs = await register(other, { url, eventTypes: ['report.received'] });

    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(mine.body.webhookEndpointId).not.toBe(theirs.body.webhookEndpointId);
    expect(mine.body.secret.value).not.toBe(theirs.body.secret.value);
  });
});

describe('rotation with an overlap window', () => {
  it('issues a new secret and tells the integrator when it starts signing', async () => {
    const { webhookEndpointId } = await registerEndpoint();

    const rotated = await rotate(tenant, webhookEndpointId, { overlapSeconds: 3_600 });

    expect(rotated.status).toBe(200);
    expect(rotated.body.secret.version).toBe(2);
    expect(rotated.body.previousSecret.version).toBe(1);
    expect(Date.parse(rotated.body.secret.signingStartsAt)).toBe(
      Date.parse(rotated.body.previousSecret.expiresAt),
    );
    // The window is real, not zero-length.
    expect(Date.parse(rotated.body.secret.signingStartsAt)).toBeGreaterThan(Date.now());
  });

  /**
   * The property this whole design exists for, stated the way a receiver
   * experiences it: mid-window, a signature made by the secret the integrator
   * ALREADY has still verifies. If this ever inverts, every integrator breaks at
   * the instant of rotation.
   */
  it('keeps the PREVIOUS secret signing during the window, and switches after it', async () => {
    const { webhookEndpointId, secret: original } = await registerEndpoint();

    const rotated = await rotate(tenant, webhookEndpointId, { overlapSeconds: 3_600 });
    const replacement: string = rotated.body.secret.value;
    const cutover = new Date(rotated.body.secret.signingStartsAt);

    const duringWindow = new Date(cutover.getTime() - 60_000);
    const afterWindow = new Date(cutover.getTime() + 60_000);

    const midRotation = await signingSecretAt(tenant.tenant, webhookEndpointId, duringWindow);
    expect(midRotation.version).toBe(1);
    expect(midRotation.value).toBe(original);

    const settled = await signingSecretAt(tenant.tenant, webhookEndpointId, afterWindow);
    expect(settled.version).toBe(2);
    expect(settled.value).toBe(replacement);

    /**
     * And what that means on the wire. A receiver holding only the original
     * secret verifies a delivery made during the window and fails one made
     * after — which is exactly the migration window §10.8 asks receivers to
     * cover by holding both.
     */
    for (const [when, secretInHand, expected] of [
      [duringWindow, original, true],
      [duringWindow, replacement, false],
      [afterWindow, original, false],
      [afterWindow, replacement, true],
    ] as const) {
      const signer = await signingSecretAt(tenant.tenant, webhookEndpointId, when);
      const timestamp = webhookTimestamp(when);
      const verification = verifyWebhookSignature({
        secret: secretInHand,
        timestamp,
        signature: signWebhookPayload(signer.value, timestamp, RAW_BODY),
        rawBody: RAW_BODY,
        now: when,
      });
      expect(verification.ok, `secret held at ${when.toISOString()}`).toBe(expected);
    }
  });

  it('has exactly two valid secrets inside the window and one outside it', async () => {
    const { webhookEndpointId } = await registerEndpoint();
    const rotated = await rotate(tenant, webhookEndpointId, { overlapSeconds: 3_600 });
    const cutover = new Date(rotated.body.secret.signingStartsAt);

    const inside = await validSecretsAt(
      tenant.tenant,
      webhookEndpointId,
      new Date(cutover.getTime() - 60_000),
    );
    expect(inside.map((secret) => secret.version).sort()).toEqual([1, 2]);

    const outside = await validSecretsAt(
      tenant.tenant,
      webhookEndpointId,
      new Date(cutover.getTime() + 60_000),
    );
    expect(outside.map((secret) => secret.version)).toEqual([2]);
  });

  /**
   * The leaked-secret path. A window is the right default and the wrong answer
   * when the outgoing secret is in someone else's hands.
   */
  it('cuts over immediately at overlapSeconds: 0', async () => {
    const { webhookEndpointId, secret: original } = await registerEndpoint();

    const rotated = await rotate(tenant, webhookEndpointId, { overlapSeconds: 0 });
    const afterwards = new Date(Date.parse(rotated.body.secret.signingStartsAt) + 1_000);

    const signer = await signingSecretAt(tenant.tenant, webhookEndpointId, afterwards);
    expect(signer.version).toBe(2);
    expect(signer.value).not.toBe(original);

    expect(
      (await validSecretsAt(tenant.tenant, webhookEndpointId, afterwards)).map((s) => s.version),
    ).toEqual([2]);
  });

  it('defaults to a working day when no overlap is given', async () => {
    const { webhookEndpointId } = await registerEndpoint();
    const before = Date.now();

    const rotated = await rotate(tenant, webhookEndpointId);

    const startsAt = Date.parse(rotated.body.secret.signingStartsAt);
    expect(startsAt).toBeGreaterThanOrEqual(before + DEFAULT_SECRET_OVERLAP_SECONDS * 1_000);
  });

  /**
   * Receivers are asked to hold TWO secrets during a rotation. A second pending
   * rotation would silently require three, breaking the thing they built.
   */
  it('refuses a second rotation while one is still pending', async () => {
    const { webhookEndpointId } = await registerEndpoint();
    expect((await rotate(tenant, webhookEndpointId, { overlapSeconds: 3_600 })).status).toBe(200);

    const second = await rotate(tenant, webhookEndpointId, { overlapSeconds: 3_600 });

    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain('two secrets');
  });

  it('allows a further rotation once the window has closed', async () => {
    const { webhookEndpointId } = await registerEndpoint();
    expect((await rotate(tenant, webhookEndpointId, { overlapSeconds: 0 })).status).toBe(200);

    const third = await rotate(tenant, webhookEndpointId, { overlapSeconds: 0 });

    expect(third.status).toBe(200);
    expect(third.body.secret.version).toBe(3);
  });

  it.each([
    [-1, 'a negative window'],
    [MAX_SECRET_OVERLAP_SECONDS + 1, 'a window past the cap'],
    [1.5, 'a fractional window'],
  ])('refuses overlapSeconds %d (%s)', async (overlapSeconds) => {
    const { webhookEndpointId } = await registerEndpoint();
    expect((await rotate(tenant, webhookEndpointId, { overlapSeconds })).status).toBe(400);
  });

  it('404s an endpoint id that is not even well formed', async () => {
    expect((await rotate(tenant, 'not-an-id')).status).toBe(404);
  });
});
