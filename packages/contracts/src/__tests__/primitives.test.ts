import { describe, expect, it } from 'vitest';

import {
  CustomPayloadSchema,
  HttpUrlSchema,
  IdentifierSchema,
  LanguageTagSchema,
  MetadataBagSchema,
  MimeTypeSchema,
  Sha256DigestSchema,
  TimestampSchema,
  UnitIntervalSchema,
} from '../primitives.js';
import { accepted, rejectionIssues, rejectionPaths } from './support/assertions.js';

describe('IdentifierSchema', () => {
  it('accepts every identifier notation the plan actually writes', () => {
    for (const value of [
      'app_mention',
      'mention_report_123',
      'mention-report-123',
      'res_post',
      'mention.community',
      '2026.07',
      'dec_01HZY6QX4A7K8ZQ0RB3W7NDPGM',
    ]) {
      expect(accepted(IdentifierSchema, value)).toBe(value);
    }
  });

  it('rejects a colon, because ":" is the caseDedupKey separator', () => {
    /**
     * §7.3 builds `caseDedupKey` by joining applicationId, the subject's
     * external id, the envelope hash and the policy version with ":". If an
     * identifier could itself contain ":", two different tuples could flatten
     * to the same string — merging two unrelated cases, and with them two
     * incidents that must stay separate.
     */
    const issues = rejectionIssues(IdentifierSchema, 'app:mention');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('letters, digits');
  });

  it('rejects the empty string, leading punctuation, whitespace and overlong values', () => {
    for (const value of ['', '-leading', '.leading', 'has space', 'a'.repeat(129)]) {
      expect(rejectionIssues(IdentifierSchema, value).length).toBeGreaterThan(0);
    }
  });
});

describe('Sha256DigestSchema', () => {
  it('accepts the canonical prefixed form', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(accepted(Sha256DigestSchema, digest)).toBe(digest);
  });

  it('rejects every other notation for the same value', () => {
    for (const value of [
      'a'.repeat(64), // bare hex, as §5.8 elides it
      `sha256:${'A'.repeat(64)}`, // uppercase hex
      `sha256:${'a'.repeat(63)}`, // truncated
      'sha256:...', // the appendix placeholder
      `sha-256:${'a'.repeat(64)}`,
    ]) {
      expect(rejectionIssues(Sha256DigestSchema, value)).toHaveLength(1);
    }
  });
});

describe('TimestampSchema', () => {
  it('accepts millisecond-precision UTC, which is what toISOString() produces', () => {
    expect(accepted(TimestampSchema, '2026-07-28T18:00:00.000Z')).toBe('2026-07-28T18:00:00.000Z');
    expect(accepted(TimestampSchema, new Date(0).toISOString())).toBe('1970-01-01T00:00:00.000Z');
  });

  it('rejects offsets and other precisions, which would hash differently', () => {
    for (const value of [
      '2026-07-28T18:00:00Z',
      '2026-07-28T18:00:00.000+02:00',
      '2026-07-28T18:00:00.000000Z',
      '2026-07-28',
    ]) {
      expect(rejectionIssues(TimestampSchema, value).length).toBeGreaterThan(0);
    }
  });
});

describe('LanguageTagSchema', () => {
  it('accepts language, language-Region and language-Script-Region', () => {
    for (const value of ['es', 'es-ES', 'zh-Hans-CN', 'pt-BR']) {
      expect(accepted(LanguageTagSchema, value)).toBe(value);
    }
  });

  it('rejects the shapes applications get wrong', () => {
    for (const value of ['ES', 'es_ES', 'spanish', 'es-es']) {
      expect(rejectionIssues(LanguageTagSchema, value).length).toBeGreaterThan(0);
    }
  });
});

describe('HttpUrlSchema', () => {
  it('accepts http and https', () => {
    expect(accepted(HttpUrlSchema, 'https://mention.earth/post/987')).toContain('mention.earth');
    expect(accepted(HttpUrlSchema, 'http://example.test/a')).toContain('example.test');
  });

  it('rejects the schemes §7.2.7 calls dangerous', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      'ftp://example.test/a',
      'not a url',
    ]) {
      expect(rejectionIssues(HttpUrlSchema, value).length).toBeGreaterThan(0);
    }
  });
});

describe('MimeTypeSchema', () => {
  it('accepts a bare type/subtype', () => {
    expect(accepted(MimeTypeSchema, 'image/jpeg')).toBe('image/jpeg');
    expect(accepted(MimeTypeSchema, 'application/vnd.oasis.opendocument.text')).toContain('vnd');
  });

  it('rejects parameters, uppercase and missing subtypes', () => {
    for (const value of ['image/jpeg; charset=utf-8', 'Image/JPEG', 'image', 'image/']) {
      expect(rejectionIssues(MimeTypeSchema, value).length).toBeGreaterThan(0);
    }
  });
});

describe('MetadataBagSchema', () => {
  it('accepts a flat bag of scalars', () => {
    expect(accepted(MetadataBagSchema, { visibility: 'public', contentVersion: 3, live: false })).toEqual(
      { visibility: 'public', contentVersion: 3, live: false },
    );
  });

  it('rejects nesting, so the bag cannot become a document tree', () => {
    expect(rejectionPaths(MetadataBagSchema, { audience: { size: 3 } })).toContain('audience');
    expect(rejectionPaths(MetadataBagSchema, { tags: ['a'] })).toContain('tags');
  });

  it('rejects the prototype-bearing keys Zod treats as ordinary', () => {
    for (const key of ['constructor', 'prototype']) {
      expect(rejectionIssues(MetadataBagSchema, { [key]: 'x' })).toHaveLength(1);
    }
  });

  it('never lets an own __proto__ survive, and never pollutes', () => {
    /**
     * `__proto__` takes a different path from the other two: Zod strips it
     * before any key check runs, so the bag parses successfully WITHOUT it
     * rather than being rejected. Asserting the real behaviour here rather than
     * the assumed one is the point — a test written as "rejects __proto__"
     * would fail, and one written as "rejects all three" would hide which
     * mechanism is actually protecting the parse.
     */
    const hostile: unknown = JSON.parse('{"visibility":"public","__proto__":{"polluted":true}}');
    expect(Object.getOwnPropertyNames(hostile)).toContain('__proto__');
    expect(accepted(MetadataBagSchema, hostile)).toEqual({ visibility: 'public' });
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });

  it('rejects a bag with more keys than the declared limit', () => {
    const oversized: Record<string, string> = {};
    for (let index = 0; index < 51; index += 1) {
      oversized[`key${index}`] = 'x';
    }
    expect(rejectionIssues(MetadataBagSchema, oversized).length).toBeGreaterThan(0);
  });
});

describe('CustomPayloadSchema', () => {
  it('accepts bounded, nested data', () => {
    expect(
      accepted(CustomPayloadSchema, {
        listing: { attributes: { colour: 'red', sizes: ['s', 'm'] } },
      }),
    ).toBeTruthy();
  });

  it('accepts hostile text verbatim, because that is the material under review', () => {
    /**
     * A lexical blocklist here would reject the evidence. §5.7's boundary is
     * structural — no field in this contract is ever interpreted as markup —
     * so the string below is data like any other.
     */
    const payload = accepted(CustomPayloadSchema, {
      quotedMessage: '<script>alert(1)</script> click javascript:void(0)',
    });
    expect(payload.quotedMessage).toContain('<script>');
  });

  it('rejects nesting past the declared depth', () => {
    expect(
      rejectionIssues(CustomPayloadSchema, { a: { b: { c: { d: { e: { f: 1 } } } } } }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects $-prefixed keys, which is every JSON Schema reference mechanism', () => {
    for (const key of ['$ref', '$dynamicRef', '$id', '$schema']) {
      expect(rejectionIssues(CustomPayloadSchema, { [key]: 'https://evil.test/s.json' }).length)
        .toBeGreaterThan(0);
    }
  });

  it('rejects prototype-bearing keys at depth, not only at the root', () => {
    expect(rejectionIssues(CustomPayloadSchema, { outer: { constructor: 'x' } }).length)
      .toBeGreaterThan(0);
    expect(rejectionIssues(CustomPayloadSchema, { outer: { prototype: 'x' } }).length)
      .toBeGreaterThan(0);
  });
});

describe('UnitIntervalSchema', () => {
  it('accepts the closed interval §9.5 clamps to', () => {
    for (const value of [0, 0.5, 1]) {
      expect(accepted(UnitIntervalSchema, value)).toBe(value);
    }
  });

  it('rejects values outside it', () => {
    for (const value of [-0.1, 1.1]) {
      expect(rejectionIssues(UnitIntervalSchema, value)).toHaveLength(1);
    }
  });
});
