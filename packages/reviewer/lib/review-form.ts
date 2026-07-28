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

import type {
  CertaintyLevel,
  ContextSufficiency,
  FindingSeverity,
  MissingContextCode,
  PolicyRule,
  ReviewOutcome,
  ReviewSubmission,
} from '@/lib/reviewer-api/types';

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

export const MISSING_CONTEXT_CODES: readonly MissingContextCode[] = [
  'none',
  'preceding_conversation',
  'author_intent',
  'translation',
  'source_or_provenance',
  'local_cultural_context',
];

export const CERTAINTY_LEVELS: readonly CertaintyLevel[] = ['low', 'medium', 'high'];

export const REVIEW_OUTCOMES: readonly ReviewOutcome[] = [
  'violation',
  'no_violation',
  'insufficient_context',
  'content_unavailable',
];

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['low', 'medium', 'high', 'critical'];

/**
 * PLAN §9.3 carries a `confidence` in 0..1 per finding. A free scalar invites a
 * reviewer to invent precision they do not have, so the form offers three points
 * and SHOWS the reviewer the number each one asserts.
 */
export const FINDING_CONFIDENCE: Record<CertaintyLevel, number> = {
  low: 0.5,
  medium: 0.75,
  high: 0.95,
};

export const RECOMMENDED_ACTIONS = [
  'no_action',
  'add_warning_label',
  'restrict_visibility',
  'remove_or_restrict',
  'escalate_to_specialist',
] as const;

export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

export type ReviewStep = 'descriptive' | 'policy';

/** One selected policy rule, with the severity and confidence the reviewer gives it. */
export interface SelectedFinding {
  ruleId: string;
  severity: FindingSeverity;
  confidence: CertaintyLevel;
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
  appliedExceptionIds: string[];
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
  | { type: 'setFindingSeverity'; ruleId: string; severity: FindingSeverity }
  | { type: 'setFindingConfidence'; ruleId: string; confidence: CertaintyLevel }
  | { type: 'toggleException'; exceptionId: string }
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
    appliedExceptionIds: [],
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
          : [...state.findings, { ruleId: action.ruleId, severity: 'medium', confidence: 'medium' }],
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
    case 'toggleException':
      return { ...state, appliedExceptionIds: toggle(state.appliedExceptionIds, action.exceptionId) };
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
  return state.recommendedActions.length > 0;
}

/**
 * Builds the wire payload, or `null` when the form is not complete.
 *
 * `rules` is the policy brief's rule list — the SERVER's applicable policy. A
 * finding's taxonomy code comes from there, never from the allegation.
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

  const findings = state.findings.flatMap((finding) => {
    const rule = rules.find((candidate) => candidate.id === finding.ruleId);
    if (!rule) {
      // The rule vanished between render and submit (a policy version change).
      // Dropping it is correct: this app must not invent a taxonomy code.
      return [];
    }
    return [
      {
        code: rule.taxonomyCode,
        resourceIds: state.affectedResourceIds,
        severity: finding.severity,
        confidence: FINDING_CONFIDENCE[finding.confidence],
        policyRuleIds: [rule.id],
      },
    ];
  });

  const notes = state.notes.trim();
  return {
    descriptive: {
      contentDescriptors: [...state.contentDescriptors],
      affectedResourceIds: [...state.affectedResourceIds],
      missingContext: [...state.missingContext],
      certainty: state.certainty,
    },
    outcome: state.outcome,
    contextSufficiency: state.contextSufficiency,
    findings,
    appliedExceptionIds: [...state.appliedExceptionIds],
    recommendedActions: [...state.recommendedActions],
    ...(notes ? { notes } : {}),
  };
}
