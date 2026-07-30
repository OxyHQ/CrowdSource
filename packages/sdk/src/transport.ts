/**
 * The HTTP transport: one authenticated call, and what happens when it fails.
 *
 * Two things here are worth reading before changing anything.
 *
 * **Retries do not replace the integrator's outbox.** §7.1 is explicit that the
 * durable retry path belongs to the application: it stores the report and an
 * outbox row in one operation, and a worker re-delivers until CrowdSource
 * accepts. The retries below only smooth over a blip inside a single delivery
 * attempt — they are bounded, they only fire for the statuses §10.5 marks as
 * "come back later", and when they give up the error they throw still says
 * `retryable: true` so the outbox keeps its job.
 *
 * **A retry is only safe because the write is idempotent.** Every write this
 * client makes carries an `Idempotency-Key` (Appendix D), so a request that was
 * received but whose response was lost returns the same `reportId` on the next
 * attempt rather than creating a second report. A write without one must not be
 * retried, and `request` refuses to retry a mutation that has no key rather than
 * trusting the caller to have thought about it.
 */

import {
  CrowdSourceApiError,
  CrowdSourceTransportError,
  apiErrorCodeForStatus,
  isCrowdSourceApiErrorCode,
} from './errors.js';

export type FetchLike = typeof globalThis.fetch;

/** How long a single attempt may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Attempts per call, including the first. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** The base of the exponential backoff between attempts. */
const RETRY_BASE_DELAY_MS = 250;

/** A cap so a `Retry-After` of an hour cannot hang a delivery worker. */
const RETRY_DELAY_CEILING_MS = 5_000;

export interface TransportConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly fetch: FetchLike;
}

export interface TransportRequest {
  readonly method: 'GET' | 'POST';
  /** Absolute path from the service root, e.g. `/v1/reports`. */
  readonly path: string;
  readonly body?: unknown;
  /** Appendix D. Required for every mutation; a mutation without one is a defect. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

function parsedErrorBody(payload: unknown): ErrorBody | null {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return null;

  const error: unknown = (payload as { error: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;

  const record: Record<string, unknown> = { ...error };
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null;

  const details =
    typeof record.details === 'object' && record.details !== null
      ? (record.details as Readonly<Record<string, string | number | boolean>>)
      : undefined;

  return { code: record.code, message: record.message, details };
}

/** `Retry-After` in either of its two legal forms, in milliseconds. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

/**
 * Full jitter over an exponential base. Without jitter, every worker that hit
 * the same 503 comes back at the same millisecond and reproduces it.
 */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_DELAY_CEILING_MS);
  return Math.random() * ceiling;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CrowdSourceTransportError('The request was aborted.', { retryable: false }));
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Transport {
  private readonly config: TransportConfig;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  async request<T>(request: TransportRequest): Promise<T> {
    if (request.method !== 'GET' && request.idempotencyKey === undefined) {
      throw new Error(
        `A ${request.method} to ${request.path} was made without an idempotency key. Appendix D requires one on every write.`,
      );
    }

    let lastError: CrowdSourceApiError | CrowdSourceTransportError | null = null;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      const outcome = await this.attempt<T>(request);
      if (outcome.ok) return outcome.value;

      lastError = outcome.error;
      if (!outcome.error.retryable || attempt === this.config.maxAttempts) break;

      await delay(outcome.retryAfterMs ?? backoffMs(attempt), request.signal);
    }

    // Unreachable with `maxAttempts >= 1`; the loop either returns or assigns.
    if (lastError === null) {
      throw new CrowdSourceTransportError('The request was never attempted.', {
        retryable: false,
      });
    }
    throw lastError;
  }

  private async attempt<T>(
    request: TransportRequest,
  ): Promise<
    | { ok: true; value: T }
    | {
        ok: false;
        error: CrowdSourceApiError | CrowdSourceTransportError;
        retryAfterMs?: number;
      }
  > {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.config.bearerToken}`,
    };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    if (request.idempotencyKey !== undefined) {
      headers['idempotency-key'] = request.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.config.fetch(`${this.config.baseUrl}${request.path}`, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: this.attemptSignal(request.signal),
      });
    } catch (cause: unknown) {
      const callerAborted = request.signal?.aborted === true;
      return {
        ok: false,
        error: new CrowdSourceTransportError(
          callerAborted
            ? 'The request was aborted by the caller.'
            : `The request to ${request.path} did not complete.`,
          { cause, retryable: !callerAborted },
        ),
      };
    }

    if (response.ok) {
      return { ok: true, value: (await this.readJson(response)) as T };
    }

    const payload: unknown = await this.readJson(response).catch(() => null);
    const body = parsedErrorBody(payload);
    const code =
      body !== null && isCrowdSourceApiErrorCode(body.code)
        ? body.code
        : apiErrorCodeForStatus(response.status);

    return {
      ok: false,
      error: new CrowdSourceApiError({
        status: response.status,
        code,
        message: body?.message ?? `CrowdSource answered ${response.status} for ${request.path}.`,
        details: body?.details,
      }),
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')) ?? undefined,
    };
  }

  /** The caller's cancellation and this attempt's timeout, as one signal. */
  private attemptSignal(callerSignal: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    return callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch (cause: unknown) {
      throw new CrowdSourceTransportError('CrowdSource answered with a body that is not JSON.', {
        cause,
        retryable: false,
      });
    }
  }
}
