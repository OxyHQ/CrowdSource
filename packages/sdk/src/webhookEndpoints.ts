/**
 * Telling CrowdSource where to deliver decisions, and holding the secret it
 * mints once.
 *
 * This is the half of the webhook integration that used to have no client at
 * all: `@oxyhq/crowdsource-express` verifies deliveries against
 * `CROWDSOURCE_WEBHOOK_SECRET`, and there was no supported way to obtain that
 * value except hand-rolling an HTTP call with the bearer half of the service
 * key. "Near-zero configuration" cannot mean an integrator writes their own
 * fetch for a mandatory step, so §10.2's two management routes are here.
 *
 * Two properties of the secret shape everything below, and both are the server's
 * design rather than this client's choice:
 *
 *   * **It is returned once and never again.** A webhook secret is decryptable
 *     by CrowdSource because deliveries have to be signed with it, but re-serving
 *     it would turn any credential holding `webhooks:manage` into a way to read
 *     the signing key of an endpoint somebody else configured. So `secret` on a
 *     registration is the only time that value exists outside the service.
 *   * **Re-registering an existing URL mints nothing.** That is what makes a
 *     deploy script safe to run on every boot — it will not invalidate the
 *     secret the running process is verifying with. The corollary is that
 *     re-registering cannot RECOVER a secret you failed to store; that is what
 *     `rotateSecret` is for.
 *
 * Which is why `secret` is optional on the result. Its presence is not a detail:
 * it means a value has just come into existence that nothing can produce again,
 * and the integration is responsible for persisting it before the process exits.
 */

import { z } from 'zod';

import { sha256Digest } from './digest';
import { CrowdSourceTransportError } from './errors';
import type { Transport } from './transport';

/**
 * A signing secret, at the one moment it is visible.
 *
 * `signingStartsAt` is what makes a rotation overlap followable rather than
 * guesswork: deliveries begin carrying this signature at that instant, so
 * "install both, retire the old one after this time" is a procedure instead of
 * an estimate.
 */
export interface WebhookSecret {
  readonly version: number;
  /** The value to configure as `CROWDSOURCE_WEBHOOK_SECRET`. Shown once. */
  readonly value: string;
  /** ISO-8601 UTC. When deliveries start being signed with this version. */
  readonly signingStartsAt: string;
}

/** A registered endpoint, and the secret if this call is what created it. */
export interface WebhookEndpoint {
  readonly webhookEndpointId: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  /**
   * Kept open deliberately. §10.11 requires a newer server not to break an older
   * client, and a status added later is exactly that case.
   */
  readonly status: string;
  readonly disabledReason: string | null;
  /** ISO-8601 UTC, as the API sends it. */
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Present ONLY when this call minted one — a newly created endpoint, or one
   * whose subscription revived it. Absent when an existing URL was updated,
   * because an update deliberately leaves the running secret alone.
   *
   * When it is present, store it before doing anything else. Nothing can return
   * it again and `rotateSecret` is the only way to get a working secret back.
   */
  readonly secret?: WebhookSecret;
}

/** The outcome of a rotation: the new secret, and when the old one dies. */
export interface RotatedWebhookSecret {
  readonly webhookEndpointId: string;
  readonly secret: WebhookSecret;
  /**
   * The secret being retired, and the instant it stops being accepted — set it
   * as `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS` until then and a rotation drops no
   * delivery. `null` when the cutover was immediate, which is what a leaked
   * secret needs.
   */
  readonly previousSecret: { readonly version: number; readonly expiresAt: string } | null;
}

export interface RegisterWebhookEndpointInput {
  /** Where CrowdSource should POST. HTTPS in production. */
  readonly url: string;
  /**
   * The event types to subscribe to. Import `WEBHOOK_EVENT_TYPES` from
   * `@oxyhq/crowdsource-contracts` for the current set; unknown types are
   * accepted so a newer contract does not need a new client.
   */
  readonly eventTypes: readonly string[];
}

/**
 * Appendix D's key for a registration.
 *
 * Derived from the URL because the URL is the endpoint's identity as far as the
 * server is concerned — the same URL registered twice is one logical operation,
 * which is exactly what makes a deploy-time `register` safe to retry. Hashed
 * rather than interpolated because a URL carries `:` and `/`, and a composite
 * value with separators in it is how an id grammar gets ambiguous.
 *
 * Note that the two webhook routes do NOT currently read `Idempotency-Key`
 * server-side; only `POST /v1/reports` does. This satisfies the transport's
 * Appendix D requirement and is inert at the service until that changes.
 */
function registrationIdempotencyKey(url: string): string {
  return `webhook-endpoint.${sha256Digest(url).replace('sha256:', '')}`;
}

export interface RotateSecretOptions {
  /**
   * How long the outgoing secret keeps being accepted. `0` is an immediate
   * cutover — the right choice for a leaked secret and the wrong one for routine
   * hygiene, because in-flight deliveries signed with the old secret are refused.
   * Omitted, the server applies its own default overlap.
   */
  readonly overlapSeconds?: number;
  /**
   * Appendix D. Defaults to a key derived from the endpoint id, which makes a
   * RETRY of one rotation safe. Two deliberate rotations are two different
   * operations, so pass a distinct key for the second one.
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface WebhookEndpointRequestOptions {
  /** Appendix D. Defaults to a key derived from the URL being registered. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

const WebhookSecretSchema = z.looseObject({
  version: z.number(),
  value: z.string(),
  signingStartsAt: z.string(),
});

const WebhookEndpointSchema = z.looseObject({
  webhookEndpointId: z.string(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  status: z.string(),
  disabledReason: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  secret: WebhookSecretSchema.optional(),
});

const RotatedWebhookSecretSchema = z.looseObject({
  webhookEndpointId: z.string(),
  secret: WebhookSecretSchema,
  previousSecret: z
    .looseObject({ version: z.number(), expiresAt: z.string() })
    .nullish(),
});

/**
 * §10.2's two webhook-management routes.
 *
 * There is no list, no read-back and no delete, because the API serves none —
 * §10.2 defines exactly two routes. An integrator therefore cannot enumerate
 * what it has registered, which is a real gap in the service rather than
 * something this client can paper over; re-registering a URL is the documented
 * way to change a subscription or revive a disabled endpoint.
 *
 * Both routes need a credential with the `crowdsource:webhooks:manage` scope,
 * and both derive the application from that credential. There is no
 * `applicationId` in any request or response here.
 */
export class WebhookEndpoints {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Registers, or updates, the endpoint CrowdSource delivers to.
   *
   * Safe to call on every deploy: an existing URL is updated and no new secret
   * is minted, so the secret the running process verifies with keeps working.
   */
  async register(
    input: RegisterWebhookEndpointInput,
    options: WebhookEndpointRequestOptions = {},
  ): Promise<WebhookEndpoint> {
    const response = await this.transport.request<unknown>({
      method: 'POST',
      path: '/v1/webhook-endpoints',
      body: { url: input.url, eventTypes: [...input.eventTypes] },
      idempotencyKey: options.idempotencyKey ?? registrationIdempotencyKey(input.url),
      signal: options.signal,
    });

    const parsed = WebhookEndpointSchema.safeParse(response);
    if (!parsed.success) {
      throw new CrowdSourceTransportError(
        'CrowdSource registered the webhook endpoint but answered with a body this client does not recognise.',
        { retryable: false, cause: parsed.error },
      );
    }

    const { disabledReason, secret, ...rest } = parsed.data;
    return {
      ...rest,
      disabledReason: disabledReason ?? null,
      ...(secret === undefined ? {} : { secret }),
    };
  }

  /**
   * Mints a new signing secret, retiring the current one after an overlap.
   *
   * The only way to recover from a secret that was never stored, and the correct
   * response to one that leaked.
   */
  async rotateSecret(
    webhookEndpointId: string,
    options: RotateSecretOptions = {},
  ): Promise<RotatedWebhookSecret> {
    const response = await this.transport.request<unknown>({
      method: 'POST',
      path: `/v1/webhook-endpoints/${encodeURIComponent(webhookEndpointId)}/rotate-secret`,
      body:
        options.overlapSeconds === undefined ? {} : { overlapSeconds: options.overlapSeconds },
      idempotencyKey:
        options.idempotencyKey ??
        `webhook-endpoint.${sha256Digest(webhookEndpointId).replace('sha256:', '')}.rotate`,
      signal: options.signal,
    });

    const parsed = RotatedWebhookSecretSchema.safeParse(response);
    if (!parsed.success) {
      throw new CrowdSourceTransportError(
        'CrowdSource rotated the webhook secret but answered with a body this client does not recognise.',
        { retryable: false, cause: parsed.error },
      );
    }

    return {
      webhookEndpointId: parsed.data.webhookEndpointId,
      secret: parsed.data.secret,
      previousSecret: parsed.data.previousSecret ?? null,
    };
  }
}
