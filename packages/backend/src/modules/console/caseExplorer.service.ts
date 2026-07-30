import type { Decision } from '@oxyhq/crowdsource-contracts';

import type { TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { caseReports, cases, type CaseDocument } from '../cases/case.collection';
import { currentDecision, decisionHistory, decisionView } from '../decision/decision.service';

/**
 * The tenant's case and decision explorer (§4.2: "explorador de casos y decisiones
 * dentro del tenant").
 *
 * ## What a developer may see, and why each omission is deliberate
 *
 * This module is the answer to the question "what does a developer's own case
 * detail actually contain?", and it is written down here rather than decided per
 * route because the omissions are the design. The reference is §11's privacy model
 * and the projection `case.service.ts` already established for the application API;
 * this is a superset of that one along exactly two axes — resource METADATA and the
 * decision HISTORY — and neither adds a category of information the tenant did not
 * already hold or could not already reach by id.
 *
 * **Never returned, at any role, to any tenant:**
 *
 *  - **Any reviewer identity.** Not a reviewer id, not an Oxy user id, not a count
 *    of who sat. `decisionView` drops `agreeingReviewerIds`, assignments are never
 *    read here, and `reviews` is not imported by this module at all. A console that
 *    named a juror would be worse than a leak — it would be a retaliation surface.
 *  - **Any individual vote.** Aggregate jury figures ride along inside
 *    `decisionView` (size, decisive votes, winning votes, agreement) because the
 *    application API already publishes them and §10.7's webhook envelope carries
 *    the same shape; a per-juror record has no path to this module.
 *  - **`reporterFingerprints`.** They exist to be counted and nothing else. The digest is
 *    domain-separated rather than keyed — the inputs are the application's own id and its
 *    own external principal id, both of which it knows — so an application handed the
 *    fingerprints could recompute them against its user table and de-anonymise its own
 *    reporters, which is precisely §11's "no puede ver identidades de denunciantes". Not
 *    even a distinct count is returned: `reportCount` is what the tenant gets.
 *  - **`contentSnapshot`'s payload.** Resource `data` never leaves. The application
 *    already holds its own material; this API is not a route back to it, and a
 *    console that rendered reported content would become a second, longer-lived
 *    copy of the most sensitive data in the system, with its own screenshot risk
 *    (§13.8) and no retention story of its own. Metadata and the digest are what a
 *    developer needs to reconcile a case against their own record.
 *  - **`priorityScore` and `reviewPool`.** Priority is an internal queue position an
 *    application could game by learning which signals move it; the pool would tell
 *    a tenant which of its cases went to specialists. Both are withheld by
 *    `case.service.ts` for the same reasons and stay withheld here.
 *  - **`incidentId`.** Cross-application correlation, set only by a privileged path.
 *    Returning it would tell one tenant that its case is linked to another's.
 */

/** One row of the case list. */
export interface CaseListEntry {
  readonly caseId: string;
  readonly status: CaseDocument['status'];
  readonly subject: { readonly externalId: string; readonly type: string };
  readonly policyVersion: string;
  readonly allegationCodes: readonly string[];
  readonly reportCount: number;
  readonly sensitivityClass: CaseDocument['sensitivityClass'];
  readonly currentRevision: number;
  readonly decidedRevision: number;
  /** The outcome in force, or null before a decision is published. */
  readonly outcome: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CaseListPage {
  readonly cases: readonly CaseListEntry[];
  readonly nextCursor: string | null;
}

/** Resource metadata, with the payload removed. */
export interface CaseResourceMetadata {
  readonly id: string;
  readonly type: string;
  readonly role: string;
  readonly language: string | null;
  readonly sha256: string | null;
}

export interface CaseReportEntry {
  readonly reportId: string;
  readonly externalReportId: string;
  readonly allegationCodes: readonly string[];
  readonly merged: boolean;
  readonly linkedAt: string;
}

export interface CaseDetail {
  readonly caseId: string;
  readonly status: CaseDocument['status'];
  readonly subject: {
    readonly externalId: string;
    readonly type: string;
    readonly primaryResourceId: string;
  };
  readonly policy: { readonly policySetId: string; readonly version: string };
  readonly taxonomyVersion: string;
  readonly allegationCodes: readonly string[];
  readonly reportCount: number;
  readonly sensitivityClass: CaseDocument['sensitivityClass'];
  readonly currentRevision: number;
  readonly resources: readonly CaseResourceMetadata[];
  readonly reports: readonly CaseReportEntry[];
  /** §9.9's "historial completo", oldest revision first. */
  readonly decisions: readonly Decision[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** How many cases one page returns. */
const PAGE_SIZE = 50;

/**
 * The list cursor: the sort key of the last row returned, opaque to the caller.
 *
 * Opaque because it is a promise about ordering and not about storage — encoding it
 * as a plain case id would let a caller pass any id at all and have the query treat
 * it as a position. Decoding is total: an unparseable cursor is a 400, never a
 * silent restart from the top, because a silently-restarting cursor makes a paging
 * client loop over the first page forever.
 */
interface PageCursor {
  readonly createdAt: Date;
  readonly caseId: string;
}

function encodeCursor(entry: PageCursor): string {
  return Buffer.from(`${entry.createdAt.toISOString()}|${entry.caseId}`, 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(raw: string): PageCursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  const createdAt = new Date(decoded.slice(0, separator));
  const caseId = decoded.slice(separator + 1);

  if (separator < 0 || Number.isNaN(createdAt.getTime()) || caseId === '') {
    throw new ApiError('invalid_request', 'The cursor is not one this endpoint issued.');
  }
  return { createdAt, caseId };
}

export interface CaseListQuery {
  readonly status?: CaseDocument['status'];
  readonly cursor?: string;
}

/**
 * One page of this tenant's cases, newest first.
 *
 * The tenant comes from `context`, which came from a membership check against the
 * stored application row. There is no filter a caller can supply that widens it:
 * `tenantScopedFilter` throws on a tenant key, so a `status` that tried to carry one
 * fails loudly rather than returning another tenant's queue.
 *
 * A keyset cursor rather than an offset. An offset re-reads the rows it skips, so a
 * tenant paging through a hundred thousand cases gets slower with every page and a
 * case created mid-paging shifts every subsequent page by one — which shows up as a
 * case the operator never saw.
 */
export async function listCases(
  context: TenantContext,
  query: CaseListQuery = {},
): Promise<CaseListPage> {
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);

  const rows = await cases.find(
    context,
    {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(cursor === null
        ? {}
        : {
            $or: [
              { createdAt: { $lt: cursor.createdAt } },
              // The tie-break. Two cases created in the same millisecond are
              // ordinary under load, and without this one of them is skipped and
              // the other repeated forever.
              { createdAt: cursor.createdAt, caseId: { $lt: cursor.caseId } },
            ],
          }),
    },
    { sort: { createdAt: -1, caseId: -1 }, limit: PAGE_SIZE + 1 },
  );

  // One row over the page size, so "is there more" is a fact rather than a guess
  // from a full page — which would hand the caller an empty final page.
  const page = rows.slice(0, PAGE_SIZE);
  const last: CaseDocument | undefined = page[page.length - 1];

  const entries: CaseListEntry[] = [];
  for (const stored of page) {
    const decided = await currentDecision(context, stored.caseId);
    entries.push({
      caseId: stored.caseId,
      status: stored.status,
      subject: { externalId: stored.externalSubjectId, type: stored.subjectType },
      policyVersion: stored.policyVersion,
      allegationCodes: stored.allegationCodes,
      reportCount: stored.reportCount,
      sensitivityClass: stored.sensitivityClass,
      currentRevision: stored.currentRevision,
      decidedRevision: stored.decidedRevision,
      outcome: decided?.outcome ?? null,
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
    });
  }

  return {
    cases: entries,
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? encodeCursor({ createdAt: last.createdAt, caseId: last.caseId })
        : null,
  };
}

/**
 * Resource metadata for one case, with the payload stripped.
 *
 * An explicit field list and not a delete of `data`: a snapshot resource is a
 * discriminated union whose payload field differs by type, and a blocklist has to
 * be updated every time the contract gains a resource kind — silently, with the new
 * payload shipping to the console until somebody notices. A whitelist ships nothing
 * new by default, which is the direction a privacy projection has to fail in.
 */
function resourceMetadata(stored: CaseDocument): CaseResourceMetadata[] {
  return stored.contentSnapshot.resources.map((resource) => ({
    id: resource.id,
    type: resource.type,
    role: resource.role,
    language: resource.language ?? null,
    sha256: resource.sha256 ?? null,
  }));
}

/** One case in full, for the tenant that owns it. */
export async function findCaseDetail(
  context: TenantContext,
  caseId: string,
): Promise<CaseDetail | null> {
  const stored = await cases.findOne(context, { caseId });
  if (!stored) return null;

  const [links, history] = await Promise.all([
    caseReports.find(context, { caseId }, { sort: { linkedAt: 1 }, limit: 500 }),
    decisionHistory(context, caseId),
  ]);

  return {
    caseId: stored.caseId,
    status: stored.status,
    subject: {
      externalId: stored.externalSubjectId,
      type: stored.subjectType,
      primaryResourceId: stored.primaryResourceId,
    },
    policy: { policySetId: stored.policySetId, version: stored.policyVersion },
    taxonomyVersion: stored.taxonomyVersion,
    allegationCodes: stored.allegationCodes,
    reportCount: stored.reportCount,
    sensitivityClass: stored.sensitivityClass,
    currentRevision: stored.currentRevision,
    resources: resourceMetadata(stored),
    reports: links.map((link) => ({
      reportId: link.reportId,
      externalReportId: link.externalReportId,
      allegationCodes: link.allegationCodes,
      merged: link.merged,
      linkedAt: link.linkedAt.toISOString(),
    })),
    // `decisionView` is the one authority on what a decision looks like outside
    // this service, and it is what drops `agreeingReviewerIds`. Re-projecting here
    // would be a second definition, and the day the two disagree the console is
    // the one showing more.
    decisions: history.map(decisionView),
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
  };
}
