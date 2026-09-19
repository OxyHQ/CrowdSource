import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_NOTE_ASSIGNMENT_BATCH_MAX,
  COMMUNITY_NOTE_STATUSES,
  COMMUNITY_NOTE_TEXT_MAX_LENGTH,
} from '@crowdsource.you/contracts';

import { parseClaims } from './appealsAdr.test';
import { ASSIGNMENT_TTL_MS, NOTES_PER_AUTHOR_PER_DAY } from '../modules/communityNotes/communityNotes.service';
import { SCORING, SCORING_ALGORITHM_VERSION } from '../modules/communityNotes/scoring';

/**
 * The community notes ADR, gated like the appeals ADR: every line of its
 * `adr-claims` block is compared with the code, so a threshold edited in one place
 * and not the other fails the build.
 */

const adrPath = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'architecture', 'community-notes.md');
const claims = parseClaims(readFileSync(adrPath, 'utf8'));

function single(key: string): string {
  const value = claims.get(key);
  if (!value) throw new Error(`the ADR does not state '${key}'`);
  expect(value, `'${key}' should be one value`).toHaveLength(1);
  return value[0] as string;
}

const EXPECTED: Readonly<Record<string, () => unknown>> = {
  'scoring-algorithm-version': () => SCORING_ALGORITHM_VERSION,
  'min-ratings': () => SCORING.MIN_RATINGS,
  'shown-intercept': () => SCORING.SHOWN_INTERCEPT,
  'max-factor': () => SCORING.MAX_FACTOR,
  'not-shown-intercept': () => SCORING.NOT_SHOWN_INTERCEPT,
  'not-shown-slope': () => SCORING.NOT_SHOWN_SLOPE,
  'notes-per-author-per-day': () => NOTES_PER_AUTHOR_PER_DAY,
  'assignment-ttl-hours': () => ASSIGNMENT_TTL_MS / 3_600_000,
  'assignment-batch-max': () => COMMUNITY_NOTE_ASSIGNMENT_BATCH_MAX,
  'note-text-max-length': () => COMMUNITY_NOTE_TEXT_MAX_LENGTH,
};

describe('the community notes ADR states what the code does', () => {
  it('parsed the claims block, and found every key this test checks', () => {
    expect([...claims.keys()].sort()).toEqual([...Object.keys(EXPECTED), 'note-statuses'].sort());
  });

  it.each(Object.entries(EXPECTED))('%s', (key, actual) => {
    expect(single(key)).toBe(String(actual()));
  });

  it('lists the statuses a note can have', () => {
    expect(claims.get('note-statuses')).toEqual([...COMMUNITY_NOTE_STATUSES]);
  });

  it('catches a drifted claim and names it', () => {
    const drifted = parseClaims('```adr-claims\nmin-ratings: 6\n```');
    expect(drifted.get('min-ratings')).toEqual(['6']);
    expect(drifted.get('min-ratings')?.[0]).not.toBe(String(SCORING.MIN_RATINGS));
  });
});
