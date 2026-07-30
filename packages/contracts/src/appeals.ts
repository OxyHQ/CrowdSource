/**
 * Appeals (§9.8, §9.9, §10.2).
 *
 * §9.8 opens with the rule the rest of this module serves: "la apelación no
 * edita la decisión original. Crea una nueva revisión del caso con un jurado
 * distinto y una nueva Decision revision." So an appeal is not a mutation and it
 * is not a request to reconsider — it is an OBJECT: a requester, a reason, the
 * author's structured additional context, and the pair of revisions it sits
 * between. Everything about the outcome belongs to the decision it opens.
 *
 * Two strictness directions meet here, and they are the same two the package
 * uses everywhere else:
 *
 *   * **`AppealSubmissionSchema` is strict.** It arrives from a tenant, over the
 *     application API, carrying text the SUBJECT of a moderation case wrote —
 *     which is to say attacker-controlled text, filed by somebody with a motive.
 *     A field this schema tolerated is a field nobody validated.
 *   * **`AppealSchema` is loose.** It travels outbound, in the response and in
 *     §10.6's `appeal.created` and `appeal.decided`, so §10.11's "unknown fields
 *     must not break clients" applies.
 *
 * What is deliberately NOT here: the appeal's outcome, the new jury, the votes,
 * anything about the panel. An appeal that carried its own verdict would be a
 * second place the outcome of a case is written down, and §9.9 is explicit that
 * there is exactly one — the decision revision.
 */

import { z } from 'zod';

import type { Closed } from './closed';
import { DecisionSchema } from './decisions';
import {
  CONTRACT_LIMITS,
  ExternalIdSchema,
  IdentifierSchema,
  MetadataBagSchema,
  TimestampSchema,
} from './primitives';
import { ResourceIdSchema } from './resources';

/**
 * Why an appeal was filed.
 *
 * §9.8 requires a reason but never enumerates one, and a closed list is the only
 * shape that works: the reason is carried into the appeal record, read by an
 * operator, and counted in §15.9's overturn-rate metrics, so a free-text field
 * would be both a channel for case content and a dimension nobody can aggregate.
 *
 * The six are derived from what the plan already says an appeal can be about.
 * `context_missing` is §9.8's own "el autor puede aportar una explicación" and
 * the remedy §9.6's `insufficient_context` asks for. `policy_misapplied` and
 * `finding_incorrect` split §6.2's two layers — the rule that was applied
 * against the classification of the material — because they want different
 * remedies and conflating them would lose that. `exception_applies` is §6.2's
 * `context` qualifier (artistic, documentary, satire) asserted by the person who
 * made the material. `not_responsible` is §11.7.4's attribution being wrong,
 * which matters most: an effect landing on the wrong principal is the one error
 * a reversal cannot fully undo. `procedural_error` covers the process itself.
 */
export const APPEAL_REASONS = [
  'context_missing',
  'policy_misapplied',
  'finding_incorrect',
  'exception_applies',
  'not_responsible',
  'procedural_error',
] as const;
export const AppealReasonSchema = z.enum(APPEAL_REASONS);
export type AppealReason = z.infer<typeof AppealReasonSchema>;

/**
 * The lifecycle of an appeal, which has exactly two states and no third.
 *
 * `open` from the moment it creates a revision until that revision publishes a
 * decision, `decided` afterwards. There is no `rejected` state: an appeal that
 * is not eligible is REFUSED at the boundary and never becomes an object at all
 * (§10.5's 403 and 409), because an appeal row that exists without having opened
 * a revision would be a case in `appealed` status with no jury owed to it — the
 * one failure mode §9.8 cannot tolerate, since the author has been told their
 * case is being looked at again.
 *
 * There is also no `upheld`/`overturned` pair, and that is the same rule as
 * above: whether the outcome changed is a property of the two decisions, and
 * `decision.corrected` (§10.6) is what says so.
 */
export const APPEAL_STATUSES = ['open', 'decided'] as const;
export const AppealStatusSchema = z.enum(APPEAL_STATUSES);
export type AppealStatus = z.infer<typeof AppealStatusSchema>;

/**
 * §9.8's "contexto adicional": what the author may add, "sujeta a validación y
 * redacción".
 *
 * Three shapes, and each is bounded for a different reason. `statement` is the
 * explanation in the author's own words and is the field the redaction in the
 * backend's `appealContext.ts` exists for. `resourceIds` point at material
 * ALREADY in the case snapshot — an appeal cannot introduce new evidence through
 * this field, because evidence enters through §10.2's upload endpoints where it
 * is hashed and scanned, and a URL or a blob here would be an unvalidated
 * resource reaching a reviewer's screen. `fields` is §9.8's "evidencia
 * estructurada" in the one shape the contract already trusts: a flat bag of
 * scalars, key-restricted and prototype-safe.
 */
export const AppealAuthorContextSchema = z.strictObject({
  /**
   * Free text from the author. Case content everywhere downstream: never logged,
   * never attested, redacted before a reviewer sees it (§9.8, §13.4, §13.5).
   */
  statement: z.string().min(1).max(CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH),
  /** Resources of the case this context is about. Validated against the case. */
  resourceIds: z
    .array(ResourceIdSchema)
    .max(CONTRACT_LIMITS.RESOURCE_REFS_PER_FINDING_MAX)
    .optional(),
  /** §9.8's structured evidence: flat, scalar, bounded — never a document tree. */
  fields: MetadataBagSchema.optional(),
});
export type AppealAuthorContext = z.infer<typeof AppealAuthorContextSchema>;

/**
 * The body of `POST /v1/cases/{id}/appeals` (§10.2).
 *
 * Strict, and with no `caseId`, no `decisionId` and no `applicationId` — the
 * case comes from the route, the revision under appeal is whichever one the case
 * has decided, and the application comes from the credential. A schema that
 * tolerated any of the three would let a caller appeal a decision of a case it
 * was not handed, which is the same class of hole as a review submission that
 * accepted a case id.
 *
 * `appellantExternalPrincipalId` is the application's own id for the person
 * appealing, and the server checks it against the principals the CASE MATERIAL
 * points at. That is what makes §9.8's "el autor" enforceable rather than
 * declarative: a reporter is referenced by an allegation and never by the
 * material, so a reporter's id is not in that set and cannot appeal a decision
 * that went against somebody else.
 */
export const AppealSubmissionSchema = z.strictObject({
  appellantExternalPrincipalId: ExternalIdSchema,
  reason: AppealReasonSchema,
  authorContext: AppealAuthorContextSchema.optional(),
});
export type AppealSubmission = z.infer<typeof AppealSubmissionSchema>;

/**
 * One appeal, as it travels back to the application (§10.2, §10.6).
 *
 * `supersededRevision` and `openedRevision` are both here because an appeal is
 * exactly the link between them, and reading it is how an integrator follows
 * §9.9's history: the decision it appealed is the one at `supersededRevision`,
 * and the decision that answers it is the one at `openedRevision`.
 *
 * `requiredAgreeingVotes` is the bar the new panel must clear — §9.4's "umbral
 * superior al de la primera decisión cuando la acción sea grave" — recorded on
 * the appeal so it is auditable and fixed at filing time rather than recomputed
 * later from a ladder that may have changed.
 *
 * The author's context is deliberately absent. The application supplied it, so
 * echoing it back tells the tenant nothing it does not have, and §13.5's
 * minimisation applies to every copy of case content — including the ones in a
 * webhook body that will be retried, stored and logged by a receiver.
 */
export const AppealSchema = z
  .looseObject({
    id: IdentifierSchema,
    caseId: IdentifierSchema,
    status: AppealStatusSchema,
    reason: AppealReasonSchema,
    /** The revision whose decision was appealed, and which is now superseded. */
    supersededRevision: z.number().int().positive(),
    supersededDecisionId: IdentifierSchema,
    /** The revision this appeal opened. Always `supersededRevision + 1` (§9.9). */
    openedRevision: z.number().int().positive(),
    requiredAgreeingVotes: z.number().int().positive().max(CONTRACT_LIMITS.JURY_SIZE_MAX),
    filedAt: TimestampSchema,
    /** The decision that answered the appeal, once one exists. */
    decision: DecisionSchema.optional(),
  })
  .superRefine((appeal, ctx) => {
    /**
     * §9.9's chain, checked rather than described: an appeal opens the revision
     * immediately after the one it superseded. A gap would mean a revision
     * nobody appealed and nobody decided.
     */
    if (appeal.openedRevision !== appeal.supersededRevision + 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['openedRevision'],
        message: 'an appeal opens the revision immediately after the one it superseded',
      });
    }
    /**
     * The status is DERIVED from whether the revision it opened has published a
     * decision, so the two cannot disagree — and asserting it here is what
     * catches a serializer that started storing the status separately.
     */
    if (appeal.status === 'decided' && appeal.decision === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision'],
        message: 'a decided appeal must carry the decision that answered it',
      });
    }
    if (appeal.status === 'open' && appeal.decision !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'an appeal that carries a decision is decided, not open',
      });
    }
    if (appeal.decision !== undefined && appeal.decision.revision !== appeal.openedRevision) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision', 'revision'],
        message: 'the decision answering an appeal is the one at the revision it opened',
      });
    }
  });
/**
 * `Closed`, like every other outbound type in this package.
 *
 * The schema stays loose — §10.11 requires unknown fields to pass through — and
 * the exported type drops the index signature that looseness contributes. This
 * DTO is the one in the package most likely to be misnamed by an integrator:
 * `appeal.appealId` reads naturally and the field is `id`, and the webhook
 * payload carries `data.appealId` beside `data.appeal.id`, so the two spellings
 * sit next to each other in the same body. With an index signature both compile
 * and one is `undefined` at runtime; closed, only the real one does.
 */
export type Appeal = Closed<z.infer<typeof AppealSchema>>;
