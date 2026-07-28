/**
 * Error classification for the Reviewer API.
 *
 * The reviewer surface is being built while its backend is: `packages/backend`
 * currently mounts health routes and nothing else. A missing route answers 404,
 * which is indistinguishable from "that case is gone" unless the app says which
 * it means. Rather than show a generic failure — or, worse, fall back to
 * plausible-looking sample data — every call names the endpoint it needs, and a
 * 404 on an unbuilt route surfaces as {@link ReviewerApiUnavailableError} so the
 * screen can state exactly what it is waiting for.
 *
 * When the endpoint ships, the same call succeeds and the notice disappears.
 * Nothing else has to change.
 */

/** An error carrying an HTTP status, as thrown by the SDK's HttpService. */
interface HttpErrorLike {
  status?: unknown;
  message?: unknown;
}

/** Reads the HTTP status off an unknown thrown value, when it has one. */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const status = (error as HttpErrorLike).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Thrown when the endpoint a screen depends on is not deployed yet.
 *
 * Carries the method and path so the UI can name them instead of guessing. This
 * is not a user-facing string: screens render it through i18n.
 */
export class ReviewerApiUnavailableError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(`Reviewer API endpoint is not available: ${endpoint}`);
    this.name = 'ReviewerApiUnavailableError';
    this.endpoint = endpoint;
  }
}

/** True when the request could not reach the API at all (offline, DNS, CORS). */
export class ReviewerApiUnreachableError extends Error {
  constructor(endpoint: string, cause: unknown) {
    super(`Reviewer API could not be reached: ${endpoint}`, { cause });
    this.name = 'ReviewerApiUnreachableError';
  }
}

/**
 * Thrown when the caller is not entitled to the assignment they asked for.
 *
 * Distinct from a plain 403 so the case viewer can say "this assignment is no
 * longer yours" — which is the expected outcome of an expiry or a replacement
 * draw, not a bug.
 */
export class AssignmentNotHeldError extends Error {
  constructor() {
    super('This assignment is no longer held by the signed-in reviewer');
    this.name = 'AssignmentNotHeldError';
  }
}

/**
 * Thrown when a payload does not match the contract this app was built against.
 *
 * The message names the offending FIELD PATH and never its value: a malformed
 * assignment is still case material, and case material must not reach logs.
 */
export class MalformedPayloadError extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`Field "${path}" is missing or not ${expected}`);
    this.name = 'MalformedPayloadError';
    this.path = path;
  }
}

export function isReviewerApiUnavailable(error: unknown): error is ReviewerApiUnavailableError {
  return error instanceof ReviewerApiUnavailableError;
}

export function isReviewerApiUnreachable(error: unknown): error is ReviewerApiUnreachableError {
  return error instanceof ReviewerApiUnreachableError;
}

export function isAssignmentNotHeld(error: unknown): error is AssignmentNotHeldError {
  return error instanceof AssignmentNotHeldError;
}
