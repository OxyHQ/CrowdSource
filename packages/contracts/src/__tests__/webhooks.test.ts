import { describe, expect, it } from 'vitest';

import {
  KnownWebhookEventSchema,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_RETRY_SCHEDULE_SECONDS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  WebhookEventEnvelopeSchema,
  WebhookSignatureHeaderSchema,
  WebhookTimestampHeaderSchema,
  buildWebhookSignedPayload,
} from '../webhooks.js';
import { accepted, rejectionIssues, rejectionPaths } from './support/assertions.js';
import { caseDecidedEventExample, decisionExample } from './support/examples.js';

describe('the event catalogue', () => {
  it('publishes exactly the eight events §10.6 lists', () => {
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([
      'report.received',
      'case.created',
      'case.escalated',
      'case.decided',
      'decision.corrected',
      'appeal.created',
      'appeal.decided',
      'case.closed',
    ]);
  });
});

describe('the generic envelope', () => {
  it('accepts an event type this version has never heard of', () => {
    /**
     * §10.11: "unknown events must be ignored safely". A receiver has to be
     * able to verify the signature and record the event id BEFORE it knows what
     * the event is, so refusing to parse an unrecognised type would make safe
     * ignoring impossible.
     */
    const envelope = accepted(WebhookEventEnvelopeSchema, {
      ...caseDecidedEventExample(),
      type: 'case.rehydrated',
      data: { caseId: 'case_01HZ' },
    });
    expect(envelope.type).toBe('case.rehydrated');
    expect(envelope.id).toBe('evt_01HZ');
  });

  it('still requires the fields a receiver needs to be safe', () => {
    const { id, ...withoutId } = caseDecidedEventExample();
    expect(id).toBeDefined();
    expect(rejectionPaths(WebhookEventEnvelopeSchema, withoutId)).toEqual(['id']);
  });

  it('preserves unknown fields instead of stripping them', () => {
    const envelope = accepted(WebhookEventEnvelopeSchema, {
      ...caseDecidedEventExample(),
      deliveryAttempt: 2,
    });
    expect(envelope).toHaveProperty('deliveryAttempt', 2);
  });
});

describe('the typed events', () => {
  it('parses case.decided into a typed decision', () => {
    const event = accepted(KnownWebhookEventSchema, caseDecidedEventExample());
    expect(event.type).toBe('case.decided');
    if (event.type === 'case.decided') {
      expect(event.data.decision.outcome).toBe('violation');
    }
  });

  it('rejects a correction that does not supersede anything', () => {
    expect(
      rejectionPaths(KnownWebhookEventSchema, {
        ...caseDecidedEventExample(),
        type: 'decision.corrected',
        data: { caseId: 'case_01HZ', decision: decisionExample() },
      }),
    ).toEqual(['data.decision']);
  });

  it('accepts a correction that names the revision it replaced', () => {
    const event = accepted(KnownWebhookEventSchema, {
      ...caseDecidedEventExample(),
      type: 'decision.corrected',
      data: {
        caseId: 'case_01HZ',
        decision: {
          ...decisionExample(),
          id: 'dec_02HZ',
          revision: 2,
          outcome: 'no_violation',
          findings: [],
          supersedesDecisionId: 'dec_01HZ',
        },
      },
    });
    expect(event.type).toBe('decision.corrected');
  });

  it('rejects an event type it does not know, which is the point of the other schema', () => {
    expect(
      rejectionIssues(KnownWebhookEventSchema, {
        ...caseDecidedEventExample(),
        type: 'case.rehydrated',
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('signature and replay protection (§10.8)', () => {
  it('publishes the three header names the plan defines', () => {
    expect(WEBHOOK_EVENT_ID_HEADER).toBe('X-CrowdSource-Event-Id');
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe('X-CrowdSource-Timestamp');
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('X-CrowdSource-Signature');
  });

  it('signs exactly timestamp + "." + rawBody', () => {
    /**
     * Signer and verifier live in different packages. If they ever disagree
     * about these bytes, every delivery fails — or a signature validates over
     * something other than what the receiver goes on to parse.
     */
    expect(buildWebhookSignedPayload('1785263400', '{"id":"evt_01"}')).toBe(
      '1785263400.{"id":"evt_01"}',
    );
  });

  it('signs the raw body byte for byte, including whitespace', () => {
    const body = '{\n  "id": "evt_01"\n}';
    expect(buildWebhookSignedPayload('1', body)).toBe(`1.${body}`);
  });

  it('accepts a well-formed signature header and rejects the near misses', () => {
    const signature = `v1=${'a'.repeat(64)}`;
    expect(accepted(WebhookSignatureHeaderSchema, signature)).toBe(signature);
    for (const value of [
      'a'.repeat(64),
      `v0=${'a'.repeat(64)}`,
      `v1=${'A'.repeat(64)}`,
      `v1=${'a'.repeat(63)}`,
    ]) {
      expect(rejectionIssues(WebhookSignatureHeaderSchema, value)).toHaveLength(1);
    }
  });

  it('accepts unix seconds and rejects anything else in the timestamp header', () => {
    expect(accepted(WebhookTimestampHeaderSchema, '1785263400')).toBe('1785263400');
    for (const value of ['2026-07-28T18:30:00.000Z', '1785263400.5', '-1', '']) {
      expect(rejectionIssues(WebhookTimestampHeaderSchema, value)).toHaveLength(1);
    }
  });

  it('publishes the five-minute replay window', () => {
    expect(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).toBe(300);
  });
});

describe('delivery retries (§10.9)', () => {
  it('publishes the backoff the plan states, in seconds', () => {
    expect([...WEBHOOK_RETRY_SCHEDULE_SECONDS]).toEqual([30, 120, 900, 3_600, 21_600, 86_400]);
  });

  it('is frozen, so no consumer can reschedule another tenant\'s deliveries', () => {
    expect(Object.isFrozen(WEBHOOK_RETRY_SCHEDULE_SECONDS)).toBe(true);
  });
});
