import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LanguageTagSchema, TAXONOMY_FAMILIES } from '@oxyhq/crowdsource-contracts';

import { DEFAULT_CASE_AXIS, REVIEWER_AXES, type ReviewerAxis } from './support/reviewerAxes';

/**
 * The gate that makes `support/reviewerAxes.ts` a rule rather than a convention.
 *
 * ## What it has to prove, and why distinctness alone is not it
 *
 * Reviewer profiles are global (see the registry's own header), so isolation
 * between concurrently-written suites rests entirely on each one holding a
 * `(family, language)` cell no other file holds. "All declared cells are
 * distinct" is the obvious check and, on its own, is nearly worthless: it is
 * trivially satisfied by a registry that has forgotten a file. The collision it
 * would have had to catch — `reviewerAppContract` and `appeals` both on
 * `(harassment, ast)` — was not caused by anyone declaring a duplicate. It was
 * caused by two files declaring their axes privately, where no single reader
 * could see both.
 *
 * So COMPLETENESS is the load-bearing assertion here and distinctness is what
 * completeness makes meaningful. Every file that puts a globally drawable
 * reviewer profile into the database must appear in the registry; only then does
 * "no two entries collide" say anything about the suite rather than about the
 * registry.
 *
 * ## Why the scan is not a pattern match on constant names
 *
 * The tempting shape — grep the test files for `LANGUAGE = '...'` and compare —
 * cannot distinguish a file that has no axes from a file whose axes it failed to
 * parse. `appeals.integration.test.ts` calls its languages `APPEALED_LANGUAGE`,
 * `CLEARED_LANGUAGE`, `REFUSED_LANGUAGE`; a scan keyed on `LANGUAGE =` finds
 * nothing in `reviewerOnboarding.integration.test.ts`, which sends its languages
 * through an HTTP body. Both read as "clean". This scan asks a different
 * question — does this file CREATE reviewers — whose two answers have different
 * consequences, and it answers it on the four routes by which a profile can
 * actually reach the collection.
 *
 * ## The vacuity floors
 *
 * A directory traversal that returns nothing satisfies every for-loop below. The
 * counts are asserted first, so a broken `readdirSync`, a moved `__tests__`
 * directory or a predicate that stopped matching fails here loudly instead of
 * turning the whole file green.
 */

const TESTS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/**
 * This file is excluded from its own scan: it necessarily quotes every marker
 * below, so it would otherwise match its own predicate and demand a registry
 * entry for a file that seeds nothing.
 */
const SELF = path.basename(fileURLToPath(import.meta.url));

/**
 * The four ways a globally drawable reviewer profile reaches the collection.
 *
 * The first three are direct writes. The fourth is `reviewerOnboarding`, which
 * touches none of the fixture helpers and creates its reviewers by driving the
 * real routes — `POST /v1/reviewer/preferences` is the one that writes
 * `categories` and `languages`, which ARE the two axes. `GET /v1/reviewer/profile`
 * is deliberately not a marker: it materialises a profile with no categories at
 * all, and §8.2 can never draw such a person, so treating it as seeding would
 * pull in `cors.test.ts` (an OPTIONS preflight against that path) and make the
 * completeness assertion a source of false alarms — the fastest way to get a
 * gate switched off.
 */
const SEEDING_MARKERS = [
  'createReviewer(',
  'createReviewerPool(',
  'reviewerProfiles.insertOne(',
  'reviewerProfiles.insertMany(',
  '/v1/reviewer/preferences',
] as const;

/**
 * Floors, not targets. `TEST_FILE_FLOOR` sits comfortably below the current
 * count so ordinary additions and removals do not touch it; it exists so a
 * traversal returning zero files cannot pass. `SEEDING_FILE_FLOOR` is the exact
 * current count on purpose — the failure it guards against is a predicate that
 * silently stops recognising ONE of the five routes above, which would leave a
 * file creating reviewers outside the registry with everything still green.
 * Deleting a reviewer suite is a deliberate act and lowering this with it is
 * part of that act.
 */
const TEST_FILE_FLOOR = 55;
const SEEDING_FILE_FLOOR = 8;

function cellOf(axis: ReviewerAxis): string {
  return `${axis.family}|${axis.language}`;
}

const testFiles = readdirSync(TESTS_DIRECTORY)
  .filter((entry) => entry.endsWith('.test.ts') && entry !== SELF)
  .sort();

const seedingFiles = testFiles.filter((file) => {
  const source = readFileSync(path.join(TESTS_DIRECTORY, file), 'utf8');
  return SEEDING_MARKERS.some((marker) => source.includes(marker));
});

describe('the reviewer axis registry is complete', () => {
  it('scanned a plausible number of test files', () => {
    expect(
      testFiles.length,
      `scanned only ${testFiles.length} test files in ${TESTS_DIRECTORY}; the ` +
        'traversal is broken, and every assertion below it is vacuous',
    ).toBeGreaterThanOrEqual(TEST_FILE_FLOOR);
  });

  it('recognised every suite that seeds a globally drawable reviewer', () => {
    expect(
      seedingFiles.length,
      `only ${seedingFiles.length} of ${testFiles.length} test files matched a ` +
        `seeding marker (${SEEDING_MARKERS.join(', ')}); a suite that creates ` +
        'reviewers is no longer being recognised, so the completeness check ' +
        `below cannot see it. Matched: ${seedingFiles.join(', ')}`,
    ).toBeGreaterThanOrEqual(SEEDING_FILE_FLOOR);
  });

  it('gives every seeding suite an entry in REVIEWER_AXES', () => {
    const missing = seedingFiles.filter((file) => REVIEWER_AXES[file] === undefined);

    expect(
      missing,
      `${missing.join(', ')} creates reviewer profiles, which are GLOBAL, but ` +
        'declares no (family, language) cells in support/reviewerAxes.ts. Until ' +
        "it does, nothing stops it from drawing another suite's jury or being " +
        'drawn into one — the failure surfaces as a panel seated with the wrong ' +
        "people in a file that changed nothing, and only when the suite's " +
        'execution order shifts.',
    ).toEqual([]);
  });

  it('has no entry for a file that no longer exists', () => {
    const orphans = Object.keys(REVIEWER_AXES).filter((file) => !testFiles.includes(file));

    expect(
      orphans,
      `${orphans.join(', ')} is claimed in REVIEWER_AXES but is not a test file ` +
        'in this directory. A renamed or deleted suite leaves its cells reserved ' +
        'against nobody, which shrinks the space every other suite can draw from.',
    ).toEqual([]);
  });
});

describe('no two suites can be drawn into each other’s panels', () => {
  it('assigns every (family, language) cell to at most one file', () => {
    const owners = new Map<string, string>();
    const collisions: string[] = [];

    for (const [file, slots] of Object.entries(REVIEWER_AXES)) {
      for (const [slot, axis] of Object.entries(slots)) {
        const cell = cellOf(axis);
        const owner = owners.get(cell);

        if (owner === undefined) {
          owners.set(cell, `${file} (${slot})`);
          continue;
        }

        collisions.push(
          `(${axis.family}, ${axis.language}) is claimed by BOTH ${owner} and ` +
            `${file} (${slot})`,
        );
      }
    }

    expect(
      collisions,
      `${collisions.join('; ')}. §8.2 makes a reviewer eligible for a case when ` +
        'they accept its family AND hold its language, so two suites sharing a ' +
        "cell share a candidate pool: either can seat the other's reviewers, and " +
        'which one does depends on the order the files happen to run in.',
    ).toEqual([]);
  });

  it('leaves the default case cell unclaimed', () => {
    const defaultCell = cellOf(DEFAULT_CASE_AXIS);
    const claimants = Object.entries(REVIEWER_AXES).flatMap(([file, slots]) =>
      Object.entries(slots)
        .filter(([, axis]) => cellOf(axis) === defaultCell)
        .map(([slot]) => `${file} (${slot})`),
    );

    expect(
      claimants,
      `${claimants.join(', ')} claims (${DEFAULT_CASE_AXIS.family}, ` +
        `${DEFAULT_CASE_AXIS.language}), which is what sampleEnvelope produces ` +
        'when a suite configures nothing. Most of the suite ingests reports into ' +
        'that cell without mentioning it and expects no panel; a pool there opens ' +
        'juries underneath all of them at once.',
    ).toEqual([]);
  });
});

describe('every declared cell is one the product could actually match', () => {
  it('names a real taxonomy family', () => {
    for (const [file, slots] of Object.entries(REVIEWER_AXES)) {
      for (const [slot, axis] of Object.entries(slots)) {
        expect(TAXONOMY_FAMILIES, `${file} (${slot})`).toContain(axis.family);
      }
    }
  });

  it('names a language tag the envelope contract accepts', () => {
    for (const [file, slots] of Object.entries(REVIEWER_AXES)) {
      for (const [slot, axis] of Object.entries(slots)) {
        expect(
          LanguageTagSchema.safeParse(axis.language).success,
          `${file} (${slot}) declares '${axis.language}', which LanguageTagSchema ` +
            'rejects — a case could never be ingested in it, so the pool would sit ' +
            'in a cell no case can reach',
        ).toBe(true);
      }
    }
  });

  it('does not give one file the same cell twice under two names', () => {
    for (const [file, slots] of Object.entries(REVIEWER_AXES)) {
      const cells = Object.values(slots).map(cellOf);

      expect(
        new Set(cells).size,
        `${file} declares ${cells.length} slots covering only ` +
          `${new Set(cells).size} distinct cells. Two slots on one cell share a ` +
          'pool, and §8.7 hands a juror the assignment they were given longest ' +
          'ago — so a reviewer drawn for both blocks votes on the wrong case.',
      ).toBe(cells.length);
    }
  });
});
