import { describe, expect, it } from 'vitest';

import {
  createSeededUniforms,
  decodeSeed,
  encodeSeed,
  newSortitionSeed,
  SEED_BYTES,
} from '../modules/sortition/seededRandom';
import { panelSpecFor, type SlotType } from '../modules/sortition/panelSpec';
import {
  drawPanel,
  type PanelDrawInput,
  type WeightedCandidate,
} from '../modules/sortition/weightedSampling';

/**
 * §16.3's tests of the draw, against the pure function that makes them
 * meaningful.
 *
 * The plan asks for reproducibility with a known seed, unpredictability before
 * the seed exists, statistical distribution within expected limits, and respect
 * for slots and minimums. Every one of those is a property of `drawPanel` and
 * `seededRandom` alone — no database, no clock — which is precisely why the
 * service persists exactly the inputs these take: re-running this function over
 * a stored draw record IS the audit.
 */

const COMMUNITY_ROUND_1 = panelSpecFor('community', 1);

function candidate(
  index: number,
  overrides: Partial<WeightedCandidate> = {},
): WeightedCandidate {
  return {
    // Zero-padded so lexicographic order is numeric order, which makes a failing
    // assertion readable rather than a puzzle about string sorting.
    reviewerId: `rvw_${String(index).padStart(4, '0')}`,
    selectionWeight: 1,
    reliability: 0.8,
    riskClusterId: null,
    eligibleSlots: ['reliable_general', 'intermediate', 'calibrated_newcomer'],
    ...overrides,
  };
}

function pool(size: number, overrides: (index: number) => Partial<WeightedCandidate> = () => ({})) {
  return Array.from({ length: size }, (_, index) => candidate(index, overrides(index)));
}

function input(overrides: Partial<PanelDrawInput> = {}): PanelDrawInput {
  return {
    spec: COMMUNITY_ROUND_1,
    candidates: pool(40),
    seed: Buffer.alloc(SEED_BYTES, 7),
    slots: COMMUNITY_ROUND_1.slots,
    incumbents: [],
    affinityBlocked: new Map(),
    ...overrides,
  };
}

function selectedIds(outcome: ReturnType<typeof drawPanel>): string[] {
  if (!outcome.ok) throw new Error(`Expected a panel, got a refusal: ${outcome.reason}`);
  return outcome.seats.map((seat) => seat.reviewerId);
}

describe('the seed', () => {
  it('is 32 bytes and survives a round trip through storage', () => {
    const seed = newSortitionSeed();
    expect(seed).toHaveLength(SEED_BYTES);
    expect(decodeSeed(encodeSeed(seed))).toEqual(seed);
  });

  it('refuses a malformed stored seed instead of padding it', () => {
    // A replay from a truncated seed would produce a DIFFERENT panel and report
    // it as the original — worse than failing.
    expect(() => decodeSeed('abcd')).toThrow(/32 bytes/);
    expect(() => decodeSeed('X'.repeat(64))).toThrow(/lowercase hex/);
  });

  it('produces a different seed every time (§16.3 unpredictability)', () => {
    const seeds = new Set(Array.from({ length: 200 }, () => encodeSeed(newSortitionSeed())));
    expect(seeds.size).toBe(200);
  });

  it('expands one seed into a deterministic stream in (0, 1]', () => {
    const seed = Buffer.alloc(SEED_BYTES, 3);
    const first = Array.from({ length: 50 }, createSeededUniforms(seed, 'panel'));
    const second = Array.from({ length: 50 }, createSeededUniforms(seed, 'panel'));

    expect(first).toEqual(second);
    for (const value of first) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('separates independent uses of one seed by label', () => {
    const seed = Buffer.alloc(SEED_BYTES, 3);
    expect(Array.from({ length: 10 }, createSeededUniforms(seed, 'panel'))).not.toEqual(
      Array.from({ length: 10 }, createSeededUniforms(seed, 'tiebreak')),
    );
  });
});

describe('reproducibility (§16.3)', () => {
  it('the same seed and pool produce the same panel, every time', () => {
    const runs = Array.from({ length: 20 }, () => selectedIds(drawPanel(input())));
    for (const run of runs) expect(run).toEqual(runs[0]);
  });

  it('does not depend on the order the pool was returned in', () => {
    const candidates = pool(40);
    const shuffled = [...candidates].reverse();

    expect(selectedIds(drawPanel(input({ candidates })))).toEqual(
      selectedIds(drawPanel(input({ candidates: shuffled }))),
    );
  });

  it('a different seed produces a different panel', () => {
    const a = selectedIds(drawPanel(input({ seed: Buffer.alloc(SEED_BYTES, 1) })));
    const b = selectedIds(drawPanel(input({ seed: Buffer.alloc(SEED_BYTES, 2) })));
    expect(a).not.toEqual(b);
  });
});

describe('slots (§8.3)', () => {
  it('fills every slot of the specification', () => {
    const outcome = drawPanel(input());
    if (!outcome.ok) throw new Error('expected a panel');

    expect(outcome.seats).toHaveLength(3);
    expect(outcome.seats.map((seat) => seat.slotType).sort()).toEqual([
      'calibrated_newcomer',
      'reliable_general',
      'reliable_general',
    ]);
  });

  it('never seats the same person twice', () => {
    const ids = selectedIds(drawPanel(input()));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('honours a newcomer slot when newcomers exist', () => {
    // Half the pool can ONLY fill the newcomer slot, half can only fill a
    // reliable one, so a panel that ignored slots would be visible immediately.
    const candidates = [
      ...pool(20, () => ({ eligibleSlots: ['reliable_general'], reliability: 0.9 })),
      ...pool(20, (index) => ({
        reviewerId: `rvw_new_${String(index).padStart(4, '0')}`,
        eligibleSlots: ['calibrated_newcomer'],
        reliability: 0.2,
      })),
    ];

    const outcome = drawPanel(input({ candidates }));
    if (!outcome.ok) throw new Error('expected a panel');

    const newcomer = outcome.seats.find((seat) => seat.slotType === 'calibrated_newcomer');
    expect(newcomer?.reviewerId).toMatch(/^rvw_new_/);
    expect(newcomer?.filledAs).toBe('calibrated_newcomer');
  });

  it('falls back to a MORE capable class when the preferred one is empty', () => {
    /**
     * A mature deployment where everybody is experienced has no newcomers, and
     * refusing there would mean it can no longer review anything. The fallback
     * only ever goes upward — see `SLOT_FALLBACKS` — so filling a diversity slot
     * never lowers the bar.
     */
    const candidates = pool(20, () => ({
      eligibleSlots: ['reliable_general', 'intermediate'],
      reliability: 0.95,
    }));

    const outcome = drawPanel(input({ candidates }));
    if (!outcome.ok) throw new Error('expected a panel');

    const newcomerSeat = outcome.seats.find((seat) => seat.slotType === 'calibrated_newcomer');
    expect(newcomerSeat).toBeDefined();
    expect(newcomerSeat?.filledAs).not.toBe('calibrated_newcomer');
  });

  it('does NOT fall back in the specialist pool (§7.5)', () => {
    /**
     * A case reaches the specialist pool because of what the material is alleged
     * to be. "No specialist was free, so a general reviewer saw it" is the exact
     * failure §7.5 exists to prevent, so this one refuses.
     */
    const spec = panelSpecFor('specialist', 1);
    const outcome = drawPanel(
      input({
        spec,
        slots: spec.slots,
        candidates: pool(20, () => ({ eligibleSlots: ['reliable_general'], reliability: 0.95 })),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('slot_unfillable');
    expect(outcome.slot).toBe('category_specialist');
  });
});

describe('the minimum-pool guard (§8.3, §8.8)', () => {
  /**
   * The single most important behaviour in this file.
   *
   * The system CrowdSource replaces has no guard of this kind: it opens whatever
   * panel it can and the result expires. Twenty of twenty-one civic validation
   * requests in production expired without one vote ever being cast. A panel
   * below its own threshold cannot decide anything — it only consumes the case's
   * clock while reporting progress.
   */
  it('refuses when there are fewer candidates than seats', () => {
    const outcome = drawPanel(input({ candidates: pool(2) }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('candidate_pool_too_small');
  });

  it('refuses when the reliability minimum cannot be met', () => {
    // Enough people, but only one of them is reliable and the panel needs two.
    const candidates = [
      candidate(0, { reliability: 0.95 }),
      ...pool(9, (index) => ({
        reviewerId: `rvw_weak_${index}`,
        reliability: 0.1,
        eligibleSlots: ['calibrated_newcomer', 'intermediate'],
      })),
    ];

    const outcome = drawPanel(input({ candidates }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(['slot_unfillable', 'reliability_minimum']).toContain(outcome.reason);
  });

  it('opens exactly at the boundary, so the refusal is not merely pessimism', () => {
    /**
     * The control for the two tests above. Without it, a guard that refused
     * EVERYTHING would pass both of them — the failure mode the ecosystem's own
     * lesson calls "a check that cannot distinguish success from failure".
     */
    const candidates = [
      candidate(0, { reliability: 0.95, eligibleSlots: ['reliable_general'] }),
      candidate(1, { reliability: 0.95, eligibleSlots: ['reliable_general'] }),
      candidate(2, { reliability: 0.1, eligibleSlots: ['calibrated_newcomer'] }),
    ];

    const outcome = drawPanel(input({ candidates }));
    expect(outcome.ok).toBe(true);
    expect(selectedIds(outcome).sort()).toEqual(['rvw_0000', 'rvw_0001', 'rvw_0002']);
  });

  /**
   * The mutation test. Break the guard and confirm these tests fail, and fail
   * naming what they caught — otherwise "refused" above is indistinguishable
   * from a function that always refuses, and "opened" from one that never checks.
   */
  it('mutation: a draw with the minimum lowered to zero would seat an unreliable panel', () => {
    const weakSpec = {
      ...COMMUNITY_ROUND_1,
      constraints: { ...COMMUNITY_ROUND_1.constraints, minReliableCount: 0 },
    };
    const candidates = [
      candidate(0, { reliability: 0.95, eligibleSlots: ['reliable_general'] }),
      ...pool(9, (index) => ({
        reviewerId: `rvw_weak_${index}`,
        reliability: 0.1,
        eligibleSlots: ['reliable_general', 'calibrated_newcomer', 'intermediate'],
      })),
    ];

    // With the real minimum: refused.
    expect(drawPanel(input({ candidates })).ok).toBe(false);

    // With the minimum broken: a panel opens, and it is one the real rules
    // reject — so the assertions above are testing the guard and not the pool.
    const mutated = drawPanel(input({ spec: weakSpec, candidates }));
    expect(mutated.ok).toBe(true);
    if (!mutated.ok) throw new Error('unreachable');
    expect(
      mutated.seats.filter((seat) => seat.reliability >= 0.7).length,
    ).toBeLessThan(COMMUNITY_ROUND_1.constraints.minReliableCount);
  });

  it('mutation: dropping the pool-size check would seat a panel of one', () => {
    /**
     * The guard's other half, exercised by asking for fewer seats than the
     * shortfall. Two candidates cannot fill three slots; two candidates CAN fill
     * two, which is what the real code would have to allow if the check were
     * removed.
     */
    const twoOnly = pool(2, () => ({ reliability: 0.9 }));
    expect(drawPanel(input({ candidates: twoOnly })).ok).toBe(false);

    const shortened = drawPanel(
      input({ candidates: twoOnly, slots: ['reliable_general', 'reliable_general'] }),
    );
    expect(shortened.ok).toBe(true);
    expect(selectedIds(shortened)).toHaveLength(2);
  });
});

describe('risk clusters and affinity (§8.3, §8.5)', () => {
  it('never seats more than one member of a risk cluster', () => {
    const candidates = pool(30, (index) => ({
      riskClusterId: index < 25 ? 'cluster_a' : null,
      reliability: 0.9,
    }));

    const outcome = drawPanel(input({ candidates }));
    if (!outcome.ok) throw new Error('expected a panel');

    const inCluster = outcome.seats.filter((seat) => seat.riskClusterId === 'cluster_a');
    expect(inCluster).toHaveLength(1);
  });

  it('mutation: raising the cluster cap seats the cluster it was excluding', () => {
    const candidates = pool(30, (index) => ({
      riskClusterId: index < 25 ? 'cluster_a' : null,
      reliability: 0.9,
    }));

    const permissive = drawPanel(
      input({
        candidates,
        spec: {
          ...COMMUNITY_ROUND_1,
          constraints: { ...COMMUNITY_ROUND_1.constraints, maxPerRiskCluster: 3 },
        },
      }),
    );
    if (!permissive.ok) throw new Error('expected a panel');

    // With the cap raised, the cluster takes more than one seat — so the
    // assertion above is the cap and not an accident of the pool's shape.
    expect(
      permissive.seats.filter((seat) => seat.riskClusterId === 'cluster_a').length,
    ).toBeGreaterThan(1);
  });

  it('keeps a high-affinity pair off the same panel', () => {
    const candidates = pool(6, () => ({ reliability: 0.9 }));
    const unrestricted = selectedIds(drawPanel(input({ candidates })));

    // Block the first two who were actually drawn together.
    const affinityBlocked = new Map<string, ReadonlySet<string>>([
      [unrestricted[0], new Set([unrestricted[1]])],
      [unrestricted[1], new Set([unrestricted[0]])],
    ]);

    const restricted = selectedIds(drawPanel(input({ candidates, affinityBlocked })));

    expect(unrestricted).toContain(unrestricted[0]);
    expect(unrestricted).toContain(unrestricted[1]);
    expect(restricted.includes(unrestricted[0]) && restricted.includes(unrestricted[1])).toBe(
      false,
    );
  });
});

describe('weighting (§8.4)', () => {
  /**
   * §16.3's "statistical distribution within expected limits".
   *
   * The clamp bounds selection weight to [0.75, 1.25], so the most favoured
   * reviewer is drawn about 1.67 times as often as the least favoured eligible
   * one. This checks the direction and the ORDER OF MAGNITUDE — a weighting that
   * had become a ranking would show up as one group taking nearly every seat.
   */
  it('favours higher weights, and only slightly', () => {
    const trials = 600;
    let heavy = 0;
    let light = 0;

    for (let trial = 0; trial < trials; trial += 1) {
      const seed = Buffer.alloc(32);
      seed.writeUInt32BE(trial, 0);

      const candidates = pool(20, (index) => ({
        selectionWeight: index < 10 ? 1.25 : 0.75,
        reliability: 0.9,
      }));

      for (const id of selectedIds(drawPanel(input({ candidates, seed })))) {
        const index = Number(id.slice('rvw_'.length));
        if (index < 10) heavy += 1;
        else light += 1;
      }
    }

    // Heavier candidates win more often…
    expect(heavy).toBeGreaterThan(light);
    // …but nowhere near a landslide: with equal group sizes the ratio sits near
    // 1.2, and anything past 2 would mean weight had become a ranking.
    expect(heavy / light).toBeLessThan(2);
    expect(heavy / light).toBeGreaterThan(1.02);
  });

  it('refuses a non-positive weight loudly instead of excluding somebody silently', () => {
    /**
     * `u ** (1 / ε)` is zero for every `u < 1`, so substituting a tiny weight
     * for a broken one would make that candidate unselectable while the draw
     * reported an ordinary panel — an exclusion nobody asked for and nobody can
     * see. Weights are clamped to [0.75, 1.25] upstream, so anything else here
     * is a caller defect and has to surface as one.
     */
    for (const broken of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const candidates = pool(10, (index) => ({
        selectionWeight: index === 0 ? broken : 1,
        reliability: 0.9,
      }));
      expect(() => drawPanel(input({ candidates }))).toThrow(/selection weight/);
    }
  });
});

describe('incumbents (§8.7 replacement)', () => {
  const incumbent = {
    reviewerId: 'rvw_incumbent',
    slotType: 'reliable_general' as SlotType,
    filledAs: 'reliable_general' as SlotType,
    reliability: 0.9,
    riskClusterId: null,
  };

  it('fills only the vacated slot and leaves the rest alone', () => {
    const outcome = drawPanel(
      input({ incumbents: [incumbent], slots: ['calibrated_newcomer'] }),
    );
    if (!outcome.ok) throw new Error('expected a panel');

    expect(outcome.seats).toHaveLength(2);
    expect(outcome.seats[0]).toMatchObject({ reviewerId: 'rvw_incumbent' });
  });

  it('counts incumbents toward the reliability minimum rather than re-earning it', () => {
    /**
     * §8.7: a replacement never lowers the threshold. It also must not RAISE it
     * — an incumbent who already satisfies the minimum still counts, or a panel
     * would become progressively harder to fill each time somebody recused.
     */
    const weakOnly = pool(5, (index) => ({
      reviewerId: `rvw_weak_${index}`,
      reliability: 0.1,
      eligibleSlots: ['calibrated_newcomer'],
    }));

    const twoReliableIncumbents = [
      incumbent,
      { ...incumbent, reviewerId: 'rvw_incumbent_2' },
    ];

    const outcome = drawPanel(
      input({
        candidates: weakOnly,
        incumbents: twoReliableIncumbents,
        slots: ['calibrated_newcomer'],
      }),
    );

    expect(outcome.ok).toBe(true);
  });

  it('refuses a replacement when the minimum would break, rather than lowering it', () => {
    const weakOnly = pool(5, (index) => ({
      reviewerId: `rvw_weak_${index}`,
      reliability: 0.1,
      eligibleSlots: ['reliable_general', 'calibrated_newcomer'],
    }));

    // One reliable incumbent, one seat left, and a minimum of two: the seat has
    // to go to somebody reliable, and nobody is.
    const outcome = drawPanel(
      input({ candidates: weakOnly, incumbents: [incumbent], slots: ['reliable_general'] }),
    );

    expect(outcome.ok).toBe(false);
  });
});
