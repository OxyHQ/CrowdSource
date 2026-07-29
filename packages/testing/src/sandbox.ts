/**
 * An in-process CrowdSource, so an integration can be exercised end to end
 * before a jury exists.
 *
 * The path an application actually cares about is: deliver a report → get a
 * case → a decision is published → a signed webhook arrives → enforcement runs.
 * Today the middle of that does not exist anywhere — sortition, review and
 * consensus are not built, so nothing publishes a decision. Waiting for them
 * means an integrator cannot write, or test, the half of their code that
 * matters most: what they DO when a decision says `violation`.
 *
 * So this sandbox implements the two ends and lets the test drive the middle.
 * It accepts reports over a `fetch` the real `@oxyhq/crowdsource` client can be
 * pointed at — same transport, same idempotency, same 409, same tenant check —
 * and `decide()` publishes a decision the way consensus eventually will, which
 * `deliver()` then sends as a genuinely signed `case.decided`.
 *
 * **What it is and is not.** It is a faithful implementation of the RULES an
 * integrator's code depends on: `applicationId` from the credential, an
 * idempotency key that returns the same `reportId`, a 409 for a reused
 * `externalReportId` with a changed body, and §7.3's "two reports about the same
 * version of the same content are one case". It is NOT the service, it holds no
 * state between processes, and where it and the backend ever disagree the
 * backend is right. The deduplication projection below mirrors the backend's
 * `modules/evidence/contentSnapshot.ts`; that logic belongs in the contracts
 * package so both sides share one implementation, and until it moves this file
 * is the second copy — which is a thing to know rather than a thing to rely on.
 */

import { createHash, randomUUID } from 'node:crypto';

import {
  CreateReportRequestSchema,
  DecisionSchema,
  KnownWebhookEventSchema,
  PRINCIPAL_TARGETED_RELATION_TYPES,
  UNIVERSAL_TAXONOMY_VERSION,
  type CaseEnvelope,
  type Decision,
  type DecisionFinding,
  type DecisionOutcome,
  type DecisionRecommendedAction,
  type KnownWebhookEvent,
  type TaxonomyCode,
} from '@oxyhq/crowdsource-contracts';

import { WebhookSimulator, type WebhookDeliveryResult } from './webhook-simulator';

export interface SandboxReport {
  readonly reportId: string;
  readonly externalReportId: string;
  readonly caseId: string;
  readonly idempotencyKey: string;
  readonly envelope: CaseEnvelope;
  /** `merged` when this report joined a case another report had already opened. */
  readonly status: 'received' | 'merged';
  readonly receivedAt: string;
  /**
   * The fingerprint of what was delivered — the backend calls it `payloadHash`
   * and computes it over `{ externalReportId, envelope }`, deliberately without
   * the idempotency key, so the same content re-sent under a fresh key is
   * recognised as the same report rather than conflicting with it.
   */
  readonly payloadHash: string;
}

export interface SandboxCase {
  readonly caseId: string;
  readonly externalSubjectId: string;
  readonly dedupKey: string;
  readonly policy: CaseEnvelope['policy'];
  /** The union of what every merged report alleged (§6.2). */
  readonly allegationCodes: readonly TaxonomyCode[];
  readonly reportIds: readonly string[];
  readonly decisions: readonly Decision[];
}

export interface CrowdSourceSandboxOptions {
  readonly applicationId?: string;
  readonly organizationId?: string;
  readonly webhookSecret?: string;
  /** The origin the client believes it is calling. Never reached over a socket. */
  readonly baseUrl?: string;
}

export interface SandboxDecisionInput {
  readonly outcome?: DecisionOutcome;
  readonly status?: Decision['status'];
  readonly findings?: readonly DecisionFinding[];
  readonly recommendedActions?: readonly DecisionRecommendedAction[];
  readonly confidence?: number;
}

const DEFAULT_BASE_URL = 'https://sandbox.crowdsource.test';

function publicId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * §7.3's `contentEnvelopeHash`, over the same projection the backend hashes.
 *
 * The three normalisations that make two reporters agree, restated so a reader
 * does not have to open the backend to know what is excluded: order is removed
 * where it is not meaning, proof-of-delivery fields are dropped from principal
 * bindings, and nothing per-reporter is included at all — no
 * `externalReportId`, no `source`, no `allegations`, no reporter binding, no
 * `urgency`, no `metadata`.
 */
function contentHashOf(envelope: CaseEnvelope): string {
  const referencedPrincipals = new Set<string>();
  for (const resource of envelope.resources) {
    if (resource.authorPrincipalRef !== undefined) {
      referencedPrincipals.add(resource.authorPrincipalRef);
    }
    if (resource.type === 'listing' && resource.data.sellerRef !== undefined) {
      referencedPrincipals.add(resource.data.sellerRef);
    }
  }
  for (const relation of envelope.relations) {
    if (PRINCIPAL_TARGETED_RELATION_TYPES.some((type) => type === relation.type)) {
      referencedPrincipals.add(relation.to);
    }
  }

  const snapshot = {
    schemaVersion: envelope.schemaVersion,
    subject: envelope.subject,
    resources: [...envelope.resources].sort((left, right) => (left.id < right.id ? -1 : 1)),
    relations: [...envelope.relations].sort((left, right) =>
      `${left.from} ${left.type} ${left.to}` < `${right.from} ${right.type} ${right.to}` ? -1 : 1,
    ),
    principals: envelope.principalBindings
      .filter((binding) => referencedPrincipals.has(binding.principalRef))
      .sort((left, right) => (left.principalRef < right.principalRef ? -1 : 1))
      .map((binding) => ({
        principalRef: binding.principalRef,
        type: binding.type,
        externalPrincipalId: binding.externalPrincipalId,
      })),
  };

  return sha256Hex(JSON.stringify(snapshot));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

export class CrowdSourceSandbox {
  readonly applicationId: string;
  readonly organizationId: string;
  readonly baseUrl: string;
  readonly webhookSecret: string;
  /** The one opaque string an integration configures. */
  readonly serviceKey: string;

  private readonly bearerToken: string;
  private readonly reportsById = new Map<string, SandboxReport>();
  private readonly reportsByIdempotencyKey = new Map<string, SandboxReport>();
  private readonly reportsByExternalId = new Map<string, SandboxReport>();
  private readonly casesById = new Map<string, SandboxCase>();
  private readonly caseIdByDedupKey = new Map<string, string>();
  private readonly decisionsById = new Map<string, Decision>();

  constructor(options: CrowdSourceSandboxOptions = {}) {
    this.applicationId = options.applicationId ?? publicId('app');
    this.organizationId = options.organizationId ?? publicId('org');
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.webhookSecret = options.webhookSecret ?? randomUUID();

    const credentialId = publicId('csk');
    const secret = randomUUID().replace(/-/g, '');
    this.bearerToken = `${credentialId}.${secret}`;
    this.serviceKey = [this.applicationId, credentialId, secret].join(':');
  }

  get reports(): readonly SandboxReport[] {
    return [...this.reportsById.values()];
  }

  get cases(): readonly SandboxCase[] {
    return [...this.casesById.values()];
  }

  /** The `fetch` to hand `new CrowdSource({ fetch, serviceKey, baseUrl })`. */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);

    if (headers.get('authorization') !== `Bearer ${this.bearerToken}`) {
      return apiError(401, 'unauthorized', 'The service credential is missing or invalid.');
    }

    if (method === 'POST' && url.pathname === '/v1/reports') {
      return this.createReport(headers, init?.body);
    }
    if (method === 'GET' && url.pathname.startsWith('/v1/reports/')) {
      return this.readReport(decodeURIComponent(url.pathname.slice('/v1/reports/'.length)));
    }
    if (method === 'GET' && url.pathname.startsWith('/v1/cases/')) {
      return this.readCase(decodeURIComponent(url.pathname.slice('/v1/cases/'.length)));
    }
    if (method === 'GET' && url.pathname.startsWith('/v1/decisions/')) {
      return this.readDecision(decodeURIComponent(url.pathname.slice('/v1/decisions/'.length)));
    }

    /**
     * Everything else, including the upload routes, answers 404 — the same thing
     * the deployed backend does today. A sandbox that faked an endpoint the
     * service does not serve would let an integration pass its tests and fail on
     * its first real call.
     */
    return apiError(404, 'not_found', `The sandbox does not serve ${method} ${url.pathname}.`);
  };

  /**
   * Publishes a decision for a case, the way consensus eventually will.
   *
   * A published revision is immutable (Appendix F), so calling this twice
   * produces revision 2 superseding revision 1 rather than editing anything.
   */
  decide(caseId: string, input: SandboxDecisionInput = {}): Decision {
    const stored = this.casesById.get(caseId);
    if (!stored) throw new Error(`The sandbox holds no case '${caseId}'.`);

    const previous = stored.decisions.at(-1);
    const revision = (previous?.revision ?? 0) + 1;
    const outcome = input.outcome ?? 'violation';

    const decision = DecisionSchema.parse({
      id: publicId('dec'),
      caseId,
      revision,
      status: input.status ?? 'final',
      outcome,
      contextSufficiency: outcome === 'insufficient_context' ? 'insufficient' : 'sufficient',
      confidence: input.confidence ?? 1,
      findings:
        input.findings ??
        (outcome === 'violation'
          ? [
              {
                code: stored.allegationCodes[0] ?? 'other.unclassifiable',
                resourceIds: ['res_subject'],
                severity: 'medium',
                scope: 'application_local',
                attribution: 'author',
              },
            ]
          : []),
      recommendedActions:
        input.recommendedActions ??
        (outcome === 'violation' ? [{ action: 'remove_or_restrict' }] : [{ action: 'no_action' }]),
      jury: { size: 3, decisiveVotes: 3, winningVotes: 3, agreement: 1, specialistPresent: false },
      policyVersions: {
        taxonomy: UNIVERSAL_TAXONOMY_VERSION,
        application: stored.policy.version,
        oxyConduct: stored.policy.version,
      },
      ...(previous === undefined ? {} : { supersedesDecisionId: previous.id }),
      publishedAt: new Date().toISOString(),
    });

    this.decisionsById.set(decision.id, decision);
    this.casesById.set(caseId, { ...stored, decisions: [...stored.decisions, decision] });
    return decision;
  }

  /** The `case.decided` (or `decision.corrected`) event for a decision. */
  eventFor(decision: Decision): KnownWebhookEvent {
    return KnownWebhookEventSchema.parse({
      id: publicId('evt'),
      type: decision.revision === 1 ? 'case.decided' : 'decision.corrected',
      createdAt: new Date().toISOString(),
      organizationId: this.organizationId,
      applicationId: this.applicationId,
      data: { caseId: decision.caseId, decision },
    });
  }

  /** Signs and POSTs an event to the integration's webhook endpoint. */
  async deliver(url: string, event: unknown): Promise<WebhookDeliveryResult> {
    return await new WebhookSimulator({ secret: this.webhookSecret, url }).deliver(event);
  }

  private createReport(headers: Headers, body: BodyInit | null | undefined): Response {
    const idempotencyKey = headers.get('idempotency-key');
    if (idempotencyKey === null || idempotencyKey.length === 0) {
      return apiError(400, 'invalid_request', 'The Idempotency-Key header is required.');
    }
    if (typeof body !== 'string') {
      return apiError(400, 'invalid_request', 'The request body must be JSON.');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      return apiError(400, 'invalid_request', 'The request body must be JSON.');
    }

    const parsed = CreateReportRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return apiError(
        422,
        'unprocessable_envelope',
        `The envelope cannot be processed — ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const { externalReportId, envelope } = parsed.data;

    if (envelope.applicationId !== this.applicationId) {
      return apiError(
        403,
        'forbidden',
        'The envelope names a different applicationId than the credential it was delivered with.',
      );
    }

    const payloadHash = sha256Hex(JSON.stringify(parsed.data));

    /**
     * Appendix D, both halves. The same key with the same payload is the SAME
     * report and returns the same `reportId`; the same `externalReportId` with a
     * DIFFERENT payload is §10.5's 409 — the two cannot both be that report, and
     * no retry resolves it.
     */
    const byKey = this.reportsByIdempotencyKey.get(idempotencyKey);
    if (byKey !== undefined) {
      if (byKey.payloadHash !== payloadHash) {
        return apiError(
          409,
          'conflict',
          'This Idempotency-Key was already used with a different payload.',
        );
      }
      return this.receiptResponse(byKey);
    }

    const byExternalId = this.reportsByExternalId.get(externalReportId);
    if (byExternalId !== undefined) {
      if (byExternalId.payloadHash !== payloadHash) {
        return apiError(
          409,
          'conflict',
          `externalReportId '${externalReportId}' was already delivered with different content.`,
        );
      }
      return this.receiptResponse(byExternalId);
    }

    const dedupKey = sha256Hex(
      [
        this.applicationId,
        envelope.subject.externalId,
        contentHashOf(envelope),
        `${envelope.policy.policySetId}@${envelope.policy.version}`,
      ].join(':'),
    );

    const existingCaseId = this.caseIdByDedupKey.get(dedupKey);
    const merged = existingCaseId !== undefined;
    const caseId = existingCaseId ?? publicId('case');

    const report: SandboxReport = {
      reportId: publicId('rpt'),
      externalReportId,
      caseId,
      idempotencyKey,
      envelope,
      status: merged ? 'merged' : 'received',
      receivedAt: new Date().toISOString(),
      payloadHash,
    };

    this.reportsById.set(report.reportId, report);
    this.reportsByIdempotencyKey.set(idempotencyKey, report);
    this.reportsByExternalId.set(externalReportId, report);

    const existingCase = this.casesById.get(caseId);
    this.casesById.set(caseId, {
      caseId,
      externalSubjectId: envelope.subject.externalId,
      dedupKey,
      policy: envelope.policy,
      allegationCodes: [
        ...new Set([
          ...(existingCase?.allegationCodes ?? []),
          ...envelope.allegations.map((allegation) => allegation.code),
        ]),
      ],
      reportIds: [...(existingCase?.reportIds ?? []), report.reportId],
      decisions: existingCase?.decisions ?? [],
    });
    this.caseIdByDedupKey.set(dedupKey, caseId);

    return this.receiptResponse(report);
  }

  private receiptResponse(report: SandboxReport): Response {
    return jsonResponse(202, {
      reportId: report.reportId,
      caseId: report.caseId,
      status: report.status,
      merged: report.status === 'merged',
    });
  }

  private readReport(reportId: string): Response {
    const report = this.reportsById.get(reportId);
    if (!report) return apiError(404, 'not_found', 'No such report.');

    return jsonResponse(200, {
      reportId: report.reportId,
      externalReportId: report.externalReportId,
      caseId: report.caseId,
      status: report.status,
      receivedAt: report.receivedAt,
    });
  }

  private readCase(caseId: string): Response {
    const stored = this.casesById.get(caseId);
    if (!stored) return apiError(404, 'not_found', 'No such case.');

    return jsonResponse(200, {
      caseId: stored.caseId,
      status: stored.decisions.length > 0 ? 'decided' : 'awaiting_review',
      subject: { externalId: stored.externalSubjectId, type: 'social.post' },
      policy: stored.policy,
      taxonomyVersion: UNIVERSAL_TAXONOMY_VERSION,
      allegationCodes: stored.allegationCodes,
      reportCount: stored.reportIds.length,
      sensitivityClass: 'standard',
      currentRevision: stored.decisions.length,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  private readDecision(decisionId: string): Response {
    const decision = this.decisionsById.get(decisionId);
    if (!decision) return apiError(404, 'not_found', 'No such decision.');
    return jsonResponse(200, decision);
  }
}

export function createCrowdSourceSandbox(
  options: CrowdSourceSandboxOptions = {},
): CrowdSourceSandbox {
  return new CrowdSourceSandbox(options);
}
