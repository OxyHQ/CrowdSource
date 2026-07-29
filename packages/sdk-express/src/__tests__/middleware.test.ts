/**
 * The middleware, over a real socket.
 *
 * Every test here starts an Express app on an ephemeral port and delivers to it
 * with `@oxyhq/crowdsource-testing`'s simulator, which signs exactly the way the
 * service does. Nothing is faked at the boundary that matters: the bytes go
 * through a kernel socket, through Express's own routing, and into the handler,
 * because the failure this package exists to prevent — verifying a signature
 * over bytes that are not the ones that arrived — is invisible to any test that
 * hands the handler a Buffer it prepared itself.
 */

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { WebhookSimulator, caseDecidedEventFixture } from '@oxyhq/crowdsource-testing';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { crowdsourceWebhooks, type CrowdSourceWebhooksOptions } from '../middleware';

const SECRET = 'webhook-secret-under-test';
const PREVIOUS_SECRET = 'webhook-secret-being-retired';

interface Harness {
  readonly url: string;
  readonly simulator: WebhookSimulator;
  /** Errors that reached the application's error handler. */
  readonly errors: unknown[];
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function harness(
  options: CrowdSourceWebhooksOptions,
  build?: (app: Express) => void,
): Promise<Harness> {
  const app = express();
  build?.(app);
  app.post('/webhooks/crowdsource', crowdsourceWebhooks({ secret: SECRET, ...options }));

  const errors: unknown[] = [];
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    errors.push(error);
    response.status(500).json({ received: false });
  });

  const server = app.listen(0);
  await once(server, 'listening');
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/webhooks/crowdsource`;
  return { url, simulator: new WebhookSimulator({ secret: SECRET, url }), errors };
}

describe('crowdsourceWebhooks', () => {
  it('verifies a real delivery and dispatches it to the typed handler', async () => {
    const decided = vi.fn();
    const { simulator } = await harness({ on: { 'case.decided': decided } });
    const event = caseDecidedEventFixture();

    const result = await simulator.deliver(event);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ received: true, eventId: event.id, handled: true });
    expect(decided).toHaveBeenCalledTimes(1);
    expect(decided.mock.calls[0]?.[0]).toMatchObject({
      type: 'case.decided',
      data: { decision: { outcome: 'violation' } },
    });
  });

  /**
   * The headline case. An application with `express.json()` mounted globally is
   * the normal shape of an Express app, and it is exactly the shape in which a
   * hand-written verifier silently starts checking `JSON.stringify(req.body)`.
   * Here it must REFUSE, loudly, through the application's own error handler.
   */
  it('refuses to verify anything once a JSON parser has consumed the body', async () => {
    const decided = vi.fn();
    const { simulator, errors } = await harness({ on: { 'case.decided': decided } }, (app) => {
      app.use(express.json());
    });

    const result = await simulator.deliver(caseDecidedEventFixture());

    expect(result.status).toBe(500);
    expect(decided).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).name).toBe('CrowdSourceWebhookConfigurationError');
    expect((errors[0] as Error).message).toContain('body parser ran before');
  });

  it('accepts the two supported ways of keeping the raw body', async () => {
    const withRaw = await harness({}, (app) => {
      app.use(express.raw({ type: '*/*' }));
    });
    const withVerify = await harness({}, (app) => {
      app.use(
        express.json({
          verify: (request, _response, buffer) => {
            Reflect.set(request, 'rawBody', buffer);
          },
        }),
      );
    });

    expect((await withRaw.simulator.deliver(caseDecidedEventFixture())).status).toBe(200);
    expect((await withVerify.simulator.deliver(caseDecidedEventFixture())).status).toBe(200);
  });

  it('refuses a delivery replayed from outside the timestamp window', async () => {
    const decided = vi.fn();
    const { simulator } = await harness({ on: { 'case.decided': decided } });

    const result = await simulator.deliver(caseDecidedEventFixture(), { expired: true });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ rejection: 'timestamp_out_of_window' });
    expect(decided).not.toHaveBeenCalled();
  });

  it('refuses a delivery signed with a secret it does not hold', async () => {
    const decided = vi.fn();
    const { simulator } = await harness({ on: { 'case.decided': decided } });

    const result = await simulator.deliver(caseDecidedEventFixture(), {
      wrongSecret: 'not-the-secret',
    });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ rejection: 'signature_mismatch' });
    expect(decided).not.toHaveBeenCalled();
  });

  it('refuses a body altered after it was signed', async () => {
    const decided = vi.fn();
    const { simulator } = await harness({ on: { 'case.decided': decided } });

    const result = await simulator.deliver(caseDecidedEventFixture(), {
      tamperedBody: JSON.stringify({ ...caseDecidedEventFixture(), injected: true }),
    });

    expect(result.status).toBe(401);
    expect(decided).not.toHaveBeenCalled();
  });

  it('accepts both secrets during a rotation, so no event is dropped', async () => {
    const decided = vi.fn();
    const { url } = await harness({
      secret: SECRET,
      previousSecret: PREVIOUS_SECRET,
      on: { 'case.decided': decided },
    });

    const withNew = await new WebhookSimulator({ secret: SECRET, url }).deliver(
      caseDecidedEventFixture({ id: 'evt_new' }),
    );
    const withOld = await new WebhookSimulator({ secret: PREVIOUS_SECRET, url }).deliver(
      caseDecidedEventFixture({ id: 'evt_old' }),
    );

    expect([withNew.status, withOld.status]).toEqual([200, 200]);
    expect(decided).toHaveBeenCalledTimes(2);
  });

  it('runs a redelivered event once and acknowledges the duplicate', async () => {
    const decided = vi.fn();
    const { simulator } = await harness({ on: { 'case.decided': decided } });
    const event = caseDecidedEventFixture({ id: 'evt_redelivered' });

    const first = await simulator.deliver(event);
    const second = await simulator.deliver(event);

    expect(first.body).toMatchObject({ duplicate: false });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true });
    expect(decided).toHaveBeenCalledTimes(1);
  });

  /**
   * The reason the store claims rather than records. A handler that failed must
   * be reachable again: §10.9 will redeliver, and a decision lost because a
   * queue blinked is not an acceptable outcome.
   */
  it('lets a redelivery retry a handler that failed', async () => {
    const decided = vi
      .fn()
      .mockRejectedValueOnce(new Error('the queue was down'))
      .mockResolvedValueOnce(undefined);
    const { simulator, errors } = await harness({ on: { 'case.decided': decided } });
    const event = caseDecidedEventFixture({ id: 'evt_retried' });

    const failed = await simulator.deliver(event);
    const retried = await simulator.deliver(event);

    expect(failed.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ duplicate: false, handled: true });
    expect(decided).toHaveBeenCalledTimes(2);
  });

  /**
   * §10.11. A version of CrowdSource that emits an event type this integration
   * has never heard of must not be able to break it — not with a 500, not with a
   * thrown parse error, and not by reaching a handler registered for something
   * else.
   */
  it('acknowledges and ignores an event type it does not know', async () => {
    const decided = vi.fn();
    const { simulator, errors } = await harness({ on: { 'case.decided': decided } });

    const result = await simulator.deliver({
      id: 'evt_from_the_future',
      type: 'case.rehearing_scheduled',
      createdAt: '2027-01-01T00:00:00.000Z',
      organizationId: 'org_test',
      applicationId: 'app_test',
      data: { caseId: 'case_test_1', hearingAt: '2027-02-01T00:00:00.000Z' },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ received: true, handled: false });
    expect(decided).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('offers the unknown event to onUnhandled when one is registered', async () => {
    const unhandled = vi.fn();
    const { simulator } = await harness({ on: { 'case.decided': vi.fn() }, onUnhandled: unhandled });

    await simulator.deliver({
      id: 'evt_from_the_future_2',
      type: 'case.rehearing_scheduled',
      createdAt: '2027-01-01T00:00:00.000Z',
      organizationId: 'org_test',
      applicationId: 'app_test',
      data: {},
    });

    expect(unhandled).toHaveBeenCalledTimes(1);
    expect(unhandled.mock.calls[0]?.[0]).toMatchObject({ type: 'case.rehearing_scheduled' });
  });

  it('refuses a delivery whose signed header and signed body name different events', async () => {
    const { simulator } = await harness({});

    const result = await simulator.deliver(caseDecidedEventFixture({ id: 'evt_in_body' }), {
      eventId: 'evt_in_header',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ rejection: 'event_id_mismatch' });
  });

  it('refuses a body larger than the configured limit before verifying it', async () => {
    const { simulator } = await harness({ maxBodyBytes: 256 });

    const result = await simulator.deliver(
      caseDecidedEventFixture({ id: 'evt_large' }),
      { tamperedBody: JSON.stringify({ padding: 'x'.repeat(4_096) }) },
    );

    expect(result.status).toBe(413);
  });

  it('reports a rejection to onRejected without handing it any of the delivery', async () => {
    const onRejected = vi.fn();
    const { simulator } = await harness({ onRejected });

    await simulator.deliver(caseDecidedEventFixture(), { wrongSecret: 'nope' });

    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected.mock.calls[0]).toEqual(['signature_mismatch']);
  });

  it('refuses everything when no secret is configured', async () => {
    const decided = vi.fn();
    const { simulator } = await harness({ secret: '', on: { 'case.decided': decided } });

    const result = await simulator.deliver(caseDecidedEventFixture());

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ rejection: 'no_secret_configured' });
    expect(decided).not.toHaveBeenCalled();
  });
});
