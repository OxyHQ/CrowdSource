import { createSeededUniforms } from './seededRandom';
import {
  RELIABLE_MIN_RELIABILITY,
  SLOT_FALLBACKS,
  slotAllowsFallback,
  type PanelSpec,
  type SlotType,
} from './panelSpec';

/**
 * The draw itself (§8.4, §8.5) — pure, deterministic, and the only place a
 * panel is chosen.
 *
 * Nothing here touches a database, a clock or a global. Given the same
 * candidates, the same seed, the same specification and the same incumbents it
 * returns the same panel, on any machine, forever. That is what makes §16.3's
 * "reproducible from a known seed" a property of the code rather than a claim
 * about it: `sortition.service.ts` persists exactly these inputs, so re-running
 * this function is a complete audit of a draw.
 *
 * ## The sampling method
 *
 * Weighted random sampling without replacement, by the standard key method: draw
 * a uniform `u` per candidate and rank by `u^(1/w)`. Sampling `k` items by the
 * `k` largest keys is exactly weighted sampling without replacement, which is
 * what §8.4 asks for ("weighted reservoir sampling or an equivalent variant").
 * The keys are drawn ONCE, in a canonical order, before any slot is filled — so
 * the order the slots happen to be listed in cannot change who is available for
 * a later slot in a way the seed did not decide.
 *
 * ## Where a refusal comes from
 *
 * The lookahead below is the whole reason this can refuse rather than quietly
 * produce a weak panel. Before each slot it asks: if every remaining slot went
 * to somebody unreliable, would the panel still clear §8.3's minimum? When the
 * answer is no, the remaining slots are restricted to reliable candidates. If
 * that leaves nobody, the draw FAILS and the case is not opened.
 *
 * The alternative — open the panel anyway — is precisely what the civic
 * validator does today: it has no minimum-pool guard, so it opens panels below
 * quorum which can only ever expire. Twenty of twenty-one civic validation
 * requests in production expired with zero votes ever cast. A panel that cannot
 * resolve is worse than no panel, because it consumes the case's clock and
 * reports progress.
 */

/** A candidate as the draw sees them. No identity, no reputation figure. */
export interface WeightedCandidate {
  readonly reviewerId: string;
  /** §8.4's weight. Affects selection probability and nothing else. */
  readonly selectionWeight: number;
  /** Measured reliability in the case's family, for §8.3's minimum. */
  readonly reliability: number;
  /** §8.3's cluster cap. Null for the overwhelming majority. */
  readonly riskClusterId: string | null;
  /** Slot classes this candidate satisfies, from `satisfiesSlot`. */
  readonly eligibleSlots: readonly SlotType[];
}

/** A reviewer on the panel: either just drawn, or already serving. */
export interface SeatedReviewer {
  readonly reviewerId: string;
  /** The slot of the specification this seat is. */
  readonly slotType: SlotType;
  /** The class that actually filled it — different when a fallback was used. */
  readonly filledAs: SlotType;
  readonly reliability: number;
  readonly riskClusterId: string | null;
}

export interface PanelDrawInput {
  readonly spec: PanelSpec;
  readonly candidates: readonly WeightedCandidate[];
  readonly seed: Buffer;
  /** Slots still to fill. A replacement draw passes exactly one. */
  readonly slots: readonly SlotType[];
  /** Reviewers already serving, who still count toward every constraint. */
  readonly incumbents: readonly SeatedReviewer[];
  /**
   * §8.5's high-affinity pairs: for a reviewer, the reviewers they have served
   * with too often to be independent of. Symmetric, and consulted against
   * everybody already seated.
   */
  readonly affinityBlocked: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Why a draw could not produce a panel. Never a partial result. */
export const PANEL_REFUSAL_REASONS = [
  'slot_unfillable',
  'reliability_minimum',
  'candidate_pool_too_small',
] as const;
export type PanelRefusalReason = (typeof PANEL_REFUSAL_REASONS)[number];

export type PanelDrawOutcome =
  | { readonly ok: true; readonly seats: readonly SeatedReviewer[] }
  | {
      readonly ok: false;
      readonly reason: PanelRefusalReason;
      /** The slot that could not be filled, when that is what happened. */
      readonly slot?: SlotType;
    };

/**
 * Sorting keys, drawn once per candidate.
 *
 * The candidates are sorted by `reviewerId` first, so the mapping from seed to
 * keys does not depend on the order the database happened to return rows in. A
 * draw whose result changed with query order would be reproducible only by
 * accident.
 */
function sortingKeys(
  candidates: readonly WeightedCandidate[],
  seed: Buffer,
): ReadonlyMap<string, number> {
  const ordered = [...candidates].sort((left, right) =>
    left.reviewerId < right.reviewerId ? -1 : 1,
  );
  const uniform = createSeededUniforms(seed, 'panel');

  const keys = new Map<string, number>();
  for (const candidate of ordered) {
    /**
     * A non-positive or non-finite weight is a DEFECT, not a state of the world,
     * and it is thrown rather than absorbed.
     *
     * The tempting absorption — substitute a tiny weight — is worse than it
     * looks: `u ** (1 / ε)` is zero for every `u < 1`, so the candidate is
     * silently unselectable while the draw reports a perfectly ordinary panel.
     * That is an exclusion nobody asked for and nobody can see, which is the
     * failure this whole module is written to avoid. `selectionWeight` clamps to
     * [0.75, 1.25], so reaching here with anything else means the caller is
     * broken and the draw must say so.
     */
    if (!Number.isFinite(candidate.selectionWeight) || candidate.selectionWeight <= 0) {
      throw new Error(
        `Candidate '${candidate.reviewerId}' has a selection weight of ${candidate.selectionWeight}; weights must be positive and finite.`,
      );
    }
    keys.set(candidate.reviewerId, uniform() ** (1 / candidate.selectionWeight));
  }
  return keys;
}

function isReliable(reliability: number): boolean {
  return reliability >= RELIABLE_MIN_RELIABILITY;
}

/** Draws a panel, or refuses. Never returns fewer seats than it was asked for. */
export function drawPanel(input: PanelDrawInput): PanelDrawOutcome {
  const { spec, seed, slots, incumbents, affinityBlocked } = input;

  if (input.candidates.length < slots.length) {
    return { ok: false, reason: 'candidate_pool_too_small' };
  }

  const keys = sortingKeys(input.candidates, seed);
  const byId = new Map(input.candidates.map((candidate) => [candidate.reviewerId, candidate]));

  const seats: SeatedReviewer[] = [...incumbents];
  const taken = new Set(incumbents.map((seat) => seat.reviewerId));
  const clusterCounts = new Map<string, number>();
  for (const seat of incumbents) {
    if (seat.riskClusterId === null) continue;
    clusterCounts.set(seat.riskClusterId, (clusterCounts.get(seat.riskClusterId) ?? 0) + 1);
  }

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];

    /**
     * §8.3's reliability minimum, enforced by lookahead rather than by hoping.
     *
     * If every slot still to fill would be needed to reach the minimum, this
     * one is restricted to reliable candidates. Checking only at the end would
     * leave a panel that has to be thrown away and redrawn, which is not
     * reproducible from a seed — the discarded draw consumed no keys, but the
     * decision to discard it is not in the audit record.
     */
    const reliableSeated = seats.filter((seat) => isReliable(seat.reliability)).length;
    const reliableStillNeeded = Math.max(0, spec.constraints.minReliableCount - reliableSeated);
    const slotsRemaining = slots.length - index;
    const mustBeReliable = reliableStillNeeded >= slotsRemaining;

    const admissible = (candidate: WeightedCandidate, asSlot: SlotType): boolean => {
      if (taken.has(candidate.reviewerId)) return false;
      if (!candidate.eligibleSlots.includes(asSlot)) return false;
      if (mustBeReliable && !isReliable(candidate.reliability)) return false;

      if (candidate.riskClusterId !== null) {
        const seatedInCluster = clusterCounts.get(candidate.riskClusterId) ?? 0;
        if (seatedInCluster >= spec.constraints.maxPerRiskCluster) return false;
      }

      const blocked = affinityBlocked.get(candidate.reviewerId);
      if (blocked && seats.some((seat) => blocked.has(seat.reviewerId))) return false;

      return true;
    };

    /**
     * The preferred class first, then its fallbacks — and only where the pool
     * allows fallbacks at all. A specialist pool does not: §7.5 sent the case
     * there because of what the material is alleged to be, and filling the slot
     * with a general reviewer would undo that routing silently.
     */
    const classes = slotAllowsFallback(spec, slot) ? SLOT_FALLBACKS[slot] : [slot];

    let chosen: WeightedCandidate | null = null;
    let chosenAs: SlotType = slot;

    for (const asSlot of classes) {
      let best: WeightedCandidate | null = null;
      let bestKey = -1;

      for (const candidate of byId.values()) {
        if (!admissible(candidate, asSlot)) continue;
        const key = keys.get(candidate.reviewerId) ?? 0;
        // Strictly greater, and the ids are unique, so ties (which the 53-bit
        // key makes vanishingly unlikely) resolve by iteration order over a map
        // built from a sorted array — deterministic either way.
        if (key > bestKey) {
          best = candidate;
          bestKey = key;
        }
      }

      if (best) {
        chosen = best;
        chosenAs = asSlot;
        break;
      }
    }

    if (!chosen) {
      return { ok: false, reason: 'slot_unfillable', slot };
    }

    seats.push({
      reviewerId: chosen.reviewerId,
      slotType: slot,
      filledAs: chosenAs,
      reliability: chosen.reliability,
      riskClusterId: chosen.riskClusterId,
    });
    taken.add(chosen.reviewerId);
    if (chosen.riskClusterId !== null) {
      clusterCounts.set(
        chosen.riskClusterId,
        (clusterCounts.get(chosen.riskClusterId) ?? 0) + 1,
      );
    }
  }

  /**
   * The postcondition, checked rather than assumed.
   *
   * The lookahead above should make this unreachable. It is here because "should
   * make unreachable" is how a panel below quorum ships: if the lookahead is
   * ever wrong, this turns a silent weak panel into a refusal, which is the
   * direction the whole module leans.
   */
  if (seats.filter((seat) => isReliable(seat.reliability)).length < spec.constraints.minReliableCount) {
    return { ok: false, reason: 'reliability_minimum' };
  }

  return { ok: true, seats };
}
