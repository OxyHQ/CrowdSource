import { taxonomyFamilyOf, type TaxonomyCode, type TaxonomyFamily } from '@oxyhq/crowdsource-contracts';

/**
 * Triage (§7.4, §7.5) — deterministic, and with no AI in it.
 *
 * §7.4 states the boundary in one sentence: triage decides the ORDER cases are
 * reviewed in, the POOL required, and whether the material may be shown to the
 * community. **It does not decide guilt.** Everything below is computed from
 * allegations, which are unverified claims (§6.2), and none of it is ever shown
 * to a jury — §9.1 lists report count, reporter reputation and prior votes among
 * the things a reviewer must not see, and every one of them is an input here.
 *
 * A pure function of a stated input, on purpose. It is re-run whenever a case
 * changes (a merged report changes velocity, and a report that forbids community
 * review changes the route), so it must be replay-safe: running it twice on the
 * same case state produces the same answer, and running it on a newer state
 * never un-does a restriction the older state imposed.
 *
 * §13.9 permits AI for preliminary sensitivity classification and duplicate
 * detection. None is used here and none is needed: routing is a table over
 * taxonomy codes, and a table is auditable, explainable and identical on every
 * replay — which a model is not.
 */

/**
 * How exposing the material is believed to be, BEFORE anyone has reviewed it.
 *
 * This is the computed `sensitivity_class` of §12.8 and it is the authority —
 * distinct from the tenant's `sensitivityHint`, which the contract deliberately
 * describes as "never shown as a verdict" and which is not consulted for
 * routing. A tenant that under-declares cannot talk its way into a community
 * jury.
 */
export const SENSITIVITY_CLASSES = ['standard', 'sensitive', 'restricted', 'prohibited'] as const;
export type SensitivityClass = (typeof SENSITIVITY_CLASSES)[number];

/** Who may be drawn for this case (§7.5, §8.1). */
export const REVIEW_POOLS = ['community', 'specialist', 'legal'] as const;
export type ReviewPool = (typeof REVIEW_POOLS)[number];

/** Ordered least to most restrictive; the strictest allegation in a case wins. */
const SENSITIVITY_RANK: Readonly<Record<SensitivityClass, number>> = Object.freeze({
  standard: 0,
  sensitive: 1,
  restricted: 2,
  prohibited: 3,
});

const POOL_RANK: Readonly<Record<ReviewPool, number>> = Object.freeze({
  community: 0,
  specialist: 1,
  legal: 2,
});

interface Route {
  readonly sensitivity: SensitivityClass;
  readonly pool: ReviewPool;
  /** §7.5's urgent paths: the case leaves the ordinary queue entirely. */
  readonly escalate: boolean;
  /** §13.5: redact before anyone reviews it. */
  readonly redact: boolean;
}

const STANDARD_ROUTE: Route = Object.freeze({
  sensitivity: 'standard',
  pool: 'community',
  escalate: false,
  redact: false,
});

/**
 * §7.5's table, as data.
 *
 * A code absent from this map routes to `STANDARD_ROUTE`. That default is safe
 * because the taxonomy is closed (`@oxyhq/crowdsource-contracts` rejects a code
 * it does not know), so "absent" means "a code we classified as ordinary", never
 * "a code nobody has looked at".
 */
const CODE_ROUTES: Partial<Record<TaxonomyCode, Route>> = Object.freeze({
  /**
   * §7.5 row 1. Never reaches a community jury under any circumstance —
   * `allowCommunityReview: true` cannot pull it back, because the restriction
   * comes from what the material is alleged to be, not from what the tenant
   * asked for.
   */
  'child_safety.sexualization': { sensitivity: 'prohibited', pool: 'legal', escalate: true, redact: true },
  'child_safety.grooming': { sensitivity: 'prohibited', pool: 'legal', escalate: true, redact: true },
  'child_safety.exploitation': { sensitivity: 'prohibited', pool: 'legal', escalate: true, redact: true },

  /** §7.5 row 2: imminent risk. The application keeps its own emergency path. */
  'self_harm.imminent_risk': { sensitivity: 'restricted', pool: 'specialist', escalate: true, redact: false },
  'harassment.credible_threat': { sensitivity: 'restricted', pool: 'specialist', escalate: true, redact: false },
  'violence.threat': { sensitivity: 'restricted', pool: 'specialist', escalate: true, redact: false },

  /** §7.5 row 3 and the non-consensual sexual material of §6.5. */
  'sexual_content.non_consensual': { sensitivity: 'restricted', pool: 'specialist', escalate: true, redact: true },
  'sexual_content.exploitation': { sensitivity: 'restricted', pool: 'specialist', escalate: true, redact: true },
  'privacy.intimate_media': { sensitivity: 'restricted', pool: 'specialist', escalate: true, redact: true },
  'violence.graphic': { sensitivity: 'sensitive', pool: 'specialist', escalate: false, redact: false },

  /** §7.5 row 4: personal data and documents. Redact first, then minimal access. */
  'privacy.personal_information': { sensitivity: 'sensitive', pool: 'community', escalate: false, redact: true },
  'privacy.location_exposure': { sensitivity: 'sensitive', pool: 'community', escalate: false, redact: true },
  'harassment.doxxing': { sensitivity: 'sensitive', pool: 'community', escalate: false, redact: true },

  /**
   * §7.5 row 5: ordinary adult pornography. Community, but `sensitive` — the
   * per-category adult consent §8.2 requires is a reviewer ELIGIBILITY property,
   * gated on this class, not a pool of its own.
   */
  'sexual_content.nudity': { sensitivity: 'sensitive', pool: 'community', escalate: false, redact: false },
  'sexual_content.explicit_activity': { sensitivity: 'sensitive', pool: 'community', escalate: false, redact: false },

  'self_harm.promotion': { sensitivity: 'sensitive', pool: 'community', escalate: false, redact: false },
  'self_harm.instruction': { sensitivity: 'sensitive', pool: 'community', escalate: false, redact: false },
});

/**
 * The severity a family is treated as when ordering the queue.
 *
 * A weight on the QUEUE, not a finding. §6.2's whole point is that a reporter's
 * chosen code and the jury's eventual finding routinely differ, so this decides
 * what gets looked at sooner and nothing else.
 */
const FAMILY_SEVERITY_WEIGHT: Readonly<Record<TaxonomyFamily, number>> = Object.freeze({
  child_safety: 40,
  self_harm: 30,
  violence: 30,
  privacy: 26,
  hate: 26,
  sexual_content: 24,
  harassment: 22,
  integrity: 14,
  commerce: 14,
  platform_abuse: 10,
  other: 8,
});

/** Codes whose urgency exceeds their family's ordinary weight. */
const CODE_SEVERITY_WEIGHT: Partial<Record<TaxonomyCode, number>> = Object.freeze({
  'self_harm.imminent_risk': 40,
  'sexual_content.non_consensual': 40,
  'sexual_content.exploitation': 40,
  'harassment.credible_threat': 36,
  'violence.threat': 36,
  'privacy.intimate_media': 36,
});

/**
 * The ceiling on every component, and the whole score.
 *
 * Every term is bounded so no single signal can dominate. The one that matters
 * most is `REPORTER_PRIORITY_BOOST`: §7.4 says reporter reputation "may
 * influence priority only in a limited way, is never shown to the jury and is
 * never used as evidence that the allegation is true". Five points out of a
 * possible 105 is that limit expressed as a number, and `triageCase` clamps to
 * it rather than trusting its caller.
 */
export const TRIAGE_WEIGHTS = Object.freeze({
  SEVERITY_MAX: 40,
  REPORT_VELOCITY_MAX: 15,
  UNIQUE_REPORTER_MAX: 15,
  REACH_MAX: 10,
  VULNERABLE_TARGET_MAX: 10,
  REPORTER_PRIORITY_BOOST_MAX: 5,
  STALE_CASE_MAX: 10,
  DUPLICATE_NOISE_PENALTY_MAX: 10,
  SCORE_MAX: 100,
} as const);

/** Families whose target is, by the nature of the allegation, at heightened risk. */
const VULNERABLE_TARGET_FAMILIES: ReadonlySet<TaxonomyFamily> = new Set<TaxonomyFamily>([
  'child_safety',
  'self_harm',
  'privacy',
  'harassment',
]);

const HOUR_MS = 60 * 60 * 1000;

/** What triage reads. Every field is case state, never request state. */
export interface TriageInput {
  readonly allegationCodes: readonly TaxonomyCode[];
  readonly reportCount: number;
  /** Distinct reporters, counted from fingerprints — never from raw identities. */
  readonly uniqueReporterCount: number;
  /** How many people the material reached, as the application counts it. */
  readonly reach: number;
  readonly activeDistribution: boolean;
  /** False when ANY merged report withheld community review (§5.1 privacy). */
  readonly allowCommunityReview: boolean;
  readonly containsPersonalData: boolean;
  readonly firstReportedAt: Date;
  readonly now: Date;
  /**
   * §7.4's `trustedReporterPriorityBoost`, supplied by the caller and clamped
   * here.
   *
   * Nothing supplies it today: Oxy Trust holds no reporter reliability yet, and
   * inventing one would be exactly the "reputation as evidence" §7.4 forbids.
   * The parameter exists so the cap is enforced by the code that will receive
   * the value, rather than by whoever remembers to clamp it at the call site.
   */
  readonly reporterPriorityBoost?: number;
}

export interface TriageResult {
  readonly priorityScore: number;
  readonly sensitivityClass: SensitivityClass;
  readonly reviewPool: ReviewPool;
  readonly requiresRedaction: boolean;
  readonly escalate: boolean;
  /** Every component, for the audit trail and for explaining a queue position. */
  readonly components: Readonly<Record<string, number>>;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function severityWeight(codes: readonly TaxonomyCode[]): number {
  return codes.reduce((highest, code) => {
    const weight = CODE_SEVERITY_WEIGHT[code] ?? FAMILY_SEVERITY_WEIGHT[taxonomyFamilyOf(code)];
    return Math.max(highest, weight);
  }, 0);
}

/**
 * The strictest route across every allegation in the case.
 *
 * Strictest rather than first or most common: a case carrying nine spam
 * allegations and one child-safety allegation is a child-safety case until a
 * jury says otherwise, and getting that backwards puts material in front of a
 * community reviewer that §7.5 says must never reach one.
 */
function strictestRoute(codes: readonly TaxonomyCode[]): Route {
  return codes.reduce<Route>((strictest, code) => {
    const route = CODE_ROUTES[code] ?? STANDARD_ROUTE;
    return {
      sensitivity:
        SENSITIVITY_RANK[route.sensitivity] > SENSITIVITY_RANK[strictest.sensitivity]
          ? route.sensitivity
          : strictest.sensitivity,
      pool: POOL_RANK[route.pool] > POOL_RANK[strictest.pool] ? route.pool : strictest.pool,
      escalate: strictest.escalate || route.escalate,
      redact: strictest.redact || route.redact,
    };
  }, STANDARD_ROUTE);
}

/** Deterministic priority, pool and exposure for one case. */
export function triageCase(input: TriageInput): TriageResult {
  const route = strictestRoute(input.allegationCodes);

  /**
   * The tenant may only ever tighten. §5.1 describes `allowCommunityReview:
   * false` as routing to a specialist pool and explicitly not as a preference
   * triage may override upwards, and a merged report that withheld community
   * review has to bind the whole case — otherwise the second reporter's privacy
   * terms are silently discarded by the first reporter's.
   */
  const reviewPool: ReviewPool =
    !input.allowCommunityReview && route.pool === 'community' ? 'specialist' : route.pool;

  const elapsedHours = Math.max(
    0,
    (input.now.getTime() - input.firstReportedAt.getTime()) / HOUR_MS,
  );

  const severityHint = clamp(
    severityWeight(input.allegationCodes),
    0,
    TRIAGE_WEIGHTS.SEVERITY_MAX,
  );

  /**
   * Reports per hour, not reports. A hundred reports over a month is a case
   * nobody got to; a hundred in ten minutes is something spreading right now,
   * and only the second should jump the queue. The `+1` keeps a case reported
   * seconds ago from dividing by an interval close to zero.
   */
  const reportVelocity = clamp(
    5 * Math.log2(1 + input.reportCount / (elapsedHours + 1)),
    0,
    TRIAGE_WEIGHTS.REPORT_VELOCITY_MAX,
  );

  /**
   * Distinct reporters, which is a far stronger signal than report volume: one
   * person filing forty reports is one opinion, and §11.11 treats that pattern
   * as possible report abuse rather than as urgency.
   */
  const uniqueReporterSignal = clamp(
    5 * Math.log2(1 + Math.max(0, input.uniqueReporterCount)),
    0,
    TRIAGE_WEIGHTS.UNIQUE_REPORTER_MAX,
  );

  const reachOrVirality = clamp(
    Math.log10(1 + Math.max(0, input.reach)) * 2 + (input.activeDistribution ? 2 : 0),
    0,
    TRIAGE_WEIGHTS.REACH_MAX,
  );

  const vulnerableTargetSignal = clamp(
    (input.allegationCodes.some((code) => VULNERABLE_TARGET_FAMILIES.has(taxonomyFamilyOf(code)))
      ? 6
      : 0) + (input.containsPersonalData ? 4 : 0),
    0,
    TRIAGE_WEIGHTS.VULNERABLE_TARGET_MAX,
  );

  const trustedReporterPriorityBoost = clamp(
    input.reporterPriorityBoost ?? 0,
    0,
    TRIAGE_WEIGHTS.REPORTER_PRIORITY_BOOST_MAX,
  );

  /**
   * §7.4's `staleCaseBoost`. Without it a steady stream of fresh, loud cases
   * starves the quiet ones indefinitely, and "never reviewed" is a decision
   * nobody made.
   */
  const staleCaseBoost = clamp(elapsedHours / 12, 0, TRIAGE_WEIGHTS.STALE_CASE_MAX);

  /** Reports beyond the number of distinct reporters: volume without new signal. */
  const duplicateNoisePenalty = clamp(
    Math.max(0, input.reportCount - input.uniqueReporterCount),
    0,
    TRIAGE_WEIGHTS.DUPLICATE_NOISE_PENALTY_MAX,
  );

  const priorityScore = clamp(
    severityHint +
      reportVelocity +
      uniqueReporterSignal +
      reachOrVirality +
      vulnerableTargetSignal +
      trustedReporterPriorityBoost +
      staleCaseBoost -
      duplicateNoisePenalty,
    0,
    TRIAGE_WEIGHTS.SCORE_MAX,
  );

  return {
    // Rounded to two places so a stored score is stable across replays on
    // machines that disagree in the last bit of a float.
    priorityScore: Math.round(priorityScore * 100) / 100,
    sensitivityClass: route.sensitivity,
    reviewPool,
    requiresRedaction: route.redact || input.containsPersonalData,
    escalate: route.escalate,
    components: Object.freeze({
      severityHint,
      reportVelocity,
      uniqueReporterSignal,
      reachOrVirality,
      vulnerableTargetSignal,
      trustedReporterPriorityBoost,
      staleCaseBoost,
      duplicateNoisePenalty,
    }),
  };
}
