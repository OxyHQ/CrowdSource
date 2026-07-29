/**
 * The Reviewer API wire contract (§10.3) — what the backend sends and the
 * reviewer app receives, defined once.
 *
 * ## Why this module exists at all
 *
 * It exists because the alternative was tried and failed silently. The backend
 * and the reviewer app each wrote their own version of these shapes, and they
 * agreed on almost nothing: the state vocabularies differed outright
 * (`community` against `community_reviewer`), so did the sensitivity classes
 * (`standard`/`sensitive`/`restricted` against an invented
 * `none`/`low`/`high`/`critical`); the assignment package disagreed on
 * `allegation` against `allegations`, on `policyVersion` against `version`, and
 * on five fields that existed on one side only. Nothing caught it, because there
 * was no shared declaration for anything to be checked against.
 *
 * So the rule this module encodes: **a field that crosses the reviewer boundary
 * is declared here and nowhere else.** The backend's builders return these types
 * and the app's projections return these types, which makes a rename a
 * compile error on BOTH sides rather than a runtime surprise on one.
 *
 * ## Types outbound, schemas inbound
 *
 * The direction decides the form, and the asymmetry is deliberate.
 *
 *  - **Outbound** (assignment package, profile, training, history) are TYPES.
 *    The backend builds them under this type and the app projects onto it, so
 *    the two are already pinned to each other at compile time. A third
 *    declaration — a Zod schema for the same shape — would be one more thing to
 *    keep in step and would add nothing: the app's `redaction.ts` already
 *    validates every field it reads, by name, because §9.1 requires an allowlist
 *    rather than a parse.
 *  - **Inbound** (preferences, calibration) are SCHEMAS. They are parsed from a
 *    request body, so they need runtime refusal, and they are `.strict()` for
 *    the reason `reviews.ts` is: the fields a reviewer must not be able to set
 *    are exactly the ones that decide who sits on a jury.
 *
 * The vocabularies are exported as `as const` arrays as well as enums, because
 * the app validates an incoming string against the runtime list.
 *
 * ## What is deliberately NOT here
 *
 * No case id, on any shape. §8.7 pseudonymises what a reviewer does not need and
 * a case id is not needed to judge material; more to the point, a case id on the
 * wire is a case id in a URL, and "nobody chooses the case they review" holds
 * because the assignment is the only handle. No reporter, no report count, no
 * reputation, no juror identity, no partial tally — §9.1's hidden column has no
 * representation in any type below, which is what makes the app's projection
 * able to be total.
 */

import { z } from 'zod';

import { TAXONOMY_FAMILIES, TaxonomyCodeSchema, TaxonomyFamilySchema } from './taxonomy';
import type { DecisionOutcome } from './decisions';
import type { PolicyRule } from './policies';
import type { Relation, Resource } from './resources';
import type { ReviewOutcome } from './reviews';
import type { TaxonomyCode, TaxonomyFamily } from './taxonomy';

/**
 * §8.1's seven onboarding states, ordered from least to most capable.
 *
 * §8.1 writes them as English prose labels ("Community Reviewer", "Category
 * Specialist"). These are the identifiers, and they are the SHORT forms on
 * purpose: the `_reviewer` suffix says nothing a `ReviewerState` type does not
 * already say, and `specialist` pairs with a separate `specialistCategories`
 * field, so `category_specialist` would name the category twice.
 *
 * `suspended` is apart from the ordering rather than at the bottom of it — see
 * the backend's `REVIEWER_STATE_RANK`, which gives it -1 so that every
 * capability comparison fails for it, including one against `applicant`.
 */
export const REVIEWER_STATES = [
  'applicant',
  'calibrating',
  'community',
  'trusted',
  'specialist',
  'appeals',
  'suspended',
] as const;
export const ReviewerStateSchema = z.enum(REVIEWER_STATES);
export type ReviewerState = z.infer<typeof ReviewerStateSchema>;

/**
 * The sensitivity classes a jury can be shown, ranked (§7.5, §13.7).
 *
 * Triage computes a fourth, `prohibited`, and it is absent here on purpose:
 * §7.5 routes that material to a specialist team under legal protocol and never
 * to a jury, so a reviewer-facing type that could express it would eventually be
 * handed it. The backend's `sensitivityRank` throws rather than returning a
 * number for it, for the same reason.
 *
 * This is also the vocabulary a reviewer's own consent is stored in, as a rank —
 * which is why it could never have been the app's invented
 * `none`/`low`/`high`/`critical`: those four map onto nothing the server
 * computes or the reviewer consented to.
 */
export const REVIEWER_SENSITIVITY_CLASSES = ['standard', 'sensitive', 'restricted'] as const;
export const ReviewerSensitivityClassSchema = z.enum(REVIEWER_SENSITIVITY_CLASSES);
export type ReviewerSensitivityClass = z.infer<typeof ReviewerSensitivityClassSchema>;

/**
 * The eligibility requirements a reviewer may be TOLD about (§8.2).
 *
 * §8.2 lists ten conditions and this list is eight, which is the interesting
 * part. Two groups are missing and neither is an oversight:
 *
 *  - **Relative to a case.** Conflict with a party, prior participation in the
 *    case or incident, and coordination-cluster overlap are properties of a
 *    candidate against a specific case's parties — they live in
 *    `sortition/exclusions.ts` where the parties are known, and outside a draw
 *    there is no answer to give.
 *  - **Anti-abuse signals.** A sock-puppet suspicion is deliberately not
 *    disclosed. Telling somebody they are flagged tells them what to change,
 *    which is the same reasoning that keeps `suspectedSockPuppet` and
 *    `riskClusterId` out of the profile projection.
 *
 * Exposure is absent too, but only because it has a richer home of its own:
 * `ReviewerExposureView` gives the numbers rather than a boolean.
 *
 * Every id here maps to a check the server actually performs, so the app can
 * never display a requirement nobody enforces. There is no server-authored
 * explanation string: the app is translated (`locales/*.json`) and a sentence
 * composed by a backend with no locale would arrive in the wrong language.
 */
export const REVIEWER_ELIGIBILITY_REQUIREMENTS = [
  /** §8.2: "an active and authenticated Oxy account". */
  'oxy_account',
  /** §8.2: personhood sufficient for real decisions. */
  'personhood',
  /** §8.2: an age compatible with the chosen categories. */
  'age',
  /** §13.7: the reviewing rules were accepted. */
  'rules_accepted',
  /** §8.2: at least one language, or no case can match. */
  'languages_selected',
  /** §8.2: at least one category, likewise. */
  'categories_selected',
  /** §8.1: every training module complete. */
  'training_current',
  /** §8.2: calibration passed and not lapsed. */
  'calibration_current',
] as const;
export const ReviewerEligibilityRequirementIdSchema = z.enum(REVIEWER_ELIGIBILITY_REQUIREMENTS);
export type ReviewerEligibilityRequirementId = z.infer<
  typeof ReviewerEligibilityRequirementIdSchema
>;

export interface ReviewerEligibilityRequirement {
  readonly id: ReviewerEligibilityRequirementId;
  readonly met: boolean;
}

/**
 * §4.1's "Fiabilidad" — the reviewer's OWN standing in one category.
 *
 * Per category and not per (category, language): reliability is seeded by
 * calibration and moved by gold cases and audits, none of which are measured per
 * language, so a per-language figure would be the same number repeated. §4.1
 * asks for both axes and this is the honest half of it.
 *
 * It is never anybody else's figure. §9.1 forbids a reviewer seeing another
 * person's reputation, and there is no shape on this surface that could carry
 * one.
 */
export interface ReviewerCategoryStanding {
  readonly category: TaxonomyFamily;
  /** 0..1, this reviewer's own measured reliability in this category. */
  readonly reliability: number;
  /** Whether this reviewer is a recognised specialist in it (§8.1, §8.3). */
  readonly specialist: boolean;
}

/**
 * §13.7's exposure and rest, as numbers rather than as a verdict.
 *
 * `breakRequiredUntil` is the sensitive-material rest of `eligibility.ts`: after
 * `SENSITIVE_EXPOSURE_MAX` sensitive cases inside
 * `SENSITIVE_EXPOSURE_WINDOW_HOURS`, the oldest of them leaving the window is
 * when the reviewer may be drawn for sensitive material again. It rests only the
 * sensitive route — a reviewer who has worked through several distressing cases
 * can still judge a spam report — so it is not a blanket block, and the app must
 * present it as what it is.
 */
export interface ReviewerExposureView {
  readonly reviewedToday: number;
  readonly dailyLimit: number;
  readonly openAssignments: number;
  readonly maxOpenAssignments: number;
  /** ISO instant, or null when no rest is being enforced. */
  readonly breakRequiredUntil: string | null;
}

/**
 * §13.7 — consent, per category and revocable at any moment.
 *
 * `maxSensitivity` lives here rather than in preferences because it is consent:
 * it is the ceiling of what this person agreed to be shown. Keeping a second
 * copy of `sensitiveCategories` under preferences — which is what the app used
 * to declare — guarantees two fields that can disagree about the same fact.
 */
export interface ReviewerConsentView {
  /** ISO instant the reviewer accepted the reviewing rules, or null. */
  readonly rulesAcceptedAt: string | null;
  /** §8.2's age compatibility, as the one bit the routing needs (§13.5). */
  readonly ageConfirmed: boolean;
  readonly maxSensitivity: ReviewerSensitivityClass;
  readonly sensitiveCategories: readonly TaxonomyFamily[];
}

export interface ReviewerPreferencesView {
  /** BCP-47 primary subtags the reviewer reads. */
  readonly languages: readonly string[];
  readonly categories: readonly TaxonomyFamily[];
  readonly dailyLimit: number;
  /** False means this reviewer is in no draw at all — §4.1's immediate exit. */
  readonly availableForAssignment: boolean;
}

/**
 * `GET /v1/reviewer/profile` (§10.3: "eligibility, categories and PRIVATE
 * reliability").
 *
 * Private meaning shown to its owner and to nobody else. What the document holds
 * and this does not: `oxyUserId` (§8.7 keeps the identity and the reviewer id
 * apart), `samplingKey` (publishing it would let somebody reason about when they
 * are likely to be considered), and the anti-abuse signals.
 */
export interface ReviewerProfileView {
  readonly reviewerId: string;
  readonly state: ReviewerState;
  readonly eligibility: readonly ReviewerEligibilityRequirement[];
  readonly standings: readonly ReviewerCategoryStanding[];
  readonly completedReviewCount: number;
  readonly preferences: ReviewerPreferencesView;
  readonly consent: ReviewerConsentView;
  readonly exposure: ReviewerExposureView;
}

/**
 * §13.7's ceiling on a self-chosen daily limit.
 *
 * Declared here rather than in the backend because the request schema below
 * bounds the body with it and the app's control has to offer the same range —
 * two numbers that must agree, so there is one.
 */
export const REVIEWER_DAILY_LIMIT_MAX = 40;

/**
 * The body of `POST /v1/reviewer/preferences` (§10.3).
 *
 * This is also §4.1's onboarding submission. There is no
 * `POST /v1/reviewer/onboarding`: §10.3's route table has no such endpoint, and
 * everything the onboarding screen collects — languages, categories, sensitive
 * consent, age — is precisely what §10.3 says this route updates. Rules
 * acceptance is the one thing that had no home, so it is a field here.
 *
 * `.strict()` matters more here than anywhere else on this surface. `state`,
 * `personhoodConfidence`, `reliabilityByCategory` and `completedReviewCount` are
 * the fields that decide who sits on a jury, and a lenient schema plus a
 * spread-based update is exactly how a reviewer would promote themselves. The
 * schema refuses unknown keys and the service takes named arguments, so there
 * are two independent reasons it cannot happen.
 *
 * Every field is optional and at least one must be present: a partial update is
 * the normal case (the wellbeing screen changes one toggle), and an empty body
 * is a mistake worth naming rather than a no-op worth accepting.
 */
export const ReviewerPreferencesUpdateSchema = z
  .strictObject({
    languages: z.array(z.string().min(2).max(16)).max(20).optional(),
    categories: z.array(TaxonomyFamilySchema).max(TAXONOMY_FAMILIES.length).optional(),
    /** §13.7: acceptance is recorded once and never revoked to `false` here. */
    rulesAccepted: z.literal(true).optional(),
    isAdult: z.boolean().optional(),
    available: z.boolean().optional(),
    dailyReviewLimit: z.number().int().min(1).max(REVIEWER_DAILY_LIMIT_MAX).optional(),
    maxSensitivity: ReviewerSensitivityClassSchema.optional(),
    consentedSensitiveCategories: z
      .array(TaxonomyFamilySchema)
      .max(TAXONOMY_FAMILIES.length)
      .optional(),
    declaredConflictApplications: z.array(z.string().min(1).max(64)).max(50).optional(),
    principalLinks: z
      .array(
        z.strictObject({
          applicationId: z.string().min(1).max(64),
          externalPrincipalId: z.string().min(1).max(256),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'a preferences update must change at least one field',
  });
export type ReviewerPreferencesUpdate = z.infer<typeof ReviewerPreferencesUpdateSchema>;

/** One training module, as its owner sees it (§10.3: "list modules"). */
export interface ReviewerTrainingModuleView {
  readonly moduleId: string;
  readonly title: string;
  readonly families: readonly TaxonomyFamily[];
  readonly completed: boolean;
}

/**
 * One calibration item to answer.
 *
 * `itemId` and `text`, and nothing else. A calibration that hands back
 * `expectedViolation` or `expectedCode` is one everybody passes on the second
 * attempt, which measures attendance rather than judgement.
 */
export interface ReviewerCalibrationItemView {
  readonly itemId: string;
  readonly text: string;
}

/** `GET /v1/reviewer/training` (§10.3). */
export interface ReviewerTrainingView {
  readonly modules: readonly ReviewerTrainingModuleView[];
  readonly trainingComplete: boolean;
  readonly calibrationItems: readonly ReviewerCalibrationItemView[];
  readonly calibrationOpen: boolean;
  /** ISO instant, or null when never passed. */
  readonly calibrationPassedAt: string | null;
  /** ISO instant after which calibration lapses (§8.2), or null. */
  readonly calibrationCurrentUntil: string | null;
  readonly calibrationScore: number | null;
  readonly calibrationAttempts: number;
  /** The score a pass requires, so the app does not restate it. */
  readonly calibrationPassScore: number;
}

/** The body of `POST /v1/reviewer/training/calibration`. */
export const ReviewerCalibrationSubmissionSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        itemId: z.string().min(1).max(64),
        violation: z.boolean(),
        code: TaxonomyCodeSchema.optional(),
      }),
    )
    .min(1)
    .max(64),
});
export type ReviewerCalibrationSubmission = z.infer<typeof ReviewerCalibrationSubmissionSchema>;

/**
 * What a graded attempt reports back.
 *
 * The score and which items were wrong, never which answer was right — see
 * `ReviewerCalibrationItemView`.
 */
export interface ReviewerCalibrationResultView {
  readonly passed: boolean;
  readonly score: number;
  readonly incorrectItemIds: readonly string[];
  readonly state: ReviewerState;
}

/**
 * A resource asset as a reviewer receives it (§8.7, §9.1).
 *
 * The envelope's `AssetRef` carries `uploadId` OR `url`, plus a `sha256`. None of
 * the three reaches a reviewer:
 *
 *  - `url` is a location on the REPORTING APPLICATION's own host, so sending it
 *    puts that application's brand in front of the jury — §9.1's last hidden row
 *    — and it bypasses the media chokepoint that every Oxy surface resolves
 *    files through.
 *  - `sha256` is how a case is pinned to the exact bytes that were reported. A
 *    reviewer does not verify that; the case does.
 *
 * What replaces them is `fileId`, a bare Oxy file id resolved through
 * `getFileDownloadUrl` at the app root, and `retrievable`, which is the honest
 * answer when there is nothing a reviewer can be shown. A reviewer facing an
 * unretrievable resource has an outcome for exactly that situation
 * (`content_unavailable`), which is why this is a flag rather than an omission:
 * dropping the resource would hide from the jury that material existed.
 */
export interface ReviewerAssetView {
  readonly mediaType: string;
  /** Bare Oxy file id. Absent whenever `retrievable` is false. */
  readonly fileId?: string;
  /** False when CrowdSource cannot serve these bytes to a reviewer. */
  readonly retrievable: boolean;
  readonly sizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
}

/**
 * One resource of case material, as a reviewer receives it.
 *
 * Derived from the envelope's `Resource` union rather than restated, so a new
 * resource type in `resources.ts` cannot appear on the reviewer surface without
 * this type changing with it — and cannot be silently DROPPED from the reviewer
 * surface either, which is the failure that would matter: a jury judging
 * material it was never shown.
 *
 * The conditional distributes over the union, so the result is still
 * discriminated on `type` and the app can project it with an exhaustive switch.
 */
export type ReviewerResourceView<R = Resource> = R extends { asset: unknown }
  ? Omit<R, 'sha256' | 'asset'> & { readonly asset: ReviewerAssetView }
  : Omit<R, 'sha256'>;
export type ReviewerResource = ReviewerResourceView;

/**
 * §9.1 — the allegation, labelled as what it is.
 *
 * `codes` is plural because a case is the union of every report about the same
 * material (§7.3), and reporters do not all choose the same code. A singular
 * field would silently show a jury one allegation out of several.
 *
 * `unverified` is a constant `true` on the wire. It is redundant to a reader of
 * this file and it is not redundant to a screen: §9.1's whole requirement is
 * that the claim is presented AS a claim, and a flag that must be read to render
 * the label cannot be forgotten the way a comment can.
 */
export interface ReviewerAllegationsView {
  readonly unverified: true;
  readonly codes: readonly TaxonomyCode[];
}

/** §9.1's "applicable policy and its rules", in full and at one version (§6.4). */
export interface ReviewerPolicyView {
  readonly policySetId: string;
  readonly version: string;
  readonly taxonomyVersion: string;
  readonly rules: readonly PolicyRule[];
}

/**
 * §9.8's "contexto adicional" — the author's own words, for a panel reviewing an
 * appeal.
 *
 * `unverified` is a constant `true` for the same reason it is on an allegation:
 * this is a claim by an interested party, not a finding, and the flag is what
 * makes a screen say so.
 *
 * What this view deliberately CANNOT carry is everything else about the appeal.
 * Not the reason code, which is an argument about the verdict and would anchor
 * the panel against §9.1's list. Not the superseded decision, its outcome, its
 * findings or its jury — that is §9.8's blindness rule. Not the threshold this
 * panel is held to, which is a property of the count and not of the material. A
 * reviewer can tell they are looking at a contested case, because somebody is
 * contesting it in their own words; they cannot tell what anybody concluded.
 *
 * The absence of those fields is the enforcement. A field that exists gets
 * filled eventually by somebody who does not know why it was empty.
 */
export interface ReviewerAppealContextView {
  readonly unverified: true;
  readonly statement: string;
  readonly resourceIds: readonly string[];
  readonly fields: readonly { readonly label: string; readonly value: string }[];
}

/** §9.1's language, warnings and sensitivity, plus §13.7's blur decision. */
export interface ReviewerPresentationView {
  readonly sensitivityClass: ReviewerSensitivityClass;
  readonly requiresRedaction: boolean;
  readonly blurBeforeReveal: boolean;
}

/**
 * The renderable package for ONE assignment (§8.7, §9.1).
 *
 * There is no `caseId`. The assignment is the only handle, it is held in memory
 * for the session, and the route that renders it takes no parameters — so
 * nobody can link to a case, which is "nobody chooses the case they review"
 * expressed as an absent field rather than as a rule somebody enforces.
 *
 * `language` is nullable because an envelope's resources may declare none, and
 * `families` is plural because a case can allege several: a reviewer is only
 * drawn when they accept ALL of them (§8.2), so naming one would misdescribe
 * what they were asked to judge.
 */
export interface AssignmentPackage {
  readonly assignmentId: string;
  /** The case revision this assignment is bound to (§8.7, §9.9). */
  readonly caseRevision: number;
  /** ISO instant. After this the assignment is gone and a replacement is drawn. */
  readonly expiresAt: string;
  /** BCP-47 language of the material, or null when it declares none. */
  readonly language: string | null;
  readonly families: readonly TaxonomyFamily[];
  readonly allegations: ReviewerAllegationsView;
  readonly policy: ReviewerPolicyView;
  readonly presentation: ReviewerPresentationView;
  readonly resources: readonly ReviewerResource[];
  /** §5.5 — which resource replies to, quotes or contextualises which. */
  readonly relations: readonly Relation[];
  /**
   * §13.8's pseudonymous per-assignment watermark.
   *
   * Server-issued so that a leaked screenshot is traceable back to one
   * assignment. It is never synthesised on the device: a watermark the client
   * composes is one the client can also omit or forge, which would leave a
   * reviewer with the impression of a sealed screen and no actual trace.
   */
  readonly watermark: string | null;
  /**
   * §9.8, present only when this assignment belongs to an appeal revision AND the
   * author supplied context. Absent on a first-instance panel, so a screen cannot
   * infer "this is an appeal" from the field existing with an empty value.
   */
  readonly authorContext?: ReviewerAppealContextView;
}

/**
 * What `POST /v1/reviewer/assignments/next` returns.
 *
 * The token is here and on no other response, because it is handed over exactly
 * once and only its hash is stored (§8.7). Every later call on this assignment
 * presents it in `x-assignment-token`.
 */
export interface IssuedAssignmentPackage extends AssignmentPackage {
  readonly token: string;
}

/** The header §8.7's assignment token travels in. One spelling, both sides. */
export const ASSIGNMENT_TOKEN_HEADER = 'x-assignment-token';

/**
 * §4.1's "Historial" — one completed review as its author may see it back.
 *
 * `outcome` is the reviewer's OWN submitted outcome. `decision` is populated only
 * once a decision has been PUBLISHED for the revision this reviewer judged, and
 * carries the outcome and the moment and nothing else — no agreement figure, no
 * jury size, no vote count, no findings. §4.1 asks the history to show "results
 * that may already be revealed"; §9.1 forbids partial results and vote tallies.
 * Both hold: a published decision is not partial, and an agreement ratio IS a
 * tally, so it has no field here.
 */
export interface ReviewHistoryEntry {
  readonly reviewId: string;
  /** ISO instant. */
  readonly submittedAt: string;
  readonly families: readonly TaxonomyFamily[];
  readonly language: string | null;
  readonly outcome: ReviewOutcome;
  readonly decision: {
    readonly outcome: DecisionOutcome;
    /** ISO instant. */
    readonly publishedAt: string;
  } | null;
}

/** `GET /v1/reviewer/reviews`. */
export interface ReviewHistoryPage {
  readonly entries: readonly ReviewHistoryEntry[];
  /** Opaque cursor for the next page, or null when the list is exhausted. */
  readonly nextCursor: string | null;
}

/**
 * The query of `GET /v1/reviewer/reviews`.
 *
 * The cursor is opaque and the page size is bounded, because an unbounded page
 * over a reviewer's whole history is a slow query a client chooses to make.
 */
export const REVIEW_HISTORY_PAGE_SIZE_MAX = 50;
export const REVIEW_HISTORY_PAGE_SIZE_DEFAULT = 20;

export const ReviewHistoryQuerySchema = z.strictObject({
  /**
   * The last `reviewId` of the previous page.
   *
   * Opaque to the client and meaningful to the server, which is what lets the
   * pagination change without a client change. It is not an offset: a reviewer
   * submitting a review between two pages would shift every offset by one and
   * silently skip an entry.
   */
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(REVIEW_HISTORY_PAGE_SIZE_MAX).optional(),
});
export type ReviewHistoryQuery = z.infer<typeof ReviewHistoryQuerySchema>;
