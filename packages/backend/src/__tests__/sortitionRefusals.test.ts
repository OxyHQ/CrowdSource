import { describe, expect, it } from 'vitest';

import {
  MAX_PANEL_ROUND,
  panelSpecFor,
  satisfiesSlot,
  type SlotType,
} from '../modules/sortition/panelSpec';
import { SEED_BYTES } from '../modules/sortition/seededRandom';
import { drawPanel, type SeatedReviewer } from '../modules/sortition/weightedSampling';

/**
 * The paths that refuse, and the ones that throw.
 *
 * Every branch here is a way for the draw to say no, and none of them is
 * decoration: §7.5's legal route must have no panel to compose, §8.6's ladder
 * must run out rather than invent a round 4, and §8.3's slot requirements must
 * reject as well as accept. A refusal path nobody exercises is a refusal path
 * that turns out to be a crash on the day it first fires — which, being a
 * refusal path, is a day when something has already gone unusual.
 */

const SPEC = panelSpecFor('community', 1);

describe('§8.6’s escalation ladder', () => {
  it('defines 3, then 5, then 7 for both pools', () => {
    for (const pool of ['community', 'specialist'] as const) {
      expect(panelSpecFor(pool, 1).slots).toHaveLength(3);
      expect(panelSpecFor(pool, 2).slots).toHaveLength(5);
      expect(panelSpecFor(pool, 3).slots).toHaveLength(7);
    }
  });

  it('keeps §8.3’s reliability ratio at every round', () => {
    expect(panelSpecFor('community', 1).constraints.minReliableCount).toBe(2);
    expect(panelSpecFor('community', 2).constraints.minReliableCount).toBe(3);
    expect(panelSpecFor('community', 3).constraints.minReliableCount).toBe(4);
  });

  it('matches §8.3’s worked example at round 2, exactly', () => {
    // "2 slots: reliable general reviewers, 1: category specialist,
    //  1: intermediate reviewer, 1: newly calibrated reviewer"
    expect([...panelSpecFor('community', 2).slots].sort()).toEqual([
      'calibrated_newcomer',
      'category_specialist',
      'intermediate',
      'reliable_general',
      'reliable_general',
    ]);
  });

  it('runs out rather than inventing a round beyond the ladder', () => {
    expect(() => panelSpecFor('community', MAX_PANEL_ROUND + 1)).toThrow(
      /No panel specification/,
    );
    expect(() => panelSpecFor('community', 0)).toThrow(/No panel specification/);
  });

  /**
   * §7.5 row 1: material alleged to be child sexual abuse is never delivered to
   * a jury at all. Returning a plausible-looking specification here would be the
   * single most dangerous thing this file could do, so asking for one throws.
   */
  it('has NO specification for the legal pool, and says so loudly', () => {
    expect(() => panelSpecFor('legal', 1)).toThrow(/never drawn a jury/);
  });
});

describe('§8.3’s slot requirements reject as well as accept', () => {
  const capable = {
    state: 'specialist' as const,
    reliability: 0.95,
    completedReviewCount: 200,
    specialistCategories: ['harassment' as const],
  };

  it('keeps an experienced reviewer out of the newcomer slot', () => {
    // The slot exists for renewal (§8.3). Somebody with two hundred reviews in
    // it would defeat the purpose while looking like a filled panel.
    expect(satisfiesSlot('calibrated_newcomer', capable, 'harassment')).toBe(false);
    expect(
      satisfiesSlot('calibrated_newcomer', { ...capable, completedReviewCount: 0 }, 'harassment'),
    ).toBe(true);
  });

  it('keeps a newcomer out of the intermediate slot', () => {
    expect(
      satisfiesSlot('intermediate', { ...capable, completedReviewCount: 2 }, 'harassment'),
    ).toBe(false);
    expect(satisfiesSlot('intermediate', capable, 'harassment')).toBe(true);
  });

  it('requires the specialism to be in the case’s OWN family', () => {
    expect(satisfiesSlot('category_specialist', capable, 'harassment')).toBe(true);
    expect(satisfiesSlot('category_specialist', capable, 'child_safety')).toBe(false);
  });

  it('cannot fill a specialist slot on a case with no family to specialise in', () => {
    expect(satisfiesSlot('category_specialist', capable, null)).toBe(false);
  });

  it('holds the reliability floor for a general slot', () => {
    expect(satisfiesSlot('reliable_general', { ...capable, reliability: 0.69 }, null)).toBe(false);
    expect(satisfiesSlot('reliable_general', { ...capable, reliability: 0.7 }, null)).toBe(true);
  });

  it('holds the state floor', () => {
    expect(
      satisfiesSlot('reliable_general', { ...capable, state: 'calibrating' }, null),
    ).toBe(false);
    expect(
      satisfiesSlot('category_specialist', { ...capable, state: 'trusted' }, 'harassment'),
    ).toBe(false);
  });
});

describe('the reliability postcondition', () => {
  /**
   * The check after the loop, which the lookahead is supposed to make
   * unreachable — and which exists precisely because "supposed to" is how a
   * panel below quorum ships.
   *
   * It IS reachable, through incumbents: a panel whose sitting members have
   * since fallen below the reliability floor cannot be brought back above it by
   * filling one remaining seat. The correct answer is to refuse the draw rather
   * than to seat somebody into a panel that already fails §8.3.
   */
  it('refuses when incumbents leave the panel short however the last seat is filled', () => {
    const unreliableIncumbents: SeatedReviewer[] = [0, 1, 2].map((index) => ({
      reviewerId: `rvw_incumbent_${index}`,
      slotType: 'reliable_general' as SlotType,
      filledAs: 'reliable_general' as SlotType,
      reliability: 0.1,
      riskClusterId: null,
    }));

    const outcome = drawPanel({
      spec: panelSpecFor('community', 3),
      candidates: [
        {
          reviewerId: 'rvw_only',
          selectionWeight: 1,
          reliability: 0.95,
          riskClusterId: null,
          eligibleSlots: ['reliable_general', 'calibrated_newcomer'],
        },
      ],
      seed: Buffer.alloc(SEED_BYTES, 5),
      slots: ['calibrated_newcomer'],
      incumbents: unreliableIncumbents,
      affinityBlocked: new Map(),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('reliability_minimum');
  });
});

describe('risk clusters carried by incumbents', () => {
  it('counts an incumbent’s cluster against the cap (§8.3)', () => {
    const incumbent: SeatedReviewer = {
      reviewerId: 'rvw_incumbent',
      slotType: 'reliable_general',
      filledAs: 'reliable_general',
      reliability: 0.9,
      riskClusterId: 'cluster_a',
    };

    const outcome = drawPanel({
      spec: SPEC,
      candidates: [
        {
          reviewerId: 'rvw_same_cluster',
          selectionWeight: 1,
          reliability: 0.9,
          riskClusterId: 'cluster_a',
          eligibleSlots: ['reliable_general', 'calibrated_newcomer'],
        },
      ],
      seed: Buffer.alloc(SEED_BYTES, 5),
      slots: ['calibrated_newcomer'],
      incumbents: [incumbent],
      affinityBlocked: new Map(),
    });

    // The only candidate shares the incumbent's cluster, and §8.3 allows one
    // member per cluster — so there is nobody to seat.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('slot_unfillable');
  });
});
