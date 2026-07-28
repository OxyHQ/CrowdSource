import { describe, expect, it } from 'vitest';

import { CaseEnvelopeSchema } from '../case-envelope';
import {
  CONTRACT_JSON_SCHEMA_NAMES,
  CONTRACT_SCHEMAS,
  crowdSourceJsonSchema,
} from '../json-schema';
import { rejectionPaths } from './support/assertions';
import { caseEnvelopeExample } from './support/examples';

/**
 * Walk a JSON Schema document by key, narrowing at every step.
 *
 * A JSON Schema subschema is legally `true`, `false` or an object, so optional
 * chaining alone would let a wrong path read as "the key is missing" and quietly
 * assert nothing. Throwing on the way down means a structural change to the
 * generated document fails the test that depends on it instead of skipping it.
 */
function objectAt(document: unknown, keys: readonly string[]): Record<string, unknown> {
  let current: unknown = document;
  const walked: string[] = [];
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new Error(`expected an object at "${walked.join('.')}"`);
    }
    const entries: Record<string, unknown> = { ...current };
    current = entries[key];
    walked.push(key);
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new Error(`expected an object at "${walked.join('.')}"`);
  }
  return { ...current };
}

describe('the exported JSON Schema', () => {
  it('publishes one schema per contract, with nothing missing on either side', () => {
    // Vacuity floor: a traversal that silently produced nothing would still
    // "pass" a loop-based test, so the count is asserted directly.
    expect(CONTRACT_JSON_SCHEMA_NAMES.length).toBe(13);
    expect(Object.keys(CONTRACT_SCHEMAS).sort()).toEqual([...CONTRACT_JSON_SCHEMA_NAMES].sort());
  });

  it('converts every contract without throwing', () => {
    /**
     * Conversion is not free of failure modes — `z.custom`, transforms and
     * some refinement forms are unrepresentable and throw. This is what stops a
     * schema change from quietly making the JSON Schema half of the package
     * unusable.
     */
    for (const name of CONTRACT_JSON_SCHEMA_NAMES) {
      const document = crowdSourceJsonSchema(name);
      expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(Object.keys(document).length).toBeGreaterThan(1);
    }
  });

  it('carries the inbound/outbound strictness split into the JSON Schema', () => {
    const envelope = crowdSourceJsonSchema('case-envelope');
    expect(envelope.additionalProperties).toBe(false);

    // A loose object converts to `additionalProperties: {}` — anything goes,
    // which is the JSON Schema spelling of "unknown fields must not break
    // clients" (§10.11).
    const decision = crowdSourceJsonSchema('decision');
    expect(decision.additionalProperties).toEqual({});

    const reputationEvent = crowdSourceJsonSchema('reputation-event');
    const [variant] = reputationEvent.oneOf ?? reputationEvent.anyOf ?? [];
    expect(variant?.additionalProperties).toBe(false);
  });

  it('does not carry the cross-reference rules, and the gap is where it is documented', () => {
    /**
     * JSON Schema gets the structure; Zod keeps the invariants. `relations[].to`
     * converts to a plain pattern-checked string with no way to express "and it
     * must name a resource in this document", so a dangling relation is
     * well-formed JSON Schema and an invalid envelope. An integrator who
     * validates only against the JSON Schema will meet the difference as a 422,
     * which is why this is asserted rather than left as a claim in a comment.
     */
    const document: unknown = JSON.parse(JSON.stringify(crowdSourceJsonSchema('case-envelope')));
    const relationTo = objectAt(document, ['properties', 'relations', 'items', 'properties', 'to']);
    expect(relationTo.type).toBe('string');
    expect(Object.keys(relationTo).sort()).toEqual(['maxLength', 'minLength', 'pattern', 'type']);

    const dangling = {
      ...caseEnvelopeExample(),
      relations: [{ from: 'res_post', type: 'has_attachment', to: 'res_ghost' }],
    };
    expect(rejectionPaths(CaseEnvelopeSchema, dangling)).toEqual(['relations.0.to']);
  });
});
