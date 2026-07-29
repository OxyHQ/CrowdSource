import type { TaxonomyFamily } from '@oxyhq/crowdsource-contracts';

import type { ReviewPool } from '../triage/triage';
import { REVIEWER_STATE_RANK, type ReviewerState } from '../reviewer/reviewerState';

/**
 * Panel composition (§8.3) and the escalation ladder (§8.6), as data.
 *
 * §8.3 is emphatic that a panel is not "the highest-reputation people
 * available": it is built from SLOTS, so that capacity, diversity and renewal
 * survive contact with a reliability score. A system that always draws its best
 * reviewers has no second generation of reviewers, and the day its best ones
 * leave it has no jury at all.
 *
 * Two kinds of rule live here and they behave differently on purpose:
 *
 *  - **Slots are preferences with a fallback chain.** A panel that cannot find a
 *    newcomer should not refuse to open; it should fill that slot from the next
 *    class and record that it did. Refusing here would mean a mature deployment
 *    where everyone is experienced can no longer review anything.
 *  - **Constraints are hard.** Minimum reliability, one member per risk cluster,
 *    zero relations with the people involved. These do not fall back, and a
 *    panel that cannot satisfy them is not opened at all — `sortition.service.ts`
 *    refuses, loudly. Opening a panel that cannot resolve is exactly what
 *    produced twenty expired civic validation requests and zero votes in the
 *    system this replaces.
 *
 * The one slot with NO fallback is `reliable_general`, because that slot IS the
 * reliability minimum §8.3 states.
 */

/** §8.3's slot kinds. */
export const SLOT_TYPES = [
  'reliable_general',
  'category_specialist',
  'intermediate',
  'calibrated_newcomer',
] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

/**
 * The reliability at which a reviewer counts as "sufficiently reliable" for
 * §8.3's minimum.
 *
 * Note what this is NOT: a state. §8.3 says "mínimo 3 con fiabilidad
 * suficiente" — reliability, which CrowdSource measures — and reading it as
 * "minimum 3 trusted-tier reviewers" is the exact substitution that produced an
 * empty jury pool in the civic validator, where the tier nobody had was the only
 * gate. A newly calibrated reviewer who answered the gold items well IS reliable
 * enough for a general slot; what `trusted` buys is a slightly higher selection
 * weight and, later, specialisation.
 */
export const RELIABLE_MIN_RELIABILITY = 0.7;

/** Submitted reviews above which a reviewer is no longer a newcomer (§8.3). */
export const NEWCOMER_MAX_REVIEWS = 10;

/** The floor for an intermediate slot: past the newcomer band, still learning. */
export const INTERMEDIATE_MIN_RELIABILITY = 0.5;

/** What a candidate must be to fill a slot of this type. */
export interface SlotRequirement {
  readonly minState: ReviewerState;
  readonly minReliability: number;
  /** Reviews below which the candidate counts as a newcomer. */
  readonly maxCompletedReviews?: number;
  readonly minCompletedReviews?: number;
  /** True when the candidate must be a recognised specialist in the family. */
  readonly requiresSpecialism: boolean;
}

const SLOT_REQUIREMENTS: Readonly<Record<SlotType, SlotRequirement>> = Object.freeze({
  reliable_general: {
    minState: 'community',
    minReliability: RELIABLE_MIN_RELIABILITY,
    requiresSpecialism: false,
  },
  category_specialist: {
    minState: 'specialist',
    minReliability: RELIABLE_MIN_RELIABILITY,
    requiresSpecialism: true,
  },
  intermediate: {
    minState: 'community',
    minReliability: INTERMEDIATE_MIN_RELIABILITY,
    minCompletedReviews: NEWCOMER_MAX_REVIEWS,
    requiresSpecialism: false,
  },
  calibrated_newcomer: {
    minState: 'community',
    minReliability: 0,
    maxCompletedReviews: NEWCOMER_MAX_REVIEWS,
    requiresSpecialism: false,
  },
});

/**
 * Which classes may fill a slot, in order of preference.
 *
 * `reliable_general` has no fallback and that is the design: it is the hard
 * reliability floor wearing a slot's clothes. Everything else degrades toward a
 * more capable class rather than a less capable one, so a fallback never lowers
 * the bar — §8.7 forbids exactly that when replacing a recused juror, and the
 * same reasoning applies to the first draw.
 */
export const SLOT_FALLBACKS: Readonly<Record<SlotType, readonly SlotType[]>> = Object.freeze({
  reliable_general: ['reliable_general'],
  category_specialist: ['category_specialist', 'reliable_general'],
  intermediate: ['intermediate', 'reliable_general'],
  calibrated_newcomer: ['calibrated_newcomer', 'intermediate', 'reliable_general'],
});

/** The hard constraints on a finished panel (§8.3). */
export interface PanelConstraints {
  /** How many members must clear `RELIABLE_MIN_RELIABILITY`. */
  readonly minReliableCount: number;
  /** §8.3's "máximo 1 por cluster de riesgo". */
  readonly maxPerRiskCluster: number;
}

export interface PanelSpec {
  readonly panelSpecId: string;
  readonly pool: ReviewPool;
  /** §8.6's round: 3, then 5, then 7 reviewers in total. */
  readonly round: number;
  /** Every slot of the panel at this round, INCLUDING earlier rounds' slots. */
  readonly slots: readonly SlotType[];
  readonly constraints: PanelConstraints;
}

/**
 * The community ladder of §8.6, cumulative.
 *
 * Round 1's three are §8.6's opening panel. Round 2's five are §8.3's worked
 * example verbatim — two reliable, one specialist, one intermediate, one
 * calibrated newcomer. Round 3 adds a second specialist and a fourth reliable
 * member, which is what §8.6's "5 of 7 plus specialist requirements" needs to be
 * satisfiable.
 *
 * `minReliableCount` holds §8.3's ratio at every round: 2 of 3, 3 of 5, 4 of 7.
 */
const COMMUNITY_ROUNDS: readonly PanelSpec[] = Object.freeze([
  Object.freeze({
    panelSpecId: 'community.round1',
    pool: 'community',
    round: 1,
    slots: Object.freeze<SlotType[]>([
      'reliable_general',
      'reliable_general',
      'calibrated_newcomer',
    ]),
    constraints: Object.freeze({ minReliableCount: 2, maxPerRiskCluster: 1 }),
  }),
  Object.freeze({
    panelSpecId: 'community.round2',
    pool: 'community',
    round: 2,
    slots: Object.freeze<SlotType[]>([
      'reliable_general',
      'reliable_general',
      'calibrated_newcomer',
      'category_specialist',
      'intermediate',
    ]),
    constraints: Object.freeze({ minReliableCount: 3, maxPerRiskCluster: 1 }),
  }),
  Object.freeze({
    panelSpecId: 'community.round3',
    pool: 'community',
    round: 3,
    slots: Object.freeze<SlotType[]>([
      'reliable_general',
      'reliable_general',
      'calibrated_newcomer',
      'category_specialist',
      'intermediate',
      'category_specialist',
      'reliable_general',
    ]),
    constraints: Object.freeze({ minReliableCount: 4, maxPerRiskCluster: 1 }),
  }),
]);

/**
 * The specialist ladder (§7.5 rows 2 and 3).
 *
 * Every slot is `category_specialist` and — unlike the community ladder — the
 * fallback chain is not consulted, because a case that reached this pool did so
 * because of what the material is alleged to be. "No specialist was available,
 * so a general reviewer saw it" is the failure §7.5 exists to prevent, and it
 * has to surface as a refusal an operator sees rather than as a quietly
 * downgraded panel.
 */
const SPECIALIST_ROUNDS: readonly PanelSpec[] = Object.freeze([
  Object.freeze({
    panelSpecId: 'specialist.round1',
    pool: 'specialist',
    round: 1,
    slots: Object.freeze<SlotType[]>([
      'category_specialist',
      'category_specialist',
      'category_specialist',
    ]),
    constraints: Object.freeze({ minReliableCount: 3, maxPerRiskCluster: 1 }),
  }),
  Object.freeze({
    panelSpecId: 'specialist.round2',
    pool: 'specialist',
    round: 2,
    slots: Object.freeze<SlotType[]>(new Array<SlotType>(5).fill('category_specialist')),
    constraints: Object.freeze({ minReliableCount: 4, maxPerRiskCluster: 1 }),
  }),
  Object.freeze({
    panelSpecId: 'specialist.round3',
    pool: 'specialist',
    round: 3,
    slots: Object.freeze<SlotType[]>(new Array<SlotType>(7).fill('category_specialist')),
    constraints: Object.freeze({ minReliableCount: 5, maxPerRiskCluster: 1 }),
  }),
]);

/** True when a slot type may be filled without its own class being available. */
export function slotAllowsFallback(spec: PanelSpec, slot: SlotType): boolean {
  return spec.pool === 'community' && SLOT_FALLBACKS[slot].length > 1;
}

/**
 * The panel specification for a pool at a round.
 *
 * `legal` has no specification and asking for one throws. §7.5 routes that
 * material to a specialist team under legal protocol and states that it is not
 * delivered to a community jury — so there is no panel to compose, and returning
 * a plausible-looking spec would be the single most dangerous thing this file
 * could do. `sortition.service.ts` refuses before reaching here; the throw is
 * the second lock.
 */
export function panelSpecFor(pool: ReviewPool, round: number): PanelSpec {
  if (pool === 'legal') {
    throw new Error(
      'Material routed to the legal pool is never drawn a jury; it has no panel specification.',
    );
  }

  const ladder = pool === 'specialist' ? SPECIALIST_ROUNDS : COMMUNITY_ROUNDS;
  const spec = ladder.find((candidate) => candidate.round === round);
  if (!spec) {
    throw new Error(`No panel specification for the '${pool}' pool at round ${round}.`);
  }
  return spec;
}

/** The highest round the escalation ladder defines (§8.6). */
export const MAX_PANEL_ROUND = 3;

/** What a candidate offers a slot, as the numbers the requirements are about. */
export interface SlotCandidateFacts {
  readonly state: ReviewerState;
  readonly reliability: number;
  readonly completedReviewCount: number;
  readonly specialistCategories: readonly TaxonomyFamily[];
}

/** True when this candidate satisfies the requirements of `slot`. */
export function satisfiesSlot(
  slot: SlotType,
  facts: SlotCandidateFacts,
  family: TaxonomyFamily | null,
): boolean {
  const requirement = SLOT_REQUIREMENTS[slot];

  if (REVIEWER_STATE_RANK[facts.state] < REVIEWER_STATE_RANK[requirement.minState]) return false;
  if (facts.reliability < requirement.minReliability) return false;
  if (
    requirement.minCompletedReviews !== undefined &&
    facts.completedReviewCount < requirement.minCompletedReviews
  ) {
    return false;
  }
  if (
    requirement.maxCompletedReviews !== undefined &&
    facts.completedReviewCount >= requirement.maxCompletedReviews
  ) {
    return false;
  }
  if (requirement.requiresSpecialism) {
    // A specialist slot on a case with no single dominant family cannot be
    // filled by definition: there is no family to be a specialist in.
    if (family === null) return false;
    if (!facts.specialistCategories.includes(family)) return false;
  }

  return true;
}
