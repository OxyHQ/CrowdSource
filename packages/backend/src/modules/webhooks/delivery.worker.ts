import { SsrfRejection } from '@oxyhq/core/server';
import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@oxyhq/crowdsource-contracts';

import { createTenantContext } from '../../db/tenantScope';
import { logger } from '../../utils/logger';
import {
  claimDueDelivery,
  recordAttempt,
  type AttemptResult,
} from './delivery.service';
import { disableWebhookEndpoint, signingSecretAt } from './endpoint.service';
import { WebhookSecretUnavailableError } from './secretCipher';
import {
  classifyResponseStatus,
  parseRetryAfter,
  type WebhookOutcome,
} from './retrySchedule';
import { signWebhookPayload, webhookTimestamp } from './signature';
import { webhookEndpoints, type WebhookDeliveryDocument } from './webhook.collections';
import { safeFetchTransport, type WebhookTransport } from './transport';

/**
 * The delivery worker (§10.8, §10.9).
 *
 * ## Why this polls MongoDB instead of consuming a queue
 *
 * The same reason `outbox.dispatcher.ts` gives, taken one step further. The
 * Valkey a BullMQ queue would run on is a single `cache.t4g.micro` node with no
 * replica, no failover and no snapshots, shared with six live backends, so a
 * node replacement loses whatever was queued. Our rule is that the queue is
 * dispatch and never the record — and the cleanest way to honour a rule about
 * what a queue may not be relied upon for is not to have one: the delivery ROW
 * is unambiguously the record, written before any attempt and re-derivable in
 * full by re-running the fan-out over the outbox.
 *
 * A queue would be a latency optimisation over this loop, and `runWebhookPass`
 * is the seam it would call. Adding one also needs `REDIS_URL` to carry an
 * explicit non-zero database index, enforced in `deploy-aws.yml`, or two Oxy
 * backends elect one leader between them and consume each other's jobs.
 *
 * ## The poll interval, against §16.5
 *
 * One second by default. The interval adds at most that much to each attempt, so
 * over a delivery's seven attempts it contributes under ten seconds to a
 * schedule that spans thirty-two hours — immaterial against §16.5's 24-hour
 * target, and small even against the ladder's tightest thirty-second rung. The
 * margin is stated here so the next person can see it rather than re-derive it:
 * the interval could grow by two orders of magnitude before it mattered to the
 * SLO, and what it actually costs is how quickly a FIRST attempt goes out.
 */

/** The transport in use. Replaced only by a test, and always restored. */
let transport: WebhookTransport = safeFetchTransport;

export function setWebhookTransport(replacement: WebhookTransport): void {
  transport = replacement;
}

/** Restores the production transport. */
export function resetWebhookTransport(): void {
  transport = safeFetchTransport;
}

/** The transport a delivery would use right now. Read by the test that pins it. */
export function currentWebhookTransport(): WebhookTransport {
  return transport;
}

/**
 * Classifies a failure that produced no HTTP status.
 *
 * `SsrfRejection` is terminal, not transient. The URL passed the offline check
 * at registration and now resolves into a private or reserved range, which is
 * either a misconfiguration or a rebinding attempt — and either way, retrying it
 * six more times means probing an internal address on a schedule. It becomes a
 * visible dead letter instead, which is the thing an operator should see.
 *
 * Everything else — connection refused, TLS failure, redirect loop, timeout — is
 * a receiver that may come back.
 */
function classifyTransportError(error: unknown): WebhookOutcome {
  if (error instanceof SsrfRejection) {
    return { kind: 'unsafe_target', failureKind: 'unsafe_target' };
  }
  if (error instanceof WebhookSecretUnavailableError) {
    // Nothing was sent. The endpoint's secret could not be decrypted — a missing
    // or wrong WEBHOOK_SECRET_ENCRYPTION_KEY — which is an operator's problem to
    // fix and a delivery that should survive until they do.
    return { kind: 'transient', failureKind: 'secret_unavailable' };
  }
  return { kind: 'transient', failureKind: 'upstream_unreachable' };
}

/**
 * Makes one attempt at one delivery and records what happened.
 *
 * Exported so it can be driven directly. The claim loop is not the interesting
 * part — the classification and what it does to the delivery is — and going
 * through the loop would couple every assertion to whatever else is due.
 */
export async function attemptDelivery(
  delivery: WebhookDeliveryDocument,
  now: Date = new Date(),
): Promise<void> {
  const context = createTenantContext(delivery.organizationId, delivery.applicationId);
  const endpoint = await webhookEndpoints.findOne(context, {
    webhookEndpointId: delivery.webhookEndpointId,
  });

  /**
   * The endpoint was disabled — or, unreachably today, removed — between
   * fan-out and this attempt. Terminal rather than retried: a disabled endpoint
   * is a decision somebody made, and the delivery stays as a dead letter that a
   * replay can pick up once the endpoint is registered again.
   */
  if (!endpoint || endpoint.status !== 'active') {
    await recordAttempt(
      delivery,
      {
        outcome: { kind: 'endpoint_disabled', failureKind: 'endpoint_disabled' },
        responseStatus: null,
        failureKind: 'endpoint_disabled',
        responseBody: '',
        latencyMs: 0,
        secretVersion: null,
      },
      now,
    );
    return;
  }

  let secretVersion: number | null = null;
  const startedAt = Date.now();

  try {
    const secret = await signingSecretAt(context, delivery.webhookEndpointId, now);
    secretVersion = secret.version;

    /**
     * The timestamp is generated ONCE, as a string, and the same string is both
     * signed and sent. Re-deriving it for the header from a parsed number is the
     * mistake §10.8's signature exists to catch.
     */
    const timestamp = webhookTimestamp(now);
    const signature = signWebhookPayload(secret.value, timestamp, delivery.body);

    const response = await transport({
      url: endpoint.url,
      body: delivery.body,
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_EVENT_ID_HEADER]: delivery.eventId,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: signature,
      },
    });

    const outcome = classifyResponseStatus(response.status);
    const retryAfterMs = parseRetryAfter(response.retryAfter, now);

    const result: AttemptResult = {
      outcome,
      responseStatus: response.status,
      failureKind: outcome.failureKind,
      responseBody: response.body,
      latencyMs: Date.now() - startedAt,
      secretVersion,
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    };
    await recordAttempt(delivery, result, now);

    /**
     * §10.9: "a 410 may disable the endpoint". It does. 410 is the one status
     * whose HTTP meaning is that the resource is permanently gone rather than
     * unavailable right now, so continuing to deliver is noise for both sides.
     * Re-registering the same URL brings it back, which is the only route §10.2
     * offers and a deliberate one.
     */
    if (outcome.kind === 'endpoint_gone') {
      const disabled = await disableWebhookEndpoint(
        context,
        delivery.webhookEndpointId,
        'gone',
        now,
      );
      if (disabled) {
        logger.warn(
          {
            webhookEndpointId: delivery.webhookEndpointId,
            applicationId: delivery.applicationId,
            deliveryId: delivery.deliveryId,
          },
          'Webhook endpoint disabled after 410 Gone',
        );
      }
    }
  } catch (error: unknown) {
    const outcome = classifyTransportError(error);
    await recordAttempt(
      delivery,
      {
        outcome,
        responseStatus: null,
        failureKind: outcome.failureKind,
        // No response, so nothing to redact — and the error's own message is
        // NOT used: a transport error can quote the request it failed on.
        responseBody: '',
        latencyMs: Date.now() - startedAt,
        secretVersion,
      },
      now,
    );
  }
}

export interface WebhookPassSummary {
  readonly claimed: number;
  readonly delivered: number;
}

/**
 * Drains up to `limit` due deliveries.
 *
 * The seam a queue job would call. `delivered` counts attempts made, not
 * successes — a claim that produced an attempt is progress whatever the receiver
 * answered, and the delivery's own status is where the outcome lives.
 */
export async function runWebhookPass(
  limit = 25,
  now: Date = new Date(),
): Promise<WebhookPassSummary> {
  let claimed = 0;
  let delivered = 0;

  for (let index = 0; index < limit; index += 1) {
    const delivery = await claimDueDelivery(now);
    if (!delivery) break;
    claimed += 1;

    try {
      await attemptDelivery(delivery, now);
      delivered += 1;
    } catch (error: unknown) {
      /**
       * `attemptDelivery` handles its own failures, so reaching here means the
       * RECORDING failed — the database, not the receiver. The lease expires and
       * the delivery is reclaimed, which is the correct outcome; what must not
       * happen is one broken row ending the pass for every other tenant.
       *
       * The message only, never the error object: a driver error quotes the
       * document it choked on, and that document carries the delivery body.
       */
      logger.error(
        {
          deliveryId: delivery.deliveryId,
          reason: error instanceof Error ? error.message.slice(0, 200) : 'Unknown failure',
        },
        'Webhook delivery attempt could not be recorded',
      );
    }
  }

  return { claimed, delivered };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the delivery loop.
 *
 * Called by `server.ts` and never by `app.ts`: building the HTTP application
 * must not start a timer. `.unref()` for the reason the ecosystem requires it of
 * every module-level interval — a housekeeping timer that keeps the event loop
 * alive turns a clean shutdown into a hang, and under a test runner it hangs the
 * whole run.
 */
export function startWebhookDeliveryWorker(intervalMs = 1_000): void {
  if (timer) return;

  timer = setInterval(() => {
    void runWebhookPass().catch((error: unknown) => {
      logger.error({ err: error }, 'Webhook delivery pass failed');
    });
  }, intervalMs);
  timer.unref?.();
}

export function stopWebhookDeliveryWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
