import { describe, expect, it } from 'vitest';

import {
  canonicalHash,
  canonicalize,
  CanonicalJsonError,
  MAX_CANONICAL_DEPTH,
} from '../utils/canonicalJson';

/**
 * The fingerprint that decides whether a second delivery is a retry or a
 * conflict (§10.5). Two properties matter and they pull in opposite directions:
 * it must ignore everything an HTTP client is free to change, and it must not
 * ignore anything that changes what was reported.
 */
describe('canonicalize', () => {
  it('is independent of the order the client sent object members in', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe(canonicalize({ outer: { a: 2, z: 1 } }));
  });

  it('preserves array order, because order is meaning in an array', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('treats an absent member and an undefined member as the same payload', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('keeps an undefined array element in place rather than shifting later indexes', () => {
    expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('does not conflate values that differ', () => {
    const distinct = [
      canonicalize({ a: 1 }),
      canonicalize({ a: '1' }),
      canonicalize({ a: true }),
      canonicalize({ a: null }),
      canonicalize({ a: [1] }),
      canonicalize({ a: { b: 1 } }),
    ];

    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it('serialises the JSON scalars exactly', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(1.5)).toBe('1.5');
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
  });

  it('refuses values JSON.parse could never have produced', () => {
    expect(() => canonicalize(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(Number.NaN)).toThrow(/Non-finite number/);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/Non-finite number/);
    expect(() => canonicalize(new Date())).toThrow(/non-plain object/);
    expect(() => canonicalize(new Map())).toThrow(/non-plain object/);
    expect(() => canonicalize(() => undefined)).toThrow(/type 'function'/);
    expect(() => canonicalize(1n)).toThrow(/type 'bigint'/);
  });

  it('names where the offending value sits', () => {
    expect(() => canonicalize({ resources: [{ createdAt: new Date() }] })).toThrow(
      /resources\[0\]\.createdAt/,
    );
  });

  it('accepts a member literally named constructor', () => {
    // The prototype is what identifies a plain object; reading `.constructor`
    // instead would reject this perfectly legitimate payload.
    expect(canonicalize({ constructor: 'not a function' })).toBe('{"constructor":"not a function"}');
  });

  it('accepts an object with no prototype', () => {
    const bare: Record<string, unknown> = Object.create(null);
    bare.a = 1;
    expect(canonicalize(bare)).toBe('{"a":1}');
  });

  it('refuses nesting deep enough to overflow the stack', () => {
    const build = (depth: number): unknown => {
      let value: unknown = 'leaf';
      for (let level = 0; level < depth; level += 1) value = { nested: value };
      return value;
    };

    // The boundary in both directions: one level inside the limit is accepted,
    // one level past it is refused. A limit only tested from one side can be off
    // by any amount and still look correct.
    expect(() => canonicalize(build(MAX_CANONICAL_DEPTH - 1))).not.toThrow();
    expect(() => canonicalize(build(MAX_CANONICAL_DEPTH))).toThrow(/Nesting exceeds/);
  });
});

describe('canonicalHash', () => {
  it('is stable, prefixed and distinguishing', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});
