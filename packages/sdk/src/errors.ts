/**
 * The failures an integrator can observe, and the one question they all answer.
 *
 * §7.1 puts the durable retry path in the INTEGRATOR's outbox: a 2xx from their
 * own application means the report is stored locally and will be delivered
 * eventually, never that a synchronous call to CrowdSource succeeded. So the
 * only thing an outbox worker needs from a failure is whether re-delivering the
 * same payload can still succeed. That is `retryable`, and every error below
 * answers it — an integrator branching on `instanceof` or on a status code is
 * re-deriving something this class already knows.
 *
 * The distinction that matters most is 409. §10.5 gives it one meaning: the same
 * `externalReportId` arrived with a different body. Retrying that forever never
 * succeeds and the payload is the thing that has to change, so it is the one
 * 4xx an outbox must stop on rather than back off from.
 */

/**
 * The machine-readable codes §10.5 assigns a meaning to.
 *
 * Declared here rather than imported because `@oxyhq/crowdsource-contracts`
 * does not publish the HTTP error vocabulary — it publishes the documents that
 * travel over HTTP. That is a gap worth closing in contracts rather than a
 * decision to state the list twice: the backend has the same union in
 * `http/apiError.ts`, and the two must not drift. Until it moves, this is the
 * copy integrators compile against.
 */
export const CROWDSOURCE_API_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'unprocessable_envelope',
  'rate_limited',
  'internal_error',
  'service_unavailable',
] as const;

export type CrowdSourceApiErrorCode = (typeof CROWDSOURCE_API_ERROR_CODES)[number];

const API_ERROR_CODE_SET: ReadonlySet<string> = new Set(CROWDSOURCE_API_ERROR_CODES);

export function isCrowdSourceApiErrorCode(value: unknown): value is CrowdSourceApiErrorCode {
  return typeof value === 'string' && API_ERROR_CODE_SET.has(value);
}

/**
 * The code to report when the response carried no usable one — a proxy, a load
 * balancer or a gateway answering instead of the service.
 */
export function apiErrorCodeForStatus(status: number): CrowdSourceApiErrorCode {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 422:
      return 'unprocessable_envelope';
    case 429:
      return 'rate_limited';
    case 503:
      return 'service_unavailable';
    default:
      return 'internal_error';
  }
}

/** The base of every error this package throws. */
export class CrowdSourceError extends Error {
  /** Whether re-delivering the same payload can still succeed. */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.retryable = retryable;
  }
}

/**
 * The client is not configured to be able to make the call.
 *
 * Never retryable: a missing service key, a malformed one or a base URL that is
 * not a URL do not become correct by waiting.
 */
export class CrowdSourceConfigurationError extends CrowdSourceError {
  constructor(message: string) {
    super(message, false);
  }
}

/**
 * The request never produced an HTTP response — DNS, connection, TLS, timeout,
 * or an abort.
 *
 * Retryable, with one exception: an abort the CALLER asked for. Retrying that
 * would ignore the instruction, so it is surfaced as not retryable and the
 * caller decides what happens next.
 */
export class CrowdSourceTransportError extends CrowdSourceError {
  constructor(message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(message, options.retryable ?? true, { cause: options.cause });
  }
}

/**
 * CrowdSource answered, and the answer was a refusal (§10.5).
 *
 * `code` is the machine-readable code from the response body when the service
 * sent one. A proxy or load balancer that answers instead of the service does
 * not, so it is derived from the status in that case rather than left undefined
 * — an integrator switching on `code` should not have to handle "the 502 came
 * from the ALB" as a separate shape.
 */
export class CrowdSourceApiError extends CrowdSourceError {
  readonly status: number;
  readonly code: CrowdSourceApiErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(input: {
    status: number;
    code: CrowdSourceApiErrorCode;
    message: string;
    details?: Readonly<Record<string, string | number | boolean>>;
  }) {
    super(input.message, RETRYABLE_STATUSES.has(input.status));
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
  }

  /** True when this is §10.5's "external id reused with a different body". */
  get isPayloadConflict(): boolean {
    return this.code === 'conflict';
  }
}

/**
 * The statuses a retry of the SAME payload can still resolve.
 *
 * 429 and 503 are the two §10.5 names for "come back later". 5xx is included
 * because a defect on the service side is not a defect in the payload, and the
 * idempotency key makes the retry free of duplicates either way. Every 4xx below
 * 429 is excluded deliberately: a rejected envelope, a missing scope, a revoked
 * credential and a payload conflict all stay rejected.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isCrowdSourceError(error: unknown): error is CrowdSourceError {
  return error instanceof CrowdSourceError;
}

export function isCrowdSourceApiError(error: unknown): error is CrowdSourceApiError {
  return error instanceof CrowdSourceApiError;
}
