import { Schema } from 'mongoose';

import { defineUnscopedCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';

/**
 * Application moderation trust (§11.13).
 *
 * An external application can abuse the system as surely as a reporter or a
 * juror can, so it has standing of its own. Standing is what decides whether an
 * application may ingest at all and whether its cases may ever move an Oxy Trust
 * figure — the second being the gate §16.2 states as "una aplicación sandbox no
 * puede producir efectos globales".
 *
 * Declared UNSCOPED because both of its readers are outside any one tenant: Trust
 * & Safety compares standing ACROSS applications (§4.3, "aplicaciones sospechosas
 * o con alta tasa de revocación"), and the ingestion gate reads the row that is
 * about to establish the tenant. Every row is tenant-stamped on write, and the
 * only read that serves a tenant goes through `findTenantTrust`, which filters
 * explicitly — the same shape `webhook_deliveries` uses and for the same reason.
 *
 * Standing is NOT the tenant's to change. A row is created with the application,
 * and only a Trust & Safety operator with the `security` role moves it.
 */

/** §11.13's three states, verbatim. */
export const APPLICATION_STANDINGS = ['sandbox', 'trusted', 'restricted'] as const;
export type ApplicationStanding = (typeof APPLICATION_STANDINGS)[number];

/**
 * Why standing was last moved. A closed vocabulary, not free text: this value is
 * shown on an operator screen and kept indefinitely, and a free-text field next to
 * a case is where a fragment of reported material eventually lands.
 */
export const STANDING_REASONS = [
  /** The initial state of every new application (§11.13). */
  'initial',
  /** Passed technical review, identity verification and a quality period. */
  'promotion_review_passed',
  /** Evidence integrity or binding reliability failed an audit. */
  'evidence_integrity_failed',
  /** Decisions about this application's cases are overturned unusually often. */
  'high_overturn_rate',
  /** Reported volume or content indicates abuse of the pipeline. */
  'suspected_abuse',
  /** An operator restored standing after an investigation closed. */
  'investigation_closed',
] as const;
export type StandingReason = (typeof STANDING_REASONS)[number];

export interface ApplicationTrustDocument extends TenantContext {
  standing: ApplicationStanding;
  /**
   * Whether a decision about this application's cases may reach Oxy Trust.
   *
   * Stored rather than derived from `standing`, because §11.13 lists it as its own
   * field and the two are genuinely separable: an operator promoting an
   * application to `trusted` for throughput reasons may still withhold global
   * effects while identity binding is under review. Deriving it would silently
   * grant the larger power with the smaller one.
   */
  globalReputationEffectsAllowed: boolean;

  /**
   * §11.13's quality signals — `null` where nothing measures them YET.
   *
   * Only `decisionOverturnRate` has a source of truth today (decision revisions,
   * see `applicationTrust.service.ts`), and it is derived at read time rather than
   * stored so it cannot go stale against the decisions it summarises. The other
   * three depend on modules that are not built: evidence integrity on the
   * evidence pipeline's hash and scan results, identity binding reliability on
   * §11.14's binding proofs, policy quality on appeal outcomes per policy version.
   *
   * They are `null` and not `0` on purpose. A fabricated 0.5 on an operator screen
   * is worse than an absent number: it looks like a measurement, it will be acted
   * on, and nothing in the system would ever contradict it.
   */
  evidenceIntegrity: number | null;
  identityBindingReliability: number | null;
  policyQuality: number | null;

  lastStandingReason: StandingReason;
  standingChangedAt: Date | null;
  /** The staff member who moved it, or null while it is still the initial state. */
  standingChangedByOxyUserId: string | null;

  createdAt: Date;
  updatedAt: Date;
}

const applicationTrustSchema = new Schema<ApplicationTrustDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true, unique: true },
    standing: {
      type: String,
      required: true,
      enum: APPLICATION_STANDINGS,
      default: 'sandbox',
    },
    globalReputationEffectsAllowed: { type: Boolean, required: true, default: false },
    evidenceIntegrity: { type: Number, default: null },
    identityBindingReliability: { type: Number, default: null },
    policyQuality: { type: Number, default: null },
    lastStandingReason: {
      type: String,
      required: true,
      enum: STANDING_REASONS,
      default: 'initial',
    },
    standingChangedAt: { type: Date, default: null },
    standingChangedByOxyUserId: { type: String, default: null },
  },
  { timestamps: true, collection: 'app_trust_snapshots' },
);

/** The Trust & Safety queue: "which applications are in which standing". */
applicationTrustSchema.index({ standing: 1, updatedAt: -1 });

export const applicationTrust = defineUnscopedCollection(
  'ApplicationTrust',
  applicationTrustSchema,
  {
    why: 'Trust & Safety compares standing across every application (§4.3), and the ingestion gate reads the row that establishes the tenant.',
  },
);
