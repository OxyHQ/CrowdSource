/**
 * Test support shared by every contract suite.
 *
 * `rejectionIssues` exists because "the schema rejected it" is not a useful
 * assertion on its own. A negative example that fails for an unintended reason
 * — a typo in the fixture, a required field left out while constructing the
 * defect — passes just as loudly as one that fails for the reason under test,
 * and then quietly stops testing anything the day the rule it was written for
 * is removed. Every negative test in this package therefore asserts the ISSUE
 * PATHS, not merely that parsing failed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ZodType } from 'zod';

export interface RejectionIssue {
  readonly path: string;
  readonly message: string;
}

/** Parse, require failure, and return the issues as `{ path, message }`. */
export function rejectionIssues(schema: ZodType, value: unknown): RejectionIssue[] {
  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error('expected the schema to reject this value, but it was accepted');
  }
  return result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** The dotted paths a rejection reported, in order. */
export function rejectionPaths(schema: ZodType, value: unknown): string[] {
  return rejectionIssues(schema, value).map((issue) => issue.path);
}

/**
 * Parse and require success, reporting the issues if there are any.
 *
 * A bare `expect(result.success).toBe(true)` tells you a fixture broke but not
 * which field, which turns a one-line fix into a bisect.
 */
export function accepted<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`expected the schema to accept this value, but it reported:\n  ${detail}`);
  }
  return result.data;
}

const FIXTURES_DIRECTORY = path.resolve(__dirname, '..', 'fixtures');

/** A reference document from the plan, exactly as the plan writes it. */
export function readFixture(fileName: string): unknown {
  const contents = readFileSync(path.join(FIXTURES_DIRECTORY, fileName), 'utf8');
  const parsed: unknown = JSON.parse(contents);
  return parsed;
}

export interface Expansion {
  readonly value: unknown;
  readonly used: readonly string[];
}

/**
 * Replace elided placeholder VALUES in a reference document.
 *
 * The plan's appendices are prose documents: they write `"sha256:..."` and
 * `"upload_01..."` where a real value would go. Most of those elisions happen
 * to be well-formed for their field and validate untouched; a digest does not,
 * and cannot, because accepting `sha256:...` as a digest would mean the schema
 * does not check digests at all.
 *
 * So the fixtures are stored verbatim and the substitutions are made here,
 * explicitly and by exact string match, with the set of placeholders that were
 * actually consumed returned so a test can assert none of them went stale. That
 * keeps the appendix in the repository as the appendix, and keeps every
 * deviation from it enumerable in one place.
 */
export function expandPlaceholders(
  document: unknown,
  expansions: Readonly<Record<string, string>>,
): Expansion {
  const used = new Set<string>();

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const replacement = expansions[value];
      if (replacement === undefined) {
        return value;
      }
      used.add(value);
      return replacement;
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        result[key] = walk(nested);
      }
      return result;
    }
    return value;
  };

  return { value: walk(document), used: [...used] };
}
