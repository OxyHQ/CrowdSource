/**
 * `POST /v1/reports` and `GET /v1/reports/{id}` (§10.2, §10.4).
 *
 * The 202 this returns means what §7.1 says it means: the report is stored and
 * durable rows exist for everything that happens next. It does not mean a jury
 * exists, a decision exists, or that any downstream call succeeded — and an
 * application that treats it as "moderation is done" has misread the contract.
 * The decision comes back later, over a webhook.
 */

import {
  CreateReportResponseSchema,
  type CreateReportResponse,
  type ReportStatus,
} from '@oxyhq/crowdsource-contracts';
import { z } from 'zod';

import { composeCaseEnvelope, defaultIdempotencyKey, type ReportInput } from './envelope.js';
import { CrowdSourceTransportError } from './errors.js';
import type { Transport } from './transport.js';

/**
 * `GET /v1/reports/{id}` (§10.2 "receipt, caseId and limited status").
 *
 * Declared here because `@oxyhq/crowdsource-contracts` publishes the DOCUMENTS
 * that travel over the API and not every HTTP response shape. The receipt and
 * the case view below both belong in contracts; until they move, these are the
 * types integrators compile against and the loose parse is what keeps a newer
 * server from breaking an older client (§10.11).
 */
export interface ReportReceipt {
  readonly reportId: string;
  readonly externalReportId: string;
  readonly caseId: string;
  /**
   * §3.2's report states, kept open. §10.11 requires a newer server not to break
   * an older client, and a state added to §3.2 is exactly that case: the union
   * still autocompletes the four this version knows and still type-checks the
   * fifth when it arrives.
   */
  readonly status: ReportStatus | (string & {});
  /** ISO-8601 UTC, as the API sends it. */
  readonly receivedAt: string;
}

const ReportReceiptSchema = z.looseObject({
  reportId: z.string(),
  externalReportId: z.string(),
  caseId: z.string(),
  status: z.string(),
  receivedAt: z.string(),
});

export interface ReportRequestOptions {
  readonly signal?: AbortSignal;
}

export class Reports {
  private readonly transport: Transport;
  private readonly applicationId: string;
  private readonly environment: 'production' | 'sandbox';

  constructor(input: {
    transport: Transport;
    applicationId: string;
    environment: 'production' | 'sandbox';
  }) {
    this.transport = input.transport;
    this.applicationId = input.applicationId;
    this.environment = input.environment;
  }

  /**
   * Delivers a report.
   *
   * Call this from a delivery worker draining the application's own outbox, not
   * from the request handler that answered the user (§7.1). The user is told
   * their report was received the moment it is stored locally; this call is what
   * eventually makes it CrowdSource's problem, and it is allowed to fail and be
   * retried without the user ever knowing.
   *
   * Re-delivering the same report is safe and returns the same `reportId`. What
   * is NOT safe is re-delivering the same `externalReportId` with a CHANGED
   * body: §10.5 answers 409 and this client surfaces it as
   * `CrowdSourceApiError` with `isPayloadConflict` and `retryable: false`,
   * because no number of retries makes two different payloads one report.
   */
  async create(
    input: ReportInput,
    options: ReportRequestOptions = {},
  ): Promise<CreateReportResponse> {
    const envelope = composeCaseEnvelope(input, {
      applicationId: this.applicationId,
      environment: this.environment,
    });

    const response = await this.transport.request<unknown>({
      method: 'POST',
      path: '/v1/reports',
      body: { externalReportId: input.externalReportId, envelope },
      idempotencyKey: input.idempotencyKey ?? defaultIdempotencyKey(input.externalReportId),
      signal: options.signal,
    });

    const parsed = CreateReportResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new CrowdSourceTransportError(
        'CrowdSource accepted the report but answered with a body this client does not recognise.',
        { retryable: false, cause: parsed.error },
      );
    }
    return parsed.data;
  }

  /** Reads back the receipt for a report this application delivered. */
  async get(reportId: string, options: ReportRequestOptions = {}): Promise<ReportReceipt> {
    const response = await this.transport.request<unknown>({
      method: 'GET',
      path: `/v1/reports/${encodeURIComponent(reportId)}`,
      signal: options.signal,
    });

    const parsed = ReportReceiptSchema.safeParse(response);
    if (!parsed.success) {
      throw new CrowdSourceTransportError(
        'CrowdSource answered with a report receipt this client does not recognise.',
        { retryable: false, cause: parsed.error },
      );
    }
    return parsed.data;
  }
}
