import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SELECTION_WEIGHT_BOUNDS,
  SELECTION_WEIGHT_COEFFICIENTS,
  SELECTION_WEIGHT_EFFECTIVE_MAX,
  selectionWeight,
} from '../modules/sortition/selectionWeight';

/**
 * "Reputation affects eligibility and selection probability, NEVER the weight of
 * a vote" (§8.4, Appendix F) — as a checked property rather than a comment.
 *
 * This is the invariant the system CrowdSource replaces gets wrong, and it is
 * worth being precise about how. Oxy's civic validator has a single
 * `validatorWeight` function whose result feeds BOTH the selection reservoir and
 * the stake attached to the resulting vote. Nothing about that looks like a
 * mistake at the call site — it looks like reuse — which is exactly why an
 * intention to keep them apart is not enough.
 *
 * So the separation is structural, and this file is what keeps it structural as
 * the code grows:
 *
 *   1. A source scan pins WHICH modules may import the weight. Today that is the
 *      draw and nothing else. If a consensus engine ever imports it, this fails.
 *   2. A field scan asserts that the documents a vote is made of — assignments
 *      and reviews — declare no weight-shaped field at all. A consensus engine
 *      reading those rows has nothing to multiply by.
 *
 * Both carry the defences the ecosystem's own lesson asks for: a mutation test
 * that breaks the thing being guarded and confirms the check fails and names the
 * offender, and a vacuity floor so a broken traversal cannot pass silently.
 */

const backendRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(backendRoot, 'src');

interface SourceFile {
  readonly path: string;
  readonly source: string;
}

function collectSources(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : collectSources(absolute);
    }
    if (!entry.name.endsWith('.ts')) return [];
    return [
      {
        path: path.relative(backendRoot, absolute).replaceAll(path.sep, '/'),
        source: readFileSync(absolute, 'utf8'),
      },
    ];
  });
}

const sources = collectSources(sourceRoot);

/**
 * Modules allowed to import the selection weight.
 *
 * `selectionWeight.ts` DECLARES it, so it does not import it. Exactly one
 * module does: `sortition.service.ts`, which computes one per candidate for the
 * draw. Nothing that touches a vote is on this list, and adding one has to be a
 * deliberate edit here.
 */
const SELECTION_WEIGHT_IMPORTERS: readonly string[] = [
  'src/modules/sortition/sortition.service.ts',
];

/** Finds every non-test module that imports from `selectionWeight`. */
function importersOfSelectionWeight(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => /from\s+'[^']*selectionWeight'/.test(file.source))
    .map((file) => file.path)
    .sort();
}

describe('the selection weight reaches the draw and nothing else', () => {
  it('scanned the source tree', () => {
    // The vacuity floor: a traversal that returned nothing would make every
    // assertion below pass while checking no files at all.
    expect(sources.length).toBeGreaterThanOrEqual(30);
    expect(sources.map((file) => file.path)).toContain(
      'src/modules/sortition/weightedSampling.ts',
    );
    expect(sources.map((file) => file.path)).toContain('src/modules/review/review.service.ts');
  });

  it('is imported by exactly the modules that draw a panel', () => {
    expect(importersOfSelectionWeight(sources)).toEqual([...SELECTION_WEIGHT_IMPORTERS].sort());
  });

  it('mutation: a consensus-shaped module importing it would be caught, by name', () => {
    const offender: SourceFile = {
      path: 'src/modules/review/consensus.ts',
      source: "import { selectionWeight } from '../sortition/selectionWeight';",
    };

    const found = importersOfSelectionWeight([...sources, offender]);
    expect(found).toContain('src/modules/review/consensus.ts');
    expect(found).not.toEqual([...SELECTION_WEIGHT_IMPORTERS].sort());
  });
});

/**
 * Field names that would let a vote be weighted.
 *
 * Deliberately broad: `weight`, `stake`, `multiplier`, `tier`, `reputation`,
 * `karma`. A consensus engine cannot weight a vote by a number that is not on
 * the row it reads.
 */
const VOTE_WEIGHT_FIELD = /\b(selectionWeight|voteWeight|weight|stake|multiplier|trustTier|reputation|karma)\b/i;

function declaredFields(source: string): string[] {
  /**
   * The interface bodies of the file, as lines.
   *
   * A regex over the whole file would match the words in the doc comments that
   * explain why these fields are absent — which would make the check fail for
   * saying so. Only lines that look like a field declaration are considered, and
   * comment lines are dropped.
   */
  return source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .filter((line) => /^\s{2}[a-zA-Z_]+\??:\s/.test(line));
}

describe('the objects a vote is made of carry no weight', () => {
  const voteBearing = [
    'src/modules/sortition/assignment.collection.ts',
    'src/modules/review/review.collection.ts',
  ];

  it('finds the files it is about', () => {
    for (const file of voteBearing) {
      expect(sources.map((entry) => entry.path)).toContain(file);
    }
  });

  it('declares no weight-shaped field on an assignment or a review', () => {
    for (const file of voteBearing) {
      const source = sources.find((entry) => entry.path === file)?.source ?? '';
      const offending = declaredFields(source).filter((line) => VOTE_WEIGHT_FIELD.test(line));
      expect(offending, `${file} declares a weight-shaped field`).toEqual([]);
    }
  });

  it('mutation: adding one to a review would be caught', () => {
    const mutated = ['  reviewId: string;', '  voteWeight: number;', '  caseId: string;'].join(
      '\n',
    );
    const offending = declaredFields(mutated).filter((line) => VOTE_WEIGHT_FIELD.test(line));

    expect(offending).toHaveLength(1);
    expect(offending[0]).toContain('voteWeight');
  });

  it('the field scanner actually reads fields, not comments', () => {
    // Without this, a scanner whose regex never matched anything would report a
    // clean bill of health for a file full of weights.
    const sample = [
      '  /** A weight is never stored here. */',
      '  reviewId: string;',
      '  outcome: string;',
    ].join('\n');

    expect(declaredFields(sample)).toEqual(['  reviewId: string;', '  outcome: string;']);
  });

  /**
   * The audit record is the ONE exception, and it is deliberate: §8.5 requires
   * the candidate snapshot to persist what the draw saw, and re-running a draw
   * without the weights is not an audit. It is not a vote-bearing document — no
   * consensus engine reads it — so the exception is stated here rather than left
   * to look like an oversight.
   */
  it('the draw record DOES persist weights, because §8.5 requires the snapshot', () => {
    const draw = sources.find((entry) => entry.path === 'src/modules/sortition/draw.collection.ts');
    expect(draw?.source).toMatch(/selectionWeight:\s*number/);
  });
});

describe('§8.4’s formula', () => {
  const balanced = {
    categoryReliability: 0.5,
    recentCalibration: 0.5,
    personhoodConfidence: 0.5,
    availabilityScore: 0.5,
  };

  it('uses the plan’s coefficients, unchanged', () => {
    expect(SELECTION_WEIGHT_COEFFICIENTS).toEqual({
      base: 0.7,
      categoryReliability: 0.15,
      recentCalibration: 0.05,
      personhoodConfidence: 0.05,
      availabilityScore: 0.05,
    });
  });

  const worst = selectionWeight({
    categoryReliability: 0,
    recentCalibration: 0,
    personhoodConfidence: 0,
    availabilityScore: 0,
  });
  const best = selectionWeight({
    categoryReliability: 1,
    recentCalibration: 1,
    personhoodConfidence: 1,
    availabilityScore: 1,
  });

  it('clamps the floor at 0.75', () => {
    // The base alone is 0.70, so the lower clamp is what a reviewer with every
    // term at zero actually gets.
    expect(worst).toBe(SELECTION_WEIGHT_BOUNDS.MIN);
  });

  /**
   * §8.4's stated upper clamp is 1.25 and its coefficients cannot reach it:
   * 0.70 + 0.15 + 0.05 + 0.05 + 0.05 = 1.00. Asserted rather than corrected —
   * rescaling to reach 1.25 would invent a coefficient the plan does not give,
   * and it would WIDEN reputation's influence on selection, which is the
   * opposite of what §8.4 asks for.
   */
  it('documents that the plan’s upper clamp is unreachable by construction', () => {
    expect(best).toBe(SELECTION_WEIGHT_EFFECTIVE_MAX);
    expect(best).toBeLessThan(SELECTION_WEIGHT_BOUNDS.MAX);

    const coefficientSum = Object.values(SELECTION_WEIGHT_COEFFICIENTS).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(coefficientSum).toBeCloseTo(SELECTION_WEIGHT_EFFECTIVE_MAX, 10);
  });

  /**
   * The "limited" in "reputation must affect selection probability in a limited
   * way", as a number an argument can be had about.
   */
  it('makes the best-placed reviewer under 1.4× as likely as the worst', () => {
    expect(best / worst).toBeLessThan(1.4);
    expect(best / worst).toBeGreaterThan(1);
  });

  it('clamps a stored input that is out of range instead of trusting it', () => {
    // A corrupted reliability of 3 would otherwise make one reviewer a
    // near-certainty while the draw still looked random from outside.
    expect(selectionWeight({ ...balanced, categoryReliability: 3 })).toBe(
      selectionWeight({ ...balanced, categoryReliability: 1 }),
    );
    expect(selectionWeight({ ...balanced, categoryReliability: -5 })).toBe(
      selectionWeight({ ...balanced, categoryReliability: 0 }),
    );
    expect(selectionWeight({ ...balanced, availabilityScore: Number.NaN })).toBe(
      selectionWeight({ ...balanced, availabilityScore: 0 }),
    );
  });

  it('is monotonic in every term', () => {
    for (const term of [
      'categoryReliability',
      'recentCalibration',
      'personhoodConfidence',
      'availabilityScore',
    ] as const) {
      expect(selectionWeight({ ...balanced, [term]: 1 })).toBeGreaterThan(
        selectionWeight({ ...balanced, [term]: 0 }),
      );
    }
  });

  it('is stable to four places, so a persisted snapshot replays identically', () => {
    const value = selectionWeight({ ...balanced, categoryReliability: 1 / 3 });
    expect(value).toBe(Math.round(value * 10_000) / 10_000);
  });
});
