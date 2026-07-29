import { describe, expect, it } from 'vitest';

import {
  classifyResponseStatus,
  nextRetry,
  parseRetryAfter,
  WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_RETRY_AFTER_MS,
  WEBHOOK_RETRY_DELAYS_MS,
} from '../modules/webhooks/retrySchedule';

/**
 * The retry ladder and the failure classification of §10.9.
 *
 * §10.9 states the schedule as an exact sequence, so these tests assert the
 * exact sequence. A test that only checked "the delay grows" would pass for a
 * ladder that reached a week, and the whole point of writing the plan's numbers
 * down is that an integrator can predict what their endpoint will see.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('the schedule §10.9 names', () => {
  it('is initial attempt, 30s, 2m, 15m, 60m, 6h, 24h', () => {
    expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([
      30 * SECOND,
      2 * MINUTE,
      15 * MINUTE,
      60 * MINUTE,
      6 * HOUR,
      24 * HOUR,
    ]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(7);
  });

  it('walks a failing delivery down every rung, in order', () => {
    const walked: number[] = [];

    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      const decision = nextRetry({
        outcome: { kind: 'transient', failureKind: 'http_status' },
        cycleAttemptCount: attempt,
      });

      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(decision.retry, `attempt ${attempt} must still retry`).toBe(true);
        walked.push(decision.delayMs);
      } else {
        /**
         * The seventh attempt is the last. §10.9: "after → status =
         * dead_letter, alert the tenant, manual replay available".
         */
        expect(decision).toEqual({
          retry: false,
          delayMs: 0,
          deadLetterReason: 'attempts_exhausted',
        });
      }
    }

    expect(walked).toEqual([...WEBHOOK_RETRY_DELAYS_MS]);
  });
});

describe('classifying what a receiver answered', () => {
  it.each([200, 201, 202, 204, 299])('treats %d as success', (status) => {
    expect(classifyResponseStatus(status)).toEqual({ kind: 'succeeded', failureKind: null });
  });

  it.each([500, 502, 503, 504])('retries %d with the full ladder', (status) => {
    expect(classifyResponseStatus(status).kind).toBe('transient');
  });

  /**
   * 4xx by number, transient by meaning. "You were too slow" and "you were too
   * fast" are both answered by trying again, so they must not fall into the
   * short client-error ladder.
   */
  it.each([408, 429])('treats %d as transient despite being a 4xx', (status) => {
    expect(classifyResponseStatus(status).kind).toBe('transient');
  });

  it('treats 410 Gone as its own terminal case', () => {
    expect(classifyResponseStatus(410)).toEqual({
      kind: 'endpoint_gone',
      failureKind: 'http_status',
    });
  });

  it.each([400, 401, 403, 404, 409, 413, 415, 422])(
    'classifies %d as a client error rather than retrying it indefinitely',
    (status) => {
      expect(classifyResponseStatus(status).kind).toBe('client_error');
    },
  );

  it('treats an unexpected 3xx as transient, since safeFetch already followed redirects', () => {
    expect(classifyResponseStatus(302).kind).toBe('transient');
  });
});

describe('a classified client error', () => {
  /**
   * §10.9 forbids retrying the remaining 4xx "indefinitely, without
   * classification" — which is not the same as never. A receiver can answer 404
   * for the five minutes a bad build is live, and giving up on the first one
   * would drop a decision over a deploy.
   */
  it('gets a short ladder and then dead-letters with its own reason', () => {
    for (let attempt = 1; attempt < WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS; attempt += 1) {
      expect(
        nextRetry({
          outcome: { kind: 'client_error', failureKind: 'http_status' },
          cycleAttemptCount: attempt,
        }).retry,
      ).toBe(true);
    }

    expect(
      nextRetry({
        outcome: { kind: 'client_error', failureKind: 'http_status' },
        cycleAttemptCount: WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS,
      }),
    ).toEqual({ retry: false, delayMs: 0, deadLetterReason: 'client_error' });
  });

  it('stops well before the transient ladder would', () => {
    expect(WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS).toBeLessThan(WEBHOOK_MAX_ATTEMPTS);
    // Twenty minutes rather than a day and a half.
    const spent = WEBHOOK_RETRY_DELAYS_MS.slice(0, WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS - 1).reduce(
      (total, delay) => total + delay,
      0,
    );
    expect(spent).toBeLessThan(HOUR);
  });
});

describe('the terminal classifications', () => {
  it.each([
    ['endpoint_gone', 'endpoint_gone'],
    ['unsafe_target', 'unsafe_target'],
    ['endpoint_disabled', 'endpoint_disabled'],
  ] as const)('never retries %s, even on the first attempt', (kind, reason) => {
    expect(
      nextRetry({ outcome: { kind, failureKind: null }, cycleAttemptCount: 1 }),
    ).toEqual({ retry: false, delayMs: 0, deadLetterReason: reason });
  });
});

describe('Retry-After', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');

  it('reads the delta-seconds form', () => {
    expect(parseRetryAfter('120', now)).toBe(2 * MINUTE);
  });

  it('reads the HTTP-date form', () => {
    expect(parseRetryAfter('Wed, 29 Jul 2026 12:05:00 GMT', now)).toBe(5 * MINUTE);
  });

  it.each([
    ['', 'an empty header'],
    ['soon', 'a word'],
    ['Wed, 29 Jul 2026 11:55:00 GMT', 'a date already past'],
  ])('ignores %j (%s)', (header) => {
    expect(parseRetryAfter(header, now)).toBeNull();
  });

  it('is absent when the header is', () => {
    expect(parseRetryAfter(undefined, now)).toBeNull();
  });

  /**
   * A receiver may only push the next attempt LATER. Honouring a shorter one
   * would let a receiver under load ask us to come back in a second, which is
   * the opposite of what it needs.
   */
  it('never shortens the ladder', () => {
    const decision = nextRetry({
      outcome: { kind: 'transient', failureKind: 'http_status' },
      cycleAttemptCount: 1,
      retryAfterMs: SECOND,
    });
    expect(decision.delayMs).toBe(WEBHOOK_RETRY_DELAYS_MS[0]);
  });

  it('lengthens it when the receiver asks for longer', () => {
    const decision = nextRetry({
      outcome: { kind: 'transient', failureKind: 'http_status' },
      cycleAttemptCount: 1,
      retryAfterMs: 10 * MINUTE,
    });
    expect(decision.delayMs).toBe(10 * MINUTE);
  });

  it('caps an absurd request at the ladder’s own longest wait', () => {
    const decision = nextRetry({
      outcome: { kind: 'transient', failureKind: 'http_status' },
      cycleAttemptCount: 1,
      retryAfterMs: 30 * 24 * HOUR,
    });
    expect(decision.delayMs).toBe(WEBHOOK_MAX_RETRY_AFTER_MS);
  });
});
