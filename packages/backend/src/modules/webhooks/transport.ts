import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import { safeFetch } from '@oxyhq/core/server';

import { WEBHOOK_RESPONSE_PREVIEW_LIMIT } from './redaction';

/**
 * The outbound HTTP hop, behind one seam.
 *
 * Delivery is the only place CrowdSource contacts an address a tenant chose, so
 * it is the only place SSRF can happen, and it goes through `safeFetch` from
 * `@oxyhq/core/server` — the ecosystem's one implementation. What that buys and
 * why a second implementation would be wrong:
 *
 *  - Every hop is validated against the private, loopback, link-local and
 *    metadata ranges, INCLUDING each redirect, rather than only the first URL.
 *  - The connection is pinned to the address that was validated, so DNS is not
 *    re-resolved at connect time and a rebinding answer cannot arrive between
 *    the check and the socket.
 *  - Redirect bodies are destroyed rather than drained, so a redirect chain
 *    cannot be used to make us read an unbounded body.
 *
 * Registration already refuses what is decidable offline (`endpoint.service.ts`),
 * but DNS can change between then and now, so this is the check that counts.
 *
 * The seam exists because a test cannot reach a real endpoint through
 * `safeFetch` — by design, since every address a test could bind is one
 * `safeFetch` refuses. So the transport is injectable, and the DEFAULT is
 * asserted to be the safeFetch-backed one, with a test that drives a blocked
 * literal address straight through it. A seam that quietly became the production
 * path would be the worst outcome here, so the default is pinned rather than
 * assumed.
 */

export interface WebhookTransportRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface WebhookTransportResponse {
  readonly status: number;
  /** A bounded prefix, raw. Redaction happens where it is stored, not here. */
  readonly body: string;
  readonly retryAfter: string | undefined;
}

export type WebhookTransport = (
  request: WebhookTransportRequest,
) => Promise<WebhookTransportResponse>;

/**
 * How long to wait for response HEADERS.
 *
 * §10.8 asks receivers to answer 2xx quickly and queue the processing, so a
 * receiver that has not sent a status line in ten seconds is not slow, it is
 * doing the work inline — and waiting longer would let one such endpoint hold a
 * worker while every other tenant's deliveries queue behind it.
 */
export const WEBHOOK_HEADERS_TIMEOUT_MS = 10_000;

/**
 * How long to spend reading the bounded body prefix after headers arrive.
 *
 * Separate from the headers deadline because it guards a different attack: a
 * receiver that answers 500 instantly and then trickles one byte a minute would
 * otherwise hold the socket for as long as it liked, since the read only ends
 * when the limit is reached.
 */
export const WEBHOOK_BODY_TIMEOUT_MS = 5_000;

function firstHeader(value: IncomingHttpHeaders[string]): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Reads at most `limit` bytes, then destroys the stream.
 *
 * `safeFetch` hands the caller the response and says the caller owns it, so this
 * is that ownership: take a bounded prefix for the attempt record and destroy
 * the rest. Nothing streams a tenant's response into memory whole.
 */
export async function readBoundedBody(
  response: IncomingMessage,
  limit: number,
  timeoutMs: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  const deadline = setTimeout(() => {
    response.destroy();
  }, timeoutMs);
  deadline.unref?.();

  try {
    for await (const chunk of response) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = limit - total;
      if (remaining <= 0) break;
      chunks.push(buffer.subarray(0, remaining));
      total += buffer.length;
      if (total >= limit) break;
    }
  } catch {
    /**
     * The stream ended badly — destroyed by the deadline above, or the
     * connection dropped mid-body. Whatever arrived before that is still the
     * best evidence there is for the attempt record, and the STATUS has already
     * been read, so this is not a failed delivery. The error itself is dropped
     * rather than wrapped: it can quote the buffer it choked on, and that
     * buffer is a tenant's response body.
     */
  } finally {
    clearTimeout(deadline);
    response.destroy();
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** The production transport. Never replaced outside a test. */
export const safeFetchTransport: WebhookTransport = async (request) => {
  const result = await safeFetch(request.url, {
    method: 'POST',
    headers: { ...request.headers },
    body: request.body,
    headersTimeoutMs: WEBHOOK_HEADERS_TIMEOUT_MS,
  });

  return {
    status: result.status,
    body: await readBoundedBody(
      result.response,
      WEBHOOK_RESPONSE_PREVIEW_LIMIT,
      WEBHOOK_BODY_TIMEOUT_MS,
    ),
    retryAfter: firstHeader(result.headers['retry-after']),
  };
};
