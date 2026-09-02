import type { TransactionSession } from '../../db/collections';
import {
  TAXONOMY_FAMILIES,
  type ReviewerState,
  type TaxonomyFamily,
} from '@oxyhq/crowdsource-contracts';

import { ApiError } from '../../http/apiError';
import { getPostgresDatabase } from '../../db/postgres/database';
import {
  declareReviewerRelation as declareReviewerRelationRow,
  incrementCompletedReviewCount,
  insertReviewerProfileIfAbsent,
  replaceReviewerPrincipalLinks,
  updateReviewerProfile,
} from '../../db/postgres/repositories/reviewers';
import type { ReviewerRelationSource } from '../../db/postgres/schema/reviewers';
import type { SensitivityClass } from '../triage/triage';
import {
  CALIBRATION_ITEMS,
  gradeCalibration,
  hasCompletedTraining,
  isCalibrationItemId,
  isTrainingModuleId,
  TRAINING_MODULES,
  type CalibrationAnswer,
  type CalibrationResult,
} from './calibration';
import { requiresAdultReviewer } from './eligibility';
import { personhoodConfidence, type PersonhoodSignals } from './personhood';
import {
  reviewerProfiles,
  sensitivityRank,
  type ReviewerPrincipalLink,
  type ReviewerProfileDocument,
} from './reviewer.collection';
import { canTransition } from './reviewerState';

/**
 * The reviewer profile lifecycle (§8.1, §8.2, §13.7).
 *
 * Everything a person does to become — and to stay — eligible passes through
 * here: the profile itself, preferences, per-category consent, training,
 * calibration, declared conflicts and exposure limits. The sortition service
 * READS what this module maintains and writes none of it, which is what keeps
 * "who may be drawn" answerable in one place.
 *
 * Two properties are maintained rather than assumed, and both have tests:
 *
 *  - `personhoodConfidence` is derived, never supplied. Every write recomputes
 *    it from the signals on the document, so it cannot drift away from the
 *    inputs that justify it. A denormalised eligibility number nobody checks is
 *    a number that eventually decides who judges for a reason nobody can state.
 *  - A state change goes through `canTransition`. The illegal moves are the
 *    interesting ones — nothing reaches `community` without calibrating, and
 *    nothing leaves `suspended` except back into calibration (§9.7).
 */

/** §13.7's daily limits. The reviewer chooses within this ceiling. */
const DAILY_REVIEW_LIMIT_DEFAULT = 20;
export const DAILY_REVIEW_LIMIT_MAX = 40;

/**
 * Promotion thresholds (§8.1).
 *
 * The plan names the states and what each may do, and does not give numbers.
 * These are a judgement call, stated here so they can be argued with rather than
 * discovered in a query: a reviewer becomes `trusted` after enough submitted
 * reviews at good measured reliability, and a specialist in a FAMILY after
 * markedly more, in that family specifically.
 *
 * Reliability currently moves only at calibration — §9.7's other sources (gold
 * cases in the live queue, appeal outcomes, audits) belong to the phases that
 * own the review and appeal flows. Until they exist, promotion is volume plus
 * calibrated accuracy, which is why the volumes are not small.
 */
export const PROMOTION = Object.freeze({
  trustedMinReviews: 50,
  trustedMinReliability: 0.8,
  specialistMinReviews: 150,
  specialistMinFamilyReliability: 0.9,
  /**
   * §8.1's Appeals Reviewer: "puede participar en jurados de apelación".
   *
   * Reachable from `specialist` and from `trusted`, and the volume is the highest
   * in the table because of what the seat does: an appeal panel weighs a decision
   * another panel already reached, under §9.4's raised threshold. The state has to
   * be REACHABLE, though — a tier nobody attains is the closed door that left the
   * civic validator with a pool of five people and twenty expired requests, and
   * `SLOT_FALLBACKS` exists precisely so an appeal is not blocked while the
   * population grows into this state.
   */
  appealsMinReviews: 300,
  appealsMinReliability: 0.85,
});

/** What the Oxy session told us about the person behind the request. */
export interface ReviewerIdentity {
  readonly oxyUserId: string;
  /** Oxy's verification flag. Absent from the session payload means false. */
  readonly oxyAccountVerified: boolean;
}

function signalsOf(profile: ReviewerProfileDocument): PersonhoodSignals {
  return {
    accountActive: profile.accountActive,
    oxyAccountVerified: profile.oxyAccountVerified,
    trainingCompletedAt: profile.trainingCompletedAt,
    calibrationPassedAt: profile.calibrationPassedAt,
    suspectedSockPuppet: profile.suspectedSockPuppet,
  };
}

/**
 * The fields a write may change, as an explicit list.
 *
 * Never a spread of a request body: `reviewer.routes.ts` parses input into named
 * values and passes them here, so a client cannot mass-assign `state`,
 * `personhoodConfidence`, `reliabilityByCategory` or `completedReviewCount` —
 * the four fields that would let a reviewer promote themselves onto a jury.
 */
type ProfileMutation = Partial<
  Pick<
    ReviewerProfileDocument,
    | 'accountActive'
    | 'oxyAccountVerified'
    | 'isAdult'
    | 'languages'
    | 'categories'
    | 'specialistCategories'
    | 'maxSensitivityRank'
    | 'consentedSensitiveCategories'
    | 'declaredConflictApplications'
    | 'rulesAcceptedAt'
    | 'available'
    | 'dailyReviewLimit'
    | 'trainingCompletedModules'
    | 'trainingCompletedAt'
    | 'calibrationPassedAt'
    | 'calibrationScore'
    | 'calibrationAttempts'
    | 'lastCalibrationAt'
    | 'reliabilityByCategory'
    | 'completedReviewCount'
    | 'principalLinks'
    | 'state'
    | 'suspectedSockPuppet'
    | 'riskClusterId'
    | 'suspendedUntil'
  >
>;

/**
 * The one gate every state change passes through.
 *
 * Exported because `recordSubmittedReview` writes a promotion inside the
 * review's transaction and so cannot go through `mutateProfile`. Without this it
 * would be the ONE live path that changes a reviewer's state without consulting
 * §8.1's ladder — and it is the path that matters most, since it is the only one
 * that promotes anybody.
 *
 * A no-op transition is allowed: a write that happens to restate the current
 * state is not a move.
 */
export function assertTransition(from: ReviewerState, to: ReviewerState): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new Error(`A reviewer cannot move from '${from}' to '${to}'.`);
  }
}

/**
 * Applies a mutation and re-derives everything that depends on it.
 *
 * The single writer of `personhoodConfidence`, and the single place a state
 * transition is checked. Read-modify-write rather than an operator update
 * because the derived value depends on fields the caller may be changing in the
 * same call, and a reviewer profile is written by one person at a time — the
 * contention this trades away does not exist.
 */
async function mutateProfile(
  reviewerId: string,
  mutation: ProfileMutation,
): Promise<ReviewerProfileDocument> {
  const current = await reviewerProfiles.findOne({ reviewerId });
  if (!current) {
    throw new ApiError('not_found', 'No such reviewer profile.');
  }

  if (mutation.state !== undefined) assertTransition(current.state, mutation.state);

  const merged: ReviewerProfileDocument = { ...current, ...mutation };
  const { principalLinks, ...profileMutation } = mutation;
  const patch = {
    ...profileMutation,
    personhoodConfidence: personhoodConfidence(signalsOf(merged)),
  };
  const db = getPostgresDatabase();
  const updated = principalLinks === undefined
    ? await updateReviewerProfile(db, reviewerId, patch)
    : await db.transaction(async (tx) => {
        const row = await updateReviewerProfile(tx, reviewerId, patch);
        if (row) await replaceReviewerPrincipalLinks(tx, reviewerId, principalLinks);
        return row;
      });

  if (!updated) {
    throw new Error(`Reviewer profile '${reviewerId}' vanished during a write.`);
  }
  return {
    ...updated,
    principalLinks: principalLinks === undefined ? current.principalLinks : [...principalLinks],
  } as ReviewerProfileDocument;
}

/**
 * The reviewer's profile, created on first sight.
 *
 * §8.1's `applicant` is the state of somebody who has an account and has done
 * nothing else, so there is no separate "register" step to forget: the first
 * authenticated reviewer request creates the profile and the person starts
 * where the plan says they start. The Oxy verification flag is refreshed on
 * every call, because losing verification has to lower personhood confidence
 * without waiting for the reviewer to edit something.
 */
export async function ensureReviewerProfile(
  identity: ReviewerIdentity,
): Promise<ReviewerProfileDocument> {
  const existing = await reviewerProfiles.findOne({ oxyUserId: identity.oxyUserId });
  if (existing) {
    if (existing.oxyAccountVerified === identity.oxyAccountVerified) return existing;
    return mutateProfile(existing.reviewerId, {
      oxyAccountVerified: identity.oxyAccountVerified,
    });
  }

  const signals: PersonhoodSignals = {
    accountActive: true,
    oxyAccountVerified: identity.oxyAccountVerified,
    trainingCompletedAt: null,
    calibrationPassedAt: null,
    suspectedSockPuppet: false,
  };

  /**
   * `$setOnInsert` with an upsert rather than an insert, because two concurrent
   * first requests from the same person would otherwise both insert and one
   * would fail on the unique index — an error the reviewer would see as their
   * first interaction with the product.
   */
  const created = await insertReviewerProfileIfAbsent(
    getPostgresDatabase(),
    {
        oxyUserId: identity.oxyUserId,
        state: 'applicant',
        accountActive: true,
        oxyAccountVerified: identity.oxyAccountVerified,
        isAdult: false,
        suspectedSockPuppet: false,
        riskClusterId: null,
        languages: [],
        categories: [],
        specialistCategories: [],
        maxSensitivityRank: sensitivityRank('standard'),
        consentedSensitiveCategories: [],
        declaredConflictApplications: [],
        rulesAcceptedAt: null,
        available: true,
        dailyReviewLimit: DAILY_REVIEW_LIMIT_DEFAULT,
        trainingCompletedModules: [],
        trainingCompletedAt: null,
        calibrationPassedAt: null,
        calibrationScore: null,
        calibrationAttempts: 0,
        lastCalibrationAt: null,
        reliabilityByCategory: {},
        completedReviewCount: 0,
        personhoodConfidence: personhoodConfidence(signals),
        // Uniform in [0, 1). This is the sampling key `candidatePool.ts` scans
        // a random window of; it must be drawn once and never recomputed, or a
        // profile would move under a scan already in progress.
        samplingKey: Math.random(),
        suspendedUntil: null,
    },
  );

  if (!created) {
    throw new Error('Creating a reviewer profile returned no document.');
  }
  return { ...created, principalLinks: [] } as ReviewerProfileDocument;
}

/**
 * §10.3's `POST /v1/reviewer/preferences`, as named fields.
 *
 * The parsed shape of `ReviewerPreferencesUpdateSchema` in the published
 * contracts, restated as an interface because this function takes NAMED
 * arguments and never a spread of a request body — see `ProfileMutation`.
 * `maxSensitivity` widens to triage's `SensitivityClass` here: the schema admits
 * only the three a reviewer may consent to, and `sensitivityRank` throws on the
 * fourth, so the widening cannot smuggle `prohibited` in.
 */
export interface ReviewerPreferences {
  readonly languages?: readonly string[];
  readonly categories?: readonly TaxonomyFamily[];
  /** §13.7: acceptance of the reviewing rules. One-way; never revoked here. */
  readonly rulesAccepted?: true;
  readonly isAdult?: boolean;
  readonly available?: boolean;
  readonly dailyReviewLimit?: number;
  /** The most sensitive class this reviewer consents to see (§13.7). */
  readonly maxSensitivity?: SensitivityClass;
  readonly consentedSensitiveCategories?: readonly TaxonomyFamily[];
  readonly declaredConflictApplications?: readonly string[];
  readonly principalLinks?: readonly ReviewerPrincipalLink[];
}

/**
 * Updates preferences, consent and availability.
 *
 * §13.7 requires consent to be per-category and revocable at any moment, which
 * is why every consent field is replaced wholesale rather than merged: a
 * reviewer removing a family from the list must actually remove it, and an
 * additive merge would make withdrawal impossible to express.
 */
export async function updateReviewerPreferences(
  reviewerId: string,
  preferences: ReviewerPreferences,
): Promise<ReviewerProfileDocument> {
  const current = await reviewerProfiles.findOne({ reviewerId });
  if (!current) {
    throw new ApiError('not_found', 'No such reviewer profile.');
  }

  const isAdult = preferences.isAdult ?? current.isAdult;
  const consented = preferences.consentedSensitiveCategories ?? current.consentedSensitiveCategories;

  /**
   * Refused rather than silently dropped: a reviewer who believes they
   * consented and was quietly ignored has no way to find out, and the failure
   * stays invisible until an audit.
   */
  if (!isAdult && requiresAdultReviewer(consented)) {
    throw new ApiError(
      'invalid_request',
      'Consent to adult categories requires the profile to attest adulthood first.',
    );
  }

  if (
    preferences.dailyReviewLimit !== undefined &&
    (preferences.dailyReviewLimit < 1 || preferences.dailyReviewLimit > DAILY_REVIEW_LIMIT_MAX)
  ) {
    throw new ApiError(
      'invalid_request',
      `A daily review limit must be between 1 and ${DAILY_REVIEW_LIMIT_MAX}.`,
    );
  }

  const mutation: ProfileMutation = {
    ...(preferences.languages === undefined ? {} : { languages: [...preferences.languages] }),
    ...(preferences.categories === undefined ? {} : { categories: [...preferences.categories] }),
    /**
     * Recorded once and never moved. A second acceptance is not a second
     * consent, and overwriting the instant would lose the moment an audit needs.
     */
    ...(preferences.rulesAccepted !== true || current.rulesAcceptedAt !== null
      ? {}
      : { rulesAcceptedAt: new Date() }),
    ...(preferences.isAdult === undefined ? {} : { isAdult: preferences.isAdult }),
    ...(preferences.available === undefined ? {} : { available: preferences.available }),
    ...(preferences.dailyReviewLimit === undefined
      ? {}
      : { dailyReviewLimit: preferences.dailyReviewLimit }),
    ...(preferences.maxSensitivity === undefined
      ? {}
      : { maxSensitivityRank: sensitivityRank(preferences.maxSensitivity) }),
    ...(preferences.consentedSensitiveCategories === undefined
      ? {}
      : { consentedSensitiveCategories: [...preferences.consentedSensitiveCategories] }),
    ...(preferences.declaredConflictApplications === undefined
      ? {}
      : { declaredConflictApplications: [...preferences.declaredConflictApplications] }),
    ...(preferences.principalLinks === undefined
      ? {}
      : { principalLinks: preferences.principalLinks.map((link) => ({ ...link })) }),
  };

  const updated = await mutateProfile(reviewerId, mutation);
  return openCalibrationIfReady(updated);
}

/**
 * Moves an applicant into `calibrating` once they can actually be calibrated.
 *
 * Every condition matters. Training must be complete, because §9.7 asks us to
 * tell a reasonable error from random answering and that is impossible if the
 * error was ours for never teaching the taxonomy. Categories and languages must
 * be set, because a calibrated reviewer with neither can never be drawn and
 * would sit in `community` looking eligible while matching no case. And the
 * reviewing rules must have been accepted (§4.1's onboarding, §13.7): the app
 * shows an unaccepted reviewer an `onboarding_incomplete` blocker, and a check
 * that lives only on the device is the one thing standing between somebody who
 * consented to nothing and real case material.
 */
async function openCalibrationIfReady(
  profile: ReviewerProfileDocument,
): Promise<ReviewerProfileDocument> {
  if (profile.state !== 'applicant') return profile;
  if (profile.rulesAcceptedAt === null) return profile;
  if (!hasCompletedTraining(profile.trainingCompletedModules)) return profile;
  if (profile.languages.length === 0 || profile.categories.length === 0) return profile;

  return mutateProfile(profile.reviewerId, { state: 'calibrating' });
}

/** Records one completed training module (§8.1). */
export async function completeTrainingModule(
  reviewerId: string,
  moduleId: string,
): Promise<ReviewerProfileDocument> {
  if (!isTrainingModuleId(moduleId)) {
    throw new ApiError('not_found', 'No such training module.');
  }

  const current = await reviewerProfiles.findOne({ reviewerId });
  if (!current) {
    throw new ApiError('not_found', 'No such reviewer profile.');
  }

  const completed = [...new Set([...current.trainingCompletedModules, moduleId])];
  const updated = await mutateProfile(reviewerId, {
    trainingCompletedModules: completed,
    trainingCompletedAt: hasCompletedTraining(completed) ? new Date() : null,
  });

  return openCalibrationIfReady(updated);
}

/** What a reviewer sees about their own training and calibration (§10.3). */
export interface TrainingView {
  readonly modules: readonly {
    readonly moduleId: string;
    readonly title: string;
    readonly families: readonly TaxonomyFamily[];
    readonly completed: boolean;
  }[];
  readonly trainingComplete: boolean;
  /** The items to answer. Never carries the expected answers. */
  readonly calibrationItems: readonly { readonly itemId: string; readonly text: string }[];
  readonly calibrationOpen: boolean;
  readonly calibrationPassedAt: Date | null;
  readonly calibrationScore: number | null;
  readonly calibrationAttempts: number;
}

/**
 * The training view.
 *
 * `calibrationItems` carries `itemId` and `text` and nothing else. Returning
 * `expectedViolation` or `expectedCode` would hand every reviewer the answer
 * key, and a calibration everybody passes measures nothing — which is the same
 * failure as a gate nobody passes, in the other direction.
 */
export function trainingView(profile: ReviewerProfileDocument): TrainingView {
  const completed = new Set(profile.trainingCompletedModules);
  const trainingComplete = hasCompletedTraining(profile.trainingCompletedModules);

  return {
    modules: TRAINING_MODULES.map((module) => ({
      moduleId: module.moduleId,
      title: module.title,
      families: module.families,
      completed: completed.has(module.moduleId),
    })),
    trainingComplete,
    calibrationItems: trainingComplete
      ? CALIBRATION_ITEMS.map((item) => ({ itemId: item.itemId, text: item.text }))
      : [],
    calibrationOpen: trainingComplete,
    calibrationPassedAt: profile.calibrationPassedAt,
    calibrationScore: profile.calibrationScore,
    calibrationAttempts: profile.calibrationAttempts,
  };
}

/**
 * Grades a calibration attempt and moves the reviewer if they passed.
 *
 * A failed attempt is recorded and the reviewer stays in `calibrating` — §9.7 is
 * explicit that a reviewer is not punished for being wrong, and calibration is
 * where being wrong is supposed to happen. What a failure does cost is that the
 * gate stays shut, which is the entire mechanism.
 */
export async function submitCalibration(
  reviewerId: string,
  answers: readonly CalibrationAnswer[],
): Promise<{ readonly result: CalibrationResult; readonly profile: ReviewerProfileDocument }> {
  const current = await reviewerProfiles.findOne({ reviewerId });
  if (!current) {
    throw new ApiError('not_found', 'No such reviewer profile.');
  }
  if (!hasCompletedTraining(current.trainingCompletedModules)) {
    throw new ApiError('forbidden', 'Calibration opens once every training module is complete.');
  }
  if (current.state === 'suspended') {
    throw new ApiError('forbidden', 'A suspended reviewer cannot calibrate until review.');
  }

  const unknown = answers.filter((answer) => !isCalibrationItemId(answer.itemId));
  if (unknown.length > 0) {
    throw new ApiError('invalid_request', 'A calibration answer names an item that is not in the set.');
  }

  const result = gradeCalibration(answers);
  const now = new Date();

  const profile = await mutateProfile(reviewerId, {
    calibrationAttempts: current.calibrationAttempts + 1,
    lastCalibrationAt: now,
    calibrationScore: result.score,
    ...(result.passed
      ? {
          calibrationPassedAt: now,
          reliabilityByCategory: { ...current.reliabilityByCategory, ...result.reliabilityByFamily },
        }
      : {}),
  });

  if (!result.passed) return { result, profile };

  /**
   * `calibrating` is the only state this promotes out of. A `community` or
   * `trusted` reviewer re-calibrating keeps their state — re-calibration is how
   * §8.2's "current calibration" requirement is met, not a demotion followed by
   * a promotion.
   */
  if (profile.state !== 'calibrating') return { result, profile };
  return { result, profile: await mutateProfile(reviewerId, { state: 'community' }) };
}

/** The mean reliability across the families a reviewer is calibrated in. */
function meanReliability(reliability: Record<string, number>): number {
  const values = Object.values(reliability);
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Records that a reviewer submitted a review, and promotes them if that was the
 * one that earned it (§8.1).
 *
 * Called from the review submission path inside its transaction, so the counter
 * and the review commit together: a counter incremented outside would drift
 * every time a submission failed after this point, and the drift always runs one
 * way — upward, toward promoting people who did less than the number says.
 */
export async function recordSubmittedReview(
  reviewerId: string,
  session: TransactionSession,
): Promise<void> {
  const updated = await incrementCompletedReviewCount(session, reviewerId);
  if (!updated) {
    throw new Error(`Reviewer profile '${reviewerId}' vanished while recording a review.`);
  }

  const promotion = promotionFor({ ...updated, principalLinks: [] } as ReviewerProfileDocument);
  if (promotion === null) return;

  assertTransition(updated.state as ReviewerState, promotion.state);

  await updateReviewerProfile(session, reviewerId, {
    ...promotion,
    personhoodConfidence: updated.personhoodConfidence,
  });
}

/**
 * The state (and specialisation) this profile has earned, or null.
 *
 * Pure and exported so the thresholds can be exercised without a database: the
 * interesting cases are the boundaries, and reaching them through fifty real
 * submissions in a test would prove nothing extra.
 */
export function promotionFor(
  profile: ReviewerProfileDocument,
): { state: ReviewerState; specialistCategories: TaxonomyFamily[] } | null {
  if (
    profile.state !== 'community' &&
    profile.state !== 'trusted' &&
    profile.state !== 'specialist'
  ) {
    return null;
  }

  const specialisms = TAXONOMY_FAMILIES.filter(
    (family) =>
      (profile.reliabilityByCategory[family] ?? 0) >= PROMOTION.specialistMinFamilyReliability,
  );

  /**
   * §8.1's Appeals Reviewer, checked before the states below it so a profile that
   * has earned the top of the ladder does not stall one rung short.
   *
   * Reached from `specialist` and from `trusted`, which is what `canTransition`
   * already allows — a reviewer who never specialised in one family but has judged
   * broadly and reliably is exactly the general appeals juror §8.1 describes. The
   * specialisms travel unchanged: an appeals reviewer does not stop being a
   * specialist in the families they were one in, and §7.5's restricted material
   * still needs that specialism, not this state.
   */
  if (
    (profile.state === 'specialist' || profile.state === 'trusted') &&
    profile.completedReviewCount >= PROMOTION.appealsMinReviews &&
    meanReliability(profile.reliabilityByCategory) >= PROMOTION.appealsMinReliability
  ) {
    return { state: 'appeals', specialistCategories: profile.specialistCategories };
  }

  if (
    profile.state === 'trusted' &&
    profile.completedReviewCount >= PROMOTION.specialistMinReviews &&
    specialisms.length > 0
  ) {
    return {
      state: 'specialist',
      specialistCategories: [...specialisms],
    };
  }

  if (
    profile.state === 'community' &&
    profile.completedReviewCount >= PROMOTION.trustedMinReviews &&
    meanReliability(profile.reliabilityByCategory) >= PROMOTION.trustedMinReliability
  ) {
    return { state: 'trusted', specialistCategories: profile.specialistCategories };
  }

  return null;
}

/**
 * Records that a reviewer must not be drawn for cases involving this principal
 * again (§8.5's graph exclusion, §8.7's "a recusal is never punished").
 *
 * Idempotent through the unique index: declaring the same conflict twice, or
 * recusing twice from cases sharing an author, produces one row.
 */
export async function declareReviewerRelation(
  reviewerId: string,
  applicationId: string,
  externalPrincipalId: string,
  source: ReviewerRelationSource,
  session?: TransactionSession,
): Promise<void> {
  await declareReviewerRelationRow(session ?? getPostgresDatabase(), {
    reviewerId,
    applicationId,
    externalPrincipalId,
    source,
  });
}
