/**
 * Decisions (§9.6, §9.9, Appendix B).
 *
 * "A published decision is never edited, only superseded." No parse can see a
 * second write, so schema-level immutability would be theatre — and a shallow
 * `Object.freeze` on the parsed result would be worse than theatre, since it
 * would leave `findings` mutable while looking like a guarantee. Immutability
 * is enforced where it is real: the store never updates a published revision.
 *
 * What the schema CAN enforce is the shape of the supersession chain, and it
 * does: revision 1 supersedes nothing, and every later revision names what it
 * replaced. §9.9's worked example is exactly that, and a revision 2 that
 * supersedes nothing would be an edit wearing a new number.
 *
 * Decisions travel outbound, to tenants and to the reviewer app, so they are
 * `.loose()`: §10.11 requires unknown fields not to break clients, and passing
 * them through rather than stripping them means a client that persists a
 * decision keeps whatever a newer CrowdSource added. This is the opposite of
 * the inbound rule in `case-envelope.ts`, for the opposite reason.
 */

import { z } from 'zod';

import { CONTRACT_LIMITS, IdentifierSchema, TimestampSchema, UnitIntervalSchema } from './primitives';
import { DecisionPolicyVersionsSchema, PolicyRuleIdSchema } from './policies';
import { ResourceIdSchema } from './resources';
import { ContextSufficiencySchema } from './reviews';
import {
  FindingAttributionSchema,
  FindingScopeSchema,
  RecommendedActionSchema,
  SeveritySchema,
  TaxonomyCodeSchema,
} from './taxonomy';

/** §3.2 decision states. */
export const DECISION_STATUSES = ['provisional', 'final', 'superseded', 'corrected'] as const;
export const DecisionStatusSchema = z.enum(DECISION_STATUSES);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

/**
 * §9.6 outcomes.
 *
 * `inconclusive` is its own outcome and must never collapse into
 * `no_violation`: a jury that reviewed the case and did not reach the threshold
 * has said something different from a jury that agreed nothing was wrong. Both
 * are here, distinctly, and no code in this package maps one to the other.
 */
export const DECISION_OUTCOMES = [
  'violation',
  'no_violation',
  'insufficient_context',
  'inconclusive',
  'content_unavailable',
  'duplicate',
  'escalated',
] as const;
export const DecisionOutcomeSchema = z.enum(DECISION_OUTCOMES);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/**
 * A confirmed finding (Appendix B).
 *
 * Carries two fields a `ReviewFinding` does not. `scope` says how far the
 * finding reaches and is what §11.7.5 gates an Oxy Trust effect on;
 * `attribution` names whose conduct it is. Neither belongs on an individual
 * review: a reviewer classifies material, and it is the consensus process that
 * decides the classification is confirmed and therefore attributable.
 *
 * `attribution` is optional because plenty of confirmed findings attribute
 * nothing to anybody — material can violate a rule without any principal having
 * behaved badly.
 */
export const DecisionFindingSchema = z.looseObject({
  code: TaxonomyCodeSchema,
  resourceIds: z.array(ResourceIdSchema).min(1).max(CONTRACT_LIMITS.RESOURCE_REFS_PER_FINDING_MAX),
  severity: SeveritySchema,
  scope: FindingScopeSchema,
  attribution: FindingAttributionSchema.optional(),
  policyRuleIds: z.array(PolicyRuleIdSchema).max(CONTRACT_LIMITS.POLICY_RULE_IDS_MAX).optional(),
});
export type DecisionFinding = z.infer<typeof DecisionFindingSchema>;

/**
 * A recommended action bound to what it applies to (Appendix B).
 *
 * §10.7's webhook example writes recommended actions as bare strings, the way
 * §9.3 writes them for a single review. Appendix B — the reference Decision —
 * writes them as objects. The object form wins for decisions: a decision that
 * recommends removal without saying what to remove is not actionable, and an
 * application that acts on it is guessing. The string form survives where the
 * plan uses it, on a review.
 *
 * `targetResourceIds` is optional because some actions have no target —
 * `escalate`, `no_global_effect` and `no_action` are about the case, not about
 * a resource.
 */
export const DecisionRecommendedActionSchema = z.looseObject({
  action: RecommendedActionSchema,
  targetResourceIds: z
    .array(ResourceIdSchema)
    .max(CONTRACT_LIMITS.RESOURCE_REFS_PER_FINDING_MAX)
    .optional(),
});
export type DecisionRecommendedAction = z.infer<typeof DecisionRecommendedActionSchema>;

/** Floating point: `winningVotes / decisiveVotes` will not be exact. */
const AGREEMENT_TOLERANCE = 1e-6;

/**
 * The panel that produced the decision (Appendix B).
 *
 * The arithmetic is checked here because it is the auditable trace of "one
 * qualified person, one vote": `agreement` must equal
 * `winningVotes / decisiveVotes` (§9.5), and the counts must nest. If a
 * weighting ever crept into the engine, `agreement` would stop matching the
 * count of people, and this is where that shows up.
 *
 * `size` is not restricted to {3, 5, 7}. Those are §9.4's community panel
 * sizes, but §9.4 also routes critical categories to specialist pools that do
 * not use the standard jury at all, and an appeal panel is only bounded below.
 */
export const DecisionJurySchema = z
  .looseObject({
    size: z.number().int().positive().max(CONTRACT_LIMITS.JURY_SIZE_MAX),
    /** Reviews that expressed a decisive opinion — the denominator of §9.5. */
    decisiveVotes: z.number().int().positive().max(CONTRACT_LIMITS.JURY_SIZE_MAX),
    winningVotes: z.number().int().nonnegative().max(CONTRACT_LIMITS.JURY_SIZE_MAX),
    agreement: UnitIntervalSchema,
    specialistPresent: z.boolean(),
  })
  .superRefine((jury, ctx) => {
    if (jury.decisiveVotes > jury.size) {
      ctx.addIssue({
        code: 'custom',
        path: ['decisiveVotes'],
        message: 'decisiveVotes cannot exceed the panel size',
      });
      return;
    }
    if (jury.winningVotes > jury.decisiveVotes) {
      ctx.addIssue({
        code: 'custom',
        path: ['winningVotes'],
        message: 'winningVotes cannot exceed decisiveVotes',
      });
      return;
    }
    const expected = jury.winningVotes / jury.decisiveVotes;
    if (Math.abs(jury.agreement - expected) > AGREEMENT_TOLERANCE) {
      ctx.addIssue({
        code: 'custom',
        path: ['agreement'],
        message: `agreement must equal winningVotes / decisiveVotes (${expected})`,
      });
    }
  });
export type DecisionJury = z.infer<typeof DecisionJurySchema>;

/**
 * One immutable revision of a case's outcome (Appendix B).
 *
 * Every field except `supersedesDecisionId` is required, following §12.8, which
 * marks `supersedes_decision_id` as the only nullable column on the decisions
 * table. The DTO uses that column's name; §9.9's prose sketch writes the same
 * link as `supersedes`.
 */
export const DecisionSchema = z
  .looseObject({
    id: IdentifierSchema,
    caseId: IdentifierSchema,
    revision: z.number().int().positive(),
    status: DecisionStatusSchema,
    outcome: DecisionOutcomeSchema,
    contextSufficiency: ContextSufficiencySchema,
    confidence: UnitIntervalSchema,
    findings: z.array(DecisionFindingSchema).max(CONTRACT_LIMITS.FINDINGS_MAX),
    recommendedActions: z
      .array(DecisionRecommendedActionSchema)
      .max(CONTRACT_LIMITS.RECOMMENDED_ACTIONS_MAX),
    jury: DecisionJurySchema,
    policyVersions: DecisionPolicyVersionsSchema,
    supersedesDecisionId: IdentifierSchema.optional(),
    publishedAt: TimestampSchema,
  })
  .superRefine((decision, ctx) => {
    if (decision.revision === 1 && decision.supersedesDecisionId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedesDecisionId'],
        message: 'the first revision of a case supersedes nothing',
      });
    }
    if (decision.revision > 1 && decision.supersedesDecisionId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedesDecisionId'],
        message: 'a revision after the first must name the decision it supersedes',
      });
    }
    if (decision.outcome === 'violation' && decision.findings.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['findings'],
        message: 'a violation outcome requires at least one finding',
      });
    }
  });
export type Decision = z.infer<typeof DecisionSchema>;
