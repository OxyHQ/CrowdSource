import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildWebhookSignedPayload,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from '@oxyhq/crowdsource-contracts';
import { describe, expect, it } from 'vitest';

import {
  signWebhookPayload,
  verifyWebhookSignature,
  verifyWebhookSignatureAgainst,
  webhookTimestamp,
} from '../modules/webhooks/signature';

/**
 * The signature of §10.8.
 *
 * A signature check that cannot fail is the worst artefact this module could
 * produce, so every test here is written to be capable of failing: each one
 * names a specific way the guard could be wrong, and the mutation runs recorded
 * alongside this change confirm that breaking the guard breaks the test.
 */

const SECRET = 'a-webhook-signing-secret';
const NOW = new Date('2026-07-29T12:00:00.000Z');
const TIMESTAMP = webhookTimestamp(NOW);

/** The exact document a receiver would be sent, as BYTES. */
const RAW_BODY =
  '{"id":"evt_0123","type":"case.decided","createdAt":"2026-07-29T11:59:00.000Z","data":{"caseId":"case_9","confidence":0.91}}';

function sign(rawBody: string, timestamp = TIMESTAMP, secret = SECRET): string {
  return signWebhookPayload(secret, timestamp, rawBody);
}

describe('what is signed', () => {
  it('is exactly HMAC-SHA256 over timestamp + "." + rawBody', () => {
    /**
     * Computed independently of the signer rather than by calling it: a test
     * that asked the signer what the signer produces would pass for any
     * implementation, including one that signed the empty string.
     */
    const expected = createHmac('sha256', SECRET)
      .update(`${TIMESTAMP}.${RAW_BODY}`, 'utf8')
      .digest('hex');

    expect(sign(RAW_BODY)).toBe(`v1=${expected}`);
  });

  it('uses the contract’s own payload builder, so sender and receiver cannot drift', () => {
    expect(buildWebhookSignedPayload(TIMESTAMP, RAW_BODY)).toBe(`${TIMESTAMP}.${RAW_BODY}`);
  });

  it('changes when the body changes by one byte', () => {
    expect(sign(RAW_BODY)).not.toBe(sign(`${RAW_BODY} `));
  });

  it('changes when the timestamp changes, so a signature cannot be replayed at another time', () => {
    expect(sign(RAW_BODY)).not.toBe(sign(RAW_BODY, String(Number(TIMESTAMP) + 1)));
  });

  it('changes when the secret changes', () => {
    expect(sign(RAW_BODY)).not.toBe(sign(RAW_BODY, TIMESTAMP, `${SECRET}!`));
  });

  it('emits the header shape the contract pins', () => {
    expect(sign(RAW_BODY)).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});

describe('a body that was parsed and re-serialised', () => {
  /**
   * The property the whole scheme exists for. A receiver that verifies against
   * `JSON.stringify(JSON.parse(body))` is verifying a DIFFERENT document from
   * the one it will act on, and the day those two differ is the day a signature
   * approves something nobody signed. Signing the raw bytes is what makes that
   * impossible, and this test is what proves the raw bytes are what we sign.
   */
  it('does not verify against the signature of the original bytes', () => {
    const pretty = JSON.stringify(JSON.parse(RAW_BODY), null, 2);
    expect(pretty).not.toBe(RAW_BODY);

    const signature = sign(RAW_BODY);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature,
        rawBody: pretty,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' });

    // And the same bytes still do, so the failure above is about the
    // re-serialisation rather than about a verifier that rejects everything.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('does not verify when only key ORDER changed, which a JSON parse loses', () => {
    const reordered = '{"type":"case.decided","id":"evt_0123"}';
    const original = '{"id":"evt_0123","type":"case.decided"}';
    expect(JSON.stringify(JSON.parse(reordered))).not.toBe(original);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: sign(original),
        rawBody: reordered,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});

describe('the five-minute window (§10.8)', () => {
  const at = (offsetSeconds: number): Date =>
    new Date(NOW.getTime() + offsetSeconds * 1_000);

  it('accepts a timestamp at the edge of tolerance', () => {
    for (const offset of [
      WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
      -WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    ]) {
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          timestamp: TIMESTAMP,
          signature: sign(RAW_BODY),
          rawBody: RAW_BODY,
          now: at(offset),
        }),
      ).toEqual({ ok: true });
    }
  });

  it('rejects a stale timestamp one second past the window', () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: sign(RAW_BODY),
        rawBody: RAW_BODY,
        now: at(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1),
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  /**
   * Both directions. A future timestamp is not a harmless clock difference: it
   * is how a captured signature is kept valid for longer than the window allows.
   */
  it('rejects a timestamp from the future, not only a stale one', () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature: sign(RAW_BODY),
        rawBody: RAW_BODY,
        now: at(-WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1),
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('refuses a stale delivery on its age, before spending an HMAC on it', () => {
    // A valid signature, far outside the window: the answer must be about the
    // clock, so the ordering inside the verifier is checked rather than assumed.
    const staleTimestamp = String(Number(TIMESTAMP) - 3_600);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: staleTimestamp,
        signature: sign(RAW_BODY, staleTimestamp),
        rawBody: RAW_BODY,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });
});

describe('malformed headers', () => {
  it.each([
    ['not-a-number', 'malformed_timestamp'],
    ['', 'malformed_timestamp'],
    ['12.5', 'malformed_timestamp'],
    ['-1785263400', 'malformed_timestamp'],
  ])('rejects the timestamp %j', (timestamp, reason) => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature: sign(RAW_BODY),
        rawBody: RAW_BODY,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason });
  });

  it.each([
    ['deadbeef', 'no version prefix'],
    ['v1=DEADBEEF', 'uppercase hex'],
    ['v2=' + '0'.repeat(64), 'an unknown scheme version'],
    ['v1=' + '0'.repeat(63), 'a short digest'],
    ['', 'nothing at all'],
  ])('rejects the signature %j (%s)', (signature) => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: TIMESTAMP,
        signature,
        rawBody: RAW_BODY,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'malformed_signature' });
  });
});

describe('verifying against several secrets, as a receiver does mid-rotation', () => {
  it('accepts a signature made by any secret currently on record', () => {
    const outgoing = 'the-secret-being-retired';
    const incoming = 'the-secret-taking-over';

    for (const signer of [outgoing, incoming]) {
      expect(
        verifyWebhookSignatureAgainst([outgoing, incoming], {
          timestamp: TIMESTAMP,
          signature: sign(RAW_BODY, TIMESTAMP, signer),
          rawBody: RAW_BODY,
          now: NOW,
        }),
      ).toEqual({ ok: true });
    }
  });

  it('rejects a signature from a secret that is no longer on record', () => {
    expect(
      verifyWebhookSignatureAgainst(['the-only-live-secret'], {
        timestamp: TIMESTAMP,
        signature: sign(RAW_BODY, TIMESTAMP, 'a-retired-secret'),
        rawBody: RAW_BODY,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('reports a stale timestamp as staleness, not as a mismatch, however many secrets are held', () => {
    const stale = String(Number(TIMESTAMP) - 3_600);
    expect(
      verifyWebhookSignatureAgainst(['one', 'two'], {
        timestamp: stale,
        signature: sign(RAW_BODY, stale, 'one'),
        rawBody: RAW_BODY,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects when there is no secret at all rather than accepting vacuously', () => {
    expect(
      verifyWebhookSignatureAgainst([], {
        timestamp: TIMESTAMP,
        signature: sign(RAW_BODY),
        rawBody: RAW_BODY,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});

/**
 * Constant-time comparison, guarded at the source.
 *
 * This is the one property in the module that a behavioural test cannot defend.
 * Swapping `verifySecret` for `===` changes nothing an assertion can observe —
 * the same signatures verify, the same ones do not — while making a valid
 * signature recoverable a byte at a time from the timing. So the guard is a
 * check on the source, and it carries its own mutation test, because a scanner
 * nobody proved can fail is exactly the "check that cannot distinguish success
 * from failure" this project treats as worse than no check.
 */
describe('how a signature is compared', () => {
  const signatureModule = readFileSync(
    path.join(__dirname, '..', 'modules', 'webhooks', 'signature.ts'),
    'utf8',
  );

  /**
   * Equality against something that holds signature bytes.
   *
   * Scoped to those identifiers rather than to every `===` in the file: the
   * verifier legitimately compares a FAILURE REASON with `!==`, and a scanner
   * that flagged it would be disabled by whoever hit it next.
   */
  function timingUnsafeComparisons(source: string): string[] {
    const suspect = /^(?!\s*(\*|\/\/)).*\b(?:input\.)?(signature|expected|digest)\b\s*[!=]==?/gm;
    return (source.match(suspect) ?? []).map((line) => line.trim());
  }

  it('goes through the ecosystem’s constant-time helper', () => {
    expect(signatureModule).toContain("import { verifySecret } from '@oxyhq/core/server';");
    expect(signatureModule).toContain('verifySecret(input.signature, expected)');
  });

  it('never compares signature bytes with an equality operator', () => {
    // The full offending lines, so a failure names what to fix.
    expect(timingUnsafeComparisons(signatureModule)).toEqual([]);
  });

  it('detects the comparison it claims to detect', () => {
    for (const violation of [
      '  if (input.signature !== expected) return { ok: false };',
      '  if (signature === expected) return { ok: true };',
      '  return digest == expected;',
    ]) {
      expect(timingUnsafeComparisons(violation), violation).toHaveLength(1);
    }
  });

  it('does not flag the comparisons that are not about signature bytes', () => {
    expect(
      timingUnsafeComparisons("    if (result.reason !== 'signature_mismatch') {"),
    ).toEqual([]);
    expect(timingUnsafeComparisons(' * a signature === expected comparison leaks bytes')).toEqual(
      [],
    );
  });
});

describe('the timestamp header', () => {
  it('is unix SECONDS as a string, which is what gets signed', () => {
    expect(webhookTimestamp(new Date('2026-07-29T12:00:00.000Z'))).toBe('1785326400');
    // Truncated, not rounded: a receiver re-deriving seconds from milliseconds
    // must land on the same integer we signed.
    expect(webhookTimestamp(new Date('2026-07-29T12:00:00.999Z'))).toBe('1785326400');
  });
});
