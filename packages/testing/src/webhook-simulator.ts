/**
 * The webhook simulator — the producer side of §10.8.
 *
 * An integrator can point this at their own receiver and watch a real delivery
 * arrive, signed exactly as CrowdSource signs one, without a jury having sat and
 * without anything being enforced against a real user.
 *
 * It deliberately also makes it easy to send a delivery that is WRONG:
 * `expired`, `wrongSecret`, `tampered` and a raw `signature` override are here
 * so an integration test can assert that the receiver REFUSES those. A test
 * suite that only ever sends valid deliveries proves the receiver can say yes.
 * Proving it can say no is the part that matters, and it is the part nobody
 * writes unless the tooling makes it a one-liner.
 *
 * Signing lives here rather than in `@oxyhq/crowdsource-express` because the two
 * are opposite sides of the contract: the verifier must never import a signer
 * that could be "corrected" until they agree with each other and both disagree
 * with the service. What they share instead is
 * `buildWebhookSignedPayload` from the contracts package, which is the one
 * definition of what gets signed.
 */

import { createHmac } from 'node:crypto';

import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_HEADER,
  buildWebhookSignedPayload,
} from '@oxyhq/crowdsource-contracts';

export interface SignedWebhookDelivery {
  /** Headers as CrowdSource sends them, plus `content-type`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The exact bytes that were signed. Send these, not a re-serialisation. */
  readonly body: string;
}

export interface SignWebhookInput {
  readonly secret: string;
  /**
   * The event to deliver. Typed as `unknown` on purpose: a simulator that only
   * accepted `KnownWebhookEvent` could not send an event type from a future
   * version of the service, which is precisely the case §10.11 asks every
   * receiver to survive.
   */
  readonly event: unknown;
  /** Unix seconds. Defaults to now. */
  readonly timestampSeconds?: number;
  /** Overrides the body sent, WITHOUT re-signing it. For tamper tests. */
  readonly tamperedBody?: string;
  /** Overrides the signature header verbatim. For forgery tests. */
  readonly signature?: string;
  /** Overrides the event id header, to test header/body disagreement. */
  readonly eventId?: string;
}

function eventIdOf(event: unknown): string {
  if (typeof event === 'object' && event !== null && 'id' in event) {
    const id: unknown = (event as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  throw new TypeError('A webhook event must carry a string `id` (§10.7).');
}

/** Signs one delivery. */
export function signWebhookDelivery(input: SignWebhookInput): SignedWebhookDelivery {
  const signedBody = JSON.stringify(input.event);
  const timestamp = String(input.timestampSeconds ?? Math.floor(Date.now() / 1_000));

  const signature =
    input.signature ??
    `${WEBHOOK_SIGNATURE_VERSION}=${createHmac('sha256', input.secret)
      .update(buildWebhookSignedPayload(timestamp, signedBody), 'utf8')
      .digest('hex')}`;

  return {
    headers: {
      'content-type': 'application/json',
      [WEBHOOK_EVENT_ID_HEADER]: input.eventId ?? eventIdOf(input.event),
      [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      [WEBHOOK_SIGNATURE_HEADER]: signature,
    },
    // The tampered body is sent WITHOUT re-signing, which is the whole point:
    // the signature above covers `signedBody` and the receiver is handed
    // something else.
    body: input.tamperedBody ?? signedBody,
  };
}

export interface WebhookDeliveryResult {
  readonly status: number;
  readonly body: unknown;
}

export interface WebhookSimulatorOptions {
  readonly secret: string;
  /** The receiver's webhook URL. */
  readonly url: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** How a delivery should be wrong, for a test that asserts a refusal. */
export interface WebhookDeliveryOverrides {
  /** Signs with a timestamp far outside §10.8's five-minute window. */
  readonly expired?: boolean;
  /** Signs with a secret the receiver does not hold. */
  readonly wrongSecret?: string;
  /** Sends a body different from the one that was signed. */
  readonly tamperedBody?: string;
  readonly signature?: string;
  readonly eventId?: string;
  readonly timestampSeconds?: number;
}

/** Comfortably outside the five-minute window, in either direction. */
const EXPIRED_SKEW_SECONDS = 3_600;

export class WebhookSimulator {
  private readonly options: WebhookSimulatorOptions;

  constructor(options: WebhookSimulatorOptions) {
    this.options = options;
  }

  /** Signs a delivery without sending it. */
  sign(event: unknown, overrides: WebhookDeliveryOverrides = {}): SignedWebhookDelivery {
    return signWebhookDelivery({
      secret: overrides.wrongSecret ?? this.options.secret,
      event,
      timestampSeconds:
        overrides.timestampSeconds ??
        Math.floor(Date.now() / 1_000) - (overrides.expired === true ? EXPIRED_SKEW_SECONDS : 0),
      ...(overrides.tamperedBody === undefined ? {} : { tamperedBody: overrides.tamperedBody }),
      ...(overrides.signature === undefined ? {} : { signature: overrides.signature }),
      ...(overrides.eventId === undefined ? {} : { eventId: overrides.eventId }),
    });
  }

  /** Signs and POSTs a delivery to the receiver. */
  async deliver(
    event: unknown,
    overrides: WebhookDeliveryOverrides = {},
  ): Promise<WebhookDeliveryResult> {
    const delivery = this.sign(event, overrides);
    const fetchImpl = this.options.fetch ?? globalThis.fetch;

    const response = await fetchImpl(this.options.url, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
    });

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  }
}
