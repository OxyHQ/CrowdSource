/**
 * The two-step review form (PLAN §9.2), as a pure reducer.
 *
 * Step 1 describes what the material CONTAINS. Step 2 evaluates it against a
 * policy. The order is the product, not a layout preference: the reporter chose
 * a category when they filed, and a reviewer who reads that category first tends
 * to go looking for it. Describing first is what stops the allegation anchoring
 * the finding.
 *
 * Three properties are enforced here rather than in the screen, because a screen
 * is one refactor away from losing them:
 *
 *  1. {@link createInitialReviewFormState} takes NO arguments. It cannot be
 *     seeded from the allegation, the reported category or anything else the
 *     reporter supplied, because it has nothing to seed from. Step 2 starts
 *     empty, always.
 *  2. {@link reviewFormReducer} refuses `advance` until step 1 is complete, so
 *     the steps cannot be collapsed by rendering both at once and letting the
 *     reviewer fill them in either order.
 *  3. {@link buildReviewSubmission} returns `null` unless both steps are
 *     complete, so a partially-filled form has no representation on the wire.
 */

import {
  FINDING_CONTEXTS,
  RECOMMENDED_ACTIONS,
  REVIEW_OUTCOMES as CONTRACT_REVIEW_OUTCOMES,
  SEVERITIES,
  type ContextSufficiency,
  type FindingContext,
  type PolicyRule,
  type RecommendedAction,
  type ReviewFinding,
  type ReviewOutcome,
  type ReviewSubmission,
  type Severity,
} from '@oxyhq/crowdsource-contracts';

/**
 * Step 1 vocabulary. Every entry describes something OBSERVABLE in the material.
 * None of them names a policy, a rule or a verdict — that is step 2's job, and
 * mixing the two here would reintroduce the anchoring the split exists to
 * prevent.
 */
export const CONTENT_DESCRIPTORS = [
  'insults_or_slurs',
  'threat_of_violence',
  'sexual_content',
  'nudity',
  'graphic_injury',
  'self_harm',
  'minor_appears_present',
  'personal_information',
  'impersonation_claim',
  'commercial_promotion',
  'contested_factual_claim',
  'nothing_notable',
] as const;

export type ContentDescriptor = (typeof CONTENT_DESCRIPTORS)[number];

/**
 * What context the reviewer says is missing.
 *
 * App-local, and it stays app-local: nothing on the wire carries these. They feed
 * the reviewer's own `contextSufficiency` answer in step 2, which is the field
 * §9.4 measures consensus on. Sending the list too would put a second, unread
 * description of the material into the record — §13.5 minimisation.
 */
export const MISSING_CONTEXT_CODES = [
  'none',
  'preceding_conversation',
  'author_intent',
  'translation',
  'source_or_provenance',
  'local_cultural_context',
] as const;

export type MissingContextCode = (typeof MISSING_CONTEXT_CODES)[number];

/**
 * How sure the reviewer is, as three points rather than a free scalar.
 *
 * PLAN §9.3 carries a `confidence` in 0..1 per finding, and a slider invites
 * somebody to invent precision they do not have. The form offers three points and
 * SHOWS the number each one asserts.
 */
export const CERTAINTY_LEVELS = ['low', 'medium', 'high'] as const;

export type CertaintyLevel = (typeof CERTAINTY_LEVELS)[number];

export const REVIEW_OUTCOMES: readonly ReviewOutcome[] = CONTRACT_REVIEW_OUTCOMES;

export const FINDING_SEVERITIES: readonly Severity[] = SEVERITIES;

/**
 * §6.2's and §9.4's "excepción" — the context that makes a classification not
 * mean what it usually means.
 *
 * A CLOSED list from the contract, not a per-policy list the server sends. §9.4
 * makes the exception one of the six dimensions consensus is measured on, and two
 * reviewers who answer `no_violation` for incompatible reasons have not agreed —
 * which only works if both were choosing from the same vocabulary. It belongs to
 * ONE finding, beside its code and severity, because "artistic nudity" is a
 * different description of the material rather than a different verdict about it.
 */
export const FINDING_EXCEPTIONS: readonly FindingContext[] = FINDING_CONTEXTS;

/** The number each certainty point asserts, shown to the reviewer as such. */
export const FINDING_CONFIDENCE: Record<CertaintyLevel, number> = {
  low: 0.5,
  medium: 0.75,
  high: 0.95,
};

/**
 * The actions a reviewer may recommend.
 *
 * A five-item subset of the contract's twenty-two, typed as
 * `readonly RecommendedAction[]` so a rename or removal upstream is a compile
 * error here rather than a `400` at submit time. The app used to offer
 * `add_warning_label`, `restrict_visibility` and `escalate_to_specialist`, none of
 * which the contract has ever accepted; these are the real tokens for the same
 * five intentions. The rest of the vocabulary is for the CONSENSUS engine and the
 * Trust & Safety console — a juror recommending `legal_queue` or `freeze_transaction`
 * is a juror making a routing decision that is not theirs.
 */
export const REVIEWER_RECOMMENDED_ACTIONS: readonly RecommendedAction[] = [
  'no_action',
  'label',
  'reduce_distribution',
  'remove_or_restrict',
  'specialist_queue',
];

export type ReviewStep = 'descriptive' | 'policy';

/**
 * One selected policy rule, with what the reviewer says about it.
 *
 * `exception` is §6.2's `context` and it is per finding, not per form: the same
 * review can find one thing documentary and another not.
 */
export interface SelectedFinding {
  ruleId: string;
  severity: Severity;
  confidence: CertaintyLevel;
  exception: FindingContext | null;
}

export interface ReviewFormState {
  step: ReviewStep;
  /** Step 1 — descriptive classification. */
  contentDescriptors: ContentDescriptor[];
  affectedResourceIds: string[];
  missingContext: MissingContextCode[];
  certainty: CertaintyLevel | null;
  /** Step 2 — policy evaluation. Empty until the reviewer fills it in. */
  outcome: ReviewOutcome | null;
  contextSufficiency: ContextSufficiency | null;
  findings: SelectedFinding[];
  recommendedActions: RecommendedAction[];
  notes: string;
}

export type ReviewFormAction =
  | { type: 'toggleDescriptor'; descriptor: ContentDescriptor }
  | { type: 'toggleResource'; resourceId: string }
  | { type: 'toggleMissingContext'; code: MissingContextCode }
  | { type: 'setCertainty'; certainty: CertaintyLevel }
  | { type: 'advance' }
  | { type: 'back' }
  | { type: 'setOutcome'; outcome: ReviewOutcome }
  | { type: 'setContextSufficiency'; sufficiency: ContextSufficiency }
  | { type: 'toggleFinding'; ruleId: string }
  | { type: 'setFindingSeverity'; ruleId: string; severity: Severity }
  | { type: 'setFindingConfidence'; ruleId: string; confidence: CertaintyLevel }
  | { type: 'setFindingException'; ruleId: string; exception: FindingContext | null }
  | { type: 'toggleAction'; action: RecommendedAction }
  | { type: 'setNotes'; notes: string };

/**
 * The empty form.
 *
 * Zero parameters, by design — see the note at the top of this file. If a future
 * change needs the assignment here, that change is the moment to ask whether it
 * is smuggling the allegation into step 2.
 */
export function createInitialReviewFormState(): ReviewFormState {
  return {
    step: 'descriptive',
    contentDescriptors: [],
    affectedResourceIds: [],
    missingContext: [],
    certainty: null,
    outcome: null,
    contextSufficiency: null,
    findings: [],
    recommendedActions: [],
    notes: '',
  };
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/**
 * `nothing_notable` and `none` are assertions that the list is otherwise empty,
 * so they are mutually exclusive with everything else in their group. Letting
 * both stand would produce a description that contradicts itself.
 */
function toggleExclusive<T>(list: T[], value: T, exclusive: T): T[] {
  if (value === exclusive) {
    return list.includes(exclusive) ? [] : [exclusive];
  }
  return toggle(
    list.filter((item) => item !== exclusive),
    value,
  );
}

export function reviewFormReducer(
  state: ReviewFormState,
  action: ReviewFormAction,
): ReviewFormState {
  switch (action.type) {
    case 'toggleDescriptor':
      return {
        ...state,
        contentDescriptors: toggleExclusive(
          state.contentDescriptors,
          action.descriptor,
          'nothing_notable',
        ),
      };
    case 'toggleResource':
      return { ...state, affectedResourceIds: toggle(state.affectedResourceIds, action.resourceId) };
    case 'toggleMissingContext':
      return {
        ...state,
        missingContext: toggleExclusive(state.missingContext, action.code, 'none'),
      };
    case 'setCertainty':
      return { ...state, certainty: action.certainty };
    case 'advance':
      // Guarded here, not in the screen: step 2 is unreachable until the
      // material has been described on its own terms.
      return isDescriptiveComplete(state) ? { ...state, step: 'policy' } : state;
    case 'back':
      // Going back is always allowed. Step 2 answers are kept — losing a
      // reviewer's work for re-reading the material would teach them not to.
      return { ...state, step: 'descriptive' };
    case 'setOutcome':
      return { ...state, outcome: action.outcome };
    case 'setContextSufficiency':
      return { ...state, contextSufficiency: action.sufficiency };
    case 'toggleFinding': {
      const existing = state.findings.find((finding) => finding.ruleId === action.ruleId);
      return {
        ...state,
        findings: existing
          ? state.findings.filter((finding) => finding.ruleId !== action.ruleId)
          : [
              ...state.findings,
              {
                ruleId: action.ruleId,
                severity: 'medium',
                // Seeded from step 1's certainty rather than a fixed default: the
                // reviewer has already said how sure they are of what they are
                // looking at, and asking again from scratch discards that answer.
                confidence: state.certainty ?? 'medium',
                exception: null,
              },
            ],
      };
    }
    case 'setFindingSeverity':
      return {
        ...state,
        findings: state.findings.map((finding) =>
          finding.ruleId === action.ruleId ? { ...finding, severity: action.severity } : finding,
        ),
      };
    case 'setFindingConfidence':
      return {
        ...state,
        findings: state.findings.map((finding) =>
          finding.ruleId === action.ruleId ? { ...finding, confidence: action.confidence } : finding,
        ),
      };
    case 'setFindingException':
      return {
        ...state,
        findings: state.findings.map((finding) =>
          finding.ruleId === action.ruleId ? { ...finding, exception: action.exception } : finding,
        ),
      };
    case 'toggleAction':
      return { ...state, recommendedActions: toggle(state.recommendedActions, action.action) };
    case 'setNotes':
      return { ...state, notes: action.notes };
  }
}

export function isDescriptiveComplete(state: ReviewFormState): boolean {
  return (
    state.contentDescriptors.length > 0 &&
    state.missingContext.length > 0 &&
    state.certainty !== null
  );
}

export function isPolicyComplete(state: ReviewFormState): boolean {
  if (state.outcome === null || state.contextSufficiency === null) {
    return false;
  }
  // A `violation` with no finding names no rule, which is not a decision anyone
  // could act on or appeal. Every other outcome stands on its own.
  if (state.outcome === 'violation' && state.findings.length === 0) {
    return false;
  }
  /**
   * A finding must say what it is about.
   *
   * `ReviewFindingSchema` requires a non-empty `resourceIds` because §9.4 makes
   * the affected resource one of the dimensions consensus is measured on — a
   * finding that names no resource cannot be agreed or disagreed with. Enforced
   * here so the reviewer is told by a disabled button, rather than by a `400`
   * after they have written the whole thing.
   */
  if (state.findings.length > 0 && state.affectedResourceIds.length === 0) {
    return false;
  }
  return state.recommendedActions.length > 0;
}

/**
 * Builds the wire payload, or `null` when the form is not complete.
 *
 * `rules` is the policy brief's rule list — the SERVER's applicable policy. A
 * finding's taxonomy code comes from there, never from the allegation.
 *
 * ## Step 1's answers are not on the wire, and that is the contract's decision
 *
 * `ReviewSubmissionSchema` is `.strict()` and has no branch for the descriptive
 * step. §9.2 gives the split two purposes and both survive without persisting it:
 * anchoring is reduced by the ORDER (the reviewer describes before they see the
 * allegation), and findings are reusable under different policies because a
 * finding carries a universal taxonomy code alongside the application's
 * `policyRuleIds` — layer one and layer two, kept apart.
 *
 * What step 1 does reach the wire through: `affectedResourceIds` becomes every
 * finding's `resourceIds`, and `certainty` seeds each finding's confidence. What
 * it does not: `contentDescriptors` and `missingContext`, which nothing reads.
 * Storing a second description of case material that no consumer looks at is
 * exactly §13.5's minimisation problem — it would let this service answer
 * questions nobody asked it, about reported content.
 */
export function buildReviewSubmission(
  state: ReviewFormState,
  rules: readonly PolicyRule[],
): ReviewSubmission | null {
  if (!isDescriptiveComplete(state) || !isPolicyComplete(state)) {
    return null;
  }
  if (state.certainty === null || state.outcome === null || state.contextSufficiency === null) {
    return null;
  }

  const findings = state.findings.flatMap<ReviewFinding>((finding) => {
    const rule = rules.find((candidate) => candidate.id === finding.ruleId);
    /**
     * A rule declares which universal findings it responds to (§6.2), and a
     * multi-code rule gives no way to pick one — so the FIRST is used and a rule
     * that vanished between render and submit (a policy version change) is
     * dropped. Dropping is correct: this app must not invent a taxonomy code.
     */
    const code = rule?.taxonomyCodes[0];
    if (rule === undefined || code === undefined) {
      return [];
    }
    return [
      {
        code,
        resourceIds: state.affectedResourceIds,
        severity: finding.severity,
        confidence: FINDING_CONFIDENCE[finding.confidence],
        policyRuleIds: [rule.id],
        ...(finding.exception === null ? {} : { context: finding.exception }),
      },
    ];
  });

  const notes = state.notes.trim();
  return {
    outcome: state.outcome,
    contextSufficiency: state.contextSufficiency,
    findings,
    recommendedActions: [...state.recommendedActions],
    ...(notes ? { notes } : {}),
  };
}
