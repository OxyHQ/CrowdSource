import { createHash } from 'node:crypto';

/**
 * Deterministic serialisation and hashing of a JSON value.
 *
 * A report is idempotent on `externalReportId`, so the service has to answer a
 * second delivery with either "the same thing, here is your id again" or "a
 * different thing under an id you already used" (§10.5, 409). Distinguishing
 * those needs a fingerprint of what was delivered, and a fingerprint is only
 * useful if two payloads differing solely in key order hash the same — an HTTP
 * client is free to reorder object members, and a retry that hashed differently
 * would turn every reordered retry into a false conflict.
 *
 * So: object keys are sorted, array order is preserved (order is meaning in an
 * array), and everything else follows `JSON.stringify` for a single value.
 *
 * The input is expected to be the output of `JSON.parse` — the null/boolean/
 * number/string/array/object value space and nothing else. Anything outside it
 * (a `Date`, a `Map`, a class instance, a non-finite number) is REJECTED rather
 * than coerced: a serialiser that silently maps two different payloads onto one
 * digest would fire the 409 above on the wrong deliveries, which is worse than
 * refusing the input.
 */

/**
 * Nesting beyond this is refused.
 *
 * Recursion depth is attacker-controlled otherwise: a payload well inside the
 * body-size limit can nest half a million levels deep, and the resulting stack
 * overflow takes the process down rather than the request. No legitimate Case
 * Envelope — resources, relations, allegations, policy, privacy — comes close.
 */
export const MAX_CANONICAL_DEPTH = 64;

/** A value that cannot be canonicalised, with the reason and where it sits. */
export class CanonicalJsonError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path || '(root)'}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

/**
 * True for an object `JSON.parse` could have produced.
 *
 * The prototype is the test, not `value.constructor`: a payload is free to carry
 * a member literally named `constructor`, and reading it back would reject a
 * perfectly legitimate envelope.
 */
function isJsonRecord(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serialize(value: unknown, path: string, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalJsonError(`Nesting exceeds ${MAX_CANONICAL_DEPTH} levels`, path);
  }

  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError('Non-finite number', path);
    }
    return JSON.stringify(value);
  }

  if (typeof value !== 'object') {
    throw new CanonicalJsonError(`Unsupported value of type '${typeof value}'`, path);
  }

  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return `[${items
      .map((item, index) =>
        // An `undefined` element is `null` in JSON; mirror that rather than
        // dropping it, which would shift every later index.
        item === undefined ? 'null' : serialize(item, `${path}[${index}]`, depth + 1),
      )
      .join(',')}]`;
  }

  if (!isJsonRecord(value)) {
    throw new CanonicalJsonError('Unsupported non-plain object', path);
  }

  // Sorted by UTF-16 code unit, which is what `Array#sort` does by default and
  // what makes the result independent of the order the client happened to send.
  const members = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const member = value[key];
      // `JSON.stringify` omits `undefined` members; an absent key and a key set
      // to `undefined` are the same payload, so they must hash the same.
      if (member === undefined) return [];
      const memberPath = path ? `${path}.${key}` : key;
      return [`${JSON.stringify(key)}:${serialize(member, memberPath, depth + 1)}`];
    });

  return `{${members.join(',')}}`;
}

/** The canonical serialisation of a JSON value. Throws `CanonicalJsonError`. */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new CanonicalJsonError('Undefined is not a JSON value', '');
  }
  return serialize(value, '', 1);
}

/** `sha256:<hex>` over the canonical serialisation. Throws `CanonicalJsonError`. */
export function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;
}
