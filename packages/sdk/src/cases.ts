/**
 * `GET /v1/cases/{id}` and `GET /v1/decisions/{id}` (§10.2).
 *
 * Both are look-ups by an id CrowdSource gave the application. There is no case
 * search and there will not be one: "nobody chooses the case they review" is an
 * invariant, and a list endpoint on the application API would be the first step
 * towards a queue somebody browses.
 *
 * `decisions.get` is written against the route §10.2 defines. **The backend does
 * not serve it yet** — nothing publishes decisions, because sortition, review
 * and consensus are not built — so it answers 404 today. It is here because a
 * client of a documented endpoint is not a stub, and because the webhook path
 * (`case.decided`) is how an application learns about a decision anyway; this is
 * the read-back for one it already has an id for.
 */

import { DecisionSchema, type Decision, type TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import { z } from 'zod';

import { CrowdSourceTransportError } from './errors.js';
import type { Transport } from './transport.js';

/**
 * The projection §10.2 returns for a case.
 *
 * Deliberately not the case document. Priority score, review pool and reporter
 * fingerprints never leave the service — an application that could read its own
 * cases' priority could learn which signals move it.
 */
export interface CaseView {
  readonly caseId: string;
  readonly status: string;
  readonly subject: { readonly externalId: string; readonly type: string };
  readonly policy: { readonly policySetId: string; readonly version: string };
  readonly taxonomyVersion: string;
  readonly allegationCodes: readonly (TaxonomyCode | (string & {}))[];
  /** How many reports merged into this case. §7.3: many reports, one case. */
  readonly reportCount: number;
  readonly sensitivityClass: string;
  readonly currentRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const CaseViewSchema = z.looseObject({
  caseId: z.string(),
  status: z.string(),
  subject: z.looseObject({ externalId: z.string(), type: z.string() }),
  policy: z.looseObject({ policySetId: z.string(), version: z.string() }),
  taxonomyVersion: z.string(),
  allegationCodes: z.array(z.string()),
  reportCount: z.number(),
  sensitivityClass: z.string(),
  currentRevision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface ReadOptions {
  readonly signal?: AbortSignal;
}

export class Cases {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async get(caseId: string, options: ReadOptions = {}): Promise<CaseView> {
    const response = await this.transport.request<unknown>({
      method: 'GET',
      path: `/v1/cases/${encodeURIComponent(caseId)}`,
      signal: options.signal,
    });

    const parsed = CaseViewSchema.safeParse(response);
    if (!parsed.success) {
      throw new CrowdSourceTransportError(
        'CrowdSource answered with a case this client does not recognise.',
        { retryable: false, cause: parsed.error },
      );
    }
    return parsed.data;
  }
}

export class Decisions {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Reads one immutable revision of a decision.
   *
   * A published revision is never edited (Appendix F); a later revision
   * supersedes it and carries `supersedesDecisionId`. So a decision read twice
   * is byte-identical, and an application that cached one never needs to
   * invalidate it — it needs to notice a `decision.corrected` webhook.
   */
  async get(decisionId: string, options: ReadOptions = {}): Promise<Decision> {
    const response = await this.transport.request<unknown>({
      method: 'GET',
      path: `/v1/decisions/${encodeURIComponent(decisionId)}`,
      signal: options.signal,
    });

    const parsed = DecisionSchema.safeParse(response);
    if (!parsed.success) {
      throw new CrowdSourceTransportError(
        'CrowdSource answered with a decision this client does not recognise.',
        { retryable: false, cause: parsed.error },
      );
    }
    return parsed.data;
  }
}
