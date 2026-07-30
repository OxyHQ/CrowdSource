/**
 * The Reviewer API wire contract (§10.3) — what the backend sends and the
 * reviewer app receives, declared once.
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
 * is declared here and nowhere else.**
 *
 * ## Schemas, and types inferred from them
 *
 * Every shape is a Zod schema, and its TypeScript type is `z.infer` of that
 * schema. One declaration, so the two cannot disagree — which is a property worth
 * more here than the hand-written interfaces it replaces, since "two declarations
 * of one shape drifted apart" is the exact bug this file was written to end.
 *
 * Both halves are load-bearing and they catch different failures:
 *
 *  - The **type** is what the backend's builders return and what the app's
 *    projections return, so a renamed field is a compile error on BOTH sides at
 *    once — the check that would have caught every drift listed above on the day
 *    it appeared.
 *  - The **schema** is what the app parses the response WITH, and it is
 *    `.strict()` at every level. §9.1's hidden column has no field on any shape
 *    here, so a server that starts sending a report count or an author's
 *    reputation is REFUSED rather than having it quietly reach a screen. A type
 *    cannot do that: types are gone at runtime, and the wire is where an
 *    unexpected field actually arrives.
 *
 * Strict is the right direction for this surface specifically. A reviewer seeing
 * a blank screen is a bug somebody fixes today; a reviewer seeing an author's
 * reputation is a bug nobody notices.
 *
 * ## What is deliberately NOT here
 *
 * No case id, on any shape. §8.7 pseudonymises what a reviewer does not need and
 * a case id is not needed to judge material; more to the point, a case id on the
 * wire is a case id in a URL, and "nobody chooses the case they review" holds
 * because the assignment is the only handle. No reporter, no report count, no
 * reputation, no juror identity, no partial tally.
 */

import { z } from 'zod';

import { DecisionOutcomeSchema } from './decisions';
import { PolicyRuleSchema, PolicySetIdSchema, PolicyVersionSchema } from './policies';
import {
  CustomPayloadSchema,
  IdentifierSchema,
  LanguageTagSchema,
  MetadataBagSchema,
  MimeTypeSchema,
  TimestampSchema,
  UnitIntervalSchema,
} from './primitives';
import {
  AudioResourceDataSchema,
  ConversationResourceDataSchema,
  DocumentResourceDataSchema,
  LinkResourceDataSchema,
  ListingResourceDataSchema,
  LocationResourceDataSchema,
  MetadataResourceDataSchema,
  PrincipalRefSchema,
  ProfileResourceDataSchema,
  RelationSchema,
  ResourceIdSchema,
  ResourceRoleSchema,
  TextResourceDataSchema,
  VideoResourceDataSchema,
  type Resource,
} from './resources';
import { ReviewOutcomeSchema } from './reviews';
import {
  SensitivityHintSchema,
  TAXONOMY_FAMILIES,
  TaxonomyCodeSchema,
  TaxonomyFamilySchema,
} from './taxonomy';

// --- vocabularies ------------------------------------------------------------

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
 * the backend's `REVIEWER_STATE_RANK`, which gives it -1 so every capability
 * comparison fails for it, including one against `applicant`.
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
 * Triage computes a fourth, `prohibited`, and it is absent here on purpose: §7.5
 * routes that material to a specialist team under legal protocol and never to a
 * jury, so a reviewer-facing type that could express it would eventually be
 * handed it. The backend's `sensitivityRank` throws rather than returning a
 * number for it, for the same reason.
 *
 * This is also the vocabulary a reviewer's own consent is stored in, as a rank —
 * which is why it could never have been the app's invented
 * `none`/`low`/`high`/`critical`: those four map onto nothing the server computes
 * or the reviewer consented to.
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
 *    `riskClusterId` out of the profile projection entirely.
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
  /** §8.2: at least one language, or no case can ever match. */
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

/**
 * §13.7's ceiling on a self-chosen daily limit.
 *
 * Declared here because the request schema below bounds the body with it and the
 * app's control has to offer the same range — two numbers that must agree, so
 * there is one.
 */
export const REVIEWER_DAILY_LIMIT_MAX = 40;

/** The header §8.7's assignment token travels in. One spelling, both sides. */
export const ASSIGNMENT_TOKEN_HEADER = 'x-assignment-token';

// --- case material -----------------------------------------------------------

/**
 * A resource asset as a reviewer receives it (§8.7, §9.1).
 *
 * The envelope's `AssetRef` carries `uploadId` OR `url`, plus a `sha256`. None of
 * the three reaches a reviewer:
 *
 *  - `url` is a location on the REPORTING APPLICATION's own host, so sending it
 *    puts that application's brand in front of the jury — §9.1's last hidden row
 *    — and it bypasses the media chokepoint every Oxy surface resolves files
 *    through.
 *  - `sha256` is what pins a case to the exact bytes reported. A reviewer does
 *    not verify that; the case does.
 *
 * What replaces them is `fileId`, a bare Oxy file id resolved through
 * `getFileDownloadUrl` at the app root, and `retrievable`, which is the honest
 * answer when there is nothing a reviewer can be shown. A reviewer facing an
 * unretrievable resource has an outcome for exactly that (`content_unavailable`),
 * which is why this is a flag rather than an omission: dropping the resource
 * would hide from the jury that material existed at all.
 */
export const ReviewerAssetSchema = z.strictObject({
  mediaType: MimeTypeSchema,
  /** Bare Oxy file id. Absent whenever `retrievable` is false. */
  fileId: IdentifierSchema.optional(),
  /** False when CrowdSource cannot serve these bytes to a reviewer. */
  retrievable: z.boolean(),
  sizeBytes: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
});
export type ReviewerAssetView = z.infer<typeof ReviewerAssetSchema>;

/**
 * The envelope fields every reviewer-facing resource carries.
 *
 * `sha256` is absent, as above. `authorPrincipalRef` is PRESENT, and that is a
 * decision rather than an oversight: §9.1 hides the author's IDENTITY and
 * REPUTATION, and an envelope-scoped pseudonym (§13.5's "a pseudonymous
 * principal wherever one suffices") is neither. It resolves to nothing outside
 * this one case, and which resources share an author is exactly the context a
 * harassment allegation cannot be judged without.
 */
const reviewerResourceShape = {
  id: ResourceIdSchema,
  role: ResourceRoleSchema,
  language: LanguageTagSchema.optional(),
  createdAt: TimestampSchema.optional(),
  authorPrincipalRef: PrincipalRefSchema.optional(),
  sensitivity: SensitivityHintSchema.optional(),
};

/**
 * One resource of case material, as a reviewer receives it.
 *
 * Built from the same `*DataSchema` exports the envelope's own resources are
 * built from, so the twelve content shapes exist once. What differs is exactly
 * the two things the reviewer projection changes: no `sha256`, and `asset` is a
 * media handle rather than a locator.
 *
 * A strict parse rather than a hand-written field-by-field copy, and the reason
 * is the direction each fails in. A copy can only drop what somebody thought to
 * drop, and it can also DROP MATERIAL by accident — a jury shown less than the
 * application sent is the worse failure of the two. A strict parse against a
 * closed union refuses an unknown field outright and cannot silently lose a known
 * one.
 *
 * `__tests__/reviewer-surface.test.ts` asserts this union still covers every
 * `RESOURCE_TYPES` member and every base field of an envelope resource, so a new
 * resource type or field in `resources.ts` cannot quietly stop reaching a jury.
 */
export const ReviewerResourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('text'),
    data: TextResourceDataSchema,
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('link'),
    data: LinkResourceDataSchema,
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('profile'),
    data: ProfileResourceDataSchema,
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('conversation'),
    data: ConversationResourceDataSchema,
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('listing'),
    data: ListingResourceDataSchema,
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('location'),
    data: LocationResourceDataSchema,
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('metadata'),
    data: MetadataResourceDataSchema,
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('custom'),
    schemaId: IdentifierSchema,
    payload: CustomPayloadSchema,
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('image'),
    asset: ReviewerAssetSchema,
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('video'),
    asset: ReviewerAssetSchema,
    data: VideoResourceDataSchema.optional(),
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('audio'),
    asset: ReviewerAssetSchema,
    data: AudioResourceDataSchema.optional(),
  }),
  z.strictObject({
    ...reviewerResourceShape,
    type: z.literal('document'),
    asset: ReviewerAssetSchema,
    data: DocumentResourceDataSchema,
  }),
]);
export type ReviewerResource = z.infer<typeof ReviewerResourceSchema>;

/**
 * The reviewer view of an envelope resource, derived rather than written.
 *
 * Not the type the two sides use — `ReviewerResource` above is. This exists so
 * the test can compare the WRITTEN union against what the envelope's own
 * `Resource` union implies, which is the only way a new resource type in
 * `resources.ts` produces a failure rather than a resource that silently never
 * reaches a jury.
 */
export type ReviewerResourceOf<R = Resource> = R extends { asset: unknown }
  ? Omit<R, 'sha256' | 'asset'> & { asset: ReviewerAssetView }
  : Omit<R, 'sha256'>;

// --- the assignment package --------------------------------------------------

/**
 * The renderable package for ONE assignment (§8.7, §9.1).
 *
 * `language` is nullable because an envelope's resources may declare none, and
 * `families` is plural because a case can allege several: a reviewer is only
 * drawn when they accept ALL of them (§8.2), so naming one would misdescribe what
 * they were asked to judge.
 *
 * `allegations.unverified` is a constant `true` on the wire. It is redundant to a
 * reader of this file and it is not redundant to a screen: §9.1's requirement is
 * that the claim is presented AS a claim, and a flag that must be read to render
 * the label cannot be forgotten the way a comment can. `codes` is plural because
 * a case is the union of every report about the same material (§7.3) and
 * reporters do not all choose the same code — a singular field would silently
 * show a jury one allegation out of several.
 *
 * `watermark` is §13.8's pseudonymous per-assignment mark. Server-issued so a
 * leaked screenshot is traceable to one assignment; never synthesised on the
 * device, because a watermark the client composes is one the client can also omit
 * or forge, leaving a reviewer with the impression of a sealed screen and no
 * actual trace.
 */
export const AssignmentPackageSchema = z.strictObject({
  assignmentId: IdentifierSchema,
  /** The case revision this assignment is bound to (§8.7, §9.9). */
  caseRevision: z.number().int().positive(),
  /** ISO instant. After this the assignment is gone and a replacement is drawn. */
  expiresAt: TimestampSchema,
  language: LanguageTagSchema.nullable(),
  families: z.array(TaxonomyFamilySchema).max(TAXONOMY_FAMILIES.length),
  allegations: z.strictObject({
    unverified: z.literal(true),
    codes: z.array(TaxonomyCodeSchema),
  }),
  /** §9.1's "applicable policy and its rules", in full and at one version (§6.4). */
  policy: z.strictObject({
    policySetId: PolicySetIdSchema,
    version: PolicyVersionSchema,
    taxonomyVersion: z.string().min(1).max(32),
    rules: z.array(PolicyRuleSchema),
  }),
  /** §9.1's warnings and sensitivity, plus §13.7's blur decision. */
  presentation: z.strictObject({
    sensitivityClass: ReviewerSensitivityClassSchema,
    requiresRedaction: z.boolean(),
    blurBeforeReveal: z.boolean(),
  }),
  resources: z.array(ReviewerResourceSchema),
  /** §5.5 — which resource replies to, quotes or contextualises which. */
  relations: z.array(RelationSchema),
  watermark: z.string().min(1).max(64).nullable(),
  /**
   * §9.8's "contexto adicional" — the author's own words, present ONLY when this
   * assignment belongs to an appeal revision and the author supplied any. Optional
   * rather than nullable so a first-instance panel receives no such key at all: a
   * `null` would let a screen infer "this is an appeal" from the field existing.
   *
   * `unverified` is a constant `true` for the same reason it is on an allegation —
   * this is a claim by an interested party, not a finding, and the flag is what
   * makes a screen say so.
   *
   * What this shape deliberately CANNOT carry is everything else about the appeal.
   * Not the reason code, which is an argument about the verdict and would anchor
   * the panel against §9.1's list. Not the superseded decision, its outcome, its
   * findings or its jury — that is §9.8's blindness rule. Not the threshold this
   * panel is held to, which is a property of the count and not of the material. A
   * reviewer can tell they are looking at a contested case, because somebody is
   * contesting it in their own words; they cannot tell what anybody concluded. The
   * absence of those fields is the enforcement, and `.strict()` is what makes a
   * server that starts sending one a refusal rather than a screen.
   */
  authorContext: z
    .strictObject({
      unverified: z.literal(true),
      statement: z.string().min(1),
      /**
       * The same shapes `AppealAuthorContextSchema` stores, reused rather than
       * restated: `resourceIds` point at material already in the case snapshot,
       * and `fields` is §9.8's "evidencia estructurada" as a flat bag of scalars.
       * Restating them as some reviewer-shaped variant would need a translation
       * step, and a translation step between two declarations of one shape is how
       * the drift this file exists to end got started.
       */
      resourceIds: z.array(ResourceIdSchema).optional(),
      fields: MetadataBagSchema.optional(),
    })
    .optional(),
});
export type AssignmentPackage = z.infer<typeof AssignmentPackageSchema>;

/**
 * What `POST /v1/reviewer/assignments/next` returns.
 *
 * The token is here and on no other response, because it is handed over exactly
 * once and only its hash is stored (§8.7). Every later call on this assignment
 * presents it in `x-assignment-token`.
 */
export const IssuedAssignmentPackageSchema = AssignmentPackageSchema.extend({
  token: z.string().min(1).max(128),
});
export type IssuedAssignmentPackage = z.infer<typeof IssuedAssignmentPackageSchema>;

// --- the reviewer's own profile ----------------------------------------------

export const ReviewerEligibilityRequirementSchema = z.strictObject({
  id: ReviewerEligibilityRequirementIdSchema,
  met: z.boolean(),
});
export type ReviewerEligibilityRequirement = z.infer<typeof ReviewerEligibilityRequirementSchema>;

/**
 * §4.1's "Fiabilidad" — the reviewer's OWN standing in one category.
 *
 * Per category and not per (category, language): reliability is seeded by
 * calibration and moved by gold cases and audits, none of which are measured per
 * language, so a per-language figure would be the same number repeated. §4.1 asks
 * for both axes and this is the honest half of it.
 *
 * It is never anybody else's figure. §9.1 forbids a reviewer seeing another
 * person's reputation, and no shape on this surface could carry one.
 */
export const ReviewerCategoryStandingSchema = z.strictObject({
  category: TaxonomyFamilySchema,
  reliability: UnitIntervalSchema,
  specialist: z.boolean(),
});
export type ReviewerCategoryStanding = z.infer<typeof ReviewerCategoryStandingSchema>;

/**
 * §13.7's exposure and rest, as numbers rather than as a verdict.
 *
 * `breakRequiredUntil` is the sensitive-material rest of the backend's
 * `eligibility.ts`: after `SENSITIVE_EXPOSURE_MAX` sensitive cases inside
 * `SENSITIVE_EXPOSURE_WINDOW_HOURS`, the oldest of them leaving the window is
 * when the reviewer may be drawn for sensitive material again. It rests only the
 * SENSITIVE route — somebody who has worked through several distressing cases can
 * still judge a spam report — so it is not a blanket block, and a screen showing
 * it has to say which route it applies to.
 */
export const ReviewerExposureViewSchema = z.strictObject({
  reviewedToday: z.number().int().nonnegative(),
  dailyLimit: z.number().int().positive(),
  openAssignments: z.number().int().nonnegative(),
  maxOpenAssignments: z.number().int().positive(),
  /** ISO instant, or null when no rest is being enforced. */
  breakRequiredUntil: TimestampSchema.nullable(),
});
export type ReviewerExposureView = z.infer<typeof ReviewerExposureViewSchema>;

/**
 * §13.7 — consent, per category and revocable at any moment.
 *
 * `maxSensitivity` lives here rather than in preferences because it IS consent:
 * the ceiling of what this person agreed to be shown. Keeping a second copy of
 * `sensitiveCategories` under preferences — which is what the app used to declare
 * — guarantees two fields that can disagree about the same fact.
 */
export const ReviewerConsentViewSchema = z.strictObject({
  /** ISO instant the reviewer accepted the reviewing rules, or null. */
  rulesAcceptedAt: TimestampSchema.nullable(),
  /** §8.2's age compatibility, as the one bit the routing needs (§13.5). */
  ageConfirmed: z.boolean(),
  maxSensitivity: ReviewerSensitivityClassSchema,
  sensitiveCategories: z.array(TaxonomyFamilySchema),
});
export type ReviewerConsentView = z.infer<typeof ReviewerConsentViewSchema>;

export const ReviewerPreferencesViewSchema = z.strictObject({
  /** BCP-47 primary subtags the reviewer reads. */
  languages: z.array(z.string().min(2).max(16)),
  categories: z.array(TaxonomyFamilySchema),
  dailyLimit: z.number().int().positive(),
  /** False means this reviewer is in no draw at all — §4.1's immediate exit. */
  availableForAssignment: z.boolean(),
});
export type ReviewerPreferencesView = z.infer<typeof ReviewerPreferencesViewSchema>;

/**
 * `GET /v1/reviewer/profile` (§10.3: "eligibility, categories and PRIVATE
 * reliability").
 *
 * Private meaning shown to its owner and to nobody else. What the document holds
 * and this does not: `oxyUserId` (§8.7 keeps the identity and the reviewer id
 * apart), `samplingKey` (publishing it would let somebody reason about when they
 * are likely to be considered), `personhoodConfidence` (the threshold is what
 * matters; a bare number invites optimising a figure whose inputs are invisible),
 * and the anti-abuse signals.
 */
export const ReviewerProfileViewSchema = z.strictObject({
  reviewerId: IdentifierSchema,
  state: ReviewerStateSchema,
  eligibility: z.array(ReviewerEligibilityRequirementSchema),
  standings: z.array(ReviewerCategoryStandingSchema),
  completedReviewCount: z.number().int().nonnegative(),
  preferences: ReviewerPreferencesViewSchema,
  consent: ReviewerConsentViewSchema,
  exposure: ReviewerExposureViewSchema,
});
export type ReviewerProfileView = z.infer<typeof ReviewerProfileViewSchema>;

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
 * schema refuses unknown keys and the service takes named arguments, so there are
 * two independent reasons it cannot happen.
 *
 * Every field is optional and at least one must be present: a partial update is
 * the normal case (the wellbeing screen changes one toggle), and an empty body is
 * a mistake worth naming rather than a no-op worth accepting.
 */
export const ReviewerPreferencesUpdateSchema = z
  .strictObject({
    languages: z.array(z.string().min(2).max(16)).max(20).optional(),
    categories: z.array(TaxonomyFamilySchema).max(TAXONOMY_FAMILIES.length).optional(),
    /** §13.7: acceptance is recorded once and is never revoked to `false` here. */
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

// --- training and calibration ------------------------------------------------

/** `GET /v1/reviewer/training` (§10.3: "list modules and calibration"). */
export const ReviewerTrainingViewSchema = z.strictObject({
  modules: z.array(
    z.strictObject({
      moduleId: z.string().min(1).max(64),
      title: z.string().min(1).max(200),
      families: z.array(TaxonomyFamilySchema),
      completed: z.boolean(),
    }),
  ),
  trainingComplete: z.boolean(),
  /**
   * The items to answer: `itemId` and `text`, and nothing else.
   *
   * A calibration that hands back `expectedViolation` or `expectedCode` is one
   * everybody passes on the second attempt, which measures attendance rather than
   * judgement.
   */
  calibrationItems: z.array(
    z.strictObject({ itemId: z.string().min(1).max(64), text: z.string().min(1) }),
  ),
  calibrationOpen: z.boolean(),
  /** ISO instant, or null when never passed. */
  calibrationPassedAt: TimestampSchema.nullable(),
  /** ISO instant after which calibration lapses (§8.2), or null. */
  calibrationCurrentUntil: TimestampSchema.nullable(),
  calibrationScore: UnitIntervalSchema.nullable(),
  calibrationAttempts: z.number().int().nonnegative(),
  /** The score a pass requires, so the app does not restate it. */
  calibrationPassScore: UnitIntervalSchema,
});
export type ReviewerTrainingView = z.infer<typeof ReviewerTrainingViewSchema>;

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
 * `calibrationItems` above.
 */
export const ReviewerCalibrationResultViewSchema = z.strictObject({
  passed: z.boolean(),
  score: UnitIntervalSchema,
  incorrectItemIds: z.array(z.string().min(1).max(64)),
  state: ReviewerStateSchema,
});
export type ReviewerCalibrationResultView = z.infer<typeof ReviewerCalibrationResultViewSchema>;

// --- history -----------------------------------------------------------------

export const REVIEW_HISTORY_PAGE_SIZE_MAX = 50;
export const REVIEW_HISTORY_PAGE_SIZE_DEFAULT = 20;

/**
 * §4.1's "Historial" — one completed review as its author may see it back.
 *
 * `outcome` is the reviewer's OWN submitted outcome. `decision` is populated only
 * once a decision has been PUBLISHED for the revision this reviewer judged, and
 * carries the outcome and the moment and nothing else — no agreement figure, no
 * jury size, no vote count, no findings. §4.1 asks the history to show "results
 * that may already be revealed"; §9.1 forbids previous votes and partial results.
 * Both hold: a published decision is not partial, and an agreement ratio IS a
 * tally, so it has no field here rather than merely being left unset.
 */
export const ReviewHistoryEntrySchema = z.strictObject({
  reviewId: IdentifierSchema,
  /** ISO instant. */
  submittedAt: TimestampSchema,
  families: z.array(TaxonomyFamilySchema),
  language: LanguageTagSchema.nullable(),
  outcome: ReviewOutcomeSchema,
  decision: z
    .strictObject({ outcome: DecisionOutcomeSchema, publishedAt: TimestampSchema })
    .nullable(),
});
export type ReviewHistoryEntry = z.infer<typeof ReviewHistoryEntrySchema>;

/** `GET /v1/reviewer/reviews`. */
export const ReviewHistoryPageSchema = z.strictObject({
  entries: z.array(ReviewHistoryEntrySchema),
  /** Opaque cursor for the next page, or null when the list is exhausted. */
  nextCursor: z.string().min(1).max(64).nullable(),
});
export type ReviewHistoryPage = z.infer<typeof ReviewHistoryPageSchema>;

/**
 * The query of `GET /v1/reviewer/reviews`.
 *
 * The cursor is opaque to the client and meaningful to the server, which is what
 * lets the pagination change without a client change. It is not an offset: a
 * reviewer submitting a review between two pages would shift every offset by one
 * and silently skip an entry — in a list whose only purpose is somebody checking
 * their own record.
 */
export const ReviewHistoryQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(REVIEW_HISTORY_PAGE_SIZE_MAX).optional(),
});
export type ReviewHistoryQuery = z.infer<typeof ReviewHistoryQuerySchema>;
