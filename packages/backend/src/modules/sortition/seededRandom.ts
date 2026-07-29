import { createHmac, randomBytes } from 'node:crypto';

/**
 * The randomness a draw is made of (§8.4, §8.5, §16.3).
 *
 * §16.3 asks for two properties that pull in opposite directions, and both have
 * to hold at once:
 *
 *  - **Reproducible from a known seed.** Given the seed and the candidate
 *    snapshot, anybody — an auditor, a court, the reviewer who was not picked —
 *    can re-run the draw and get the same panel. That is what makes a sortition
 *    auditable rather than merely asserted.
 *  - **Unpredictable before the seed is persisted or revealed.** If a reviewer
 *    could compute tomorrow's panel, the whole exercise is theatre.
 *
 * `Math.random()` satisfies neither: it is unseeded (so nothing reproduces) and
 * it is not cryptographic (so given enough outputs it predicts). A user-supplied
 * seed satisfies the first and destroys the second. What holds both is a
 * CSPRNG-drawn seed, persisted at the moment of the draw, expanded
 * deterministically into as many uniforms as the draw needs.
 *
 * The expansion is HMAC-SHA256 over a counter, which is a standard
 * counter-mode DRBG shape: each output is a keyed hash of a distinct message, so
 * the stream is deterministic given the key and reveals nothing about the key.
 * `randomBytes` is the only entropy source, and it is drawn once.
 */

/** How many bytes of entropy a draw's seed carries. §8.5 says 32. */
export const SEED_BYTES = 32;

/** A fresh seed. The one place the unpredictability comes from. */
export function newSortitionSeed(): Buffer {
  return randomBytes(SEED_BYTES);
}

/** The stored form of a seed: lowercase hex, so a draw record is inspectable. */
export function encodeSeed(seed: Buffer): string {
  return seed.toString('hex');
}

/**
 * Reads a stored seed back.
 *
 * Rejects anything that is not exactly `SEED_BYTES` of hex rather than padding
 * or truncating: a draw re-run from a malformed seed would produce a DIFFERENT
 * panel and report it as the original one, which is worse than failing.
 */
export function decodeSeed(encoded: string): Buffer {
  if (!new RegExp(`^[0-9a-f]{${SEED_BYTES * 2}}$`).test(encoded)) {
    throw new Error(`A sortition seed must be ${SEED_BYTES} bytes of lowercase hex.`);
  }
  return Buffer.from(encoded, 'hex');
}

/** 2^53, the largest integer a double represents exactly. */
const DENOMINATOR = 2 ** 53;

/**
 * A deterministic stream of uniforms in (0, 1], keyed by the seed.
 *
 * The interval excludes 0 on purpose. The sampler raises each uniform to the
 * power `1 / weight`; `0` collapses every weight to the same key and would make
 * a candidate unselectable for a reason that has nothing to do with their
 * weight. Adding one to the drawn integer before dividing removes the zero and
 * leaves the distribution otherwise untouched.
 *
 * `label` separates independent uses of one seed — the draw and any later
 * tie-break — so two consumers of the same seed cannot accidentally share a
 * sub-stream and correlate.
 */
export function createSeededUniforms(seed: Buffer, label: string): () => number {
  let counter = 0;

  return () => {
    const message = Buffer.from(`${label}:${counter}`, 'utf8');
    counter += 1;

    const digest = createHmac('sha256', seed).update(message).digest();
    // 53 bits: the whole precision of a double and not one bit more, so the
    // value is exactly representable and the same on every machine.
    const draw = digest.readBigUInt64BE(0) >> 11n;
    return (Number(draw) + 1) / DENOMINATOR;
  };
}
