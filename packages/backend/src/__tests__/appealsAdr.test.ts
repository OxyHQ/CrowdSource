import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { APPEALABLE_OUTCOMES, SEVERE_ACTIONS } from '../modules/appeals/appeal.service';
import {
  APPEAL_MIN_ROUND,
  panelSpecFor,
  SLOT_FALLBACKS,
} from '../modules/sortition/panelSpec';

/**
 * The appeals ADR, gated.
 *
 * `docs/architecture/appeals.md` records the choices §9.8 left open — which
 * outcomes are appealable, who may file, what "severe" means, how much higher the
 * appeal threshold is. Those are exactly the claims that rot, and `docs/` is the
 * one place a wrong statement can persist indefinitely: package `files` lists
 * exclude it, so no consumer ever trips over a stale claim there to force a
 * correction. `docs/README.md` states the rule this file implements — anything
 * load-bearing enough to be relied on gets a test that fails when it drifts.
 *
 * The ADR ends with a fenced `adr-claims` block of `key: value` lines. Every one
 * is compared against the code below, so editing the number in the document
 * without editing the code fails the build, and vice versa. The defences the
 * ecosystem's own lesson asks for are both here: a vacuity floor (the parser must
 * find every key it knows about) and a mutation test proving a drifted claim is
 * actually caught and named.
 */

const adrPath = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'architecture', 'appeals.md');
const adr = readFileSync(adrPath, 'utf8');

/** The `key: value` lines of the fenced `adr-claims` block. */
export function parseClaims(document: string): ReadonlyMap<string, readonly string[]> {
  const fenced = /```adr-claims\n([\s\S]*?)```/.exec(document);
  if (!fenced) throw new Error('the ADR has no fenced `adr-claims` block');

  const claims = new Map<string, readonly string[]>();
  for (const line of fenced[1].split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(':');
    if (separator < 0) throw new Error(`claim line is not 'key: value': ${trimmed}`);
    claims.set(
      trimmed.slice(0, separator).trim(),
      trimmed
        .slice(separator + 1)
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  }
  return claims;
}

const claims = parseClaims(adr);

function claim(key: string): readonly string[] {
  const value = claims.get(key);
  if (!value) throw new Error(`the ADR does not state '${key}'`);
  return value;
}

function single(key: string): string {
  const value = claim(key);
  expect(value, `'${key}' should be one value`).toHaveLength(1);
  return value[0];
}

describe('the appeals ADR states what the code does', () => {
  it('parsed the claims block, and found every key this test checks', () => {
    // The vacuity floor: a regex that matched nothing, or a block somebody
    // emptied, would make every assertion below pass while checking nothing.
    expect([...claims.keys()].sort()).toEqual([
      'appeal-min-round',
      'appeal-panel-seats',
      'appealable-outcomes',
      'appeals-reviewer-fallback',
      'community-appeal-slots',
      'severe-actions',
      'specialist-appeal-slots',
    ]);
  });

  it('§9.8: the outcomes an appeal may be filed against', () => {
    expect(claim('appealable-outcomes')).toEqual([...APPEALABLE_OUTCOMES]);
  });

  it('§9.4: the rung an appeal panel opens on, and its width', () => {
    expect(Number(single('appeal-min-round'))).toBe(APPEAL_MIN_ROUND);

    const seats = Number(single('appeal-panel-seats'));
    for (const pool of ['community', 'specialist'] as const) {
      expect(panelSpecFor(pool, APPEAL_MIN_ROUND, true).slots, pool).toHaveLength(seats);
    }
    expect(seats, '§9.4 says at least five').toBeGreaterThanOrEqual(5);
  });

  it('§8.1 and §7.5: what sits on an appeal panel in each pool', () => {
    expect([...panelSpecFor('community', APPEAL_MIN_ROUND, true).slots]).toEqual(
      claim('community-appeal-slots'),
    );
    expect([
      ...new Set(panelSpecFor('specialist', APPEAL_MIN_ROUND, true).slots),
    ]).toEqual(claim('specialist-appeal-slots'));
    expect(SLOT_FALLBACKS.appeals_reviewer).toEqual(claim('appeals-reviewer-fallback'));
  });

  it('§9.4: what counts as a severe action', () => {
    expect(claim('severe-actions')).toEqual([...SEVERE_ACTIONS].sort());
  });

  it('mutation: a claim that drifted from the code is caught, and named', () => {
    /**
     * Break each claim in turn and confirm the comparison fails. Without this the
     * file could be comparing a value to itself — the failure mode a doc gate is
     * most prone to, because both sides are strings read from somewhere.
     */
    const drifted = adr
      .replace('appeal-min-round: 2', 'appeal-min-round: 1')
      .replace('appeal-panel-seats: 5', 'appeal-panel-seats: 3')
      .replace(
        'appealable-outcomes: violation, inconclusive, insufficient_context',
        'appealable-outcomes: violation, no_violation',
      );

    const mutated = parseClaims(drifted);

    expect(Number(mutated.get('appeal-min-round')?.[0])).not.toBe(APPEAL_MIN_ROUND);
    expect(Number(mutated.get('appeal-panel-seats')?.[0])).not.toBe(
      panelSpecFor('community', APPEAL_MIN_ROUND, true).slots.length,
    );
    expect(mutated.get('appealable-outcomes')).not.toEqual([...APPEALABLE_OUTCOMES]);
  });

  it('mutation: a claims block that lost its fence is a failure, not a pass', () => {
    expect(() => parseClaims(adr.replace('```adr-claims', '```text'))).toThrow(
      /no fenced `adr-claims` block/,
    );
    expect(() => parseClaims('```adr-claims\nnot a claim line\n```')).toThrow(
      /not 'key: value'/,
    );
  });
});

describe('the ADR records the choices, not only the mechanics', () => {
  /**
   * The prose half. A number can be compared; an argument cannot, so what is
   * checked is that the argument is PRESENT — each of §9.8's open questions has a
   * section, and the three deliberate non-decisions are named. An ADR that lost
   * one of them would be an ADR somebody re-decides silently.
   */
  it('answers every question §9.8 leaves open', () => {
    for (const heading of [
      '## 1. Which decisions are appealable',
      '## 2. Who may file',
      '## 3. What "additional context" may contain',
      '## 4. What redaction means for text the subject of a case wrote',
      '## 5. How much higher the appeal threshold is',
      '## 6. Whether an Appeals Reviewer is required',
    ]) {
      expect(adr, `the ADR lost: ${heading}`).toContain(heading);
    }
  });

  it('names what it deliberately does NOT decide', () => {
    expect(adr).toContain('## Deliberately not decided here');
    for (const open of [
      'No appeal deadline',
      'No automatic re-pooling of an `escalated` decision',
      'No per-reviewer overturn rate',
    ]) {
      expect(adr, `the ADR stopped naming: ${open}`).toContain(open);
    }
  });
});
