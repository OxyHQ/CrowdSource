import { asc, desc, eq, or, sql } from 'drizzle-orm';
import { DECISION_OUTCOMES, type DecisionOutcome } from '@oxyhq/crowdsource-contracts';

import { getPostgresDatabase } from '../../db/postgres/database';
import {
  applications as applicationRows,
  cases as caseRows,
  decisions as decisionRows,
  reviews as reviewRows,
} from '../../db/postgres/schema';
import { withTenant } from '../../db/postgres/withTenant';
import { CASE_STATUSES, type CaseStatus } from '../cases/case.collection';
import type { SensitivityClass, ReviewPool } from '../triage/triage';

/**
 * The privileged cross-tenant reads (§4.3, §12.9).
 *
 * Trust & Safety is DEFINED as the audience that sees across tenants — specialist
 * queues, escalated cases, cross-application patterns — so the question is not whether
 * this should exist but how to express it so it cannot rot into a hole. Three rules,
 * and each closes a different failure:
 *
 *  1. **Named queries, never a filter parameter.** There is no `findAcrossTenants(f)`
 *     here, deliberately. A general method controls WHO may call it — the allowlist does
 *     that — but not WHAT they may ask, and the second half is where this goes wrong: a
 *     new cross-tenant read would become a new filter passed to an already-sanctioned
 *     call, invisible in a diff. Every future one has to be a reviewed addition to this
 *     file.
 *  2. **The projection is baked in, not the caller's job.** A cross-tenant read of
 *     `cases` is a PRIVACY boundary and not only a tenancy one: case documents carry
 *     reported material, reporter fingerprints and triage internals. Returning whole
 *     documents and trusting each caller to project is exactly the discipline that fails
 *     quietly, so the allowed fields are declared as DATA below and asserted by tests.
 *  3. **Metrics return scalars.** An aggregate that never returns a document cannot leak
 *     one, and it is far cheaper to keep honest than a projected read.
 *
 * This file does not bypass RLS. It enumerates the unscoped tenant-defining
 * application rows, enters each application through `withTenant`, and combines
 * only the fixed projections/scalars here. `crossTenantReads.test.ts` pins which
 * modules may import it and the fields those projections may expose.
 */

/**
 * Fields the escalated queue may return. §4.3's triage view: what kind of case it is and
 * where it went, never what it contains or who is involved.
 */
export const ESCALATED_QUEUE_FIELDS = [
  'caseId',
  'organizationId',
  'applicationId',
  'status',
  'allegationCodes',
  'sensitivityClass',
  'reviewPool',
  'priorityScore',
  'triagedAt',
  'createdAt',
  'updatedAt',
] as const;

/**
 * Fields that must never appear in ANY cross-tenant read, whatever the audience.
 *
 * `contentSnapshot` is the reported material. `reporterFingerprints` are per-reporter
 * values an application could recompute against its own user table — see the note in
 * `case.service.ts` — so they exist to be counted and never to be returned. The rest are
 * juror identity, which §11 protects hardest.
 *
 * A per-juror VOTE is not on the list because there is nothing to list: no function here
 * returns a `Review` or an `Assignment` row at all, so there is no projection a vote
 * field could be added to. `Decision.outcome` is deliberately absent from this list and
 * legitimately exposed — it is the published, aggregate outcome of a whole panel, which is
 * a different thing from what one juror said.
 *
 * Declared as data so a test can assert the two lists are disjoint. A projection widened
 * to include one of these fails that test by name.
 */
export const CROSS_TENANT_FORBIDDEN_FIELDS = [
  'contentSnapshot',
  'reporterFingerprints',
  'reviewerId',
  'oxyUserId',
  'agreeingReviewerIds',
  'assignmentId',
  'reviewId',
  'samplingKey',
  'riskClusterId',
  'principalLinks',
  'tokenHash',
] as const;

/** One row of the escalated queue. Shape mirrors `ESCALATED_QUEUE_FIELDS` exactly. */
export interface EscalatedCaseRow {
  readonly caseId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly status: CaseStatus;
  readonly allegationCodes: readonly string[];
  readonly sensitivityClass: SensitivityClass | null;
  /**
   * Which pool the case routed to — §7.5's specialist routing, and the closest thing
   * this schema has to an "escalation reason": there is no dedicated reason field, and
   * inventing one here would be a value nothing sets. Withheld from every TENANT-facing
   * view (an application could learn which of its cases went to specialists) and shown
   * here because running that queue is the whole job.
   */
  readonly reviewPool: ReviewPool | null;
  readonly priorityScore: number;
  readonly triagedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** How many rows one queue read may return, so a slow query cannot become an export. */
const QUEUE_LIMIT = 200;

/**
 * Enumerate the tenants from the table that defines them, then enter each
 * tenant through the same RLS-setting transaction used by request paths.
 *
 * The application role deliberately has no BYPASSRLS credential and this
 * service never carries a migrator URL. Trust & Safety therefore crosses the
 * tenant boundary by controlled fan-out, not by weakening PostgreSQL policy or
 * inventing a second runtime secret. Each callback can see exactly one
 * application; only this module may combine its fixed projection/scalars.
 */
async function forEveryTenant<T>(
  read: Parameters<typeof withTenant<T>>[2],
): Promise<T[]> {
  const db = getPostgresDatabase();
  const tenants = await db
    .select({
      organizationId: applicationRows.organizationId,
      applicationId: applicationRows.applicationId,
    })
    .from(applicationRows);

  // Sequential by design: a staff metrics request must not consume the entire
  // service pool and starve moderation traffic when the application count grows.
  const results: T[] = [];
  for (const tenant of tenants) {
    results.push(await withTenant(db, tenant, read));
  }
  return results;
}

/**
 * §4.3's escalated queue, across every tenant.
 *
 * `escalated` OR the escalated status, because triage sets the flag and the lifecycle
 * sets the status, and a case can be in either state without the other: a specialist
 * route is flagged at triage before the status moves, and an appeal can escalate a case
 * that was never flagged.
 */
export async function findEscalatedCasesAcrossTenants(): Promise<readonly EscalatedCaseRow[]> {
  const perTenant = await forEveryTenant((tx) =>
    tx
      .select({
        caseId: caseRows.caseId,
        organizationId: caseRows.organizationId,
        applicationId: caseRows.applicationId,
        status: caseRows.status,
        allegationCodes: caseRows.allegationCodes,
        sensitivityClass: caseRows.sensitivityClass,
        reviewPool: caseRows.reviewPool,
        priorityScore: caseRows.priorityScore,
        triagedAt: caseRows.triagedAt,
        createdAt: caseRows.createdAt,
        updatedAt: caseRows.updatedAt,
      })
      .from(caseRows)
      .where(or(eq(caseRows.escalated, true), eq(caseRows.status, 'escalated')))
      .orderBy(desc(caseRows.priorityScore), asc(caseRows.createdAt))
      .limit(QUEUE_LIMIT),
  );
  const rows = perTenant
    .flat()
    .sort(
      (left, right) =>
        right.priorityScore - left.priorityScore ||
        left.createdAt.getTime() - right.createdAt.getTime(),
    )
    .slice(0, QUEUE_LIMIT);

  return rows.map((stored) => ({
    caseId: stored.caseId,
    organizationId: stored.organizationId,
    applicationId: stored.applicationId,
    status: stored.status as CaseStatus,
    allegationCodes: stored.allegationCodes,
    sensitivityClass: stored.sensitivityClass as SensitivityClass | null,
    reviewPool: stored.reviewPool as ReviewPool | null,
    priorityScore: stored.priorityScore,
    triagedAt: stored.triagedAt?.toISOString() ?? null,
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
  }));
}

/**
 * §16.4's decision metrics, as SCALARS.
 *
 * One count per outcome and nothing else — no case ids, no application breakdown that
 * could identify a single tenant's single case. `inconclusive` is counted separately from
 * `no_violation` because collapsing them is the invariant this product refuses to break,
 * and a metric that merged them would be the first place that erodes.
 */
export async function countDecisionsByOutcomeAcrossTenants(): Promise<
  Readonly<Record<DecisionOutcome, number>>
> {
  const grouped = (
    await forEveryTenant((tx) =>
      tx
        .select({ outcome: decisionRows.outcome, count: sql<number>`count(*)::integer` })
        .from(decisionRows)
        .groupBy(decisionRows.outcome),
    )
  ).flat();
  const result = Object.fromEntries(DECISION_OUTCOMES.map((outcome) => [outcome, 0])) as Record<DecisionOutcome, number>;
  for (const row of grouped) {
    if (DECISION_OUTCOMES.some((outcome) => outcome === row.outcome)) {
      result[row.outcome as DecisionOutcome] += row.count;
    }
  }
  return result;
}

/** §16.4's case queue depth, as scalars: one count per lifecycle state. */
export async function countCasesByStatusAcrossTenants(): Promise<
  Readonly<Record<CaseStatus, number>>
> {
  const grouped = (
    await forEveryTenant((tx) =>
      tx
        .select({ status: caseRows.status, count: sql<number>`count(*)::integer` })
        .from(caseRows)
        .groupBy(caseRows.status),
    )
  ).flat();
  const result = Object.fromEntries(CASE_STATUSES.map((status) => [status, 0])) as Record<CaseStatus, number>;
  for (const row of grouped) {
    if (CASE_STATUSES.some((status) => status === row.status)) {
      result[row.status as CaseStatus] += row.count;
    }
  }
  return result;
}

/**
 * Reviewer conduct, as SCALARS — the juror-adjacent boundary.
 *
 * `Review`, `Assignment`, `ReviewerProfile`, `SortitionDraw`, `ReviewerAffinity` and
 * `ReviewerRelation` are declared UNSCOPED, correctly: a reviewer belongs to no tenant,
 * a caller presenting an Oxy session has no tenant to scope by, and forcing a tenant
 * filter onto reviewer data would break the draw, which spans every application by
 * design. So the tenant is not the control here and cannot be — **the control is the
 * FIELDS**, and the strongest available form of it is to return no rows at all.
 *
 * That is what this function does. A Trust & Safety operator legitimately needs to know
 * how much review work is happening and how it is distributed across outcomes; they never
 * need to know who voted which way on a given case, and a developer needs none of it. So
 * there is no console-reachable read anywhere that returns a `reviewerId`, an assignment,
 * or a per-juror vote — not because a screen declines to render one, but because no
 * accessor returns one.
 */
export interface ReviewActivitySummary {
  readonly reviewsSubmitted: number;
  /** Reviews per outcome the juror recorded — a distribution, never a vote. */
  readonly byOutcome: Readonly<Record<string, number>>;
}

export async function summariseReviewActivityAcrossTenants(): Promise<ReviewActivitySummary> {
  const grouped = await getPostgresDatabase()
    .select({ outcome: reviewRows.outcome, count: sql<number>`count(*)::integer` })
    .from(reviewRows)
    .groupBy(reviewRows.outcome);
  const byOutcome: Record<string, number> = {};
  let reviewsSubmitted = 0;
  for (const row of grouped) {
    byOutcome[row.outcome] = row.count;
    reviewsSubmitted += row.count;
  }

  return { reviewsSubmitted, byOutcome };
}
