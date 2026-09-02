import type { TaxonomyFamily } from '@oxyhq/crowdsource-contracts';

/**
 * Who owns which `(family, language)` cell of the global reviewer space.
 *
 * ## The problem this file exists to solve
 *
 * A case belongs to one tenant; a reviewer belongs to none. `candidatePool`
 * draws from EVERY reviewer profile in the database regardless of tenant, by
 * design — juries are cross-tenant on purpose. So a pool one test file creates
 * is a candidate for every case every other file opens against the same replica
 * set, and the only thing keeping two suites out of each other's panels is
 * §8.2's eligibility rule: a reviewer must accept every family a case alleges
 * AND hold its language. Two axes, both hard walls, so a file that picks a
 * `(family, language)` pair nobody else uses cannot be drawn into anybody else's
 * jury and cannot draw anybody else into its own.
 *
 * That rule was real and it was written down — in a doc comment at the top of
 * `reviewers.ts` and again, per file, in each suite's own header. Nothing
 * checked it. `reviewerAppContract.integration.test.ts` and
 * `appeals.integration.test.ts` both claimed `(harassment, ast)` exclusively,
 * each comment asserting the pair was unique, and the suite stayed green for as
 * long as the two files happened to run in an order where it did not matter.
 * The failure it was waiting to produce is not a subtle one: the app-contract
 * file's `beforeAll` draws a three-seat panel and needs one seat to belong to a
 * reviewer IT created, because every later test acts as that person. Seat three
 * of the appeals file's reviewers instead and the whole suite 404s, in a file
 * that changed nothing, on a pull request that only added a test elsewhere.
 *
 * ## Why a registry rather than a better comment
 *
 * A convention that lives in prose is enforced by whoever last read the prose.
 * The two files above were each written by someone who had read it and believed
 * they were obeying it — the information needed to notice was spread across
 * eleven files, so nobody had it. Centralising the assignment makes the
 * conflict a local, visible fact: two entries below, side by side, with the same
 * pair. `reviewerAxes.test.ts` then turns "visible" into "impossible", and does
 * it with a completeness floor rather than a pattern match, so a new file that
 * names its constants something else cannot slip past the way
 * `APPEALED_LANGUAGE` would have slipped past any scan looking for `LANGUAGE`.
 *
 * ## How to add a suite
 *
 * Add an entry keyed by the test file's basename, give each block that needs its
 * own pool a named slot, and read the values through `reviewerAxesFor` — never
 * re-declare a family or language literal in the test file, because a literal is
 * exactly the thing this file exists to stop two suites from choosing
 * independently. Adding a slot that duplicates another file's pair fails
 * `reviewerAxes.test.ts`, by name, before it can fail a panel draw.
 *
 * ## What this registry does NOT know
 *
 * It records what each suite DECLARES, so it is only as good as the declarations
 * — a file that hard-coded a language behind the registry's back would be
 * invisible to it. That hole is closed from the other side: the gate asserts
 * that every file which seeds a globally drawable reviewer profile has an entry
 * here at all, so the way to be missing from the registry is to not seed
 * reviewers.
 */

/**
 * One cell of the global reviewer space: the pair §8.2 checks, together.
 *
 * Both fields are needed to say anything useful. `violence` alone is claimed
 * twice — by one block of `sortitionPanel` and by `specialistRoute` — and that is
 * fine, because they hold different languages.
 */
export interface ReviewerAxis {
  readonly family: TaxonomyFamily;
  /** A BCP 47 tag, matched by `eligibility.ts` as an exact array-contains. */
  readonly language: string;
}

/**
 * The cell every case falls into when a suite configures nothing.
 *
 * `sampleEnvelope` in `support/tenants.ts` defaults to
 * `harassment.targeted_abuse` in `es`, so roughly half the suite ingests reports
 * into this one cell without ever mentioning it — `caseAccess`,
 * `caseDeduplication`, `reportIngestion`, the webhook files, the console files.
 * None of them expects a panel. A reviewer pool created here would open juries
 * underneath all of them at once, which is why no file may claim it and why the
 * gate checks that separately from the file-against-file comparison: the
 * conflicting party is not a file, it is a default.
 */
export const DEFAULT_CASE_AXIS: ReviewerAxis = Object.freeze({
  family: 'harassment',
  language: 'es',
});

export type ReviewerAxisSlots = Readonly<Record<string, ReviewerAxis>>;

/**
 * The assignment itself, keyed by test file basename.
 *
 * Slots exist per BLOCK, not per file, and that is deliberate beyond isolation:
 * `POST /assignments/next` hands back the assignment a reviewer was given
 * LONGEST AGO (§8.7), so a juror drawn for two of a file's cases votes on the
 * wrong one. A block that needs an unambiguous juror needs its own cell.
 *
 * Entries also exist for files that open cases in a cell and deliberately leave
 * it unserved. Those files seed no reviewers and are not required to be here,
 * but their reservation is worth defending: the assertion is that no panel ever
 * forms, and it would decay into a tautology the day another suite created a
 * pool in the same cell.
 */
const AXES_BY_TEST_FILE: Readonly<Record<string, ReviewerAxisSlots>> = {
  'appeals.integration.test.ts': {
    appealed: { family: 'harassment', language: 'ast' },
    cleared: { family: 'harassment', language: 'sc' },
    refused: { family: 'harassment', language: 'vec' },
    /** Reserved: the case that must stay undecided because nobody can serve it. */
    unserved: { family: 'harassment', language: 'lij' },
    replay: { family: 'harassment', language: 'lmo' },
    race: { family: 'harassment', language: 'fur' },
    keyRace: { family: 'harassment', language: 'rm' },
  },

  'consensusDecision.integration.test.ts': {
    unanimous: { family: 'integrity', language: 'gl' },
    ladder: { family: 'integrity', language: 'ca' },
    recusal: { family: 'integrity', language: 'br' },
    dimensions: { family: 'integrity', language: 'an' },
  },

  /**
   * Seeds nothing. Both cells are reservations: `child_safety` is §7.5 row 1 and
   * never reaches a community jury at all, and the `commerce` case is an
   * ordinary one deliberately opened where no pool exists. `sortitionPanel` owns
   * `commerce` in `es`, so this file separates on the language.
   */
  'consensusRefusals.integration.test.ts': {
    legal: { family: 'child_safety', language: 'es' },
    unserved: { family: 'commerce', language: 'oc' },
  },

  'decisionRevision.integration.test.ts': {
    revision: { family: 'integrity', language: 'eu' },
  },

  'postgresCollectionAdapter.realdb.test.ts': {
    adapter: { family: 'harassment', language: 'gd' },
  },

  /**
   * `mwl` replaced `ast`, which this file and `appeals` both claimed. Mirandese
   * is not chosen for flavour: `eligibility.ts` matches `languages` as an exact
   * array-contains, so isolation needs a tag that is not merely a distinct
   * REGION of one already in use — `ast` and `ast-ES` would not collide, but a
   * reader would reasonably assume they did, and a rule people misread is the
   * one that breaks next.
   */
  'reviewerAppContract.integration.test.ts': {
    contract: { family: 'harassment', language: 'mwl' },
  },

  'reviewerFailureModes.integration.test.ts': {
    failureModes: { family: 'privacy', language: 'es' },
  },

  /**
   * The suite that does not call the fixture helpers at all.
   *
   * Its reviewers are created by driving the real onboarding routes, and one of
   * them passes calibration and reaches `community` — a globally drawable
   * profile, identical in every way that matters to one `createReviewer` would
   * have inserted. It held `(privacy, es)`, the same cell as
   * `reviewerFailureModes`, and the two stayed apart only because that file's
   * cases are `sensitive` and these reviewers carry no consent. That is a real
   * wall but a one-directional one — consent is a floor, not a ceiling, so a
   * consenting reviewer is eligible for a `standard` case — and it held the rest
   * of the way only because this file happens to open no cases at all. Giving
   * the suite its own language makes it hold by the same two-axis rule as
   * everything else, in both directions, without depending on what either file
   * happens not to do.
   */
  'reviewerOnboarding.integration.test.ts': {
    onboarding: { family: 'privacy', language: 'ext' },
    /** A second tag, so the preferences round-trip still asserts on a LIST. */
    secondary: { family: 'privacy', language: 'scn' },
  },

  /**
   * The one file that separates on the FAMILY and keeps one language throughout.
   * It needs seven cells — six blocks with their own pool, plus the reserved one
   * below — and taking a language tag for each would have consumed a third of
   * the tags in the registry to buy isolation the family axis already provides.
   */
  'sortitionPanel.integration.test.ts': {
    panel: { family: 'commerce', language: 'es' },
    voting: { family: 'platform_abuse', language: 'es' },
    recusal: { family: 'other', language: 'es' },
    parties: { family: 'violence', language: 'es' },
    tight: { family: 'self_harm', language: 'es' },
    expiry: { family: 'sexual_content', language: 'es' },
    /**
     * The undersized-pool refusal and the mutation control that proves it is a
     * refusal rather than a broken selector. No other file may allege `hate`,
     * because the refusal has to be caused by the missing pool.
     */
    starved: { family: 'hate', language: 'es' },
  },

  'specialistRoute.integration.test.ts': {
    specialist: { family: 'violence', language: 'fy' },
  },
};

export const REVIEWER_AXES: Readonly<Record<string, ReviewerAxisSlots>> =
  Object.freeze(AXES_BY_TEST_FILE);

/**
 * The registry entry for the calling test file, looked up by its own module URL.
 *
 * Taking `import.meta.url` rather than a basename string is what makes the
 * lookup unfakeable: a file cannot read another file's cells by mistyping a key,
 * which would reintroduce exactly the collision this registry removes while
 * leaving the gate's file-against-file comparison satisfied.
 */
export function reviewerAxesFor(testFileUrl: string): (slot: string) => ReviewerAxis {
  const basename = testFileUrl.split('/').pop() ?? testFileUrl;
  const slots = REVIEWER_AXES[basename];

  if (slots === undefined) {
    throw new Error(
      `reviewerAxes: '${basename}' has no entry in REVIEWER_AXES. A file that ` +
        'seeds reviewer profiles must claim its (family, language) cells there, ' +
        'because reviewer profiles are global and nothing else keeps two suites ' +
        "out of each other's panels.",
    );
  }

  return (slot) => {
    const axis = slots[slot];
    if (axis === undefined) {
      throw new Error(
        `reviewerAxes: '${basename}' has no slot '${slot}'. Declared slots: ` +
          `${Object.keys(slots).join(', ')}.`,
      );
    }
    return axis;
  };
}
