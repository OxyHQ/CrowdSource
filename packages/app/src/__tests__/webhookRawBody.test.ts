/**
 * Invariant: the webhook receiver reads the bytes that arrived.
 *
 * The signature covers `timestamp + "." + rawBody`. Once a JSON parser has run
 * those bytes are gone, and verifying a signature over a re-serialisation is
 * verifying nothing.
 *
 * The assertion that proves this is NOT the mount order — that would only prove
 * the order. It is that the handler is reached with `req.body` still
 * `undefined`, observed from the last position in the middleware chain before
 * the router. `scripts/test-invariants.mjs` flips the mount order in
 * `support/webhookApp.ts` and asserts the first test below fails.
 *
 * Deliveries are signed by `@oxyhq/crowdsource-testing`, which signs exactly the
 * way the service does, and travel over a real socket. Nothing at the boundary
 * is faked.
 */

import { createCrowdSourceSandbox, WebhookSimulator } from '@oxyhq/crowdsource-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './support/harness';
import { startWebhookApp, type RunningWebhookApp } from './support/webhookApp';

const WEBHOOK_SECRET = 'whsec_test_0123456789abcdef0123456789abcdef';

let harness: Harness | null = null;
let app: RunningWebhookApp | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  await harness?.close();
  harness = null;
});

async function decidedEvent(): Promise<unknown> {
  const sandbox = createCrowdSourceSandbox({ webhookSecret: WEBHOOK_SECRET });
  const { CrowdSource } = await import('@oxyhq/crowdsource');
  const client = new CrowdSource({
    serviceKey: sandbox.serviceKey,
    baseUrl: sandbox.baseUrl,
    fetch: sandbox.fetch,
  });
  const receipt = await client.reports.create({
    externalReportId: 'report-1',
    reportedBy: { oxyUserId: 'oxy-reporter' },
    subject: {
      externalId: 'widget-1',
      type: 'custom.test.widget',
      author: { oxyUserId: 'oxy-owner' },
    },
    content: 'the reported text',
    allegations: ['integrity.spam'],
    submittedAt: new Date('2026-07-30T00:00:00.000Z'),
  });
  return sandbox.eventFor(sandbox.decide(receipt.caseId, { outcome: 'violation' }));
}

describe('the receiver reads raw bytes', () => {
  it('reaches the moderation router with req.body still undefined', async () => {
    harness = await createHarness({ webhookSecret: WEBHOOK_SECRET });
    app = await startWebhookApp(harness.moderation);

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: app.url });
    const result = await simulator.deliver(await decidedEvent());

    // The property: no parser ran on the bytes the handler is about to verify.
    expect(app.bodyTypeAtRouter).toEqual(['undefined']);

    // And the consequence: the signature verified, so the event was accepted.
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);
    expect(await harness.moderation.models.event.countDocuments({ state: 'queued' })).toBe(
      1,
    );
  });

  it('refuses the delivery when a JSON parser ran first, and records nothing', async () => {
    harness = await createHarness({ webhookSecret: WEBHOOK_SECRET });
    app = await startWebhookApp(harness.moderation, { jsonParser: 'before' });

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: app.url });
    const result = await simulator.deliver(await decidedEvent());

    expect(app.bodyTypeAtRouter).toEqual(['object']);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await harness.moderation.models.event.countDocuments({})).toBe(0);
    expect(await harness.moderation.models.outbox.countDocuments({})).toBe(0);
  });

  it('refuses a forged signature and records nothing', async () => {
    harness = await createHarness({ webhookSecret: WEBHOOK_SECRET });
    app = await startWebhookApp(harness.moderation);

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: app.url });
    const result = await simulator.deliver(await decidedEvent(), {
      wrongSecret: 'whsec_someone_elses_secret_0123456789ab',
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await harness.moderation.models.event.countDocuments({})).toBe(0);
    expect(await harness.moderation.models.outbox.countDocuments({})).toBe(0);
  });

  it('refuses a stale delivery and records nothing', async () => {
    harness = await createHarness({ webhookSecret: WEBHOOK_SECRET });
    app = await startWebhookApp(harness.moderation);

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: app.url });
    const result = await simulator.deliver(await decidedEvent(), { expired: true });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await harness.moderation.models.event.countDocuments({})).toBe(0);
  });

  it('does not mount at all without a webhook secret', async () => {
    harness = await createHarness();
    app = await startWebhookApp(harness.moderation);

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: app.url });
    const result = await simulator.deliver(await decidedEvent());

    /**
     * 404, which is indistinguishable from not having the feature — because
     * that is exactly what an unconfigured deployment has. A route that answered
     * anything at all without a secret is a route somebody will later reason
     * about as if it verified something.
     */
    expect(result.status).toBe(404);
  });

  it('deduplicates a redelivered event across instances, and queues the work once', async () => {
    harness = await createHarness({ webhookSecret: WEBHOOK_SECRET });
    app = await startWebhookApp(harness.moderation);

    const simulator = new WebhookSimulator({ secret: WEBHOOK_SECRET, url: app.url });
    const event = await decidedEvent();

    const first = await simulator.deliver(event);
    const second = await simulator.deliver(event);

    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeLessThan(300);
    expect(await harness.moderation.models.event.countDocuments({})).toBe(1);
    expect(
      await harness.moderation.models.outbox.countDocuments({ kind: 'decision.apply' }),
    ).toBe(1);
  });
});
