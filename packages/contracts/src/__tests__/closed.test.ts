/**
 * The outbound types are closed, and the outbound SCHEMAS are still loose.
 *
 * Both halves matter and they pull in opposite directions, so both are asserted
 * here. §10.11 needs the parse to accept and preserve a field this version has
 * never heard of; an integrator needs the compiler to reject a field they
 * invented. `Closed` is what lets those coexist — see `../closed.ts`.
 *
 * The `@ts-expect-error` lines below are the real test, and they are checked by
 * `tsc -p tsconfig.test.json` in this package's `lint` script rather than by
 * vitest. If a catchall index signature ever comes back, those lines stop being
 * errors and tsc fails with TS2578 "unused '@ts-expect-error' directive" — which
 * is the failure we want, because a passing suite would otherwise report that
 * field-name checking works while it silently does not.
 */

import { describe, expect, it } from 'vitest';

import { CreateReportResponseSchema } from '../case-envelope.js';
import { DecisionSchema } from '../decisions.js';
import { WebhookEventEnvelopeSchema } from '../webhooks.js';
import type { Closed } from '../closed.js';
import type { CreateReportResponse, Decision } from '../index.js';
import { decisionExample } from './support/examples.js';

describe('outbound schemas stay loose at runtime', () => {
  it('preserves a field this version of the contract does not know', () => {
    const parsed = CreateReportResponseSchema.parse({
      reportId: 'rpt_1',
      caseId: 'case_1',
      status: 'received',
      merged: false,
      fieldFromANewerServer: 'kept',
    });

    // §10.11: passed through, not stripped and not rejected. A receiver that
    // persists this keeps all of it.
    expect((parsed as Record<string, unknown>)['fieldFromANewerServer']).toBe('kept');
  });

  it('does not reject an unknown field on a webhook envelope', () => {
    const result = WebhookEventEnvelopeSchema.safeParse({
      id: 'evt_1',
      createdAt: '2026-07-30T00:00:00.000Z',
      organizationId: 'org_1',
      applicationId: 'app_1',
      type: 'case.decided',
      data: { caseId: 'case_1' },
      deliveryAttempt: 3,
    });

    expect(result.success).toBe(true);
  });
});

describe('outbound types are closed at compile time', () => {
  it('names only fields the contract declares', () => {
    // Runtime half: the shape the API actually sends for POST /v1/reports.
    const receipt: CreateReportResponse = {
      reportId: 'rpt_1',
      caseId: 'case_1',
      status: 'received',
      merged: false,
    };
    expect(Object.keys(receipt).sort()).toEqual(['caseId', 'merged', 'reportId', 'status']);

    // Compile-time half. Each of these was legal before `Closed` and is the
    // exact mistake an integrator makes: `externalReportId` and `receivedAt`
    // belong to GET /v1/reports/{id}, not to the create response.
    // @ts-expect-error externalReportId is not on the create response
    void receipt.externalReportId;
    // @ts-expect-error receivedAt is not on the create response
    void receipt.receivedAt;

    /**
     * Annotated deliberately. `DecisionSchema.parse()` returns `z.output`, which
     * is still the loose inferred shape — `Closed` applies to the exported TYPE,
     * not to a parse result. That is the right boundary: every SDK method
     * declares its return as the exported type, so this is the shape an
     * integrator actually receives. Dropping the annotation here would make the
     * assertions below silently test the loose type instead.
     */
    const decision: Decision = DecisionSchema.parse(decisionExample());

    expect(typeof decision.id).toBe('string');

    // @ts-expect-error the field is `id`, not `decisionId`
    void decision.decisionId;
    // @ts-expect-error the field is `policyVersions`, not `policyVersion`
    void decision.policyVersion;
    // @ts-expect-error nested objects are closed too
    void decision.policyVersions.oxyConductVersion;
    // @ts-expect-error array elements are closed too
    void decision.findings[0]?.reason;
  });

  it('keeps optionality, readonly arrays and union narrowing', () => {
    type Sample = Closed<
      ({ type: 'a'; note?: string; tags: readonly string[] } | { type: 'b'; count: number }) & {
        [k: string]: unknown;
      }
    >;

    // Taken as a parameter rather than a const: a const initialised with a
    // literal is narrowed to that member by control-flow analysis, which would
    // make the `type === 'b'` branch `never` and prove nothing about the union.
    const inspect = (value: Sample): string => {
      // @ts-expect-error the catchall is gone from the union members too
      void value.somethingInvented;

      if (value.type === 'a') {
        // Narrowed, `note` still optional, `tags` still a readonly string array.
        const note: string | undefined = value.note;
        return `${note ?? 'no note'}:${value.tags[0] ?? ''}`;
      }
      return String(value.count);
    };

    expect(inspect({ type: 'a', tags: ['x'] })).toBe('no note:x');
    expect(inspect({ type: 'b', count: 2 })).toBe('2');
  });
});
