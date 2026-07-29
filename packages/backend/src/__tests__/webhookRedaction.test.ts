import { describe, expect, it } from 'vitest';

import {
  redactionRuleNames,
  redactResponseBody,
  WEBHOOK_RESPONSE_PREVIEW_LIMIT,
} from '../modules/webhooks/redaction';

/**
 * Redaction of a receiver's response body (§10.8, §13.4, §16.6).
 *
 * §10.9 requires each attempt to keep a truncated and redacted response body,
 * and this is the only field in the module holding bytes CrowdSource did not
 * compose. The failure mode is invisible — nobody notices an unredacted preview
 * until somebody reads production data — so each rule is exercised individually
 * and the rule list carries a vacuity floor.
 */

describe('the rule set', () => {
  /**
   * The vacuity floor. A rules array that had been emptied would make every
   * assertion below pass by redacting nothing and matching nothing.
   */
  it('has every rule the module claims', () => {
    expect(redactionRuleNames()).toEqual([
      'authorization header value',
      'assignment of a secret-looking key',
      'json web token',
      'webhook signature',
      'email address',
      'high-entropy token',
    ]);
  });
});

describe('each rule fires', () => {
  it.each([
    ['Authorization: Bearer sk_live_9f8a7b6c5d4e3f2a1b', 'sk_live_9f8a7b6c5d4e3f2a1b'],
    ['{"api_key":"abcdef123456"}', 'abcdef123456'],
    [
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'eyJhbGciOiJIUzI1NiJ9',
    ],
    [`signature v1=${'a'.repeat(64)} rejected`, 'a'.repeat(64)],
    ['unknown recipient reporter@example.com', 'reporter@example.com'],
    [`session ${'Z'.repeat(48)} expired`, 'Z'.repeat(48)],
  ])('masks %j', (raw, secret) => {
    const redacted = redactResponseBody(raw);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('[redacted]');
  });
});

describe('what survives', () => {
  it('keeps the short human part an operator actually reads', () => {
    expect(redactResponseBody('{"error":"unknown event type"}')).toBe(
      '{"error":"unknown event type"}',
    );
  });

  it('is empty for an empty body rather than a marker', () => {
    expect(redactResponseBody('')).toBe('');
  });
});

describe('truncation', () => {
  it('keeps at most the limit, and says it truncated', () => {
    const long = 'x'.repeat(WEBHOOK_RESPONSE_PREVIEW_LIMIT * 4);
    const redacted = redactResponseBody(long);

    expect(redacted.endsWith('…')).toBe(true);
    expect(redacted.length).toBeLessThanOrEqual(WEBHOOK_RESPONSE_PREVIEW_LIMIT + 1);
  });

  it('does not mark a body that fitted', () => {
    expect(redactResponseBody('short').endsWith('…')).toBe(false);
  });

  /**
   * A secret beyond the limit is discarded by the truncation itself, so the
   * combination has to be checked rather than each half separately: this is the
   * case where a reader might reasonably worry that truncating first left
   * something behind.
   */
  it('cannot leak a secret that sat past the cut', () => {
    const raw = `${'a'.repeat(WEBHOOK_RESPONSE_PREVIEW_LIMIT)}Bearer sk_live_supersecrettoken`;
    expect(redactResponseBody(raw)).not.toContain('sk_live_supersecrettoken');
  });
});

describe('control characters', () => {
  /**
   * A preview is read back in a terminal. An ANSI escape or a carriage return in
   * an operator-facing field is how a hostile receiver rewrites what the
   * operator believes they are looking at.
   */
  it('strips escapes and newlines so a preview cannot rewrite a console', () => {
    const redacted = redactResponseBody('before\u001b[2K\rAFTER\nnext');
    expect(redacted).not.toContain('\u001b');
    expect(redacted).not.toContain('\r');
    expect(redacted).not.toContain('\n');
    expect(redacted).toContain('before');
    expect(redacted).toContain('AFTER');
  });
});

describe('a receiver that echoes the delivery back', () => {
  /**
   * The realistic shape: a receiver 400s and quotes the request it could not
   * handle, signature header and all. The signature must not survive into
   * storage — it is the one value that would let anyone holding the attempt row
   * replay a delivery to that endpoint.
   */
  it('does not store the signature it was sent', () => {
    const echoed = JSON.stringify({
      error: 'could not parse body',
      headers: {
        'x-crowdsource-signature': `v1=${'b'.repeat(64)}`,
        'x-crowdsource-event-id': 'evt_0123',
      },
    });

    const redacted = redactResponseBody(echoed);
    expect(redacted).not.toContain('b'.repeat(64));
    // The event id is not a secret and is what makes the preview useful.
    expect(redacted).toContain('evt_0123');
  });
});
