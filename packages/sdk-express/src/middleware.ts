/**
 * The webhook receiver.
 *
 * ```ts
 * app.post('/webhooks/crowdsource', crowdsourceWebhooks({
 *   on: {
 *     'case.decided': async (event) => { await moderationQueue.add(event.id, event.data); },
 *   },
 * }));
 * ```
 *
 * No `express.raw`, no body-parser ordering to get right, no secret to plumb
 * through — the secret comes from the environment and the handler reads the
 * request stream itself. That is not convenience for its own sake. The single
 * most likely way to ship a broken CrowdSource integration is to verify a
 * signature over `JSON.stringify(req.body)`, which succeeds on every test
 * payload a developer writes by hand and fails on the first real delivery whose
 * key order or unicode escaping differs — or, far worse, succeeds on a forged
 * body that happens to re-serialise identically. This middleware makes that
 * unreachable: it verifies the bytes it read, and if something upstream already
 * consumed them it REFUSES rather than reconstructing them.
 *
 * What it guarantees, in order:
 *
 *   1. The signature is checked over the bytes that arrived (§10.8).
 *   2. A timestamp outside the five-minute window is rejected before anything
 *      is dispatched, in both directions.
 *   3. An event id already claimed is acknowledged without running the handler
 *      again (§10.8), and a handler that throws releases the claim so the
 *      retry in §10.9 still works.
 *   4. An event type this integration does not handle — including one that did
 *      not exist when it was written — is acknowledged and ignored (§10.11). A
 *      new event type never breaks an existing integration.
 *   5. Nothing sensitive is logged. The `onRejected` hook is given the reason
 *      and never the body (§10.8's last line).
 */

import type { RequestHandler, Request, Response, NextFunction } from 'express';

import {
  KnownWebhookEventSchema,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookEventEnvelopeSchema,
  type KnownWebhookEvent,
  type WebhookEventEnvelope,
  type WebhookEventType,
} from '@oxyhq/crowdsource-contracts';

import { memoryProcessedEventStore, type ProcessedEventStore } from './store.js';
import { verifyWebhookDelivery, type WebhookRejection } from './verify.js';

/** The active signing secret. */
export const WEBHOOK_SECRET_ENV_VAR = 'CROWDSOURCE_WEBHOOK_SECRET';

/** The secret being retired, during the overlap §10.8 requires for rotation. */
export const WEBHOOK_PREVIOUS_SECRET_ENV_VAR = 'CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS';

/** Matches the backend's own `express.json` limit. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * A handler per event type, each receiving the event with its payload narrowed.
 *
 * Every entry is optional and an absent one is not an error: an integration that
 * only cares about `case.decided` registers only that.
 */
export type WebhookEventHandlers = {
  readonly [T in WebhookEventType]?: (
    event: Extract<KnownWebhookEvent, { type: T }>,
  ) => void | Promise<void>;
};

export interface CrowdSourceWebhooksOptions {
  /**
   * The active secret. Defaults to `process.env.CROWDSOURCE_WEBHOOK_SECRET`.
   */
  readonly secret?: string;
  /**
   * The secret being retired. Defaults to
   * `process.env.CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS`. Both are accepted while
   * it is set, which is what makes a rotation lossless (§10.8).
   */
  readonly previousSecret?: string;
  readonly on?: WebhookEventHandlers;
  /**
   * Called for a verified event no handler in `on` covers, including a type this
   * version of the contracts package does not know. Optional: without it, an
   * unhandled event is acknowledged and dropped, which is what §10.11 requires.
   */
  readonly onUnhandled?: (event: WebhookEventEnvelope) => void | Promise<void>;
  /** Defaults to an in-process store. See `store.ts` for when that is not enough. */
  readonly store?: ProcessedEventStore;
  /** §10.8's five minutes. Lower it in tests, never raise it in production. */
  readonly toleranceSeconds?: number;
  readonly maxBodyBytes?: number;
  /**
   * Observability for a refused delivery. Receives the reason and nothing else
   * — never the body, never the signature, never a header.
   */
  readonly onRejected?: (rejection: WebhookRejection) => void;
}

/**
 * Thrown when the request cannot be verified because of how the application is
 * assembled, not because of anything the sender did.
 *
 * Passed to `next()` so it reaches the application's error handler and is
 * impossible to miss. The alternative — falling back to `req.body` — is the bug
 * this whole package exists to prevent.
 */
export class CrowdSourceWebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrowdSourceWebhookConfigurationError';
  }
}

export function crowdsourceWebhooks(options: CrowdSourceWebhooksOptions = {}): RequestHandler {
  const store = options.store ?? memoryProcessedEventStore();
  const handlers = options.on ?? {};
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return (request: Request, response: Response, next: NextFunction): void => {
    void handleDelivery({
      request,
      response,
      next,
      store,
      handlers,
      maxBodyBytes,
      options,
    });
  };
}

interface DeliveryContext {
  readonly request: Request;
  readonly response: Response;
  readonly next: NextFunction;
  readonly store: ProcessedEventStore;
  readonly handlers: WebhookEventHandlers;
  readonly maxBodyBytes: number;
  readonly options: CrowdSourceWebhooksOptions;
}

async function handleDelivery(context: DeliveryContext): Promise<void> {
  const { request, response, next, options } = context;

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(request, context.maxBodyBytes);
  } catch (error: unknown) {
    if (error instanceof BodyTooLargeError) {
      options.onRejected?.('payload_too_large');
      response.status(413).json({ received: false, rejection: 'payload_too_large' });
      return;
    }
    next(error);
    return;
  }

  const verification = verifyWebhookDelivery({
    eventIdHeader: request.get(WEBHOOK_EVENT_ID_HEADER),
    timestampHeader: request.get(WEBHOOK_TIMESTAMP_HEADER),
    signatureHeader: request.get(WEBHOOK_SIGNATURE_HEADER),
    rawBody,
    secrets: configuredSecrets(options),
    nowMs: Date.now(),
    ...(options.toleranceSeconds === undefined
      ? {}
      : { toleranceSeconds: options.toleranceSeconds }),
  });

  if (!verification.ok) {
    options.onRejected?.(verification.rejection);
    /**
     * 401, not 400. A refused delivery is an authentication failure from the
     * sender's point of view, and §10.9 keeps retrying 4xx a bounded number of
     * times either way — what matters is that it is never a 2xx, because a 2xx
     * would retire the delivery as successfully processed.
     *
     * `no_secret_configured` is the one case that is OUR fault, and it still
     * answers 401 rather than 500: a receiver with no secret must not tell the
     * world it is running unconfigured, and answering non-2xx keeps the event on
     * the sender's retry schedule until somebody fixes it.
     */
    response.status(401).json({ received: false, rejection: verification.rejection });
    return;
  }

  const parsed = WebhookEventEnvelopeSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) {
    options.onRejected?.('malformed_event');
    response.status(400).json({ received: false, rejection: 'malformed_event' });
    return;
  }
  const envelope = parsed.data;

  /**
   * The signed header and the signed body must name the same event. They are
   * both inside the signature, so a disagreement is not an attack — it is a
   * sender defect — but a receiver that deduped on the header while handling the
   * body would process one event under another's id.
   */
  if (envelope.id !== verification.eventId) {
    options.onRejected?.('event_id_mismatch');
    response.status(400).json({ received: false, rejection: 'event_id_mismatch' });
    return;
  }

  const claimed = await context.store.claim(envelope.id);
  if (!claimed) {
    response.status(200).json({ received: true, eventId: envelope.id, duplicate: true });
    return;
  }

  try {
    const handled = await dispatch(context.handlers, envelope, options.onUnhandled);
    response.status(200).json({ received: true, eventId: envelope.id, duplicate: false, handled });
  } catch (error: unknown) {
    // The claim goes back so §10.9's retry schedule can deliver it again. Losing
    // a decision because a queue was briefly down is not an acceptable outcome.
    await context.store.release(envelope.id);
    next(error);
  }
}

/**
 * Dispatches a verified event, and returns whether anything handled it.
 *
 * The switch is exhaustive over the contract's event types on purpose: adding an
 * event to `WEBHOOK_EVENT_TYPES` stops this file compiling until it is handled
 * here, which is the right failure for the SDK. For an INTEGRATION it is the
 * opposite — the `default` branch means an unrecognised type is acknowledged and
 * ignored, so a newer CrowdSource never breaks an older receiver (§10.11).
 *
 * The payload is only parsed against the known-event schema when a handler is
 * actually registered for that type. An integration handling `case.decided` is
 * therefore unaffected by a later change to what `appeal.created` carries.
 */
async function dispatch(
  handlers: WebhookEventHandlers,
  envelope: WebhookEventEnvelope,
  onUnhandled: CrowdSourceWebhooksOptions['onUnhandled'],
): Promise<boolean> {
  const known = KnownWebhookEventSchema.safeParse(envelope);
  if (known.success && (await invoke(handlers, known.data))) return true;

  if (onUnhandled) {
    await onUnhandled(envelope);
    return true;
  }
  return false;
}

/** Calls `handler` with `event` if there is one, and says whether there was. */
async function call<T>(
  handler: ((event: T) => void | Promise<void>) | undefined,
  event: T,
): Promise<boolean> {
  if (handler === undefined) return false;
  await handler(event);
  return true;
}

/**
 * The exhaustive half of `dispatch`, written out rather than looked up.
 *
 * Indexing the handler map with `event.type` while `event.type` is still a union
 * would need a cast to call the result, and a cast is exactly what must not sit
 * between a signed event and the code that acts on it. Narrowing per case is
 * what makes each call provably well-typed, and it means adding an event to the
 * contract stops this file compiling until it is handled.
 */
async function invoke(
  handlers: WebhookEventHandlers,
  event: KnownWebhookEvent,
): Promise<boolean> {
  switch (event.type) {
    case 'report.received':
      return await call(handlers['report.received'], event);
    case 'case.created':
      return await call(handlers['case.created'], event);
    case 'case.escalated':
      return await call(handlers['case.escalated'], event);
    case 'case.decided':
      return await call(handlers['case.decided'], event);
    case 'decision.corrected':
      return await call(handlers['decision.corrected'], event);
    case 'appeal.created':
      return await call(handlers['appeal.created'], event);
    case 'appeal.decided':
      return await call(handlers['appeal.decided'], event);
    case 'case.closed':
      return await call(handlers['case.closed'], event);
    default:
      return false;
  }
}

function configuredSecrets(options: CrowdSourceWebhooksOptions): readonly string[] {
  const active = options.secret ?? process.env[WEBHOOK_SECRET_ENV_VAR];
  const previous = options.previousSecret ?? process.env[WEBHOOK_PREVIOUS_SECRET_ENV_VAR];
  return [active, previous].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
}

function parseJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

class BodyTooLargeError extends Error {}

/**
 * The bytes as they arrived.
 *
 * Three sources, in the order that keeps the guarantee:
 *
 *   1. `req.body` is already a Buffer — `express.raw()` is mounted ahead of this
 *      handler, which is correct and supported.
 *   2. `req.rawBody` is a Buffer — the `express.json({ verify })` idiom, also
 *      correct.
 *   3. Nothing has touched the request — read the stream.
 *
 * Anything else REFUSES. A parsed `req.body` means a JSON parser ran first and
 * the original bytes are gone; re-serialising them would produce a different
 * value from the one that was signed, and the only way to make that "work"
 * would be to verify a signature over bytes CrowdSource never sent.
 */
async function readRawBody(request: Request, maxBodyBytes: number): Promise<Buffer> {
  const carried: unknown = Reflect.get(request, 'rawBody');
  if (Buffer.isBuffer(carried)) return carried;

  const parsedBody: unknown = request.body;
  if (Buffer.isBuffer(parsedBody)) return parsedBody;

  if (parsedBody !== undefined && parsedBody !== null) {
    throw new CrowdSourceWebhookConfigurationError(
      'A body parser ran before the CrowdSource webhook handler, so the signed bytes no longer exist. Mount this handler before express.json(), scope express.json() away from the webhook route, or use express.json({ verify }) to keep the raw body.',
    );
  }

  if (request.readableEnded) {
    throw new CrowdSourceWebhookConfigurationError(
      'The request body was already consumed before the CrowdSource webhook handler ran, so the signed bytes no longer exist.',
    );
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        settled = true;
        // Paused rather than destroyed: destroying the request takes the socket
        // with it, and the 413 the caller is about to write would never reach
        // the sender — which would turn a clear refusal into a connection reset
        // that a delivery worker can only report as "unknown".
        request.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
