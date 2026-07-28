/**
 * The internal reputation event (§11.5, §11.6, §11.7).
 *
 * This is the only thing CrowdSource ever sends toward Oxy Trust, and it is a
 * statement, not an instruction. "CrowdSource does not write to reputation
 * collections. It publishes an authenticated internal event" (§11.5), and Oxy
 * Trust's own consequence engine decides what, if anything, follows. Nothing in
 * this payload names points, a tier, a strike or a standing: an application —
 * and CrowdSource on its behalf — never chooses an Oxy reputation figure.
 *
 * Three of §11.7's eight pre-effect validations are structural, and all three
 * are moved into the type rather than left to a runtime check that a future
 * refactor can drop:
 *
 *   * §11.7.4 — `subject.bindingProofId` is required. "No binding proof, no Oxy
 *     Trust effect" becomes an event that cannot be constructed.
 *   * §11.7.5 — a finding's scope must be `oxy_network` or `identity_integrity`.
 *     `application_local` cannot appear here at all, which is §6.5's rule that
 *     a local restriction does not become a global sanction, enforced at the
 *     wire rather than by the receiver's diligence.
 *   * §11.7.8 — the decision may not be superseded or corrected, so the status
 *     enum has only the two values that may carry an effect (§11.7.3).
 *
 * The remaining five are stateful — who signed it, whether this event was seen
 * before, whether the incident already produced an equivalent effect — and stay
 * with the bridge.
 *
 * This is the one payload in the package that is `.strict()` in the OUTBOUND
 * direction. §10.11's rule about unknown fields has an explicit exception for
 * "where the schema forbids them for safety", and this is that case twice over:
 * a finding here deliberately carries no `resourceIds` and no free text, so
 * that nothing about the reviewed material reaches a reputation ledger or a
 * signed attestation, and an unrecognised field is exactly how that would
 * happen. Forward compatibility is handled by the `.v1` in the event type.
 */

import { z } from 'zod';

import { CONTRACT_LIMITS, IdentifierSchema, Sha256DigestSchema } from './primitives';
import { PrincipalTypeSchema } from './case-envelope';
import { ReputationPolicyVersionsSchema } from './policies';
import {
  FindingAttributionSchema,
  ReputationEligibleFindingScopeSchema,
  SeveritySchema,
  TaxonomyCodeSchema,
} from './taxonomy';

/**
 * §11.6 names one event type. §11.5 names four bridge operations — apply,
 * finalize, reverse, reconcile — so siblings are expected, but the plan does
 * not write them and they are not invented here. Adding one is additive: a new
 * literal and a new variant, with the `.v1` suffix carrying the version.
 */
export const MODERATION_DECISION_FINALIZED_EVENT_TYPE = 'moderation.decision.finalized.v1';

/**
 * §11.7.3 and §11.7.8 together: an effect may follow a final decision or,
 * where policy allows, a provisional one — and never a superseded or corrected
 * one. Those two states are absent from this enum rather than rejected by a
 * refinement, so the impossibility is visible in the type.
 */
export const REPUTATION_EVENT_DECISION_STATUSES = ['provisional', 'final'] as const;
export const ReputationEventDecisionStatusSchema = z.enum(REPUTATION_EVENT_DECISION_STATUSES);
export type ReputationEventDecisionStatus = z.infer<typeof ReputationEventDecisionStatusSchema>;

/**
 * Who the effect would land on (§11.6 `subject`).
 *
 * `bindingProofId` is required, unconditionally — see §11.7.4 above. The
 * envelope's `principalBindings` make the same proof optional for non-Oxy
 * principal types, because those can never reach this event; here there is
 * nothing to be lenient about.
 */
export const ReputationEventSubjectSchema = z.strictObject({
  principalType: PrincipalTypeSchema,
  principalId: IdentifierSchema,
  bindingProofId: IdentifierSchema,
});
export type ReputationEventSubject = z.infer<typeof ReputationEventSubjectSchema>;

/**
 * A finding as Oxy Trust sees it (§11.6).
 *
 * Deliberately narrower than a `DecisionFinding`: no `resourceIds`, no policy
 * rule ids, no text. Oxy Trust needs to know what was confirmed, how serious it
 * was, how far it reaches and whose conduct it was — it does not need to know
 * which piece of content it happened on, and §13.5's minimisation plus the
 * invariant that sensitive content never appears in logs or public attestations
 * mean it must not be told.
 *
 * `attribution` is required here where it is optional on a decision finding: an
 * effect must land on somebody, and a finding that attributes nothing has
 * nothing to contribute to this event.
 */
export const ReputationEventFindingSchema = z.strictObject({
  code: TaxonomyCodeSchema,
  severity: SeveritySchema,
  scope: ReputationEligibleFindingScopeSchema,
  attribution: FindingAttributionSchema,
});
export type ReputationEventFinding = z.infer<typeof ReputationEventFindingSchema>;

/**
 * `moderation.decision.finalized.v1` (§11.6).
 *
 * `incidentId` is what makes "one penalty per incident" enforceable: it is the
 * first component of the effect's idempotency key (Appendix D:
 * `incidentId + principalId + effectType + decisionRevision`), so the same
 * incident reaching the bridge twice — from a replay, from a redelivery, from
 * two cases that were merged — produces one effect.
 *
 * `proofHash` binds the event to the decision it reports, so an effect can be
 * explained and, if the decision is later corrected, reversed against the exact
 * revision that caused it.
 */
export const ModerationDecisionFinalizedEventSchema = z.strictObject({
  eventId: IdentifierSchema,
  type: z.literal(MODERATION_DECISION_FINALIZED_EVENT_TYPE),
  caseId: IdentifierSchema,
  incidentId: IdentifierSchema,
  decisionId: IdentifierSchema,
  decisionRevision: z.number().int().positive(),
  applicationId: IdentifierSchema,
  subject: ReputationEventSubjectSchema,
  findings: z.array(ReputationEventFindingSchema).min(1).max(CONTRACT_LIMITS.FINDINGS_MAX),
  decisionStatus: ReputationEventDecisionStatusSchema,
  policyVersions: ReputationPolicyVersionsSchema,
  proofHash: Sha256DigestSchema,
});
export type ModerationDecisionFinalizedEvent = z.infer<
  typeof ModerationDecisionFinalizedEventSchema
>;

/**
 * Every reputation event CrowdSource emits.
 *
 * A union of one today. It exists so consumers switch on `type` from the start
 * and adding §11.5's remaining operations does not change how they are written.
 */
export const ReputationEventSchema = z.discriminatedUnion('type', [
  ModerationDecisionFinalizedEventSchema,
]);
export type ReputationEvent = z.infer<typeof ReputationEventSchema>;
