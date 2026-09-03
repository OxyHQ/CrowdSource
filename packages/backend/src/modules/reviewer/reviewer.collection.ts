import {
  REVIEWER_SENSITIVITY_CLASSES,
  type ReviewerState,
  type TaxonomyFamily,
} from '@oxyhq/crowdsource-contracts';

import { defineUnscopedCollection } from '../../db/collections';
import type { ReviewerRelationSource } from '../../db/postgres/schema/reviewers';
import type { SensitivityClass } from '../triage/triage';


/**
 * Reviewer profiles, declared conflicts and co-service affinity (§12.6's "Jury"
 * group, minus assignments — those live with sortition, which issues them).
 *
 * ## Why these are not tenant-scoped
 *
 * Everything else in this service belongs to one application. A reviewer does
 * not: they are a person in the Oxy ecosystem who may be drawn for a case from
 * ANY application, and scoping them to a tenant would mean a separate reviewer
 * population per customer — which is the opposite of the product. §12.9 already
 * carves out the same shape for cross-tenant correlation, and `case.collection.ts`
 * says it plainly about the queue index: "a reviewer is drawn for whichever case
 * is next across every application".
 *
 * The cost is that the tenant filter cannot protect these documents, so two
 * rules hold by review instead:
 *
 *  1. A reviewer profile carries NO tenant keys and no case data. The only
 *     application-shaped fields on it are `principalLinks` (which application
 *     account a reviewer says is theirs, needed to exclude them from their own
 *     cases) and `declaredConflictApplications` — both supplied by the reviewer
 *     about themselves.
 *  2. Nothing here is ever returned to an application-API caller. The tenant
 *     surface has no reviewer endpoint, and it must not acquire one: which
 *     people reviewed a case is precisely what §9.1's blind review protects.
 *
 * ## What is deliberately absent
 *
 * There is no reputation figure, no karma, no Oxy `trustTier`. A reviewer's
 * standing in this service is their state, their calibration and their per-
 * category reliability — all of which CrowdSource observes itself and can move a
 * person through. Oxy contributes an authenticated account and a verification
 * flag; see `personhood.ts` for why leaning on more than that produced a jury
 * pool of five people and twenty expired cases in the system this replaces.
 */

/** Which application account a reviewer says is theirs (§8.5's self-exclusion). */
export interface ReviewerPrincipalLink {
  readonly applicationId: string;
  readonly externalPrincipalId: string;
}

export interface ReviewerProfileDocument {
  reviewerId: string;
  /** The Oxy account. One profile per person, enforced by a unique index. */
  oxyUserId: string;

  state: ReviewerState;

  /** §8.2's "active and authenticated Oxy account". */
  accountActive: boolean;
  /** Oxy's verification flag as the session reported it. Absent means false. */
  oxyAccountVerified: boolean;
  /**
   * §8.2's age compatibility, as the single bit the routing actually needs.
   *
   * §13.5 minimisation: a date of birth would let this service answer questions
   * nobody asked it, and the only question it has is whether adult-only
   * categories are open to this person.
   */
  isAdult: boolean;

  /** §8.2's sock puppet, shared device and coordinated cluster signals. */
  suspectedSockPuppet: boolean;
  /**
   * A precomputed coordination cluster (§8.5, §8.8).
   *
   * Null for the overwhelming majority. §8.3 caps a panel at one member per
   * cluster, which is only meaningful if clustering is decided OUTSIDE the draw
   * — computing it inside would be the per-candidate sequential work §8.8 warns
   * against, and it would let a draw's own timing change its own result.
   */
  riskClusterId: string | null;

  /** BCP-47 primary subtags the reviewer reads. Indexed; see below. */
  languages: string[];
  /** Taxonomy families the reviewer accepts cases in. Indexed; see below. */
  categories: TaxonomyFamily[];
  /** Families this reviewer is a recognised specialist in (§8.1, §8.3). */
  specialistCategories: TaxonomyFamily[];

  /**
   * The most sensitive class this reviewer consented to see (§7.5, §13.7).
   *
   * Stored as the RANK rather than the name so the eligibility query is a
   * `$gte` on a number. `prohibited` is not a reachable value: §7.5 routes that
   * material away from every jury, and a consent field that could express it
   * would eventually be set.
   */
  maxSensitivityRank: number;
  /**
   * Per-family consent for sensitive material (§13.7's "consent per category,
   * revocable at any time"). A family absent here is a family this reviewer is
   * never shown sensitive material from, whatever `maxSensitivityRank` says.
   */
  consentedSensitiveCategories: TaxonomyFamily[];

  /** Applications the reviewer declared a conflict with (§8.2). */
  declaredConflictApplications: string[];

  /**
   * When this person accepted the reviewing rules (§4.1's onboarding, §13.7).
   *
   * An instant rather than a boolean, because §13.7's consent model only works if
   * a person can see WHAT they consented to and when — a bare `true` cannot be
   * shown back to them and cannot be audited against the version of the rules
   * they were shown. Null means never accepted, and `openCalibrationIfReady`
   * treats that as a closed gate: the app advertises it as a blocker, and a
   * client-side check that the server does not enforce is not a gate at all.
   */
  rulesAcceptedAt: Date | null;

  /** §13.7: a reviewer may stop being drawn at any moment, without explanation. */
  available: boolean;
  /** §13.7's daily limit, chosen by the reviewer within a system maximum. */
  dailyReviewLimit: number;

  trainingCompletedModules: string[];
  trainingCompletedAt: Date | null;
  calibrationPassedAt: Date | null;
  calibrationScore: number | null;
  calibrationAttempts: number;
  lastCalibrationAt: Date | null;

  /**
   * Per-family reliability in [0, 1] (§8.4's `categoryReliability`, §9.7).
   *
   * Seeded by calibration and updated only by gold cases, appeal outcomes and
   * audits — never by agreeing with a panel majority, which §9.7 forbids
   * explicitly and which would turn the reliability figure into a machine for
   * punishing correct minorities.
   *
   * It affects ELIGIBILITY and SELECTION PROBABILITY. It never affects the
   * weight of a vote (§8.4), and `weightSeparation.test.ts` is what keeps that
   * true as the code grows.
   */
  reliabilityByCategory: Record<string, number>;

  /** Submitted reviews, for §8.3's newcomer and intermediate slot bands. */
  completedReviewCount: number;

  /** Recomputed from the signals above on every write; never set directly. */
  personhoodConfidence: number;

  /**
   * A uniform random draw in [0, 1), fixed at creation.
   *
   * This is what makes the candidate query samplable at scale. §8.8 warns that
   * the civic selector caps its pool with an unordered `limit(500)`, which means
   * the same first 500 rows forever; a range scan from a random point on an
   * indexed uniform key gives a different, unbiased window each draw at the same
   * cost. See `candidatePool.ts`.
   */
  samplingKey: number;

  principalLinks: ReviewerPrincipalLink[];

  suspendedUntil: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export const reviewerProfiles = defineUnscopedCollection<ReviewerProfileDocument>('ReviewerProfile', {
  why: 'A reviewer is a person drawn across every application, not data owned by one tenant; profiles carry no tenant keys and are never returned to an application-API caller.',
});

/**
 * A relationship between a reviewer and someone on an application (§8.5's
 * `excludeGraphRelationsAndRiskClusters`).
 *
 * This is the "graph exclusion bridge" of §15.4, and what it bridges TO is worth
 * being exact about, because the honest version is narrower than the phrase
 * suggests. CrowdSource has no read of Oxy's social graph — there is no such
 * bridge to consume today — so the relations it can act on are the ones it
 * observes itself:
 *
 *  - `declared`: the reviewer said they know this person, through preferences.
 *  - `recusal`: the reviewer recused from a case citing a conflict, and the
 *    principals of that case were recorded so they are never drawn for the same
 *    people again. A conflict declared once should not have to be declared
 *    twice, and §8.7 forbids penalising a recusal — silently re-drawing them for
 *    the same person is a penalty in everything but name.
 *
 * When an Oxy relationship read does exist, it populates this collection with a
 * third source and nothing else in the selector changes.
 */
export interface ReviewerRelationDocument {
  reviewerId: string;
  applicationId: string;
  /** The application's own id for the other person. Never an Oxy user id. */
  externalPrincipalId: string;
  source: ReviewerRelationSource;
  createdAt: Date;
  updatedAt: Date;
}

export const reviewerRelations = defineUnscopedCollection<ReviewerRelationDocument>(
  'ReviewerRelation',
  {
    why: 'A reviewer’s declared conflicts follow the person across every application they may be drawn for, so the collection cannot be scoped to one tenant.',
  },
);

/**
 * How often two reviewers have served on the same panel (§8.5's
 * `excludeHighAffinityPairs`).
 *
 * Two people who keep landing on the same juries stop being two independent
 * judgements — whether they coordinate deliberately or simply learn each other's
 * reasoning. The counter is incremented for every pair when a panel is issued,
 * and a pair over the threshold is not drawn together again.
 *
 * Stored once per pair under a sorted key, so `(a, b)` and `(b, a)` are the same
 * row and cannot disagree.
 */
export interface ReviewerAffinityDocument {
  /** `${lower}:${higher}` — sorted, so the pair has exactly one row. */
  pairKey: string;
  reviewerIdA: string;
  reviewerIdB: string;
  coServedCount: number;
  lastServedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const reviewerAffinities = defineUnscopedCollection<ReviewerAffinityDocument>(
  'ReviewerAffinity',
  {
    why: 'Co-service is a property of a pair of people across every panel they have sat on, and panels span tenants; the pair has no owning application.',
  },
);

/** The one row a pair of reviewers shares, whichever order they are named in. */
export function affinityPairKey(left: string, right: string): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

/**
 * The sensitivity classes a reviewer may consent to, ranked (§7.5).
 *
 * The list itself is `REVIEWER_SENSITIVITY_CLASSES` in the published contracts,
 * because it crosses the reviewer API boundary and the app renders it — when the
 * two sides declared it separately they disagreed completely, the app having
 * invented `none`/`low`/`high`/`critical`. The annotation is what keeps the two
 * vocabularies honest: if triage's `SensitivityClass` ever stops covering what a
 * reviewer can consent to, this line stops compiling.
 */
export const CONSENTABLE_SENSITIVITY: readonly SensitivityClass[] =
  REVIEWER_SENSITIVITY_CLASSES;

/**
 * The rank of a consentable class.
 *
 * `prohibited` is absent and calling this with it throws rather than returning a
 * number: §7.5 routes that material to a specialist team under legal protocol
 * and never to a jury, so a rank for it is a value that would only ever be used
 * by mistake.
 */
export function sensitivityRank(sensitivity: SensitivityClass): number {
  const rank = CONSENTABLE_SENSITIVITY.indexOf(sensitivity);
  if (rank < 0) {
    throw new Error(
      `'${sensitivity}' material is never shown to a jury, so it has no reviewer consent rank.`,
    );
  }
  return rank;
}
