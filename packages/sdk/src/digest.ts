/**
 * Resource digests (§5.2 `sha256`, §5.6 "SHA 256 of each resource").
 *
 * Every inline resource in an envelope must carry a digest of "the exact
 * representation reviewed", and asking an integrator to compute one is asking
 * them to get canonical serialisation right — which they will do differently
 * from the next integrator, and differently again from themselves next quarter.
 * So the client computes it, from one rule applied to every resource type:
 *
 *     sha256:<hex of SHA-256 over canonicalJson({ type, data }) in UTF-8>
 *
 * `type` is inside the digest so a `text` resource and a `metadata` resource
 * carrying identical fields do not produce the same digest. `custom` hashes its
 * registered `schemaId` and `payload` for the same reason.
 *
 * Determinism is not a nicety here, it is the deduplication invariant. §7.3
 * requires two people reporting the same version of the same post to land on ONE
 * case, and the server's `caseDedupKey` is computed over a projection of the
 * envelope that INCLUDES every resource verbatim, digest and all. A digest that
 * varied with key order — or with which reporter sent it — would give the same
 * post two cases, and "one penalty per incident" would be broken by a JSON
 * serialiser.
 *
 * Asset-backed resources are the exception the contract already makes: their
 * bytes live outside the envelope and `asset.sha256` is the digest of those
 * bytes, so nothing here computes one for them.
 */

import { createHash } from 'node:crypto';

/** A JSON value that can be canonicalised. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/**
 * JSON with object keys in a fixed order and `undefined` members dropped.
 *
 * Array order is PRESERVED. In a conversation's `messageResourceIds` the order
 * is the meaning, and the backend's own canonicaliser makes the same choice for
 * the same reason.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('A resource cannot carry a non-finite number: it has no JSON form.');
    }
    return JSON.stringify(value);
  }

  if (isCanonicalArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  const members = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const member = value[key];
      return member === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
    });

  return `{${members.join(',')}}`;
}

/**
 * A written-out predicate rather than a bare `Array.isArray`, because
 * `Array.isArray` narrows `readonly T[]` in its TRUE branch only — the false
 * branch keeps the array in the union and the object branch below stops
 * type-checking.
 */
function isCanonicalArray(value: CanonicalValue): value is readonly CanonicalValue[] {
  return Array.isArray(value);
}

/** `sha256:<64 lowercase hex>` — the only digest form the contract accepts. */
export function sha256Digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The digest of an inline resource's reviewable representation. */
export function resourceDigest(reviewable: CanonicalValue): string {
  return sha256Digest(Buffer.from(canonicalJson(reviewable), 'utf8'));
}
