/**
 * What goes on the wire, and what happens when the answer is a refusal.
 *
 * The distinction the tests below spend the most effort on is which failures an
 * integrator's outbox should retry. §7.1 makes the outbox the durable retry
 * path, so `retryable` is the contract between this client and that worker: get
 * 503 wrong and moderation work is dropped, get 409 wrong and a worker retries a
 * payload conflict until somebody notices the queue.
 */

import { describe, expect, it, vi } from 'vitest';

import { CrowdSource } from '../client.js';
import { formatServiceKey } from '../credential.js';
import { CrowdSourceApiError, CrowdSourceTransportError } from '../errors.js';
import type { ReportInput } from '../envelope.js';

const SERVICE_KEY = formatServiceKey({
  applicationId: 'app_0123456789abcdef0123456789abcdef',
  credentialId: 'csk_fedcba9876543210fedcba9876543210',
  secret: 'secret-value',
});

const REPORT: ReportInput = {
  externalReportId: 'report_1',
  subject: { externalId: 'post_1', type: 'social.post', author: { oxyUserId: 'oxy_author' } },
  content: 'reported text',
  allegations: ['integrity.spam'],
  reportedBy: { oxyUserId: 'oxy_reporter' },
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function stubTransport(responses: readonly Response[]): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const rawBody = init?.body;
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : rawBody,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('The stub was called more times than it has answers.');
    return next;
  };

  return { fetch: fetchImpl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ACCEPTED = { reportId: 'rpt_1', caseId: 'case_1', status: 'received', merged: false };

function client(fetchImpl: typeof globalThis.fetch, options: { maxAttempts?: number } = {}) {
  return new CrowdSource({
    serviceKey: SERVICE_KEY,
    baseUrl: 'https://api.crowdsource.test',
    fetch: fetchImpl,
    maxAttempts: options.maxAttempts ?? 3,
  });
}

describe('reports.create', () => {
  it('sends the bearer token, an idempotency key and the composed envelope', async () => {
    const { fetch, calls } = stubTransport([json(202, ACCEPTED)]);

    const result = await client(fetch).reports.create(REPORT);

    expect(result).toEqual(ACCEPTED);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.crowdsource.test/v1/reports');
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('authorization')).toBe(
      'Bearer csk_fedcba9876543210fedcba9876543210.secret-value',
    );
    expect(call?.headers.get('idempotency-key')).toBe('report.report_1');
    expect(call?.body).toMatchObject({
      externalReportId: 'report_1',
      envelope: { applicationId: 'app_0123456789abcdef0123456789abcdef' },
    });
  });

  it('carries the caller’s idempotency key when one is given', async () => {
    const { fetch, calls } = stubTransport([json(202, ACCEPTED)]);

    await client(fetch).reports.create({ ...REPORT, idempotencyKey: 'outbox-row-42' });

    expect(calls[0]?.headers.get('idempotency-key')).toBe('outbox-row-42');
  });

  /**
   * §10.5's 409: the same `externalReportId` with a different body. The one 4xx
   * an outbox must STOP on — no number of retries turns two payloads into one
   * report.
   */
  it('surfaces a payload conflict as terminal, not as something to retry', async () => {
    const { fetch, calls } = stubTransport([
      json(409, {
        error: { code: 'conflict', message: 'externalReportId was delivered with another body.' },
      }),
    ]);

    const failure = await client(fetch)
      .reports.create(REPORT)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CrowdSourceApiError);
    const conflict = failure as CrowdSourceApiError;
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe('conflict');
    expect(conflict.isPayloadConflict).toBe(true);
    expect(conflict.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('retries a 503 and returns the eventual acceptance', async () => {
    const { fetch, calls } = stubTransport([
      json(503, { error: { code: 'service_unavailable', message: 'try again' } }, {
        'retry-after': '0',
      }),
      json(202, ACCEPTED),
    ]);

    const result = await client(fetch).reports.create(REPORT);

    expect(result).toEqual(ACCEPTED);
    expect(calls).toHaveLength(2);
    // The retry is safe only because both attempts carry the same key.
    expect(calls[0]?.headers.get('idempotency-key')).toBe(calls[1]?.headers.get('idempotency-key'));
  });

  it('gives up after the configured attempts but still says the work is retryable', async () => {
    const { fetch, calls } = stubTransport([
      json(503, { error: { code: 'service_unavailable', message: 'down' } }, { 'retry-after': '0' }),
      json(503, { error: { code: 'service_unavailable', message: 'down' } }, { 'retry-after': '0' }),
    ]);

    const failure = await client(fetch, { maxAttempts: 2 })
      .reports.create(REPORT)
      .catch((error: unknown) => error);

    expect(calls).toHaveLength(2);
    expect((failure as CrowdSourceApiError).retryable).toBe(true);
  });

  it.each([
    ['a rejected envelope', 422, 'unprocessable_envelope'],
    ['a missing scope', 403, 'forbidden'],
    ['a revoked credential', 401, 'unauthorized'],
  ])('does not retry %s', async (_name, status, code) => {
    const { fetch, calls } = stubTransport([json(status, { error: { code, message: 'no' } })]);

    const failure = await client(fetch)
      .reports.create(REPORT)
      .catch((error: unknown) => error);

    expect(calls).toHaveLength(1);
    expect((failure as CrowdSourceApiError).retryable).toBe(false);
    expect((failure as CrowdSourceApiError).code).toBe(code);
  });

  it('derives a code from the status when a proxy answers instead of the service', async () => {
    const { fetch } = stubTransport([new Response('<html>502</html>', { status: 502 })]);

    const failure = await client(fetch, { maxAttempts: 1 })
      .reports.create(REPORT)
      .catch((error: unknown) => error);

    expect((failure as CrowdSourceApiError).code).toBe('internal_error');
    expect((failure as CrowdSourceApiError).retryable).toBe(true);
  });

  it('treats a connection failure as retryable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const failure = await client(fetchImpl as unknown as typeof globalThis.fetch, {
      maxAttempts: 1,
    })
      .reports.create(REPORT)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CrowdSourceTransportError);
    expect((failure as CrowdSourceTransportError).retryable).toBe(true);
  });

  it('never sends a report the contract would reject', async () => {
    const { fetch, calls } = stubTransport([json(202, ACCEPTED)]);

    await expect(
      client(fetch).reports.create({ ...REPORT, allegations: [] }),
    ).rejects.toThrow(/allegations/);
    expect(calls).toHaveLength(0);
  });
});

describe('read paths', () => {
  it('reads a report receipt', async () => {
    const { fetch, calls } = stubTransport([
      json(200, {
        reportId: 'rpt_1',
        externalReportId: 'report_1',
        caseId: 'case_1',
        status: 'received',
        receivedAt: '2026-07-29T10:00:00.000Z',
      }),
    ]);

    const receipt = await client(fetch).reports.get('rpt_1');

    expect(calls[0]?.url).toBe('https://api.crowdsource.test/v1/reports/rpt_1');
    expect(calls[0]?.headers.get('idempotency-key')).toBeNull();
    expect(receipt.caseId).toBe('case_1');
  });

  it('reads a case without breaking on a field it has never seen', async () => {
    const { fetch } = stubTransport([
      json(200, {
        caseId: 'case_1',
        status: 'awaiting_review',
        subject: { externalId: 'post_1', type: 'social.post' },
        policy: { policySetId: 'crowdsource.baseline', version: '2026.07' },
        taxonomyVersion: '2026.1',
        allegationCodes: ['integrity.spam'],
        reportCount: 2,
        sensitivityClass: 'standard',
        currentRevision: 0,
        createdAt: '2026-07-29T10:00:00.000Z',
        updatedAt: '2026-07-29T10:05:00.000Z',
        somethingAddedLater: { nested: true },
      }),
    ]);

    const view = await client(fetch).cases.get('case_1');

    expect(view.reportCount).toBe(2);
    expect(view.status).toBe('awaiting_review');
  });

  it('reports a decision body it cannot recognise rather than returning a half-parsed one', async () => {
    const { fetch } = stubTransport([json(200, { id: 'dec_1' })]);

    await expect(client(fetch).decisions.get('dec_1')).rejects.toThrow(
      CrowdSourceTransportError,
    );
  });
});
