import {
  REVIEW_HISTORY_PAGE_SIZE_DEFAULT,
  taxonomyFamilyOf,
  type DecisionOutcome,
  type ReviewHistoryEntry,
  type ReviewHistoryPage,
  type ReviewHistoryQuery,
  type TaxonomyCode,
  type TaxonomyFamily,
} from '@oxyhq/crowdsource-contracts';

import { createTenantContext, type TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { cases, type CaseDocument } from '../cases/case.collection';
import { decisions } from '../decision/decision.collection';
import { reviews, type ReviewDocument } from './review.collection';

/**
 * §4.1's "Historial" — a reviewer's own completed reviews.
 *
 * ## Why this endpoint exists when §10.3 does not list it
 *
 * §4.1 requires the screen: "shows completed reviews, learning state, and results
 * that may already be revealed". §10.3's reviewer route table has seven endpoints
 * and none of them can answer it. That is a gap in the plan rather than a decision
 * in it, so this is the route the screen was always going to need, shaped the way
 * every other reviewer route is shaped: addressed by the authenticated reviewer,
 * never by a case id, with no filter a caller could use to look for a particular
 * case.
 *
 * ## What may be revealed, and what may not
 *
 * `outcome` is the reviewer's OWN conclusion. They wrote it; showing it back is
 * not disclosure.
 *
 * `decision` is populated only when a decision has been PUBLISHED for the exact
 * revision this reviewer judged, and it carries the outcome and the instant and
 * nothing else. §9.1 forbids "previous votes or partial results" — so there is no
 * agreement ratio here, no jury size, no vote count and no list of findings. An
 * agreement ratio IS a tally, which is why it has no field on the contract rather
 * than merely being left unset.
 *
 * A `superseded` decision is still shown. It is what was decided on the revision
 * this person judged, and hiding it after an appeal would tell them less than they
 * already knew when they voted.
 *
 * ## The reads are tenant-scoped from the REVIEW, never from the request
 *
 * A reviewer's session carries no tenant — a reviewer belongs to no application.
 * Each review row was stamped with its case's tenant inside the draw's
 * transaction, and that stamp is what the case and decision reads are scoped by.
 * There is no path by which a caller influences which tenant is read, which is the
 * same property `assignments.routes.ts` relies on.
 */

/**
 * The page cursor: the last entry's instant and id, joined.
 *
 * Not an offset. A reviewer who submits a review between two page requests would
 * shift every offset by one and silently skip an entry — in a list whose purpose
 * is for somebody to check their own record.
 *
 * The id is in the cursor as well as the instant because two reviews can land in
 * the same millisecond and a cursor on time alone would either repeat one or lose
 * one. Ids here are `randomUUID`-derived and carry no order of their own, so they
 * cannot be the whole key either; together they are a total order.
 */
const CURSOR_SEPARATOR = '.';

function encodeCursor(entry: ReviewDocument): string {
  return `${entry.submittedAt.getTime()}${CURSOR_SEPARATOR}${entry.reviewId}`;
}

interface DecodedCursor {
  readonly submittedAt: Date;
  readonly reviewId: string;
}

/**
 * Decodes a cursor, or refuses.
 *
 * A malformed cursor is a `400` rather than a silent restart from the beginning:
 * silently ignoring it would show page one where page three was asked for, and
 * a client bug would look like a server that forgets.
 */
function decodeCursor(cursor: string): DecodedCursor {
  const separator = cursor.indexOf(CURSOR_SEPARATOR);
  const millis = Number(cursor.slice(0, separator));
  const reviewId = cursor.slice(separator + 1);

  if (separator <= 0 || !Number.isSafeInteger(millis) || reviewId.length === 0) {
    throw new ApiError('invalid_request', 'That cursor is not one this endpoint issued.');
  }
  return { submittedAt: new Date(millis), reviewId };
}

/** The tenant each review was stamped with, deduplicated. */
function tenantsOf(rows: readonly ReviewDocument[]): TenantContext[] {
  const seen = new Map<string, TenantContext>();
  for (const row of rows) {
    seen.set(
      `${row.organizationId}/${row.applicationId}`,
      createTenantContext(row.organizationId, row.applicationId),
    );
  }
  return [...seen.values()];
}

/**
 * The cases behind one page, in one query per tenant.
 *
 * Never one query per row. A page is bounded, but a per-row read turns a screen
 * somebody opens routinely into twenty round trips, and the batching is free: the
 * rows are already grouped by the tenant they must be read under.
 */
async function casesFor(rows: readonly ReviewDocument[]): Promise<Map<string, CaseDocument>> {
  const byId = new Map<string, CaseDocument>();
  for (const tenant of tenantsOf(rows)) {
    const caseIds = rows
      .filter(
        (row) =>
          row.organizationId === tenant.organizationId &&
          row.applicationId === tenant.applicationId,
      )
      .map((row) => row.caseId);
    for (const stored of await cases.find(tenant, { caseId: { $in: caseIds } })) {
      byId.set(stored.caseId, stored);
    }
  }
  return byId;
}

/** The published decision for each (case, revision) a reviewer judged. */
async function decisionsFor(
  rows: readonly ReviewDocument[],
): Promise<Map<string, { outcome: DecisionOutcome; publishedAt: Date }>> {
  const byKey = new Map<string, { outcome: DecisionOutcome; publishedAt: Date }>();
  for (const tenant of tenantsOf(rows)) {
    const caseIds = rows
      .filter(
        (row) =>
          row.organizationId === tenant.organizationId &&
          row.applicationId === tenant.applicationId,
      )
      .map((row) => row.caseId);
    for (const decision of await decisions.find(tenant, { caseId: { $in: caseIds } })) {
      byKey.set(`${decision.caseId}@${decision.revision}`, {
        outcome: decision.outcome,
        publishedAt: decision.publishedAt,
      });
    }
  }
  return byKey;
}

/**
 * The families a reviewer was asked about, from the case they were shown.
 *
 * Taken from the case's allegations rather than from the reviewer's own findings,
 * because a `no_violation` review has no findings and would otherwise appear in
 * the history with no indication of what it was about.
 */
function familiesOf(stored: CaseDocument | undefined): TaxonomyFamily[] {
  if (!stored) return [];
  return [...new Set(stored.allegationCodes.map((code) => taxonomyFamilyOf(code as TaxonomyCode)))];
}

function languageOf(stored: CaseDocument | undefined): string | null {
  if (!stored) return null;
  const primary = stored.contentSnapshot.resources.find(
    (resource) => resource.id === stored.primaryResourceId,
  );
  return (
    primary?.language ??
    stored.contentSnapshot.resources.find((resource) => resource.language !== undefined)?.language ??
    null
  );
}

export async function reviewHistoryPage(
  reviewerId: string,
  query: ReviewHistoryQuery,
): Promise<ReviewHistoryPage> {
  const limit = query.limit ?? REVIEW_HISTORY_PAGE_SIZE_DEFAULT;
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);

  /**
   * One row more than the page, which is how "is there a next page" is answered
   * without a second count query — and a count would be a different question
   * anyway, since rows can land between the two.
   */
  const rows = await reviews.find(
    {
      reviewerId,
      ...(after === null
        ? {}
        : {
            $or: [
              { submittedAt: { $lt: after.submittedAt } },
              { submittedAt: after.submittedAt, reviewId: { $lt: after.reviewId } },
            ],
          }),
    },
    { sort: { submittedAt: -1, reviewId: -1 }, limit: limit + 1 },
  );

  const page = rows.slice(0, limit);
  const storedCases = await casesFor(page);
  const published = await decisionsFor(page);

  const entries: ReviewHistoryEntry[] = page.map((row) => {
    const stored = storedCases.get(row.caseId);
    const decision = published.get(`${row.caseId}@${row.caseRevision}`);
    return {
      reviewId: row.reviewId,
      submittedAt: row.submittedAt.toISOString(),
      families: familiesOf(stored),
      language: languageOf(stored),
      outcome: row.outcome,
      decision:
        decision === undefined
          ? null
          : {
              outcome: decision.outcome,
              publishedAt: decision.publishedAt.toISOString(),
            },
    };
  });

  const last = page[page.length - 1];
  return {
    entries,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
  };
}
