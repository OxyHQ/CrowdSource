import type { WebhookDeadLetterReason } from '../../db/postgres/schema/webhooks';
import type { WebhookFailureKind } from './webhook.collections';

/**
 * The retry ladder and the failure classification of §10.9.
 *
 * §10.9 names the schedule outright: initial attempt, 30 seconds, 2 minutes,
 * 15 minutes, 60 minutes, 6 hours, 24 hours, then `dead_letter` with a tenant
 * alert and manual replay. It is stated as an exact sequence, so it is written
 * here as one — no jitter, no formula. A caller can read the array and know what
 * a receiver will see, and a test can assert every rung.
 *
 * The absence of jitter is a real choice. It matters when a fleet of deliveries
 * fails at the same instant — a receiver that went down takes every pending
 * delivery to its endpoint into lockstep, and they all come back together. What
 * bounds that here is that the ladder is relative to each delivery's OWN first
 * attempt rather than to a wall clock, so deliveries created at different times
 * stay spread out, and the worker's per-pass limit caps how many leave at once.
 * If that ever proves insufficient it is a change to this file with a test,
 * rather than a surprise inside the worker.
 *
 * ## The one place this contradicts the plan
 *
 * §16.5 sets an SLO of "99.9% of events delivered or visible in the DLQ within
 * 24 hours", while the ladder above only reaches its LAST attempt at 24 hours —
 * so a delivery that fails all seven becomes visible as a dead letter at roughly
 * 32.5 hours. The schedule is the more specific statement and the one an
 * integrator can observe, so it wins; the SLO is the number that needs revising.
 */

/** §10.9, in order. The delay BEFORE attempt n+1, after attempt n failed. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  30 * 1_000,
  2 * 60 * 1_000,
  15 * 60 * 1_000,
  60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
];

/** The initial attempt plus one per rung. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

/**
 * How many attempts a classified client error gets.
 *
 * §10.9's exact requirement is that the remaining 4xx "must not be retried
 * indefinitely WITHOUT CLASSIFICATION", which is not the same as never retrying
 * them. A 400, a 401 or a 404 says the request as we send it will not be
 * accepted — a rejected signature, a URL that is not a webhook route — and
 * grinding through 32 hours of that helps nobody. But a receiver can also answer
 * 404 for the five minutes a bad build is live, and giving up on the first one
 * would drop a decision over a deploy. Three attempts spans the first three
 * rungs, so a short outage recovers and a permanent misconfiguration is a dead
 * letter within twenty minutes instead of a day and a half.
 */
export const WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS = 3;

/**
 * A `Retry-After` longer than this is ignored.
 *
 * A receiver asking us to wait a week is either broken or trying to pin a
 * delivery open; the ladder's own last rung is the longest we ever wait.
 */
export const WEBHOOK_MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

/** What an attempt's result means for the delivery. */
export type WebhookOutcomeKind =
  | 'succeeded'
  /** Worth waiting for: 5xx, 408, 429, and anything that never got a response. */
  | 'transient'
  /** A 4xx that will not become a 2xx by waiting. */
  | 'client_error'
  /** 410: the endpoint is gone. Terminal, and the endpoint is disabled. */
  | 'endpoint_gone'
  /** The target resolved somewhere it must never be contacted. Terminal. */
  | 'unsafe_target'
  /** The endpoint was disabled between fan-out and this attempt. Terminal. */
  | 'endpoint_disabled';

export interface WebhookOutcome {
  readonly kind: WebhookOutcomeKind;
  readonly failureKind: WebhookFailureKind | null;
}

/**
 * Classifies an HTTP status (§10.9).
 *
 * 408 and 429 are 4xx by number and transient by meaning — "you were too slow"
 * and "you were too fast" are both answered by trying again — so they take the
 * full ladder rather than the client-error one. A 3xx should not reach here at
 * all, because `safeFetch` follows redirects itself and returns the first
 * non-redirect response; if one does, it means the receiver redirected past the
 * hop limit, and treating that as transient is what lets a misrouted endpoint
 * recover when its operator fixes the chain.
 */
export function classifyResponseStatus(status: number): WebhookOutcome {
  if (status >= 200 && status < 300) {
    return { kind: 'succeeded', failureKind: null };
  }
  if (status === 410) {
    return { kind: 'endpoint_gone', failureKind: 'http_status' };
  }
  if (status === 408 || status === 429 || status >= 500 || status < 400) {
    return { kind: 'transient', failureKind: 'http_status' };
  }
  return { kind: 'client_error', failureKind: 'http_status' };
}

export interface WebhookRetryDecision {
  readonly retry: boolean;
  /** Milliseconds until the next attempt. Zero when there is no next attempt. */
  readonly delayMs: number;
  readonly deadLetterReason: WebhookDeadLetterReason | null;
}

export interface WebhookRetryInput {
  readonly outcome: WebhookOutcome;
  /** Attempts made in the CURRENT cycle, including the one just recorded. */
  readonly cycleAttemptCount: number;
  /** A `Retry-After` the receiver asked for, in milliseconds, if any. */
  readonly retryAfterMs?: number;
}

/**
 * Decides what happens after one failed attempt.
 *
 * The two terminal classifications never retry, however many attempts remain:
 * an endpoint that answered 410 is gone, and a URL that resolved into a private
 * range must not be probed again on a schedule.
 */
export function nextRetry(input: WebhookRetryInput): WebhookRetryDecision {
  const terminal: Partial<Record<WebhookOutcomeKind, WebhookDeadLetterReason>> = {
    endpoint_gone: 'endpoint_gone',
    unsafe_target: 'unsafe_target',
    endpoint_disabled: 'endpoint_disabled',
  };
  const terminalReason = terminal[input.outcome.kind];
  if (terminalReason) {
    return { retry: false, delayMs: 0, deadLetterReason: terminalReason };
  }

  const budget =
    input.outcome.kind === 'client_error'
      ? Math.min(WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS, WEBHOOK_MAX_ATTEMPTS)
      : WEBHOOK_MAX_ATTEMPTS;

  if (input.cycleAttemptCount >= budget) {
    return {
      retry: false,
      delayMs: 0,
      deadLetterReason:
        input.outcome.kind === 'client_error' ? 'client_error' : 'attempts_exhausted',
    };
  }

  /**
   * The rung is indexed by how many attempts have already been made: after the
   * first attempt the wait is 30 seconds, after the second two minutes, and so
   * on. The bound is arithmetic rather than trust — a cycle count past the end
   * of the ladder is already terminal above, so this cannot read past it, and
   * clamping keeps that true if the budget and the ladder ever disagree.
   */
  const rung = Math.min(input.cycleAttemptCount - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1);
  const scheduled = WEBHOOK_RETRY_DELAYS_MS[Math.max(0, rung)];

  /**
   * A `Retry-After` can only ever push the next attempt LATER.
   *
   * Honouring a shorter one would let a receiver under load ask us to come back
   * in a second, which is the opposite of what it needs; honouring a longer one
   * is a receiver telling us how long its outage will last, and ignoring that is
   * how a well-behaved sender becomes a hammer.
   */
  const requested = Math.min(input.retryAfterMs ?? 0, WEBHOOK_MAX_RETRY_AFTER_MS);
  return { retry: true, delayMs: Math.max(scheduled, requested), deadLetterReason: null };
}

/**
 * Reads a `Retry-After` header, in either form the HTTP specification allows.
 *
 * Returns null for anything it cannot read, including a date in the past: a
 * receiver that answered with a stale date is not asking for a delay, and
 * treating a negative interval as zero would silently ignore the ladder.
 */
export function parseRetryAfter(header: string | undefined, now: Date): number | null {
  if (header === undefined) return null;

  const trimmed = header.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;

  const interval = asDate - now.getTime();
  return interval > 0 ? interval : null;
}
