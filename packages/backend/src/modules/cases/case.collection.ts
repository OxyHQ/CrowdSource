import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';

import { defineTenantCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';
import { CASE_STATUSES } from '../../domain/closedValues';
import type { ContentSnapshot } from '../evidence/contentSnapshot';
import type { ReviewPool, SensitivityClass } from '../triage/triage';

/**
 * Cases and the reports merged into them (§3, §12.8).
 *
 * A case is the expedient for ONE version of ONE subject under ONE policy
 * (§3, §7.3). Every report about that same version joins it. That is what makes
 * "a hundred reports produce one case and one consequence" true at the storage
 * layer rather than as an aspiration held by the code above it.
 */

/** §3.2 case states. */
export { CASE_STATUSES } from '../../domain/closedValues';
export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface CaseDocument extends TenantContext {
  caseId: string;

  /** The three identity components of §7.3, stored as the case's identity. */
  externalSubjectId: string;
  contentHash: string;
  /** `<policySetId>@<version>` — see `caseDedupKey.ts` for why both halves. */
  policyVersion: string;
  /** §7.3's derived key. Indexed for correlation; the tuple above is enforced. */
  caseDedupKey: string;

  subjectType: string;
  primaryResourceId: string;
  policySetId: string;
  taxonomyVersion: string;

  /**
   * §5.6's immutable snapshot: the exact material that was reported.
   *
   * Written once, by the report that created the case. Every later report that
   * reaches this document carries identical content by construction — matching
   * the content hash is what routed it here — so there is nothing for a merge to
   * overwrite and no version of "which report's copy is authoritative".
   */
  contentSnapshot: ContentSnapshot;

  status: CaseStatus;

  /** The union of what every reporter alleged. Claims, never findings (§6.2). */
  allegationCodes: TaxonomyCode[];
  reportCount: number;
  /**
   * One opaque value per distinct reporter, domain-separated per application.
   *
   * §7.4 needs distinct-reporter counts and §9.1 forbids showing a reviewer
   * anything about the reporters, so the case stores a fingerprint rather than
   * an identity: it counts, and because the application id is part of the digest
   * it cannot be correlated with the same person's fingerprint under another
   * tenant.
   *
   * NOT reversible by a reviewer or another tenant, and NOT proof against the
   * application itself — the digest is keyless, so its owner can recompute it over
   * its own users. See `reporterFingerprint` in `case.service.ts`; the containment
   * is that no surface ever returns these values to an application.
   */
  reporterFingerprints: string[];

  /** Triage inputs merged across reports, strictest-wins. */
  reach: number;
  activeDistribution: boolean;
  allowCommunityReview: boolean;
  containsPersonalData: boolean;
  retentionDays: number;

  /** Triage outputs (§7.4). Recomputed on every merge; never a verdict. */
  priorityScore: number;
  sensitivityClass: SensitivityClass | null;
  reviewPool: ReviewPool | null;
  requiresRedaction: boolean;
  escalated: boolean;
  triagedAt: Date | null;

  /** §9.9: revisions supersede, they never overwrite. Revision 1 until an appeal. */
  currentRevision: number;
  /**
   * The highest revision that has a published decision. Zero until the first.
   *
   * §12.11's compare-and-swap, in the form the swap needs. Two consensus workers
   * evaluating the same case at the same instant both try to move this from
   * `< R` to `R`; PostgreSQL lets exactly one of them, and the loser's transaction
   * retries, finds the filter no longer matches, and publishes nothing.
   *
   * A separate number rather than a check on `status` because `status` has three
   * other writers — triage, the draw, and a juror opening their assignment — and
   * a compare-and-swap racing writers it does not know about is not a
   * compare-and-swap. This field has exactly one writer, only ever increases,
   * and means one thing.
   */
  decidedRevision: number;
  /**
   * Cross-application correlation (§7.3). Null until a privileged Trust & Safety
   * path links this case to an incident — never set from an application-API
   * request, and never returned to one.
   */
  incidentId: string | null;

  firstReportedAt: Date;
  lastReportedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const cases = defineTenantCollection<CaseDocument>('Case');

/**
 * The join between a report and the case it was merged into (§12.6
 * `case_reports`).
 *
 * A separate document rather than an array on the case, because the list grows
 * without bound — §11.15 opens with "100 reports" as the ordinary shape — and an
 * unbounded array inside a hot document is a document that eventually stops
 * being updatable.
 */
export interface CaseReportDocument extends TenantContext {
  caseId: string;
  reportId: string;
  externalReportId: string;
  /** What THIS reporter alleged, kept per report so §6.2's layers stay separate. */
  allegationCodes: TaxonomyCode[];
  /** True when this report joined a case that already existed (§10.4 `merged`). */
  merged: boolean;
  linkedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const caseReports = defineTenantCollection<CaseReportDocument>('CaseReport');
