/**
 * Reviewer API data shapes.
 *
 * These describe the Reviewer surface of the CrowdSource API (PLAN §10.3) as the
 * app consumes it. They live here — not in `@oxyhq/crowdsource-contracts` — only
 * because that package exports nothing yet: it is the boundary the Zod schemas
 * will be published from, and this file is the placeholder that must be DELETED
 * (not aliased, not re-exported) the moment those schemas land. Every type below
 * is written to the plan, so the swap is a rename, not a redesign.
 *
 * The single most important property of this file is what the case package does
 * NOT contain. PLAN §9.1 lists what a reviewer must never see; those fields have
 * no home in `AssignmentPackage`, and `redaction.ts` projects the wire payload
 * onto these types field by field so a server that sends them anyway cannot get
 * them onto a screen.
 */

/** PLAN §8.1 — reviewer onboarding states, in order of capability. */
export type ReviewerState =
  | 'applicant'
  | 'calibrating'
  | 'community_reviewer'
  | 'trusted_reviewer'
  | 'category_specialist'
  | 'appeals_reviewer'
  | 'suspended';

/** PLAN §8.2 — the eligibility dimensions, each independently satisfiable. */
export type EligibilityRequirementId =
  | 'oxy_account'
  | 'personhood'
  | 'age'
  | 'language_region'
  | 'training_current'
  | 'sensitive_consent'
  | 'no_conflict'
  | 'no_coordination_signals'
  | 'no_prior_participation'
  | 'exposure_headroom';

export interface EligibilityRequirement {
  id: EligibilityRequirementId;
  met: boolean;
  /**
   * Server-authored, already-localized explanation. Optional: a requirement that
   * is met rarely needs one.
   */
  detail?: string;
}

/** PLAN §4.1 "Fiabilidad" — the reviewer's OWN private standing, per category. */
export interface CategoryStanding {
  category: string;
  language: string;
  /** 0..1. The reviewer's own figure; never another person's reputation. */
  reliability: number;
  reviewsCompleted: number;
  calibrationCurrent: boolean;
}

export interface ExposureState {
  reviewedToday: number;
  dailyLimit: number;
  /** ISO instant, or null when no break is being enforced. */
  breakRequiredUntil: string | null;
}

export interface TrainingModuleSummary {
  id: string;
  title: string;
  category: string;
  /** ISO instant of completion, or null when never completed. */
  completedAt: string | null;
  /** ISO instant after which the module must be retaken, or null when it does not expire. */
  expiresAt: string | null;
  /** Number of calibration cases attached to this module. */
  calibrationCaseCount: number;
}

export interface TrainingState {
  modules: TrainingModuleSummary[];
  /** ISO instant after which calibration lapses, or null when never calibrated. */
  calibrationCurrentUntil: string | null;
  /** Calibration cases answered while in the `calibrating` state. */
  calibrationCasesAnswered: number;
  calibrationCasesRequired: number;
}

/** PLAN §13.7 — consent is per category and revocable at any time. */
export interface ReviewerConsent {
  /** ISO instant the reviewer accepted the reviewing rules, or null. */
  rulesAcceptedAt: string | null;
  /** Whether the reviewer has confirmed an age compatible with their categories. */
  ageConfirmed: boolean;
  /** Categories the reviewer has explicitly consented to see sensitive material for. */
  sensitiveCategories: string[];
}

export interface ReviewerPreferences {
  languages: string[];
  categories: string[];
  sensitiveCategories: string[];
  dailyLimit: number;
  /** When false the reviewer is not entered into any draw. PLAN §4.1 "salida inmediata". */
  availableForAssignment: boolean;
}

export interface ReviewerProfile {
  state: ReviewerState;
  eligibility: EligibilityRequirement[];
  standings: CategoryStanding[];
  preferences: ReviewerPreferences;
  consent: ReviewerConsent;
  exposure: ExposureState;
}

export type SensitivityLevel = 'none' | 'low' | 'high' | 'critical';

export type ReviewResourceKind = 'text' | 'image' | 'video' | 'audio' | 'link' | 'file';

/**
 * One piece of case material. `id` is the assignment-scoped pseudonym the server
 * issues (PLAN §8.7: resource and application ids are pseudonymized in the
 * reviewer's view), never a durable platform id.
 */
export interface ReviewResource {
  id: string;
  kind: ReviewResourceKind;
  /** Present for `text`. */
  text?: string;
  /** Bare Oxy file id for `image` / `video` / `audio` / `file`. Resolved through Bloom's ImageResolver. */
  fileId?: string;
  /** Present for `link`. */
  url?: string;
  mediaType?: string;
  /** True when this specific resource is behind the sensitive-material gate. */
  sensitive: boolean;
  /** Warning codes for this resource, shown BEFORE any reveal. */
  warnings: string[];
}

/** Neutral, non-identifying context the jury needs to judge the material. */
export interface ContextNote {
  id: string;
  /** Server-authored, already-localized. */
  text: string;
}

export interface PolicyExample {
  id: string;
  text: string;
  /** Whether the example is of a violation or of permitted material. */
  violating: boolean;
}

export interface PolicyRule {
  id: string;
  title: string;
  text: string;
  /**
   * PLAN §6.2 — the taxonomy code a finding against this rule carries. Kept
   * distinct from `id` because the rule is the application's policy and the code
   * is the universal taxonomy: the same finding is reusable under a different
   * policy set, which is the reason §9.2 separates description from evaluation
   * in the first place.
   */
  taxonomyCode: string;
}

/** A named exception a reviewer may apply (satire, news reporting, consent, …). */
export interface PolicyException {
  id: string;
  title: string;
  text: string;
}

/** PLAN §9.1 "Política aplicable y ejemplos" + §6.4 policy versioning. */
export interface PolicyBrief {
  policySetId: string;
  policyVersion: string;
  rules: PolicyRule[];
  examples: PolicyExample[];
  exceptions: PolicyException[];
}

/**
 * PLAN §9.1 — shown as an UNVERIFIED allegation and nothing more. Carries no
 * reporter identity, no report count and no reputation.
 */
export interface Allegation {
  /** Taxonomy code the reporter chose. A claim, not a finding. */
  code: string;
  /** Optional free text the reporter supplied, already redacted server-side. */
  statement?: string;
}

/**
 * The renderable package for ONE assignment (PLAN §8.7, §9.1).
 *
 * There is deliberately no `caseId` here that the app would put in a URL: the
 * assignment is the only handle, it is held in memory for the session, and the
 * route that renders it takes no parameters. Nobody can link to a case.
 */
export interface AssignmentPackage {
  assignmentId: string;
  /** ISO instant. After this the assignment is gone and a replacement is drawn. */
  expiresAt: string;
  /** The case revision this assignment is bound to (PLAN §8.7). */
  caseRevision: number;
  /** BCP-47 language of the material. */
  language: string;
  category: string;
  sensitivity: SensitivityLevel;
  /** Case-level warning codes, shown before anything is revealed. */
  warnings: string[];
  resources: ReviewResource[];
  context: ContextNote[];
  policy: PolicyBrief;
  allegation: Allegation;
  /**
   * PLAN §13.8 — pseudonymous per-assignment watermark. Server-issued so a leak
   * is traceable; rendered only when present, never synthesized on the device.
   */
  watermark: string | null;
}

/** PLAN §9.2 step 1 — descriptive classification, before any policy judgement. */
export type CertaintyLevel = 'low' | 'medium' | 'high';

export type MissingContextCode =
  | 'none'
  | 'preceding_conversation'
  | 'author_intent'
  | 'translation'
  | 'source_or_provenance'
  | 'local_cultural_context';

export interface DescriptiveClassification {
  /** What the material actually contains, in the reviewer's own reading. */
  contentDescriptors: string[];
  /** Which resources the description applies to. */
  affectedResourceIds: string[];
  missingContext: MissingContextCode[];
  certainty: CertaintyLevel;
}

/** PLAN §9.3. */
export type ReviewOutcome =
  | 'violation'
  | 'no_violation'
  | 'insufficient_context'
  | 'content_unavailable';

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ReviewFinding {
  code: string;
  resourceIds: string[];
  severity: FindingSeverity;
  /** 0..1 — the reviewer's own certainty in this finding. */
  confidence: number;
  policyRuleIds: string[];
}

export type ContextSufficiency = 'sufficient' | 'insufficient';

/**
 * PLAN §9.3, with the step-1 answers carried alongside as `descriptive`.
 *
 * The plan's example object shows only the policy-evaluation half; §9.2 requires
 * the descriptive step to be recorded too ("permite reutilizar los hallazgos con
 * políticas distintas"), so it is submitted as its own branch rather than being
 * flattened into the findings.
 */
export interface ReviewSubmission {
  descriptive: DescriptiveClassification;
  outcome: ReviewOutcome;
  contextSufficiency: ContextSufficiency;
  findings: ReviewFinding[];
  /** PLAN §9.4 — consensus checks agreement on the relevant exception too. */
  appliedExceptionIds: string[];
  recommendedActions: string[];
  notes?: string;
}

/**
 * PLAN §4.1 / §13.7 — recusal reasons. `too_sensitive` and `insufficient_context`
 * exist precisely so a reviewer never has to guess in order to get out.
 */
export type RecusalReason =
  | 'conflict_of_interest'
  | 'language'
  | 'too_sensitive'
  | 'insufficient_context'
  | 'unavailable';

export interface RecusalSubmission {
  reason: RecusalReason;
  /** Optional free text. Never required — a reviewer must not have to justify leaving. */
  notes?: string;
}

/**
 * PLAN §4.1 "Historial" — a completed review as its author may see it back.
 *
 * `outcome` is the reviewer's OWN submitted outcome. `decision` is populated
 * only once the case is decided AND publishable to this reviewer; while it is
 * null the reviewer learns nothing about where the jury is heading, which is the
 * same rule as §9.1's ban on partial votes.
 */
export interface ReviewHistoryEntry {
  reviewId: string;
  submittedAt: string;
  category: string;
  language: string;
  outcome: ReviewOutcome;
  /** `null` until the decision is final and disclosable. */
  decision: {
    outcome: string;
    publishedAt: string;
  } | null;
}

export interface ReviewHistoryPage {
  entries: ReviewHistoryEntry[];
  /** Opaque cursor for the next page, or null when the list is exhausted. */
  nextCursor: string | null;
}

/** Body of `POST /v1/reviewer/onboarding` — acceptance of the reviewing rules. */
export interface OnboardingSubmission {
  acceptRules: boolean;
  confirmAge: boolean;
  languages: string[];
  categories: string[];
  sensitiveCategories: string[];
}
