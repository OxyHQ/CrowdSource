import { Schema } from 'mongoose';
import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';

import { defineTenantCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';
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
export const CASE_STATUSES = [
  'received',
  'triaged',
  'awaiting_review',
  'under_review',
  'awaiting_consensus',
  'decided',
  'escalated',
  'appealed',
  'superseded',
  'closed',
] as const;
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
   * `< R` to `R`; MongoDB lets exactly one of them, and the loser's transaction
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

const caseSchema = new Schema<CaseDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    caseId: { type: String, required: true, unique: true },

    externalSubjectId: { type: String, required: true },
    contentHash: { type: String, required: true },
    policyVersion: { type: String, required: true },
    caseDedupKey: { type: String, required: true },

    subjectType: { type: String, required: true },
    primaryResourceId: { type: String, required: true },
    policySetId: { type: String, required: true },
    taxonomyVersion: { type: String, required: true },

    contentSnapshot: { type: Schema.Types.Mixed, required: true },

    status: { type: String, required: true, enum: CASE_STATUSES, default: 'received' },

    allegationCodes: { type: [String], required: true, default: [] },
    reportCount: { type: Number, required: true, default: 0 },
    reporterFingerprints: { type: [String], required: true, default: [] },

    reach: { type: Number, required: true, default: 0 },
    activeDistribution: { type: Boolean, required: true, default: false },
    allowCommunityReview: { type: Boolean, required: true, default: true },
    containsPersonalData: { type: Boolean, required: true, default: false },
    retentionDays: { type: Number, required: true },

    priorityScore: { type: Number, required: true, default: 0 },
    sensitivityClass: { type: String, default: null },
    reviewPool: { type: String, default: null },
    requiresRedaction: { type: Boolean, required: true, default: false },
    escalated: { type: Boolean, required: true, default: false },
    triagedAt: { type: Date, default: null },

    currentRevision: { type: Number, required: true, default: 1 },
    decidedRevision: { type: Number, required: true, default: 0 },
    incidentId: { type: String, default: null },

    firstReportedAt: { type: Date, required: true },
    lastReportedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'cases' },
);

/**
 * §12.7's case dedup constraint, and the thing that actually enforces §7.3.
 *
 * The four fields are the plan's, verbatim. It is a unique INDEX and not a
 * lookup because a lookup races: two people reporting the same post within the
 * same instant both find no case and both create one, which is two cases, two
 * juries and two consequences for one incident. With the index the second
 * insert loses and the loser merges — see `case.service.ts`.
 */
caseSchema.index(
  { applicationId: 1, externalSubjectId: 1, contentHash: 1, policyVersion: 1 },
  { unique: true },
);

/** §7.3's derived key, for lookup and for future cross-application correlation. */
caseSchema.index({ applicationId: 1, caseDedupKey: 1 });

/**
 * §12.7's operational queue index. Deliberately NOT prefixed by the tenant: a
 * reviewer is drawn for whichever case is next across every application, so the
 * queue this serves is the one query in the system that is not tenant-scoped.
 */
caseSchema.index({ status: 1, priorityScore: -1, createdAt: 1 });

export const cases = defineTenantCollection('Case', caseSchema);

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

const caseReportSchema = new Schema<CaseReportDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    caseId: { type: String, required: true },
    reportId: { type: String, required: true },
    externalReportId: { type: String, required: true },
    allegationCodes: { type: [String], required: true, default: [] },
    merged: { type: Boolean, required: true, default: false },
    linkedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'case_reports' },
);

/** One report belongs to exactly one case. */
caseReportSchema.index({ applicationId: 1, reportId: 1 }, { unique: true });
caseReportSchema.index({ applicationId: 1, caseId: 1 });

export const caseReports = defineTenantCollection('CaseReport', caseReportSchema);
