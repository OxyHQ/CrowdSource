import { createHash } from 'node:crypto';

import type { CommunityNoteRatingValue, CommunityNoteStatus } from '@oxy.so/crowdsource-contracts';

/**
 * The community-note scorer (the community notes ADR §4): matrix factorisation over one
 * tenant's ratings, the published Community Notes formulation.
 *
 *     rating(u, n) ≈ μ + i_u + i_n + f_u · f_n
 *
 * `i_n` is how helpful a note is to raters REGARDLESS of viewpoint; `f_u · f_n`
 * is the part of a rating a rater's viewpoint explains. A note is shown only when
 * its viewpoint-independent helpfulness is high AND its factor is small — raters
 * on both sides of whatever axis the ratings reveal agreed. A note one side loves
 * and the other hates gets a large `|f_n|` and a modest `i_n`, and is not shown.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. Initial factors come
 * from a hash of the ids, and the update order is fixed, so the same ratings
 * always yield the same statuses. That is what lets a revision record the
 * parameters it came from and still be recomputed and explained later.
 *
 * What it deliberately is NOT: a reputation weight. Every rating enters exactly
 * once and nothing about the rater other than the ratings they gave affects the
 * fit — the moderation invariant that reputation never weighs a vote is kept.
 */

/** Bumped whenever a constant or the fit changes, and recorded on every revision. */
export const SCORING_ALGORITHM_VERSION = 'mf-1';

export const SCORING = Object.freeze({
  /** Fewer ratings than this and a note stays `needs_ratings` whatever its fit. */
  MIN_RATINGS: 5,
  SHOWN_INTERCEPT: 0.4,
  /** Above this `|f_n|` the note is polarising, and cannot be shown. */
  MAX_FACTOR: 0.5,
  NOT_SHOWN_INTERCEPT: -0.05,
  NOT_SHOWN_SLOPE: 0.8,
  INTERCEPT_REGULARISATION: 0.15,
  FACTOR_REGULARISATION: 0.03,
  LEARNING_RATE: 0.05,
  EPOCHS: 400,
  /** Initial factor magnitude: large enough to break symmetry, small enough not to lead. */
  INITIAL_FACTOR_SCALE: 0.1,
});

export interface ScoringRating {
  readonly noteId: string;
  readonly raterPrincipalId: string;
  readonly rating: CommunityNoteRatingValue;
}

export interface NoteScore {
  readonly noteId: string;
  readonly status: Exclude<CommunityNoteStatus, 'withdrawn'>;
  readonly intercept: number;
  readonly factor: number;
  readonly ratingCount: number;
}

/** A deterministic value in [-scale, scale) from an id. */
function initialFactor(kind: 'rater' | 'note', id: string): number {
  const digest = createHash('sha256').update(`${kind}:${id}`).digest();
  const unit = digest.readUInt32BE(0) / 0x1_0000_0000;
  return (unit * 2 - 1) * SCORING.INITIAL_FACTOR_SCALE;
}

function statusFor(intercept: number, factor: number, ratingCount: number): NoteScore['status'] {
  if (ratingCount < SCORING.MIN_RATINGS) return 'needs_ratings';
  if (intercept >= SCORING.SHOWN_INTERCEPT && Math.abs(factor) < SCORING.MAX_FACTOR) return 'shown';
  if (intercept <= SCORING.NOT_SHOWN_INTERCEPT - SCORING.NOT_SHOWN_SLOPE * Math.abs(factor)) {
    return 'not_shown';
  }
  return 'needs_ratings';
}

/**
 * Scores every note that has at least one rating.
 *
 * Ratings are sorted before fitting so the result does not depend on the order
 * the database returned them in. Stochastic gradient descent over that fixed
 * order, one pass per epoch.
 */
export function scoreNotes(ratings: readonly ScoringRating[]): NoteScore[] {
  const ordered = [...ratings].sort(
    (a, b) =>
      a.noteId.localeCompare(b.noteId) || a.raterPrincipalId.localeCompare(b.raterPrincipalId),
  );

  const raterIntercept = new Map<string, number>();
  const raterFactor = new Map<string, number>();
  const noteIntercept = new Map<string, number>();
  const noteFactor = new Map<string, number>();
  const ratingCount = new Map<string, number>();

  for (const { noteId, raterPrincipalId } of ordered) {
    if (!raterFactor.has(raterPrincipalId)) {
      raterIntercept.set(raterPrincipalId, 0);
      raterFactor.set(raterPrincipalId, initialFactor('rater', raterPrincipalId));
    }
    if (!noteFactor.has(noteId)) {
      noteIntercept.set(noteId, 0);
      noteFactor.set(noteId, initialFactor('note', noteId));
    }
    ratingCount.set(noteId, (ratingCount.get(noteId) ?? 0) + 1);
  }

  const {
    LEARNING_RATE: rate,
    INTERCEPT_REGULARISATION: lambdaI,
    FACTOR_REGULARISATION: lambdaF,
  } = SCORING;
  let globalIntercept = 0;

  for (let epoch = 0; epoch < SCORING.EPOCHS; epoch += 1) {
    for (const { noteId, raterPrincipalId, rating } of ordered) {
      const target = rating === 'helpful' ? 1 : 0;
      const iu = raterIntercept.get(raterPrincipalId) as number;
      const fu = raterFactor.get(raterPrincipalId) as number;
      const inote = noteIntercept.get(noteId) as number;
      const fn = noteFactor.get(noteId) as number;

      const error = target - (globalIntercept + iu + inote + fu * fn);

      globalIntercept += rate * (error - lambdaI * globalIntercept);
      raterIntercept.set(raterPrincipalId, iu + rate * (error - lambdaI * iu));
      noteIntercept.set(noteId, inote + rate * (error - lambdaI * inote));
      raterFactor.set(raterPrincipalId, fu + rate * (error * fn - lambdaF * fu));
      noteFactor.set(noteId, fn + rate * (error * fu - lambdaF * fn));
    }
  }

  return [...noteFactor.keys()].sort().map((noteId) => {
    const intercept = noteIntercept.get(noteId) as number;
    const factor = noteFactor.get(noteId) as number;
    const count = ratingCount.get(noteId) as number;
    return { noteId, intercept, factor, ratingCount: count, status: statusFor(intercept, factor, count) };
  });
}
