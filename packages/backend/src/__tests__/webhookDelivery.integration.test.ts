import { SsrfRejection } from '@oxyhq/core/server';
import { KnownWebhookEventSchema } from '@oxyhq/crowdsource-contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { config } from '../config';
import { ApiError } from '../http/apiError';
import {
  claimDueDelivery,
  recordAttempt,
  recordDelivery,
  replayDeadLetteredDelivery,
} from '../modules/webhooks/delivery.service';
import {
  attemptDelivery,
  resetWebhookTransport,
  runWebhookPass,
  setWebhookTransport,
  startWebhookDeliveryWorker,
  stopWebhookDeliveryWorker,
} from '../modules/webhooks/delivery.worker';
import {
  assertDeliverableUrl,
  registerWebhookEndpoint,
  rotateWebhookSecret,
  signingSecretAt,
  MAX_SECRET_OVERLAP_SECONDS,
} from '../modules/webhooks/endpoint.service';
import { fanOutWebhookEvent, webhookSourcedEventTypes } from '../modules/webhooks/fanout';
import {
  OUTBOX_EVENT_TYPES,
  outboxEvents,
  type OutboxEventDocument,
} from '../modules/outbox/outbox.collection';
import {
  registeredOutboxEventTypes,
  resetOutboxHandlers,
} from '../modules/outbox/outbox.dispatcher';
import { registerOutboxWorkers } from '../modules/outbox/workers';
import { verifyWebhookSignature } from '../modules/webhooks/signature';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS,
} from '../modules/webhooks/retrySchedule';
import {
  webhookAttempts,
  webhookDeliveries,
  webhookEndpoints,
  webhookSecrets,
  type WebhookAttemptDocument,
  type WebhookDeliveryDocument,
} from '../modules/webhooks/webhook.collections';
import { logger } from '../utils/logger';
import {
  deliveryBody,
  provisionTenant,
  startDatabase,
  stopDatabase,
  type ProvisionedTenant,
} from './support/tenants';

/**
 * Webhook delivery end to end (§10.7–§10.9).
 *
 * Everything here drives the REAL delivery path — the same `attemptDelivery` the
 * worker calls, the real signer, the real classification, the real records. The
 * only substitution is the outbound HTTP hop, because every address a test could
 * bind is one `safeFetch` refuses; that seam is pinned by
 * `webhookTransport.test.ts`, which asserts the default is the safeFetch-backed
 * transport and drives a blocked address straight through it.
 */

const app = createApp();
let tenant: ProvisionedTenant;

/** What the fake receiver was sent, in order. */
interface CapturedRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

let captured: CapturedRequest[] = [];

/** A receiver that answers however the test says, and remembers what it got. */
function receiverAnswering(
  responses: readonly { status: number; body?: string; retryAfter?: string }[],
): void {
  let index = 0;
  setWebhookTransport(async (outbound) => {
    captured.push(outbound);
    const scripted = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      status: scripted.status,
      body: scripted.body ?? '',
      retryAfter: scripted.retryAfter,
    };
  });
}

beforeAll(async () => {
  await startDatabase();
});

/**
 * A fresh application per test.
 *
 * Fan-out is tenant-wide by design — an event reaches EVERY live endpoint the
 * application registered — so endpoints left behind by an earlier test would
 * receive this test's events too, and `the delivery` would stop being a single
 * row. A new tenant per test is also the honest shape: an application really
 * does start with no endpoints.
 */
beforeEach(async () => {
  tenant = await provisionTenant(['crowdsource:reports:write', 'crowdsource:webhooks:manage']);
});

afterEach(async () => {
  resetWebhookTransport();
  stopWebhookDeliveryWorker();
  captured = [];
  vi.restoreAllMocks();

  /**
   * Retire whatever this test left pending.
   *
   * The claim is deliberately cross-tenant — that is what lets one worker serve
   * every application — so a due row from an earlier test is genuinely due, and
   * the next test's claim would pick it up first. Retiring them here keeps each
   * test's claim about its own delivery without weakening the claim itself.
   */
  /**
   * The outbox rows this suite's reports produced are consumed HERE, by calling
   * the fan-out directly, so they never reach the dispatcher. Left `pending`
   * they would pile up in front of the outbox dispatcher suite's own rows —
   * `runOnce` takes the oldest first, up to its limit — and that suite would
   * stop finding its own work. They are this tenant's rows and this suite is
   * their consumer, so marking them done is the truthful state.
   */
  for (const row of await outboxEvents.find({
    applicationId: tenant.applicationId,
    status: 'pending',
  })) {
    await outboxEvents.updateOne(
      { eventId: row.eventId },
      { status: 'dispatched', dispatchedAt: new Date(), updatedAt: new Date() },
    );
  }

  const stale = await webhookDeliveries.find({ status: { $in: ['pending', 'delivering'] } });
  for (const row of stale) {
    await webhookDeliveries.updateOne(
      { deliveryId: row.deliveryId },
      {
        status: 'succeeded',
        nextAttemptAt: null,
        leaseExpiresAt: null,
        succeededAt: new Date(),
        updatedAt: new Date(),
      },
    );
  }
});

afterAll(async () => {
  await stopDatabase();
});

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/** Registers a webhook endpoint through the real route. */
async function registerEndpoint(
  eventTypes: string[] = ['report.received'],
): Promise<{ webhookEndpointId: string; secret: string; url: string }> {
  const url = `https://hooks.example.com/delivery/${unique('e')}`;
  const response = await request(app)
    .post('/v1/webhook-endpoints')
    .set('Authorization', `Bearer ${tenant.token}`)
    .send({ url, eventTypes });

  expect(response.status).toBe(201);
  return {
    webhookEndpointId: response.body.webhookEndpointId,
    secret: response.body.secret.value,
    url,
  };
}

/**
 * Delivers a real report and returns the outbox row ingestion wrote for it.
 *
 * The row is the genuine article rather than a fixture: the fan-out is only
 * worth testing against the event the domain actually publishes, including its
 * id, its tenant stamp and its `createdAt`.
 */
async function publishReportReceived(): Promise<{ eventId: string; reportId: string }> {
  const externalReportId = unique('webhook-report');
  const created = await request(app)
    .post('/v1/reports')
    .set('Authorization', `Bearer ${tenant.token}`)
    .set('Idempotency-Key', externalReportId)
    .send(
      deliveryBody(tenant, externalReportId, {
        subjectExternalId: unique('post'),
        text: 'reported text that no webhook payload may carry',
      }),
    );
  expect(created.status).toBe(202);

  const event = await outboxEvents.findOne({
    type: OUTBOX_EVENT_TYPES.reportReceived,
    'payload.reportId': created.body.reportId,
  });
  expect(event).not.toBeNull();
  if (!event) throw new Error('unreachable: asserted above');

  return { eventId: event.eventId, reportId: created.body.reportId };
}

async function fanOutFor(eventId: string): Promise<void> {
  const event = await outboxEvents.findOne({ eventId });
  expect(event).not.toBeNull();
  if (!event) throw new Error('unreachable: asserted above');
  await fanOutWebhookEvent(event);
}

function deliveriesFor(webhookEndpointId: string): Promise<WebhookDeliveryDocument[]> {
  return webhookDeliveries.find({ webhookEndpointId });
}

async function onlyDelivery(webhookEndpointId: string): Promise<WebhookDeliveryDocument> {
  const found = await deliveriesFor(webhookEndpointId);
  expect(found).toHaveLength(1);
  return found[0];
}

function attemptsFor(deliveryId: string): Promise<WebhookAttemptDocument[]> {
  return webhookAttempts.find(tenant.tenant, { deliveryId }, { sort: { attemptNumber: 1 } });
}

/** Re-reads a delivery after the worker has moved it on. */
async function reload(deliveryId: string): Promise<WebhookDeliveryDocument> {
  const found = await webhookDeliveries.findOne({ deliveryId });
  expect(found).not.toBeNull();
  if (!found) throw new Error('unreachable: asserted above');
  return found;
}

/**
 * Claims and attempts exactly the way the worker does.
 *
 * Going through `claimDueDelivery` rather than calling `attemptDelivery` on a
 * stale row is what makes the attempt counters — and therefore the retry ladder
 * — behave as they do in production.
 */
async function deliverOnce(deliveryId: string, now: Date): Promise<void> {
  const claimed = await claimDueDelivery(now);
  expect(claimed?.deliveryId, 'the delivery under test must be the one due').toBe(deliveryId);
  if (!claimed) throw new Error('unreachable: asserted above');
  await attemptDelivery(claimed, now);
}

describe('fan-out', () => {
  it('creates one logical delivery per subscribed endpoint', async () => {
    const subscribed = await registerEndpoint(['report.received']);
    const uninterested = await registerEndpoint(['case.decided']);
    const { eventId, reportId } = await publishReportReceived();

    await fanOutFor(eventId);

    const delivery = await onlyDelivery(subscribed.webhookEndpointId);
    expect(delivery.eventId).toBe(eventId);
    expect(delivery.eventType).toBe('report.received');
    expect(delivery.status).toBe('pending');

    // A subscription is a filter, not a suggestion.
    expect(await deliveriesFor(uninterested.webhookEndpointId)).toHaveLength(0);

    /**
     * §10.7's envelope, carrying §10.4's response body. It has to satisfy the
     * PUBLISHED contract, or an integrator's generated types reject it.
     */
    const parsed = KnownWebhookEventSchema.parse(JSON.parse(delivery.body));
    expect(parsed.id).toBe(eventId);
    expect(parsed.type).toBe('report.received');
    expect(parsed.applicationId).toBe(tenant.applicationId);
    expect(parsed.data).toMatchObject({ reportId, status: 'received', merged: false });
  });

  /**
   * §12.7's constraint, and the reason it is an index rather than a lookup. An
   * outbox consumer is at-least-once by construction: a lease expires, a process
   * dies between the domain write and the completion write, an operator replays
   * a row. Every one of those hands the same event id to the fan-out again.
   */
  it('produces no second logical delivery when the same event id is replayed', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();

    const first = await fanOutFor(eventId);
    const before = await onlyDelivery(endpoint.webhookEndpointId);

    // Three more times, including two at once — a replay and a race.
    await fanOutFor(eventId);
    await Promise.all([fanOutFor(eventId), fanOutFor(eventId)]);

    const after = await deliveriesFor(endpoint.webhookEndpointId);
    expect(after).toHaveLength(1);
    expect(after[0].deliveryId).toBe(before.deliveryId);
    expect(first).toBeUndefined();
  });

  it('does not reset a delivery that is already in flight', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);

    receiverAnswering([{ status: 500 }]);
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());
    const afterAttempt = await reload(delivery.deliveryId);
    expect(afterAttempt.attemptCount).toBe(1);

    await fanOutFor(eventId);

    // A replay must not hand a failing delivery a fresh ladder.
    const afterReplay = await reload(delivery.deliveryId);
    expect(afterReplay.attemptCount).toBe(1);
    expect(afterReplay.nextAttemptAt?.getTime()).toBe(afterAttempt.nextAttemptAt?.getTime());
  });

  it('writes nothing when nobody subscribed', async () => {
    const { eventId } = await publishReportReceived();
    const before = await webhookDeliveries.find({ eventId });
    expect(before).toHaveLength(0);

    await fanOutFor(eventId);

    // Not an error, and not a delivery to nowhere: a later registration must not
    // retroactively receive events from before it existed.
    expect(await webhookDeliveries.find({ eventId })).toHaveLength(0);
  });

  /**
   * The pin, and it is a pin rather than a count: an internal event becoming
   * tenant-visible is a privacy decision, not a wiring detail. §10.6 defines
   * eight webhook events and the domain publishes five of them; a sixth appearing
   * here without an edit to this line would mean a module started telling
   * applications about something nobody agreed to tell them.
   */
  it('consumes only the internal events it declares', () => {
    expect(webhookSourcedEventTypes()).toEqual([
      OUTBOX_EVENT_TYPES.reportReceived,
      OUTBOX_EVENT_TYPES.caseDecided,
      OUTBOX_EVENT_TYPES.decisionCorrected,
      OUTBOX_EVENT_TYPES.appealCreated,
      OUTBOX_EVENT_TYPES.appealDecided,
    ]);
  });

  /**
   * The wiring, asserted without running a dispatcher pass.
   *
   * A pass in this suite would claim rows belonging to the outbox dispatcher
   * suite, which runs in parallel against the same database and asserts on their
   * stored state. Reading the registered consumer set answers the question the
   * pass would have — is the fan-out actually wired into production boot? —
   * without touching anybody's rows.
   */
  it('is wired into the production worker registration', () => {
    resetOutboxHandlers();
    expect(registeredOutboxEventTypes()).toEqual([]);

    registerOutboxWorkers();

    expect(registeredOutboxEventTypes()).toContain(OUTBOX_EVENT_TYPES.reportReceived);
    // The triage worker is still there: this is the whole registration, not the
    // webhook module's own.
    expect(registeredOutboxEventTypes()).toContain(OUTBOX_EVENT_TYPES.caseReadyForTriage);

    // Leave nothing registered behind: this process must not start claiming.
    resetOutboxHandlers();
  });
});

describe('a successful delivery', () => {
  it('signs what it sends, and the receiver’s own secret verifies it', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 200, body: '{"ok":true}' }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    const now = new Date();
    await deliverOnce(delivery.deliveryId, now);

    expect(captured).toHaveLength(1);
    const sent = captured[0];
    expect(sent.url).toBe(endpoint.url);
    // Byte-identical to what was stored: the signature covers these bytes, so a
    // body rebuilt at send time would be a different document.
    expect(sent.body).toBe(delivery.body);
    expect(sent.headers['X-CrowdSource-Event-Id']).toBe(eventId);

    /**
     * The end-to-end property: what the integrator was handed at registration
     * verifies what actually went out.
     */
    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        timestamp: sent.headers['X-CrowdSource-Timestamp'],
        signature: sent.headers['X-CrowdSource-Signature'],
        rawBody: sent.body,
        now,
      }),
    ).toEqual({ ok: true });
  });

  it('records the attempt with everything §10.9 asks for', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 202 }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());

    const [attempt] = await attemptsFor(delivery.deliveryId);
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.outcome).toBe('succeeded');
    expect(attempt.responseStatus).toBe(202);
    expect(attempt.secretVersion).toBe(1);
    expect(attempt.latencyMs).toBeGreaterThanOrEqual(0);
    expect(attempt.nextAttemptAt).toBeNull();

    const settled = await reload(delivery.deliveryId);
    expect(settled.status).toBe('succeeded');
    expect(settled.nextAttemptAt).toBeNull();
    expect(settled.succeededAt).not.toBeNull();
  });

  it('is not attempted again once it has succeeded', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 200 }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());

    // Far in the future: nothing about a succeeded delivery is ever due again.
    const later = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    let claimedAgain = false;
    for (let pass = 0; pass < 5; pass += 1) {
      const claimed = await claimDueDelivery(later);
      if (claimed?.deliveryId === delivery.deliveryId) claimedAgain = true;
      if (!claimed) break;
    }
    expect(claimedAgain).toBe(false);
  });
});

describe('the retry ladder of §10.9', () => {
  it('walks every rung on a 5xx and dead-letters after the last attempt', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 503, body: 'upstream busy' }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    const observed: number[] = [];
    let now = new Date();

    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      await deliverOnce(delivery.deliveryId, now);
      const state = await reload(delivery.deliveryId);

      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(state.status, `after attempt ${attempt}`).toBe('pending');
        expect(state.nextAttemptAt).not.toBeNull();
        observed.push((state.nextAttemptAt?.getTime() ?? 0) - now.getTime());
        // Move to exactly when the delivery says it is due next.
        now = state.nextAttemptAt ?? now;
      } else {
        expect(state.status).toBe('dead_letter');
        expect(state.deadLetterReason).toBe('attempts_exhausted');
        expect(state.nextAttemptAt).toBeNull();
        expect(state.deadLetteredAt).not.toBeNull();
      }
    }

    // The plan's sequence, observed rather than asserted from the constant.
    expect(observed).toEqual([...WEBHOOK_RETRY_DELAYS_MS]);

    /**
     * Seven attempts, one logical delivery. That is the whole point of §12.7's
     * constraint: a retry is an attempt beneath a delivery, never a new one.
     */
    const attempts = await attemptsFor(delivery.deliveryId);
    expect(attempts).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await deliveriesFor(endpoint.webhookEndpointId)).toHaveLength(1);

    // Not deleted: §10.9 promises manual replay, which needs the row.
    expect(await webhookDeliveries.findOne({ deliveryId: delivery.deliveryId })).not.toBeNull();
  });

  it('recovers when a receiver comes back mid-ladder', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 500 }, { status: 500 }, { status: 200 }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    let now = new Date();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await deliverOnce(delivery.deliveryId, now);
      now = (await reload(delivery.deliveryId)).nextAttemptAt ?? now;
    }

    const state = await reload(delivery.deliveryId);
    expect(state.status).toBe('succeeded');
    expect(state.attemptCount).toBe(3);
  });

  it('honours a Retry-After that is longer than the rung', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 429, retryAfter: '600' }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    const now = new Date();
    await deliverOnce(delivery.deliveryId, now);

    const state = await reload(delivery.deliveryId);
    // Ten minutes, not the ladder's thirty seconds.
    expect((state.nextAttemptAt?.getTime() ?? 0) - now.getTime()).toBe(600_000);
  });
});

describe('classification of a 4xx (§10.9)', () => {
  it('stops a plain 400 after a short ladder rather than grinding for a day', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 400, body: '{"error":"cannot parse"}' }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    let now = new Date();
    for (let attempt = 0; attempt < WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS; attempt += 1) {
      await deliverOnce(delivery.deliveryId, now);
      now = (await reload(delivery.deliveryId)).nextAttemptAt ?? now;
    }

    const state = await reload(delivery.deliveryId);
    expect(state.status).toBe('dead_letter');
    expect(state.deadLetterReason).toBe('client_error');
    expect(state.attemptCount).toBe(WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS);
    expect(WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS).toBeLessThan(WEBHOOK_MAX_ATTEMPTS);
  });

  /**
   * §10.9: "a 410 may disable the endpoint". It does — 410 is the one status
   * whose meaning is that the resource is permanently gone.
   */
  it('disables the endpoint on a 410 and dead-letters the delivery at once', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 410 }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());

    const state = await reload(delivery.deliveryId);
    expect(state.status).toBe('dead_letter');
    expect(state.deadLetterReason).toBe('endpoint_gone');
    // Terminal on the FIRST attempt: no ladder at all.
    expect(state.attemptCount).toBe(1);

    const disabled = await webhookEndpoints.findOne(tenant.tenant, {
      webhookEndpointId: endpoint.webhookEndpointId,
    });
    expect(disabled?.status).toBe('disabled');
    expect(disabled?.disabledReason).toBe('gone');
    expect(disabled?.disabledAt).not.toBeNull();
  });

  it('stops fanning out to a disabled endpoint', async () => {
    const endpoint = await registerEndpoint();
    const first = await publishReportReceived();
    await fanOutFor(first.eventId);
    receiverAnswering([{ status: 410 }]);
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());

    const second = await publishReportReceived();
    await fanOutFor(second.eventId);

    expect(await deliveriesFor(endpoint.webhookEndpointId)).toHaveLength(1);
  });

  it('brings a disabled endpoint back when the same URL is registered again', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 410 }]);
    await deliverOnce((await onlyDelivery(endpoint.webhookEndpointId)).deliveryId, new Date());

    const revived = await request(app)
      .post('/v1/webhook-endpoints')
      .set('Authorization', `Bearer ${tenant.token}`)
      .send({ url: endpoint.url, eventTypes: ['report.received'] });

    expect(revived.status).toBe(200);
    expect(revived.body.status).toBe('active');
    expect(revived.body.disabledReason).toBeNull();
    // Reviving must not re-key the endpoint the integrator already configured.
    expect(revived.body.secret).toBeUndefined();
  });

  it('dead-letters a delivery whose endpoint was disabled while it waited', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);

    await webhookEndpoints.updateOne(
      tenant.tenant,
      { webhookEndpointId: endpoint.webhookEndpointId },
      { set: { status: 'disabled', disabledReason: 'operator', disabledAt: new Date() } },
    );

    receiverAnswering([{ status: 200 }]);
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());

    // Nothing was sent, which is the assertion that matters.
    expect(captured).toHaveLength(0);
    const state = await reload(delivery.deliveryId);
    expect(state.status).toBe('dead_letter');
    expect(state.deadLetterReason).toBe('endpoint_disabled');
  });
});

describe('a transport that never got a response', () => {
  it('retries an unreachable receiver', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    setWebhookTransport(async () => {
      throw new Error('ECONNREFUSED 203.0.113.10:443');
    });

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());

    const state = await reload(delivery.deliveryId);
    expect(state.status).toBe('pending');
    expect(state.lastResponseStatus).toBeNull();

    const [attempt] = await attemptsFor(delivery.deliveryId);
    expect(attempt.failureKind).toBe('upstream_unreachable');
    /**
     * The error's own text is never stored: a transport error routinely quotes
     * the request it failed on, which here is a signed delivery body.
     */
    expect(attempt.responseBodyPreview).toBe('');
  });
});

describe('rotation, seen from a delivery', () => {
  it('records which secret version signed each attempt, and switches at the cutover', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);

    const rotated = await rotateWebhookSecret(tenant.tenant, endpoint.webhookEndpointId, {
      overlapSeconds: 3_600,
    });
    const cutover = rotated.secret.signingStartsAt;

    receiverAnswering([{ status: 500 }, { status: 200 }]);
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);

    // Inside the window: the secret the integrator already has.
    const during = new Date(cutover.getTime() - 60_000);
    await deliverOnce(delivery.deliveryId, during);

    // Past it: the new one.
    const after = new Date(cutover.getTime() + 60_000);
    await deliverOnce(delivery.deliveryId, after);

    const attempts = await attemptsFor(delivery.deliveryId);
    expect(attempts.map((attempt) => attempt.secretVersion)).toEqual([1, 2]);

    // And each attempt really was signed by the version it claims.
    const [first, second] = captured;
    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        timestamp: first.headers['X-CrowdSource-Timestamp'],
        signature: first.headers['X-CrowdSource-Signature'],
        rawBody: first.body,
        now: during,
      }).ok,
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        secret: rotated.secret.value,
        timestamp: second.headers['X-CrowdSource-Timestamp'],
        signature: second.headers['X-CrowdSource-Signature'],
        rawBody: second.body,
        now: after,
      }).ok,
    ).toBe(true);

    const signer = await signingSecretAt(tenant.tenant, endpoint.webhookEndpointId, after);
    expect(signer.version).toBe(2);
  });
});

describe('manual replay of a dead letter (§10.9)', () => {
  it('gives the delivery the full ladder again while keeping its history', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 400 }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    let now = new Date();
    for (let attempt = 0; attempt < WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS; attempt += 1) {
      await deliverOnce(delivery.deliveryId, now);
      now = (await reload(delivery.deliveryId)).nextAttemptAt ?? now;
    }
    expect((await reload(delivery.deliveryId)).status).toBe('dead_letter');

    const replayed = await replayDeadLetteredDelivery(tenant.tenant, delivery.deliveryId, now);

    expect(replayed.status).toBe('pending');
    expect(replayed.deadLetterReason).toBeNull();
    expect(replayed.cycleAttemptCount).toBe(0);
    expect(replayed.replayCount).toBe(1);
    // The history is not rewritten: attempt numbers keep climbing.
    expect(replayed.attemptCount).toBe(WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS);

    receiverAnswering([{ status: 200 }]);
    await deliverOnce(delivery.deliveryId, now);

    const settled = await reload(delivery.deliveryId);
    expect(settled.status).toBe('succeeded');
    const attempts = await attemptsFor(delivery.deliveryId);
    expect(attempts).toHaveLength(WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS + 1);
    expect(attempts.at(-1)?.attemptNumber).toBe(WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS + 1);
  });

  it('refuses to replay a delivery that is not dead-lettered', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);

    await expect(
      replayDeadLetteredDelivery(tenant.tenant, delivery.deliveryId),
    ).rejects.toThrow(/pending/);
  });

  it('will not replay another tenant’s delivery', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    const stranger = await provisionTenant(['crowdsource:webhooks:manage']);

    await expect(
      replayDeadLetteredDelivery(stranger.tenant, delivery.deliveryId),
    ).rejects.toThrow('No such webhook delivery.');
  });
});

describe('what a receiver’s response body is allowed to reach', () => {
  const caseMaterial = 'the victim said her address is 12 Rue Verte and she is terrified';

  /**
   * The invariant with no exceptions: sensitive content never reaches logs,
   * metrics or attestations. A receiver's body is the one place in this module
   * holding bytes CrowdSource did not compose, so it is the place that would
   * break it.
   *
   * Every level is captured, not just the one the code is expected to use — a
   * regression that logged the body at `debug` would otherwise pass.
   */
  function captureAllLogs(): { lines: () => string } {
    const captured: unknown[][] = [];
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        captured.push(args);
      });
    }
    return {
      lines: () =>
        captured
          .map((args) => args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(' '))
          .join('\n'),
    };
  }

  it('never reaches a log, at any level, even when the delivery dead-letters', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 500, body: `moderation failed for: ${caseMaterial}` }]);

    const logs = captureAllLogs();
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    let now = new Date();
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      await deliverOnce(delivery.deliveryId, now);
      now = (await reload(delivery.deliveryId)).nextAttemptAt ?? now;
    }

    const written = logs.lines();
    /**
     * The vacuity floor: the dead-letter warning §16.6 asks for must actually
     * have been emitted, or "no case material in the logs" would be true simply
     * because nothing was logged.
     */
    expect(written).toContain('Webhook delivery dead-lettered');
    expect(written).toContain(delivery.deliveryId);

    expect(written).not.toContain(caseMaterial);
    expect(written).not.toContain('12 Rue Verte');
    // Nor the body we sent, which carries the tenant's own identifiers.
    expect(written).not.toContain(delivery.body);
  });

  it('is not stored at all when the receiver answered 2xx', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 200, body: `ok, filed: ${caseMaterial}` }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());

    const [attempt] = await attemptsFor(delivery.deliveryId);
    /**
     * A 2xx body has no diagnostic value — the status already said everything —
     * and successes are the overwhelming majority of deliveries. Keeping nothing
     * removes most receiver-controlled bytes from storage at no cost.
     */
    expect(attempt.responseBodyPreview).toBe('');
  });

  it('is bounded and credential-redacted when a failure keeps it (§10.9)', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([
      { status: 500, body: `denied Authorization: Bearer sk_live_abcdef123456 ${'q'.repeat(900)}` },
    ]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());

    const [attempt] = await attemptsFor(delivery.deliveryId);
    expect(attempt.responseBodyPreview).not.toContain('sk_live_abcdef123456');
    expect(attempt.responseBodyPreview.length).toBeLessThanOrEqual(513);
    // Kept, because a rejected signature is what an integrator debugs with.
    expect(attempt.responseBodyPreview).toContain('denied');
  });

  it('is never copied onto the delivery row, which has no expiry of its own', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    receiverAnswering([{ status: 500, body: caseMaterial }]);

    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    await deliverOnce(delivery.deliveryId, new Date());

    expect(JSON.stringify(await reload(delivery.deliveryId))).not.toContain(caseMaterial);
  });
});

describe('the claim two workers cannot both win', () => {
  it('hands one delivery to exactly one pass', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);

    let sends = 0;
    setWebhookTransport(async (outbound) => {
      captured.push(outbound);
      sends += 1;
      return { status: 200, body: '', retryAfter: undefined };
    });

    const now = new Date();
    await Promise.all([runWebhookPass(25, now), runWebhookPass(25, now), runWebhookPass(25, now)]);

    expect(sends).toBe(1);
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);
    expect(delivery.status).toBe('succeeded');
    expect(delivery.attemptCount).toBe(1);
  });

  it('reclaims a delivery whose worker died holding the lease', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);

    // Claimed and then lost: the row stays `delivering` with a lease.
    const claimed = await claimDueDelivery(new Date());
    expect(claimed?.deliveryId).toBe(delivery.deliveryId);
    expect((await reload(delivery.deliveryId)).status).toBe('delivering');

    // Nothing is due while the lease holds.
    expect(await claimDueDelivery(new Date())).toBeNull();

    receiverAnswering([{ status: 200 }]);
    const past = new Date(Date.now() + 10 * 60 * 1_000);
    await runWebhookPass(25, past);

    expect((await reload(delivery.deliveryId)).status).toBe('succeeded');
  });
});

describe('a delivery whose secret cannot be read', () => {
  it('sends nothing and retries, rather than going out unsigned', async () => {
    const endpoint = await registerEndpoint();
    const { eventId } = await publishReportReceived();
    await fanOutFor(eventId);
    const delivery = await onlyDelivery(endpoint.webhookEndpointId);

    receiverAnswering([{ status: 200 }]);
    /**
     * The realistic shape: the deployment lost its
     * `WEBHOOK_SECRET_ENCRYPTION_KEY`, so a secret that is perfectly well stored
     * cannot be turned back into a signing key.
     */
    vi.spyOn(config, 'webhookSecretEncryptionKey', 'get').mockReturnValue(undefined);

    await deliverOnce(delivery.deliveryId, new Date());

    // Nothing went out. An unsigned delivery is worse than a late one.
    expect(captured).toHaveLength(0);

    const attempts = await attemptsFor(delivery.deliveryId);
    expect(attempts.at(-1)?.failureKind).toBe('secret_unavailable');
    expect(attempts.at(-1)?.secretVersion).toBeNull();
    // Transient, so it survives until an operator restores the key.
    expect((await reload(delivery.deliveryId)).status).toBe('pending');
  });
});

describe('recordDelivery directly', () => {
  it('reports whether it wrote the row, which is what makes replay detectable', async () => {
    const endpoint = await registerEndpoint();
    const eventId = unique('evt');

    expect(
      await recordDelivery(tenant.tenant, {
        webhookEndpointId: endpoint.webhookEndpointId,
        eventId,
        eventType: 'report.received',
        body: '{}',
      }),
    ).toBe(true);

    expect(
      await recordDelivery(tenant.tenant, {
        webhookEndpointId: endpoint.webhookEndpointId,
        eventId,
        eventType: 'report.received',
        body: '{}',
      }),
    ).toBe(false);

    expect(await deliveriesFor(endpoint.webhookEndpointId)).toHaveLength(1);
  });
});


/**
 * A delivery written directly, without going through ingestion.
 *
 * The fan-out is exercised above against a real outbox row; the failure paths
 * below only need A delivery, and building one here keeps each of them to the
 * branch it is about.
 */
async function aDelivery(webhookEndpointId: string): Promise<WebhookDeliveryDocument> {
  const eventId = unique('evt_failure');
  await recordDelivery(tenant.tenant, {
    webhookEndpointId,
    eventId,
    eventType: 'report.received',
    body: '{"id":"evt_failure"}',
  });

  const found = await webhookDeliveries.findOne({ webhookEndpointId, eventId });
  if (!found) throw new Error('the delivery under test was not written');
  return found;
}

/** An endpoint created through the service rather than the route. */
async function anEndpoint(): Promise<string> {
  const registered = await registerWebhookEndpoint(tenant.tenant, {
    url: `https://hooks.example.com/failure/${unique('u')}`,
    eventTypes: ['report.received'],
  });
  return registered.endpoint.webhookEndpointId;
}

function freshUrl(): string {
  return `https://hooks.example.com/failure/${unique('u')}`;
}

describe('a URL that cannot be delivered to', () => {
  it('refuses one longer than the SSRF module itself accepts', () => {
    const tooLong = `https://hooks.example.com/${'p'.repeat(2_100)}`;
    expect(() => assertDeliverableUrl(tooLong)).toThrow(/2048 characters/);
  });
});

describe('two registrations of the same URL racing', () => {
  /**
   * The unique index is the arbiter, so the loser reads the winner's endpoint
   * and reports an update — which is what a retrying client asked for anyway.
   * A read-then-insert would leave two endpoints and deliver every event twice.
   */
  it('leaves exactly one endpoint, and the loser reports an update', async () => {
    const url = freshUrl();

    const [first, second] = await Promise.all([
      registerWebhookEndpoint(tenant.tenant, { url, eventTypes: ['report.received'] }),
      registerWebhookEndpoint(tenant.tenant, { url, eventTypes: ['report.received'] }),
    ]);

    expect(first.endpoint.webhookEndpointId).toBe(second.endpoint.webhookEndpointId);
    // Exactly one of them created it, and only that one was handed a secret.
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect([first.secret, second.secret].filter(Boolean)).toHaveLength(1);
  });

  it('re-raises a write failure that is not a duplicate key', async () => {
    vi.spyOn(webhookDeliveries, 'insertOne').mockRejectedValueOnce(new Error('the database blinked'));

    await expect(
      recordDelivery(tenant.tenant, {
        webhookEndpointId: await anEndpoint(),
        eventId: 'evt_not_a_duplicate',
        eventType: 'report.received',
        body: '{}',
      }),
    ).rejects.toThrow('the database blinked');
  });
});

describe('rotation when the endpoint has no live secret', () => {
  /**
   * Unreachable while registration writes the endpoint and its first secret in
   * one transaction — which is exactly why it is worth exercising. Minting a
   * fresh secret here would silently re-key an endpoint whose secret rows had
   * been lost, and the integrator would find out from failing signatures.
   */
  it('refuses rather than quietly minting a replacement', async () => {
    const webhookEndpointId = await anEndpoint();
    await webhookSecrets.updateOne(
      tenant.tenant,
      { webhookEndpointId, version: 1 },
      { set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    await expect(rotateWebhookSecret(tenant.tenant, webhookEndpointId)).rejects.toThrow(
      /no live signing secret/,
    );
  });

  it('refuses a rotation whose version number was already taken', async () => {
    const webhookEndpointId = await anEndpoint();
    // A version 2 that the pending-rotation check cannot see, because it is
    // already expired: the insert below collides on the unique index instead.
    await webhookSecrets.insertOne(tenant.tenant, {
      webhookEndpointId,
      version: 2,
      algorithm: 'aes-256-gcm',
      keyFingerprint: 'unused',
      ciphertext: 'unused',
      iv: 'unused',
      authTag: 'unused',
      activatesAt: new Date(Date.now() - 10_000),
      expiresAt: new Date(Date.now() - 1_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      rotateWebhookSecret(tenant.tenant, webhookEndpointId, { overlapSeconds: 0 }),
    ).rejects.toThrow(/already in progress/);
  });

  it('validates the overlap before it touches anything', async () => {
    const webhookEndpointId = await anEndpoint();
    await expect(
      rotateWebhookSecret(tenant.tenant, webhookEndpointId, {
        overlapSeconds: MAX_SECRET_OVERLAP_SECONDS + 1,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('signing when no version has activated yet', () => {
  it('reports the secret as unavailable rather than signing with nothing', async () => {
    const webhookEndpointId = await anEndpoint();
    // Push the only version's activation into the future: mid-rotation state
    // with the previous version already gone.
    await webhookSecrets.updateOne(
      tenant.tenant,
      { webhookEndpointId, version: 1 },
      { set: { activatesAt: new Date(Date.now() + 60_000) } },
    );

    await expect(
      signingSecretAt(tenant.tenant, webhookEndpointId, new Date()),
    ).rejects.toThrow(/no active signing secret/);
  });
});

describe('an attempt number that is already recorded', () => {
  /**
   * A worker sent the request and died before updating the delivery. The
   * history is intact, so the replay must finish the state transition rather
   * than write the attempt twice or abort.
   */
  it('finishes the state transition instead of duplicating the attempt', async () => {
    const delivery = await aDelivery(await anEndpoint());
    const claimed = await claimDueDelivery(new Date());
    expect(claimed?.deliveryId).toBe(delivery.deliveryId);
    if (!claimed) throw new Error('unreachable: asserted above');

    const result = {
      outcome: { kind: 'succeeded', failureKind: null },
      responseStatus: 200,
      failureKind: null,
      responseBody: '',
      latencyMs: 1,
      secretVersion: 1,
    } as const;

    await recordAttempt(claimed, result, new Date());
    // The same attempt number again: the unique index refuses the row, and the
    // delivery still settles.
    await recordAttempt(claimed, result, new Date());

    expect(await webhookAttempts.find(tenant.tenant, { deliveryId: delivery.deliveryId })).toHaveLength(1);
    const settled = await webhookDeliveries.findOne({ deliveryId: delivery.deliveryId });
    expect(settled?.status).toBe('succeeded');
  });

  it('re-raises an attempt write that failed for another reason', async () => {
    const delivery = await aDelivery(await anEndpoint());
    vi.spyOn(webhookAttempts, 'insertOne').mockRejectedValueOnce(new Error('disk on fire'));

    await expect(
      recordAttempt(
        delivery,
        {
          outcome: { kind: 'succeeded', failureKind: null },
          responseStatus: 200,
          failureKind: null,
          responseBody: '',
          latencyMs: 1,
          secretVersion: 1,
        },
        new Date(),
      ),
    ).rejects.toThrow('disk on fire');
  });
});

describe('replaying a delivery that is not there', () => {
  it('is a 404 rather than a silent no-op', async () => {
    await expect(
      replayDeadLetteredDelivery(tenant.tenant, 'whd_00000000000000000000000000000000'),
    ).rejects.toThrow('No such webhook delivery.');
  });
});

describe('a target that resolved somewhere it must never be contacted', () => {
  /**
   * The URL passed the offline check at registration and now resolves into a
   * private range: a misconfiguration, or a rebinding attempt. Either way,
   * retrying it six more times means probing an internal address on a schedule,
   * so it is terminal and visible instead.
   */
  it('dead-letters at once rather than retrying an internal address', async () => {
    const delivery = await aDelivery(await anEndpoint());
    setWebhookTransport(async () => {
      throw new SsrfRejection('resolves to 10.0.0.5');
    });

    const claimed = await claimDueDelivery(new Date());
    if (!claimed) throw new Error('nothing was due');
    await attemptDelivery(claimed, new Date());

    const settled = await webhookDeliveries.findOne({ deliveryId: delivery.deliveryId });
    expect(settled?.status).toBe('dead_letter');
    expect(settled?.deadLetterReason).toBe('unsafe_target');

    const [attempt] = await webhookAttempts.find(tenant.tenant, { deliveryId: delivery.deliveryId });
    expect(attempt.failureKind).toBe('unsafe_target');
  });
});

describe('the fan-out on an event it cannot translate', () => {
  function syntheticEvent(overrides: Partial<OutboxEventDocument>): OutboxEventDocument {
    const now = new Date();
    return {
      eventId: `evt_synthetic_${Date.now()}`,
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      type: OUTBOX_EVENT_TYPES.reportReceived,
      payload: {},
      status: 'pending',
      attempts: 0,
      availableAt: now,
      dispatchedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  /**
   * Throwing keeps the outbox row PENDING. Returning would mark it dispatched,
   * which destroys the one property §12.5 exists for: that pending work is
   * re-derivable by re-reading those rows.
   */
  it('throws on an internal event type it has no mapping for', async () => {
    await expect(
      fanOutWebhookEvent(syntheticEvent({ type: OUTBOX_EVENT_TYPES.caseReadyForTriage })),
    ).rejects.toThrow(/No webhook mapping/);
  });

  it('throws when the payload it needs cannot be read', async () => {
    await anEndpoint();
    // Subscribed endpoint, but the row names no report — so the §10.4 body
    // cannot be built and there is nothing honest to deliver.
    await expect(fanOutWebhookEvent(syntheticEvent({ payload: {} }))).rejects.toThrow(
      /could not be read/,
    );
  });

  it('throws when the report the row names is gone', async () => {
    await anEndpoint();
    await expect(
      fanOutWebhookEvent(syntheticEvent({ payload: { reportId: 'rpt_00000000000000000000000000000000' } })),
    ).rejects.toThrow(/could not be read/);
  });
});

describe('a worker pass that cannot record what it did', () => {
  it('logs and keeps going, rather than ending the pass for every other tenant', async () => {
    const delivery = await aDelivery(await anEndpoint());
    setWebhookTransport(async () => ({ status: 200, body: '', retryAfter: undefined }));
    /**
     * Persistently, not once. `attemptDelivery` catches its own failures and
     * records them, so a single rejection is absorbed by that second write; a
     * database that is genuinely unavailable fails both, and that is the case
     * this branch exists for.
     */
    vi.spyOn(webhookDeliveries, 'updateOne').mockRejectedValue(new Error('the database blinked'));
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const summary = await runWebhookPass(5, new Date());

    // Claimed, and NOT counted as delivered: the lease will expire and another
    // worker will take it, which is the correct outcome for a failed record.
    expect(summary.claimed).toBeGreaterThanOrEqual(1);
    expect(summary.delivered).toBeLessThan(summary.claimed);

    // Named, so an operator can find the row — and carrying the message only,
    // never the error object, which would quote the delivery body.
    const written = logged.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(written).toContain('Webhook delivery attempt could not be recorded');
    expect(written).toContain(delivery.deliveryId);
    expect(written).not.toContain(delivery.body);
  });
});

describe('the delivery loop', () => {
  /**
   * The timer belongs to `server.ts`, never to `app.ts`, and `.unref()` is what
   * stops a housekeeping interval from turning a clean shutdown into a hang.
   */
  it('starts once, is idempotent, and stops cleanly', async () => {
    const webhookEndpointId = await anEndpoint();
    const delivery = await aDelivery(webhookEndpointId);
    setWebhookTransport(async () => ({ status: 200, body: '', retryAfter: undefined }));

    startWebhookDeliveryWorker(5);
    // A second call must not start a second timer competing with the first.
    startWebhookDeliveryWorker(5);

    await vi.waitFor(async () => {
      expect((await webhookDeliveries.findOne({ deliveryId: delivery.deliveryId }))?.status).toBe(
        'succeeded',
      );
    });

    stopWebhookDeliveryWorker();
    // Stopping twice is how a shutdown path that runs on both SIGTERM and
    // SIGINT behaves; it must not throw.
    stopWebhookDeliveryWorker();
  });

  it('survives a pass that throws without stopping the loop', async () => {
    const failing = vi
      .spyOn(webhookDeliveries, 'findOneAndUpdate')
      .mockRejectedValue(new Error('the database blinked'));

    startWebhookDeliveryWorker(5);
    await vi.waitFor(() => {
      expect(failing).toHaveBeenCalled();
    });
    stopWebhookDeliveryWorker();
  });
});
