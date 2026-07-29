/**
 * Webhook signature verification (§10.8), as a pure function.
 *
 * Kept free of Express, of I/O and of the clock so that the security-critical
 * decision — do these bytes carry a valid, fresh signature from a secret we
 * hold? — can be attacked directly by a test rather than through a request. A
 * signature check that cannot be made to fail is worse than no check at all, so
 * the corpus in `__tests__/verify.test.ts` is mutation-tested: each deliberately
 * weakened verifier must be CAUGHT by at least one case, and a case that no
 * mutant fails is a case that proves nothing.
 *
 * §10.8 in full, and where each line lands:
 *
 *   * `signedPayload = timestamp + "." + rawBody` — `buildWebhookSignedPayload`
 *     in the contracts package, so the signer and the verifier cannot disagree
 *     about what gets signed. This module works on the BYTES of that value (see
 *     `signedPayloadBytes`).
 *   * "reject timestamps more than five minutes away" — `TOLERANCE`, applied in
 *     BOTH directions. A future timestamp is as much a replay signal as an old
 *     one, and only checking the past accepts a signature minted for a clock
 *     nobody controls.
 *   * "compare signatures in constant time" — `timingSafeEqual` over the decoded
 *     digests. Never `===`: it returns on the first differing byte, which is a
 *     forgery oracle with enough attempts.
 *   * "store the processed event id" — `store.ts`, not here. Freshness and
 *     authenticity are decidable from the request; whether it was already
 *     handled is not.
 *   * "allow two secrets during rotation" — `secrets` is a list, every entry is
 *     tried, and the result names WHICH one matched so an operator can see the
 *     old secret going quiet before they retire it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  WebhookSignatureHeaderSchema,
  WebhookTimestampHeaderSchema,
  buildWebhookSignedPayload,
} from '@oxyhq/crowdsource-contracts';

/**
 * Why a delivery was refused. Terse on purpose: it goes back on the wire, into
 * the sender's delivery log, and into `onRejected`.
 *
 * The first eight are what verification itself decides; the last three are the
 * middleware's. They share one vocabulary so the reason a receiver reports and
 * the reason it answers with are always the same string — two lists would drift
 * the first time one of them grew.
 */
export const WEBHOOK_REJECTIONS = [
  'missing_event_id',
  'missing_timestamp',
  'missing_signature',
  'malformed_timestamp',
  'malformed_signature',
  'timestamp_out_of_window',
  'signature_mismatch',
  'no_secret_configured',
  'malformed_event',
  'event_id_mismatch',
  'payload_too_large',
] as const;

export type WebhookRejection = (typeof WEBHOOK_REJECTIONS)[number];

export interface WebhookVerificationInput {
  readonly eventIdHeader: string | undefined;
  readonly timestampHeader: string | undefined;
  readonly signatureHeader: string | undefined;
  /** The bytes as they arrived. Never a re-serialisation of a parsed body. */
  readonly rawBody: Buffer;
  /** Active secret first; the previous one during rotation (§10.8). */
  readonly secrets: readonly string[];
  readonly nowMs: number;
  readonly toleranceSeconds?: number;
}

export type WebhookVerification =
  | {
      readonly ok: true;
      readonly eventId: string;
      /** Which configured secret matched. `0` is the active one. */
      readonly secretIndex: number;
    }
  | { readonly ok: false; readonly rejection: WebhookRejection };

/**
 * The exact bytes signed, without a UTF-8 round trip.
 *
 * §10.8 defines the signed payload as a STRING, and
 * `buildWebhookSignedPayload` is that definition. Decoding the body to a string
 * to rebuild it would map any invalid UTF-8 byte to U+FFFD — which is lossy, so
 * two different bodies could produce the same signed payload. Concatenating the
 * prefix bytes with the body bytes is the same value for every well-formed
 * (UTF-8) JSON body and is not lossy for anything else. `verify.test.ts` asserts
 * the two agree.
 */
export function signedPayloadBytes(timestamp: string, rawBody: Buffer): Buffer {
  // The prefix is taken FROM the contract's own function rather than restated
  // as `${timestamp}.`, so a change to the separator follows automatically
  // instead of leaving two definitions to drift.
  const prefix = buildWebhookSignedPayload(timestamp, '');
  return Buffer.concat([Buffer.from(prefix, 'utf8'), rawBody]);
}

function digestsMatch(expectedHex: string, presentedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const presented = Buffer.from(presentedHex, 'hex');
  // The header schema fixes the length at 64 hex characters, so this is never
  // the branch that rejects a real delivery — it is what stops `timingSafeEqual`
  // from throwing if that ever stops being true.
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

/**
 * Verifies one delivery.
 *
 * Order matters: everything cheap and decidable from the headers is checked
 * BEFORE any HMAC is computed, so a flood of malformed deliveries cannot be
 * turned into a CPU cost. The one thing that must not be reordered is the
 * timestamp window, which §10.8 puts before the comparison — a signature that
 * was valid last week is still cryptographically valid, and freshness is the
 * only thing that makes it a replay.
 */
export function verifyWebhookDelivery(input: WebhookVerificationInput): WebhookVerification {
  if (input.secrets.length === 0) return { ok: false, rejection: 'no_secret_configured' };

  const eventId = input.eventIdHeader?.trim();
  if (!eventId) return { ok: false, rejection: 'missing_event_id' };
  if (input.timestampHeader === undefined) return { ok: false, rejection: 'missing_timestamp' };
  if (input.signatureHeader === undefined) return { ok: false, rejection: 'missing_signature' };

  if (!WebhookTimestampHeaderSchema.safeParse(input.timestampHeader).success) {
    return { ok: false, rejection: 'malformed_timestamp' };
  }
  if (!WebhookSignatureHeaderSchema.safeParse(input.signatureHeader).success) {
    return { ok: false, rejection: 'malformed_signature' };
  }

  const tolerance = input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  const skewSeconds = Math.abs(input.nowMs / 1_000 - Number(input.timestampHeader));
  if (skewSeconds > tolerance) return { ok: false, rejection: 'timestamp_out_of_window' };

  const presentedHex = input.signatureHeader.slice(`${WEBHOOK_SIGNATURE_VERSION}=`.length);
  const payload = signedPayloadBytes(input.timestampHeader, input.rawBody);

  /**
   * Every secret is tried and the loop does not break early. Breaking would make
   * "the active secret matched" measurably faster than "the previous one did",
   * which tells a caller how far through a rotation the receiver is — small, but
   * free to avoid.
   */
  let matchedIndex = -1;
  input.secrets.forEach((secret, index) => {
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    if (digestsMatch(expected, presentedHex) && matchedIndex === -1) {
      matchedIndex = index;
    }
  });

  if (matchedIndex === -1) return { ok: false, rejection: 'signature_mismatch' };
  return { ok: true, eventId, secretIndex: matchedIndex };
}
