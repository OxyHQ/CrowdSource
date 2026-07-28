/**
 * The error convention of §10.5, expressed once.
 *
 * Every failure an application-API caller can observe is one of these codes.
 * They are part of the public contract: an integrator branches on `409` to stop
 * retrying a payload conflict and on `503` to keep retrying from its own outbox,
 * so a handler that answers the wrong one turns a recoverable delivery into lost
 * moderation work.
 *
 * Anything thrown that is NOT an `ApiError` is a defect, not a contract case,
 * and is answered `500` without leaking its message.
 */

/** The status codes §10.5 assigns a meaning to. */
export const API_ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unprocessable_envelope: 422,
  rate_limited: 429,
  /**
   * Not in §10.5, deliberately. Every code above is a case an integrator is
   * expected to handle; this one is a defect on our side, and it is listed only
   * so the fallback answer has a name instead of an ad-hoc literal.
   */
  internal_error: 500,
  service_unavailable: 503,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

/** Machine-readable context for a failure. Never carries reported content. */
export type ApiErrorDetails = Readonly<Record<string, string | number | boolean>>;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: ApiErrorDetails;

  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.details = details;
  }

  /** The response body for this failure. */
  toResponseBody(): { error: { code: ApiErrorCode; message: string; details?: ApiErrorDetails } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
