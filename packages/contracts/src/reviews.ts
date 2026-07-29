/**
 * What one reviewer submits (§9.2, §9.3) and how they step away (§4.1).
 *
 * §9.2 splits the form in two — describe the material, then evaluate it against
 * a rule — to reduce anchoring on the reporter's category and to let the same
 * description be reused under different policies. §9.3 then gives one flat
 * result object. Both are true at once: a `ReviewFinding` carries the step-one
 * fields (`code`, `resourceIds`, `severity`, `confidence`) and the step-two
 * fields (`policyRuleIds`), and the enclosing submission carries the step-two
 * verdict (`outcome`, `recommendedActions`). The split is a property of the
 * interface, not of the payload, so it is documented here rather than nested.
 *
 * The submission is `.strict()`, and that is a safety decision, not tidiness.
 * A review belongs to an assignment the server issued; the assignment id comes
 * from the route, the case and the reviewer come from the assignment. If this
 * object tolerated a `caseId`, an `assignmentId` or a `reviewerId`, the day
 * somebody read one of them would be the day a reviewer could vote on a case
 * they were never drawn for — against "nobody chooses the case they review".
 * Strict makes that field impossible rather than merely unused.
 */

import { z } from 'zod';

import { CONTRACT_LIMITS, UnitIntervalSchema } from './primitives';
import { PolicyRuleIdSchema } from './policies';
import { ResourceIdSchema } from './resources';
import {
  FindingContextSchema,
  RecommendedActionSchema,
  SeveritySchema,
  TaxonomyCodeSchema,
} from './taxonomy';

/**
 * What a single reviewer can conclude.
 *
 * Narrower than §9.6's decision outcomes on purpose. `inconclusive` is what the
 * consensus engine reports when a panel does not agree — a single reviewer
 * cannot fail to agree with themselves, and "the absence of consensus is
 * neither guilt nor innocence" only holds if `inconclusive` is produced by the
 * engine and never voted for. `duplicate`, `escalated` and `superseded` are
 * likewise case-level states, not opinions about material. The plan never
 * enumerates review outcomes; this is that gap resolved toward the invariant.
 */
export const REVIEW_OUTCOMES = [
  'violation',
  'no_violation',
  'insufficient_context',
  'content_unavailable',
] as const;
export const ReviewOutcomeSchema = z.enum(REVIEW_OUTCOMES);
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

/** §9.5 feeds this into `contextFactor`: 1.0 if sufficient, 0.5 otherwise. */
export const CONTEXT_SUFFICIENCIES = ['sufficient', 'insufficient'] as const;
export const ContextSufficiencySchema = z.enum(CONTEXT_SUFFICIENCIES);
export type ContextSufficiency = z.infer<typeof ContextSufficiencySchema>;

/**
 * One structured finding from one reviewer (§9.3).
 *
 * `resourceIds` is required and non-empty: §9.4 makes the affected resource one
 * of the dimensions consensus is measured on, so a finding that does not say
 * what it is about cannot be agreed with or disagreed with.
 *
 * `policyRuleIds` is optional: step one of the form can complete without step
 * two — a reviewer may classify material accurately and find no rule that
 * covers it, which is exactly the `no_violation`-with-findings case §6.2
 * describes.
 *
 * `context` is §9.2's and §9.4's "excepción", written as §6.2 writes it: beside
 * the code and the severity, because "artistic nudity" is a different
 * description of the material from "nudity" rather than a different verdict
 * about it. Optional, and absence means no exception applies.
 *
 * `confidence` communicates quality and triggers escalation (§9.5). It never
 * weights the vote.
 */
export const ReviewFindingSchema = z.strictObject({
  code: TaxonomyCodeSchema,
  resourceIds: z.array(ResourceIdSchema).min(1).max(CONTRACT_LIMITS.RESOURCE_REFS_PER_FINDING_MAX),
  severity: SeveritySchema,
  context: FindingContextSchema.optional(),
  confidence: UnitIntervalSchema,
  policyRuleIds: z.array(PolicyRuleIdSchema).max(CONTRACT_LIMITS.POLICY_RULE_IDS_MAX).optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * The body of `POST /v1/reviewer/assignments/{id}/reviews` — §9.3's "result of
 * a review".
 *
 * `recommendedActions` is a list of action tokens here, where a decision's
 * `recommendedActions` are objects that name their target resources. That
 * difference is in the plan (§9.3 versus Appendix B) and is kept: a reviewer
 * recommends a course of action, and the consensus process is what binds an
 * agreed recommendation to the specific resources it applies to.
 */
export const ReviewSubmissionSchema = z
  .strictObject({
    outcome: ReviewOutcomeSchema,
    contextSufficiency: ContextSufficiencySchema,
    findings: z.array(ReviewFindingSchema).max(CONTRACT_LIMITS.FINDINGS_MAX),
    recommendedActions: z
      .array(RecommendedActionSchema)
      .max(CONTRACT_LIMITS.RECOMMENDED_ACTIONS_MAX),
    /**
     * §13.5 and the "sensitive content never reaches logs" invariant apply to
     * this field as much as to the evidence: a note is free text a human wrote
     * while looking at the material, so it is bounded here and must be treated
     * as case content everywhere downstream — never logged, never attested.
     */
    notes: z.string().max(CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH).optional(),
  })
  .superRefine((review, ctx) => {
    if (review.outcome === 'insufficient_context' && review.contextSufficiency !== 'insufficient') {
      ctx.addIssue({
        code: 'custom',
        path: ['contextSufficiency'],
        message: 'an outcome of insufficient_context requires contextSufficiency "insufficient"',
      });
    }
    if (review.outcome === 'violation' && review.findings.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'a violation outcome requires at least one finding',
      });
    }
  });
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

/**
 * §4.1: a reviewer may declare a conflict, a language they do not have,
 * material too sensitive for them, or context they cannot obtain — "without
 * penalty". These four are the plan's own list, made structured as §10.3 asks.
 */
export const RECUSAL_REASONS = [
  'conflict_of_interest',
  'language',
  'too_sensitive',
  'insufficient_context',
] as const;
export const RecusalReasonSchema = z.enum(RECUSAL_REASONS);
export type RecusalReason = z.infer<typeof RecusalReasonSchema>;

/**
 * The body of `POST /v1/reviewer/assignments/{id}/recuse`.
 *
 * Strict for the same reason as the submission, and with no free-text field
 * beyond a short optional note: a recusal is routing information, and the more
 * it can say about the case, the more it becomes a channel for case content to
 * leak into operational data.
 */
export const RecusalSubmissionSchema = z.strictObject({
  reason: RecusalReasonSchema,
  note: z.string().max(CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH).optional(),
});
export type RecusalSubmission = z.infer<typeof RecusalSubmissionSchema>;
