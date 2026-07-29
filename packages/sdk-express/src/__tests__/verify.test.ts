/**
 * The signature verifier, attacked directly.
 *
 * This file has two halves and the second is the one that matters.
 *
 * The first half asserts what the verifier does: it accepts a real delivery,
 * accepts one signed with the previous secret during rotation, and refuses a
 * stale timestamp, a future timestamp, a wrong secret, a tampered body, a body
 * that was parsed and re-serialised, and a signature that shares a prefix with
 * the right one.
 *
 * The second half asks whether those assertions can tell the difference. A
 * signature check that cannot fail is the worst thing this package could ship,
 * and a test suite that only ever sends VALID deliveries would pass against a
 * verifier that returns `true` unconditionally. So each plausible wrong
 * implementation below is run against the same corpus, and the suite fails
 * unless every one of them is CAUGHT — with the offending case named, so a
 * mutant that survives says which property stopped being tested rather than
 * just "something is wrong".
 *
 * One property is deliberately NOT claimed here: constant-time comparison. A
 * corpus cannot observe timing, and a test that pretended to would be exactly
 * the kind of check that cannot distinguish success from failure. It is
 * enforced by `timingSafeEqual` in `verify.ts` and by review.
 */

import { createHmac } from 'node:crypto';

import {
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  buildWebhookSignedPayload,
} from '@oxyhq/crowdsource-contracts';
import { describe, expect, it } from 'vitest';

import {
  signedPayloadBytes,
  verifyWebhookDelivery,
  type WebhookVerificationInput,
} from '../verify';

const ACTIVE_SECRET = 'active-secret-value';
const PREVIOUS_SECRET = 'previous-secret-value';
const NOW_MS = 1_785_263_400_000;
const NOW_SECONDS = NOW_MS / 1_000;

function sign(secret: string, timestamp: string, rawBody: Buffer): string {
  return `${WEBHOOK_SIGNATURE_VERSION}=${createHmac('sha256', secret)
    .update(signedPayloadBytes(timestamp, rawBody))
    .digest('hex')}`;
}

function delivery(overrides: Partial<WebhookVerificationInput> = {}): WebhookVerificationInput {
  const rawBody = overrides.rawBody ?? Buffer.from('{"id":"evt_1","type":"case.decided"}', 'utf8');
  const timestampHeader = overrides.timestampHeader ?? String(NOW_SECONDS);

  return {
    eventIdHeader: 'evt_1',
    timestampHeader,
    signatureHeader: sign(ACTIVE_SECRET, timestampHeader, rawBody),
    rawBody,
    secrets: [ACTIVE_SECRET],
    nowMs: NOW_MS,
    ...overrides,
  };
}

/** A signature sharing its first eight hex characters with the valid one. */
function prefixCollidingSignature(valid: string): string {
  const hex = valid.slice(`${WEBHOOK_SIGNATURE_VERSION}=`.length);
  const tail = hex.slice(8).replace(/./g, (character) => (character === '0' ? '1' : '0'));
  return `${WEBHOOK_SIGNATURE_VERSION}=${hex.slice(0, 8)}${tail}`;
}

interface Case {
  readonly name: string;
  readonly accepted: boolean;
  readonly input: WebhookVerificationInput;
}

const REORDERED_BODY = Buffer.from('{"b":2,"a":1}', 'utf8');
const ORIGINAL_BODY = Buffer.from('{"a":1,"b":2}', 'utf8');
const VALID_TIMESTAMP = String(NOW_SECONDS);

/**
 * The corpus. Every case is a delivery a real receiver can be handed, and the
 * `accepted` flag is what §10.8 says must happen to it.
 */
const CORPUS: readonly Case[] = [
  { name: 'a valid delivery', accepted: true, input: delivery() },
  {
    name: 'a delivery signed with the previous secret during rotation',
    accepted: true,
    input: {
      ...delivery(),
      signatureHeader: sign(PREVIOUS_SECRET, VALID_TIMESTAMP, ORIGINAL_BODY),
      rawBody: ORIGINAL_BODY,
      secrets: [ACTIVE_SECRET, PREVIOUS_SECRET],
    },
  },
  {
    name: 'a delivery at exactly the edge of the tolerance window',
    accepted: true,
    input: delivery({
      timestampHeader: String(NOW_SECONDS - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS),
    }),
  },
  {
    /**
     * A VALID delivery whose bytes are not what `JSON.stringify(JSON.parse(…))`
     * would produce. This is the case that catches a receiver verifying over a
     * re-serialised body: its symptom in production is not a forged event
     * getting through, it is every real delivery being refused the moment the
     * sender's formatting differs from the receiver's serialiser.
     */
    name: 'a valid delivery whose body is pretty-printed',
    accepted: true,
    input: delivery({
      rawBody: Buffer.from('{\n  "id": "evt_1",\n  "type": "case.decided"\n}', 'utf8'),
    }),
  },
  {
    name: 'a delivery signed with a secret the receiver does not hold',
    accepted: false,
    input: {
      ...delivery(),
      signatureHeader: sign('some-other-secret', VALID_TIMESTAMP, ORIGINAL_BODY),
      rawBody: ORIGINAL_BODY,
    },
  },
  {
    name: 'a replayed delivery from six minutes ago',
    accepted: false,
    input: delivery({ timestampHeader: String(NOW_SECONDS - 360) }),
  },
  {
    name: 'a delivery timestamped six minutes in the future',
    accepted: false,
    input: delivery({ timestampHeader: String(NOW_SECONDS + 360) }),
  },
  {
    name: 'a body altered after it was signed',
    accepted: false,
    input: {
      ...delivery({ rawBody: ORIGINAL_BODY }),
      rawBody: Buffer.from('{"a":1,"b":3}', 'utf8'),
    },
  },
  {
    /**
     * The failure this package exists to prevent: a receiver that parsed the
     * body and re-serialised it verifies over BYTES CROWDSOURCE NEVER SENT.
     * Semantically identical, textually different, and the signature must not
     * cover it.
     */
    name: 'a body that was parsed and re-serialised with a different key order',
    accepted: false,
    input: {
      ...delivery(),
      signatureHeader: sign(ACTIVE_SECRET, VALID_TIMESTAMP, ORIGINAL_BODY),
      rawBody: REORDERED_BODY,
    },
  },
  {
    name: 'a signature sharing its first eight characters with the valid one',
    accepted: false,
    input: {
      ...delivery(),
      signatureHeader: prefixCollidingSignature(sign(ACTIVE_SECRET, VALID_TIMESTAMP, ORIGINAL_BODY)),
      rawBody: ORIGINAL_BODY,
    },
  },
  {
    name: 'a delivery with no signature header',
    accepted: false,
    input: { ...delivery(), signatureHeader: undefined },
  },
  {
    name: 'a delivery with no timestamp header',
    accepted: false,
    input: { ...delivery(), timestampHeader: undefined },
  },
  {
    name: 'a delivery with no event id header',
    accepted: false,
    input: { ...delivery(), eventIdHeader: undefined },
  },
  {
    name: 'a delivery whose timestamp is not unix seconds',
    accepted: false,
    input: delivery({ timestampHeader: '2026-07-29T00:00:00Z' }),
  },
  {
    name: 'a delivery whose signature is not v1=<64 hex>',
    accepted: false,
    input: { ...delivery(), signatureHeader: 'v1=not-a-digest' },
  },
  {
    name: 'a valid delivery to a receiver with no secret configured',
    accepted: false,
    input: { ...delivery(), secrets: [] },
  },
];

describe('verifyWebhookDelivery', () => {
  it.each(CORPUS)('$name', ({ accepted, input }) => {
    expect(verifyWebhookDelivery(input).ok).toBe(accepted);
  });

  it('names which secret matched, so a rotation can be watched retire', () => {
    const rawBody = ORIGINAL_BODY;
    const previous = verifyWebhookDelivery({
      ...delivery({ rawBody }),
      signatureHeader: sign(PREVIOUS_SECRET, VALID_TIMESTAMP, rawBody),
      secrets: [ACTIVE_SECRET, PREVIOUS_SECRET],
    });

    expect(previous).toEqual({ ok: true, eventId: 'evt_1', secretIndex: 1 });
  });

  it('reports why it refused, without echoing anything from the delivery', () => {
    const refused = verifyWebhookDelivery(delivery({ timestampHeader: String(NOW_SECONDS - 360) }));

    expect(refused).toEqual({ ok: false, rejection: 'timestamp_out_of_window' });
  });

  it('signs the same bytes §10.8 defines, without a lossy utf-8 round trip', () => {
    const rawBody = Buffer.from('{"text":"niño — emoji 🚀"}', 'utf8');

    expect(signedPayloadBytes(VALID_TIMESTAMP, rawBody).toString('utf8')).toBe(
      buildWebhookSignedPayload(VALID_TIMESTAMP, rawBody.toString('utf8')),
    );
  });
});

/**
 * Deliberately broken verifiers. Each one is a mistake somebody has actually
 * shipped in a webhook receiver.
 */
type Verifier = (input: WebhookVerificationInput) => boolean;

interface Mutant {
  readonly name: string;
  readonly verify: Verifier;
}

const wellFormedSignature = (input: WebhookVerificationInput): boolean =>
  /^v1=[0-9a-f]{64}$/.test(input.signatureHeader ?? '');

const MUTANTS: readonly Mutant[] = [
  {
    name: 'accepts every delivery',
    verify: () => true,
  },
  {
    name: 'refuses every delivery',
    verify: () => false,
  },
  {
    name: 'checks the signature but never the timestamp window',
    verify: (input) =>
      verifyWebhookDelivery({ ...input, nowMs: Number(input.timestampHeader) * 1_000 }).ok,
  },
  {
    name: 'only rejects timestamps in the past, never in the future',
    verify: (input) => {
      const skew = Number(input.timestampHeader) - input.nowMs / 1_000;
      if (skew > 0) {
        return verifyWebhookDelivery({ ...input, nowMs: Number(input.timestampHeader) * 1_000 }).ok;
      }
      return verifyWebhookDelivery(input).ok;
    },
  },
  {
    name: 'verifies over the parsed body re-serialised, not the bytes received',
    verify: (input) => {
      let reserialised: Buffer;
      try {
        reserialised = Buffer.from(
          JSON.stringify(JSON.parse(input.rawBody.toString('utf8')) as unknown),
          'utf8',
        );
      } catch {
        reserialised = input.rawBody;
      }
      return verifyWebhookDelivery({ ...input, rawBody: reserialised }).ok;
    },
  },
  {
    name: 'accepts any well-formed signature without checking the secret',
    verify: (input) => wellFormedSignature(input) && (input.eventIdHeader ?? '').length > 0,
  },
  {
    name: 'compares only the first eight characters of the digest',
    verify: (input) => {
      if (!wellFormedSignature(input) || input.timestampHeader === undefined) return false;
      if (!(input.eventIdHeader ?? '').length) return false;
      if (
        Math.abs(input.nowMs / 1_000 - Number(input.timestampHeader)) >
        WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
      ) {
        return false;
      }
      const presented = (input.signatureHeader ?? '').slice('v1='.length, 'v1='.length + 8);
      return input.secrets.some(
        (secret) =>
          createHmac('sha256', secret)
            .update(signedPayloadBytes(input.timestampHeader ?? '', input.rawBody))
            .digest('hex')
            .slice(0, 8) === presented,
      );
    },
  },
  {
    /**
     * Forgetting the `timestamp + "."` prefix — the single most common mistake
     * in a hand-written verifier. It looks correct, it is a real HMAC over the
     * real body, and it removes replay protection from the scheme entirely.
     */
    name: 'omits the timestamp from the signed payload',
    verify: (input) => {
      if (!wellFormedSignature(input) || input.timestampHeader === undefined) return false;
      const presented = (input.signatureHeader ?? '').slice('v1='.length);
      return input.secrets.some(
        (secret) =>
          createHmac('sha256', secret).update(input.rawBody).digest('hex') === presented,
      );
    },
  },
  {
    name: 'treats an unconfigured secret as "nothing to check"',
    verify: (input) => (input.secrets.length === 0 ? true : verifyWebhookDelivery(input).ok),
  },
];

describe('the verification corpus kills every known-bad verifier', () => {
  /**
   * A vacuity floor. Every assertion below is of the form "some case
   * disagrees", which is trivially satisfiable by a corpus that is broken in the
   * right way — one full of rejections would kill "accepts everything" while
   * proving nothing about a real delivery. These three assertions are what stop
   * that.
   */
  it('is neither empty nor one-sided, and the real verifier agrees with all of it', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(14);
    expect(CORPUS.filter((entry) => entry.accepted).length).toBeGreaterThanOrEqual(4);
    expect(CORPUS.filter((entry) => !entry.accepted).length).toBeGreaterThanOrEqual(10);

    const disagreements = CORPUS.filter(
      (entry) => verifyWebhookDelivery(entry.input).ok !== entry.accepted,
    );
    expect(disagreements.map((entry) => entry.name)).toEqual([]);
  });

  it.each(MUTANTS)('catches a verifier that $name', ({ verify }) => {
    const caughtBy = CORPUS.filter((entry) => verify(entry.input) !== entry.accepted).map(
      (entry) => entry.name,
    );

    // Naming the cases makes a surviving mutant say WHICH property stopped being
    // covered, instead of only that one did.
    expect(caughtBy.length, 'no case in the corpus distinguishes this mutant').toBeGreaterThan(0);
  });
});
