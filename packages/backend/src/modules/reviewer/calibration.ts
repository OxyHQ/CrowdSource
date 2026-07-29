import {
  taxonomyFamilyOf,
  type TaxonomyCode,
  type TaxonomyFamily,
} from '@oxyhq/crowdsource-contracts';

/**
 * Training and calibration (§8.1, §9.7) — the gate between "has an account" and
 * "may decide a real case".
 *
 * §8.1 gives `calibrating` a precise meaning: the reviewer receives training and
 * gold cases, and their answers do not resolve real cases. §9.7 adds the quality
 * rules — gold items indistinguishable from real material, reliability updated
 * from gold cases rather than from agreeing with the majority, and a minority
 * never punished automatically.
 *
 * The calibration SET lives here as a source constant, for the same reason
 * `policyBaseline.ts` does: it is immutable published content, it must be
 * identical on every deployment, and a set an operator can edit at runtime is a
 * set somebody can weaken until everybody passes. The items are synthetic and
 * deliberately mild — calibration is where a reviewer learns the taxonomy, and
 * §13.7 is clear that nobody consents to distressing material by signing up.
 *
 * What is NOT here: gold items injected into the live queue. §9.7 wants them
 * indistinguishable from real cases, which means they travel through the case
 * and assignment machinery, and that belongs to the phase that owns the review
 * flow. This module covers the entry gate; `recordCalibrationOutcome` in
 * `reviewer.service.ts` is where a later gold result updates reliability.
 */

/** One training module a reviewer works through before calibrating (§8.1). */
export interface TrainingModule {
  readonly moduleId: string;
  readonly title: string;
  /** Which part of the taxonomy the module covers, for the reviewer app's order. */
  readonly families: readonly TaxonomyFamily[];
}

/**
 * The modules, in the order they are taken.
 *
 * Every module must be completed before calibration opens: a reviewer who has
 * only read the harassment module and then calibrates on privacy items is being
 * tested on material nobody showed them, and §9.7 asks us to distinguish
 * reasonable error from random answering — which is impossible if the error was
 * ours.
 */
export const TRAINING_MODULES: readonly TrainingModule[] = Object.freeze([
  Object.freeze({
    moduleId: 'foundations',
    title: 'What a report is, and what a decision is',
    families: Object.freeze([]),
  }),
  Object.freeze({
    moduleId: 'taxonomy',
    title: 'Reading the universal taxonomy',
    families: Object.freeze<TaxonomyFamily[]>(['harassment', 'hate', 'integrity']),
  }),
  Object.freeze({
    moduleId: 'evidence',
    title: 'Judging material, not people',
    families: Object.freeze<TaxonomyFamily[]>(['privacy', 'platform_abuse']),
  }),
  Object.freeze({
    moduleId: 'wellbeing',
    title: 'Consent, exposure limits and stepping away',
    families: Object.freeze([]),
  }),
]);

const TRAINING_MODULE_IDS: ReadonlySet<string> = new Set(
  TRAINING_MODULES.map((module) => module.moduleId),
);

export function isTrainingModuleId(value: string): boolean {
  return TRAINING_MODULE_IDS.has(value);
}

/** True when every module has been completed. */
export function hasCompletedTraining(completed: readonly string[]): boolean {
  const done = new Set(completed);
  return TRAINING_MODULES.every((module) => done.has(module.moduleId));
}

/**
 * One calibration item: synthetic material with a known correct answer.
 *
 * `expectedViolation` and `expectedCode` are both graded, because §9.2's form is
 * two steps and a reviewer can get either half wrong independently — classifying
 * material correctly and then misapplying the rule is a different error from
 * mislabelling what the material is, and only the second says anything about
 * their grasp of the taxonomy.
 */
export interface CalibrationItem {
  readonly itemId: string;
  /** Short synthetic text. Never real reported material, never sensitive. */
  readonly text: string;
  readonly expectedViolation: boolean;
  /** The code a correct answer names. Absent when the answer is "no violation". */
  readonly expectedCode?: TaxonomyCode;
}

/**
 * The calibration set.
 *
 * Half the items are NOT violations, and that is the design. A set where every
 * item is a violation trains the answer "yes" and measures nothing; §9.7's
 * concern about telling reasonable error apart from random voting only has an
 * answer if a reviewer can be wrong in both directions.
 */
export const CALIBRATION_ITEMS: readonly CalibrationItem[] = Object.freeze([
  Object.freeze<CalibrationItem>({
    itemId: 'cal_harassment_1',
    text: 'A reply that repeats a stranger’s username twenty times and tells them to leave the site or be found.',
    expectedViolation: true,
    expectedCode: 'harassment.targeted_abuse',
  }),
  Object.freeze<CalibrationItem>({
    itemId: 'cal_criticism_1',
    text: 'A long, angry post arguing that a public official’s housing policy is incompetent and should be reversed.',
    expectedViolation: false,
  }),
  Object.freeze<CalibrationItem>({
    itemId: 'cal_privacy_1',
    text: 'A post listing another person’s home address and the hours they are usually out.',
    expectedViolation: true,
    expectedCode: 'harassment.doxxing',
  }),
  Object.freeze<CalibrationItem>({
    itemId: 'cal_satire_1',
    text: 'An obvious parody account of a fictional company, labelled as parody in the post itself.',
    expectedViolation: false,
  }),
  Object.freeze<CalibrationItem>({
    itemId: 'cal_integrity_1',
    text: 'A post promising to double any amount of currency sent to an address, linking to a payment page.',
    expectedViolation: true,
    expectedCode: 'integrity.scam',
  }),
  Object.freeze<CalibrationItem>({
    itemId: 'cal_spam_1',
    text: 'The same promotional message posted under forty unrelated threads within one minute.',
    expectedViolation: true,
    expectedCode: 'integrity.spam',
  }),
  Object.freeze<CalibrationItem>({
    itemId: 'cal_disagreement_1',
    text: 'Two accounts arguing rudely about a football result, insulting each other’s teams.',
    expectedViolation: false,
  }),
  Object.freeze<CalibrationItem>({
    itemId: 'cal_hate_1',
    text: 'A post saying that people of a named nationality are vermin and should be driven out.',
    expectedViolation: true,
    expectedCode: 'hate.dehumanization',
  }),
]);

const CALIBRATION_ITEM_BY_ID: ReadonlyMap<string, CalibrationItem> = new Map(
  CALIBRATION_ITEMS.map((item) => [item.itemId, item]),
);

/** What a reviewer submits for one item. */
export interface CalibrationAnswer {
  readonly itemId: string;
  readonly violation: boolean;
  /** Required when `violation` is true; §9.2's second step. */
  readonly code?: TaxonomyCode;
}

/** The pass mark. Six of eight — a reviewer may be wrong twice and still pass. */
export const CALIBRATION_PASS_SCORE = 0.75;

/**
 * How long a passed calibration remains current (§8.2, "formación y calibración
 * vigentes"). After this the reviewer re-calibrates rather than being dropped:
 * expiry is a prompt, not a punishment.
 */
export const CALIBRATION_VALID_DAYS = 180;

/**
 * The window in which a calibration counts as RECENT for §8.4's
 * `recentCalibration` term. Shorter than validity on purpose: a reviewer
 * calibrated last week and one calibrated five months ago are both eligible, and
 * only one of them should be drawn slightly more often.
 */
export const CALIBRATION_RECENT_DAYS = 30;

export interface CalibrationResult {
  readonly passed: boolean;
  /** Fraction of items answered correctly, in [0, 1]. */
  readonly score: number;
  /**
   * Per-family accuracy, seeding `reliabilityByCategory`.
   *
   * A family only appears when the set actually tested it, so a reviewer never
   * starts with a reliability figure for a category nobody measured — which
   * would be a number invented by the system and then used to decide who judges.
   */
  readonly reliabilityByFamily: Readonly<Record<string, number>>;
  /** The items answered incorrectly, so the app can explain the result. */
  readonly incorrectItemIds: readonly string[];
}

function isCorrect(item: CalibrationItem, answer: CalibrationAnswer): boolean {
  if (answer.violation !== item.expectedViolation) return false;
  // "No violation" is a complete answer; there is no code to agree about.
  if (!item.expectedViolation) return true;
  return answer.code === item.expectedCode;
}

/**
 * Grades a calibration attempt.
 *
 * An unanswered item counts as incorrect rather than being skipped: a partial
 * submission that only answered the easy items would otherwise score 100%.
 */
export function gradeCalibration(answers: readonly CalibrationAnswer[]): CalibrationResult {
  const answerByItem = new Map(answers.map((answer) => [answer.itemId, answer]));

  const incorrectItemIds: string[] = [];
  const perFamily = new Map<TaxonomyFamily, { correct: number; total: number }>();
  let correct = 0;

  for (const item of CALIBRATION_ITEMS) {
    const answer = answerByItem.get(item.itemId);
    const right = answer !== undefined && isCorrect(item, answer);
    if (right) correct += 1;
    else incorrectItemIds.push(item.itemId);

    if (item.expectedCode !== undefined) {
      const family = taxonomyFamilyOf(item.expectedCode);
      const tally = perFamily.get(family) ?? { correct: 0, total: 0 };
      perFamily.set(family, { correct: tally.correct + (right ? 1 : 0), total: tally.total + 1 });
    }
  }

  const score = correct / CALIBRATION_ITEMS.length;

  const reliabilityByFamily: Record<string, number> = {};
  for (const [family, tally] of perFamily) {
    reliabilityByFamily[family] = Math.round((tally.correct / tally.total) * 100) / 100;
  }

  return {
    passed: score >= CALIBRATION_PASS_SCORE,
    score: Math.round(score * 100) / 100,
    reliabilityByFamily: Object.freeze(reliabilityByFamily),
    incorrectItemIds,
  };
}

/** True when `itemId` names an item of the current calibration set. */
export function isCalibrationItemId(itemId: string): boolean {
  return CALIBRATION_ITEM_BY_ID.has(itemId);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when a calibration passed at `passedAt` is still current (§8.2). */
export function isCalibrationCurrent(passedAt: Date | null, now: Date): boolean {
  if (passedAt === null) return false;
  return now.getTime() - passedAt.getTime() <= CALIBRATION_VALID_DAYS * DAY_MS;
}

/**
 * §8.4's `recentCalibration` term, in [0, 1].
 *
 * 1.0 while the calibration is recent, then decaying linearly to 0 at the end of
 * its validity. A cliff would make one day's difference change a reviewer's
 * selection odds by a visible step for no reason anybody could explain.
 */
export function calibrationRecency(passedAt: Date | null, now: Date): number {
  if (passedAt === null) return 0;
  const ageDays = (now.getTime() - passedAt.getTime()) / DAY_MS;
  if (ageDays <= CALIBRATION_RECENT_DAYS) return 1;
  if (ageDays >= CALIBRATION_VALID_DAYS) return 0;
  const decayed =
    (CALIBRATION_VALID_DAYS - ageDays) / (CALIBRATION_VALID_DAYS - CALIBRATION_RECENT_DAYS);
  return Math.round(decayed * 100) / 100;
}
