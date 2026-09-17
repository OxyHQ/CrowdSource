import { describe, expect, it } from 'vitest';

import {
  SCORING,
  SCORING_ALGORITHM_VERSION,
  scoreNotes,
  type ScoringRating,
} from '../modules/communityNotes/scoring';

/**
 * the community notes ADR §4: a note is shown only when raters of DIFFERENT viewpoints agree it
 * is helpful. These build two camps whose disagreement on partisan notes reveals
 * the viewpoint axis, then check how notes on either side of it are scored.
 */

const LEFT = Array.from({ length: 8 }, (_, index) => `left_${index}`);
const RIGHT = Array.from({ length: 8 }, (_, index) => `right_${index}`);

function camps(): ScoringRating[] {
  const ratings: ScoringRating[] = [];
  const rate = (noteId: string, raters: readonly string[], helpful: boolean) => {
    for (const raterPrincipalId of raters) {
      ratings.push({ noteId, raterPrincipalId, rating: helpful ? 'helpful' : 'not_helpful' });
    }
  };
  for (let index = 0; index < 6; index += 1) {
    rate(`partisan_left_${index}`, LEFT, true);
    rate(`partisan_left_${index}`, RIGHT, false);
    rate(`partisan_right_${index}`, LEFT, false);
    rate(`partisan_right_${index}`, RIGHT, true);
  }
  rate('bridging', [...LEFT, ...RIGHT], true);
  rate('unhelpful', [...LEFT, ...RIGHT], false);
  rate('too_few', LEFT.slice(0, SCORING.MIN_RATINGS - 1), true);
  return ratings;
}

const byNote = (ratings: readonly ScoringRating[]) =>
  new Map(scoreNotes(ratings).map((score) => [score.noteId, score]));

describe('the community note scorer', () => {
  it('shows a note both camps find helpful', () => {
    const bridging = byNote(camps()).get('bridging');
    expect(bridging?.status).toBe('shown');
    expect(bridging?.intercept).toBeGreaterThanOrEqual(SCORING.SHOWN_INTERCEPT);
    expect(Math.abs(bridging?.factor ?? 1)).toBeLessThan(SCORING.MAX_FACTOR);
  });

  it('does not show a note only one camp finds helpful, however many ratings it has', () => {
    const scores = byNote(camps());
    for (const noteId of ['partisan_left_0', 'partisan_right_3']) {
      const score = scores.get(noteId);
      expect(score?.ratingCount).toBe(16);
      expect(score?.status).not.toBe('shown');
      expect(Math.abs(score?.factor ?? 0)).toBeGreaterThanOrEqual(SCORING.MAX_FACTOR);
    }
  });

  it('marks a note both camps find unhelpful as not shown', () => {
    expect(byNote(camps()).get('unhelpful')?.status).toBe('not_shown');
  });

  it('keeps a note with too few ratings as needs_ratings whatever its fit', () => {
    const tooFew = byNote(camps()).get('too_few');
    expect(tooFew?.ratingCount).toBe(SCORING.MIN_RATINGS - 1);
    expect(tooFew?.status).toBe('needs_ratings');
  });

  it('is deterministic and independent of the order ratings arrive in', () => {
    const ratings = camps();
    const forward = scoreNotes(ratings);
    const reversed = scoreNotes([...ratings].reverse());
    expect(reversed).toEqual(forward);
    expect(scoreNotes(ratings)).toEqual(forward);
  });

  it('scores nothing when there are no ratings, and carries a version', () => {
    expect(scoreNotes([])).toEqual([]);
    expect(SCORING_ALGORITHM_VERSION).toMatch(/^mf-\d+$/);
  });
});
