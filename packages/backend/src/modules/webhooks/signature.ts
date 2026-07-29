import { createHmac } from 'node:crypto';

import { verifySecret } from '@oxyhq/core/server';
import {
  buildWebhookSignedPayload,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  WebhookSignatureHeaderSchema,
  WebhookTimestampHeaderSchema,
} from '@oxyhq/crowdsource-contracts';

/**
 * The webhook signature (§10.8).
 *
 *     signedPayload = timestamp + "." + rawBody
 *     signature     = HMAC_SHA256(secret, signedPayload)
 *     header        = "v1=" + hex(signature)
 *
 * `buildWebhookSignedPayload` comes from the published contract and is the ONLY
 * thing this module and the integrator's middleware share. That is deliberate:
 * a sender and a receiver that each decide for themselves what gets signed agree
 * right up until they do not, and the failure is either every delivery rejected
 * or — far worse — a signature that validates over bytes the receiver never
 * parsed.
 *
 * Three properties this file is responsible for, and each has a test that can
 * fail:
 *
 *  1. **The signature covers the RAW body.** A body that was parsed and
 *     re-serialised is different bytes, so it does not verify. That is the whole
 *     point of signing the raw bytes rather than a canonical form of them: it is
 *     what stops a receiver from validating one document and acting on another.
 *  2. **The timestamp is the header value verbatim.** Re-deriving it from a
 *     parsed number is the mistake the signature exists to catch.
 *  3. **Comparison is constant time.** `verifySecret` from `@oxyhq/core/server`,
 *     never `!==` — a short-circuiting compare leaks a valid signature one byte
 *     at a time, and a webhook signature is exactly the thing an attacker would
 *     grind for.
 *
 * The verifier below is the receiver's side of the contract, and the shipped
 * implementation integrators use is `@oxyhq/crowdsource-express`. This one exists
 * so the signer is proven against an independent implementation instead of
 * against itself — a check that can only agree with the code it checks is not a
 * check.
 */

/** Unix seconds as they travel in the header: a string, never a number. */
export function webhookTimestamp(now: Date): string {
  return String(Math.floor(now.getTime() / 1_000));
}

/** `v1=<hex>` over `timestamp + "." + rawBody`. */
export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac('sha256', secret)
    .update(buildWebhookSignedPayload(timestamp, rawBody), 'utf8')
    .digest('hex');
  return `${WEBHOOK_SIGNATURE_VERSION}=${digest}`;
}

/** Why a signature was refused. A closed vocabulary, safe to log. */
export const WEBHOOK_VERIFICATION_FAILURES = [
  'malformed_timestamp',
  'malformed_signature',
  'timestamp_out_of_tolerance',
  'signature_mismatch',
] as const;
export type WebhookVerificationFailure = (typeof WEBHOOK_VERIFICATION_FAILURES)[number];

export type WebhookVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WebhookVerificationFailure };

export interface WebhookVerificationInput {
  readonly secret: string;
  /** The `X-CrowdSource-Timestamp` header, exactly as received. */
  readonly timestamp: string;
  /** The `X-CrowdSource-Signature` header, exactly as received. */
  readonly signature: string;
  /** The request body as BYTES, before any parse. */
  readonly rawBody: string;
  readonly now: Date;
}

/**
 * Verifies one signature against one secret.
 *
 * Order matters. Shape first, then freshness, then the HMAC: a replayed
 * delivery with a valid signature and a two-hour-old timestamp must be refused
 * for being stale, and computing the HMAC before checking the clock would make
 * the answer depend on which failure the caller happened to look at.
 */
export function verifyWebhookSignature(input: WebhookVerificationInput): WebhookVerification {
  if (!WebhookTimestampHeaderSchema.safeParse(input.timestamp).success) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  if (!WebhookSignatureHeaderSchema.safeParse(input.signature).success) {
    return { ok: false, reason: 'malformed_signature' };
  }

  /**
   * Both directions, and that is not symmetry for its own sake. A past
   * timestamp outside the window is a replay; a future one means either a
   * clock the sender does not control or an attacker choosing a timestamp to
   * keep a captured signature valid for longer.
   */
  const skewSeconds = Math.abs(
    Math.floor(input.now.getTime() / 1_000) - Number(input.timestamp),
  );
  if (skewSeconds > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = signWebhookPayload(input.secret, input.timestamp, input.rawBody);
  if (!verifySecret(input.signature, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

/**
 * Verifies against every secret the endpoint currently has valid.
 *
 * This is the receiver-side half of §10.8's "allow two valid secrets during
 * rotation". A receiver holding both the outgoing and the incoming secret
 * accepts either, which is what makes the cutover invisible to it; a receiver
 * holding only one accepts only what that one signed.
 *
 * Every candidate is tried even after a match, so the time taken does not depend
 * on which secret matched.
 */
export function verifyWebhookSignatureAgainst(
  secrets: readonly string[],
  input: Omit<WebhookVerificationInput, 'secret'>,
): WebhookVerification {
  let matched: WebhookVerification = { ok: false, reason: 'signature_mismatch' };

  for (const secret of secrets) {
    const result = verifyWebhookSignature({ ...input, secret });
    if (result.ok) {
      matched = result;
      continue;
    }
    // A shape or freshness failure is a property of the request, not of the
    // secret, so it is the answer regardless of how many secrets are on record.
    if (result.reason !== 'signature_mismatch') {
      return result;
    }
  }

  return matched;
}
