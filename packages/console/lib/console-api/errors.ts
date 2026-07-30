/**
 * Error classification for the Console API.
 *
 * ## Why classification happens here and not from the response body
 *
 * The API answers `{ error: { code, message, details? } }` with the codes §10.5
 * assigns a meaning to. The shared SDK's `HttpService` does not surface that
 * object: it reads `errorData.message` and then `errorData.error` for a message
 * string, and since ours is an OBJECT the resulting `Error.message` is
 * `"[object Object]"`. What it does attach reliably is `status`.
 *
 * So every decision below is made on the HTTP STATUS, and no screen renders an
 * API error's `message` — a `[object Object]` under a table is worse than no
 * detail at all. The status is enough because the console only ever needs to
 * distinguish these cases, and each maps to exactly one status.
 *
 * ## Why a 404 needs the caller to say what it means
 *
 * The console is being built against a backend that is not deployed yet, and an
 * unmounted route answers 404 — indistinguishable from "no such application"
 * unless the call site says which it expects. Each request therefore declares
 * how to read a 404:
 *
 * - `unavailable`: a route that always answers once mounted (the session, the
 *   organization list). A 404 there can only mean the module is not deployed, and
 *   the screen says which endpoint it is waiting for.
 * - `missing`: a route scoped to one application, organization, case or
 *   delivery. A 404 there is the server's deliberate refusal to distinguish "not
 *   yours" from "not there", and the console must not invent a distinction the
 *   API took care to withhold.
 *
 * The boot query is `unavailable`-typed, so an undeployed backend shows the
 * "not running yet" notice before any application-scoped screen can be reached.
 */

/** An error carrying an HTTP status, as thrown by the SDK's HttpService. */
interface HttpErrorLike {
  status?: unknown;
}

/** Reads the HTTP status off an unknown thrown value, when it has one. */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const status = (error as HttpErrorLike).status;
  return typeof status === 'number' ? status : undefined;
}

/** Thrown when the endpoint a screen depends on is not deployed yet. */
export class ConsoleApiUnavailableError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(`Console API endpoint is not available: ${endpoint}`);
    this.name = 'ConsoleApiUnavailableError';
    this.endpoint = endpoint;
  }
}

/** Thrown when the request never reached the API at all (offline, DNS, CORS). */
export class ConsoleApiUnreachableError extends Error {
  constructor(endpoint: string, cause: unknown) {
    super(`Console API could not be reached: ${endpoint}`, { cause });
    this.name = 'ConsoleApiUnreachableError';
  }
}

/**
 * Thrown on a 404 from a resource-scoped route.
 *
 * The message is deliberately the ambiguous one. The server refuses to tell a
 * caller whether an application exists but belongs to somebody else, because
 * that answer is a tenant-enumeration oracle; a console that guessed on the
 * caller's behalf would hand it back.
 */
export class ConsoleResourceMissingError extends Error {
  constructor() {
    super('No such resource, or it does not belong to this account');
    this.name = 'ConsoleResourceMissingError';
  }
}

/**
 * Thrown on a 403.
 *
 * Two situations, one status: an organization seat too small for the write, or an
 * absent Trust & Safety role. `surface` says which of the two a screen is looking
 * at so the copy can be specific, because "you cannot do that" without saying
 * why is the message that generates a support ticket.
 */
export class ConsoleForbiddenError extends Error {
  readonly surface: 'tenant' | 'trust-safety';

  constructor(surface: 'tenant' | 'trust-safety') {
    super(`This session is not authorized for this ${surface} operation`);
    this.name = 'ConsoleForbiddenError';
    this.surface = surface;
  }
}

/**
 * Thrown on a 409.
 *
 * A conflict is always a STATE, never a fault: the slug is taken, the member is
 * the last owner, the delivery is not dead-lettered. `operation` names which one
 * so the screen can say the specific thing instead of "conflict".
 */
export class ConsoleConflictError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`The requested change conflicts with the current state: ${operation}`);
    this.name = 'ConsoleConflictError';
    this.operation = operation;
  }
}

/**
 * Thrown on a 400.
 *
 * Every 400 the console can provoke is a value it sent: an unknown status
 * filter, a cursor the endpoint did not issue, a window outside 1..90. That makes
 * it a bug in this app rather than a message for the operator, so the screen says
 * the request was rejected and names the endpoint, and the value stays out of it.
 */
export class ConsoleRequestRejectedError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(`The API rejected this request as invalid: ${endpoint}`);
    this.name = 'ConsoleRequestRejectedError';
    this.endpoint = endpoint;
  }
}

/** Thrown on a 503 — a dependency the endpoint needs is not configured. */
export class ConsoleServiceUnavailableError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(`The API cannot serve this endpoint right now: ${endpoint}`);
    this.name = 'ConsoleServiceUnavailableError';
    this.endpoint = endpoint;
  }
}

/** Thrown on a 429 — the caller is being rate limited. */
export class ConsoleRateLimitedError extends Error {
  constructor() {
    super('Too many requests');
    this.name = 'ConsoleRateLimitedError';
  }
}

/**
 * Thrown when a payload does not match the contract this app was built against.
 *
 * The message names the offending FIELD PATH and never its value. A malformed
 * case payload is still tenant data, and the paths are what a developer needs
 * anyway.
 */
export class MalformedPayloadError extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`Field "${path}" is missing or not ${expected}`);
    this.name = 'MalformedPayloadError';
    this.path = path;
  }
}

export function isConsoleApiUnavailable(error: unknown): error is ConsoleApiUnavailableError {
  return error instanceof ConsoleApiUnavailableError;
}

export function isConsoleApiUnreachable(error: unknown): error is ConsoleApiUnreachableError {
  return error instanceof ConsoleApiUnreachableError;
}

export function isConsoleResourceMissing(error: unknown): error is ConsoleResourceMissingError {
  return error instanceof ConsoleResourceMissingError;
}

export function isConsoleForbidden(error: unknown): error is ConsoleForbiddenError {
  return error instanceof ConsoleForbiddenError;
}

export function isConsoleConflict(error: unknown): error is ConsoleConflictError {
  return error instanceof ConsoleConflictError;
}

/**
 * Whether an error is an ANSWER rather than a transient failure.
 *
 * Retrying any of these wastes the operator's time and the server's budget: an
 * unmounted route stays unmounted, a 403 stays a 403, and a 409 is the current
 * state of the world.
 */
export function isSettledAnswer(error: unknown): boolean {
  return (
    error instanceof ConsoleApiUnavailableError ||
    error instanceof ConsoleResourceMissingError ||
    error instanceof ConsoleForbiddenError ||
    error instanceof ConsoleConflictError ||
    error instanceof ConsoleRequestRejectedError ||
    error instanceof MalformedPayloadError
  );
}
