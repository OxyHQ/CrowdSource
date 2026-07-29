import {
  REPUTATION_ELIGIBLE_FINDING_SCOPES,
  type Appeal,
  type AppealSubmission,
  type DecisionOutcome,
  type RecommendedAction,
} from '@oxyhq/crowdsource-contracts';

import { duplicateKeyViolation, withTransaction } from '../../db/transaction';
import type { TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { canonicalHash } from '../../utils/canonicalJson';
import { newPublicId } from '../../utils/identifiers';
import { logger } from '../../utils/logger';
import { cases, type CaseDocument } from '../cases/case.collection';
import { riskOf, requiredAgreeingVotes, type ConsensusRisk } from '../consensus/consensus';
import { decisions, type DecisionDocument } from '../decision/decision.collection';
import { decisionView } from '../decision/decision.service';
import { openCaseRevision } from '../decision/revision.service';
import { appendOutboxEvent, OUTBOX_EVENT_TYPES } from '../outbox/outbox.collection';
import { APPEAL_MIN_ROUND, panelRoundFor, panelSpecFor } from '../sortition/panelSpec';
import { appeals, type AppealDocument } from './appeal.collection';
import { redactAuthorContext } from './appealContext';

/**
 * Filing an appeal (§9.8, §9.9, §10.2).
 *
 * The mechanism an appeal drives — a new revision that supersedes the old one,
 * a jury that shares nobody with the first, a `decision.corrected` when the
 * outcome changes — already existed. This file is the APPEAL: who may file one,
 * against what, with what, and what standard the new panel is held to.
 *
 * ## An appeal never edits anything
 *
 * `fileAppeal` writes ONE new row and moves the case to its next revision through
 * `openCaseRevision`, whose only write against a published decision sets its
 * status to `superseded`. There is no path from here to a decision's outcome,
 * findings, confidence, jury or policy versions, and `decisionImmutability.test.ts`
 * fails the build if this module ever acquires one.
 *
 * ## The appeal and the revision are one act
 *
 * Both, plus §10.6's `appeal.created` and the `case.ready_for_review` that asks
 * for the new jury, commit in a single transaction. Splitting them produces the
 * two failures §9.8 cannot tolerate: an appeal that never empanels — the author
 * has been told their case is being reviewed again and no jury was ever drawn —
 * or a case sitting in `appealed` status that nothing explains.
 *
 * ## Idempotency is two unique indexes, not this code
 *
 * `applicationId + idempotencyKey` recognises a retry of the same filing;
 * `applicationId + caseId + supersededRevision` refuses a SECOND appeal of one
 * revision. The insert is attempted and the collision interpreted afterwards,
 * because "look, then insert" races against the retry an application is required
 * to make (§7.1) and against a user tapping twice.
 */

/**
 * The outcomes §9.8's "toda decisión con consecuencias relevantes" covers.
 *
 * Not every outcome is appealable, and which ones are follows from §7.6's table
 * of what an application may DO with each:
 *
 *  - `violation` — removal, restriction, suspension. The case §9.8 is written for.
 *  - `inconclusive` — §7.6 allows `keep_restricted_temporarily`, so a restriction
 *    can outlive a jury that agreed on nothing. That is a consequence, and §9.6 is
 *    explicit that it is not innocence, so the author is owed a way to challenge it.
 *  - `insufficient_context` — §7.6's `hold` and `request_more_context`. Appealing
 *    it is the one case where the remedy is EXACTLY what §9.8 offers: the author
 *    supplying the context nobody had.
 *
 * The four that are absent, each for its own reason. `no_violation` decided in the
 * author's favour and there is nothing to appeal. `duplicate` merged the case into
 * another expedient — the decision to argue with is that one's. `content_unavailable`
 * means the evidence never arrived, which a new jury cannot fix and a fresh report
 * can. `escalated` is a process that has not finished: §9.6 sends it to specialists
 * or Trust & Safety, and appealing a referral would ask a community panel to
 * pre-empt the specialist path §7.5 routed it to.
 */
export const APPEALABLE_OUTCOMES: readonly DecisionOutcome[] = Object.freeze([
  'violation',
  'inconclusive',
  'insufficient_context',
]);

/**
 * §9.4's "cuando la acción sea grave", as a set.
 *
 * Severe means the recommendation takes the material away, cuts its reach, or
 * acts on the person. `label`, `allow_with_label` and `age_gate` are absent: they
 * annotate or narrow an audience without removing anything, and treating every
 * recommendation as severe would make §9.4's condition vacuous — every appeal
 * would carry the raised threshold and the sentence "when the action is severe"
 * would describe nothing.
 */
const SEVERE_ACTIONS: ReadonlySet<RecommendedAction> = new Set<RecommendedAction>([
  'remove',
  'remove_or_restrict',
  'hide',
  'reduce_distribution',
  'freeze_transaction',
  'suspend_user',
  'keep_restricted_temporarily',
]);

/**
 * Whether the decision under appeal carried a severe consequence.
 *
 * Three disjuncts, and the second two are not padding. §9.4 says "la acción", and
 * the recommended actions are the first and most literal reading. But a decision's
 * consequences are not only what the application was asked to do: a finding at
 * `high` or `critical` severity is a serious statement about a person on its own,
 * and a finding whose SCOPE may reach Oxy Trust (§11.7.5's `oxy_network` and
 * `identity_integrity`) can move a reputation figure that follows them across
 * every Oxy application. A decision that merely asked for a label while making a
 * finding of that reach has still done something severe, and §9.8's whole argument
 * for a higher appeal bar — a correction has to reverse the conduct effect and ask
 * for restoration — is about exactly those consequences.
 */
export function severeConsequence(
  /**
   * Narrower than the document on purpose: these two fields are everything the
   * judgement depends on, and saying so in the signature is what lets it be
   * exercised without a whole decision — and what makes a future reader see
   * immediately that nothing here reads the jury, the confidence or the outcome.
   */
  decision: Pick<DecisionDocument, 'recommendedActions' | 'findings'>,
): boolean {
  if (decision.recommendedActions.some((action) => SEVERE_ACTIONS.has(action.action))) return true;
  if (decision.findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical')) {
    return true;
  }
  return decision.findings.some((finding) =>
    REPUTATION_ELIGIBLE_FINDING_SCOPES.some((scope) => scope === finding.scope),
  );
}

/**
 * The votes an appeal panel must agree on (§9.4's appeal row).
 *
 * Three floors, and the answer is the highest of them:
 *
 *  1. §8.6's ladder for the round the appeal panel sits on — 4 of 5, 5 of 7.
 *  2. §9.4's risk minimum for the case's sensitivity, unchanged by the appeal.
 *  3. "Umbral superior al de la primera decisión cuando la acción sea grave":
 *     one more vote than the superseded decision needed, when it was severe.
 *
 * The third is capped at unanimity of the appeal panel. Without the cap a chain
 * of appeals would eventually ask for more votes than there are seats — a
 * threshold no panel can reach, which is how a case ends `inconclusive` forever
 * while the code reports it is applying a rule. Unanimity of five is already a
 * strictly higher standard than five of seven, so the cap does not soften §9.4;
 * it stops the rule from consuming itself.
 */
export function appealRequiredVotes(input: {
  readonly round: number;
  readonly panelSeats: number;
  readonly risk: ConsensusRisk;
  readonly previousRequiredVotes: number;
  readonly severeAction: boolean;
}): number {
  const base = requiredAgreeingVotes(input.round, input.risk);
  if (!input.severeAction) return base;
  return Math.max(base, Math.min(input.previousRequiredVotes + 1, input.panelSeats));
}

export interface AppealFiling {
  readonly submission: AppealSubmission;
  readonly idempotencyKey: string;
  readonly credentialId: string;
}

export interface FiledAppeal {
  readonly appeal: AppealDocument;
  /** True when this filing matched one already stored and created nothing. */
  readonly replayed: boolean;
}

/** Files an appeal against the decision a case currently has, or refuses. */
export async function fileAppeal(
  context: TenantContext,
  caseId: string,
  filing: AppealFiling,
  now: Date = new Date(),
): Promise<FiledAppeal> {
  const payloadHash = canonicalHash({ caseId, submission: filing.submission });

  /**
   * A retry is recognised BEFORE eligibility is judged, and the order is not an
   * optimisation.
   *
   * A successful filing moves the case to an undecided revision, so re-running
   * the eligibility checks on a legitimate retry would refuse it with "this case
   * has no decision to appeal" — turning the retry §7.1 requires an application to
   * make into a permanent failure, days later, as an appeal stuck in an outbox.
   */
  const replay = await appeals.findOne(context, { idempotencyKey: filing.idempotencyKey });
  if (replay) return recogniseReplay(replay, payloadHash, filing.idempotencyKey);

  const stored = await cases.findOne(context, { caseId });
  if (!stored) {
    // Indistinguishable from another tenant's case, deliberately: the filter is
    // what decides, and the shape check only saves a query.
    throw new ApiError('not_found', 'No such case.');
  }

  const decision = await appealableDecision(context, stored);
  assertAppellantIsAPrincipal(stored, filing.submission);
  assertContextResourcesBelongToTheCase(stored, filing.submission);

  const standard = appealStandardFor(stored, decision);
  const appealId = newPublicId('appeal');

  try {
    return await withTransaction<FiledAppeal>(async (session) => {
      /**
       * The appeal row first, so its unique indexes decide who is allowed to
       * proceed before the case is touched. The revision swap below is the second
       * lock and refuses a case that moved between the read and this write; with
       * the order reversed a losing filing would have to undo a revision it had
       * already opened.
       *
       * The INSERTED document is what this returns, rather than a read-back: a
       * read inside the transaction would not see its own uncommitted write, and
       * one after it would be a second round trip to learn what the caller
       * already composed.
       */
      const written = await appeals.insertOne(
        context,
        {
          appealId,
          caseId,
          supersededRevision: stored.currentRevision,
          supersededDecisionId: decision.decisionId,
          openedRevision: stored.currentRevision + 1,
          reason: filing.submission.reason,
          appellantExternalPrincipalId: filing.submission.appellantExternalPrincipalId,
          authorContext:
            filing.submission.authorContext === undefined
              ? null
              : contextDocumentOf(filing.submission.authorContext),
          previousRequiredVotes: standard.previousRequiredVotes,
          severeAction: standard.severeAction,
          requiredAgreeingVotes: standard.requiredAgreeingVotes,
          payloadHash,
          idempotencyKey: filing.idempotencyKey,
          filedAt: now,
          filedByCredentialId: filing.credentialId,
          createdAt: now,
          updatedAt: now,
        },
        session,
      );

      const opened = await openCaseRevision(context, caseId, now, session);
      if (!opened.opened) {
        /**
         * The case is no longer at the revision this appeal was judged against —
         * another appeal won the race, or a decision landed in between. Throwing
         * rolls the appeal row back with it, which is the only acceptable outcome:
         * an appeal that exists without having opened a revision is an author told
         * their case is being re-reviewed when no jury was ever asked for.
         */
        throw new ApiError(
          'conflict',
          'This case is not at the revision this appeal was filed against. Read the case again and re-file.',
        );
      }

      await appendOutboxEvent(context, session, {
        type: OUTBOX_EVENT_TYPES.appealCreated,
        payload: { caseId, appealId },
      });

      logger.info(
        {
          caseId,
          appealId,
          supersededRevision: stored.currentRevision,
          openedRevision: opened.revision,
          reason: filing.submission.reason,
          severeAction: standard.severeAction,
          requiredAgreeingVotes: standard.requiredAgreeingVotes,
        },
        'An appeal was filed and opened a new case revision',
      );

      return { appeal: written, replayed: false };
    });
  } catch (error: unknown) {
    const violation = duplicateKeyViolation(error);
    if (!violation) throw error;

    const fields = new Set(violation.indexFields);
    if (fields.has('idempotencyKey')) {
      const existing = await appeals.findOne(context, { idempotencyKey: filing.idempotencyKey });
      if (existing) return recogniseReplay(existing, payloadHash, filing.idempotencyKey);
      // Stored under another tenant, or removed between the failed insert and
      // this read. Neither filed nor refused, so the caller must retry (§10.5).
      throw new ApiError('service_unavailable', 'The appeal could not be stored. Retry it.');
    }

    if (fields.has('supersededRevision')) {
      throw new ApiError(
        'conflict',
        'This revision of the case has already been appealed. Appeal the decision the appeal produces.',
      );
    }

    throw error;
  }
}

/** The decision an appeal may be filed against, or the reason it may not. */
async function appealableDecision(
  context: TenantContext,
  stored: CaseDocument,
): Promise<DecisionDocument> {
  /**
   * The case has to be decided AT its current revision. §9.8's appeal is against
   * a published decision, and a case whose latest revision is still being
   * reviewed has a jury working on it — a second revision opened underneath them
   * would draw a panel whose ballots count toward a revision already in progress.
   */
  if (stored.decidedRevision !== stored.currentRevision) {
    throw new ApiError(
      'conflict',
      stored.decidedRevision === 0
        ? 'This case has no published decision to appeal yet.'
        : 'A revision of this case is already under review; its decision is not published yet.',
    );
  }

  const decision = await decisions.findOne(context, {
    caseId: stored.caseId,
    revision: stored.currentRevision,
  });
  if (!decision) {
    /**
     * The case says a revision was decided and no decision row exists. Not a
     * caller error and not something a retry makes worse — the two are written in
     * one transaction, so this means a read that raced a rollback.
     */
    throw new ApiError(
      'service_unavailable',
      'The decision for this case could not be read. Retry the appeal.',
    );
  }

  if (!APPEALABLE_OUTCOMES.includes(decision.outcome)) {
    throw new ApiError(
      'conflict',
      `A decision with the outcome '${decision.outcome}' carries no consequence to appeal.`,
      { outcome: decision.outcome },
    );
  }

  return decision;
}

/**
 * §9.8's "el autor", enforced rather than declared.
 *
 * The appellant has to be a principal the case MATERIAL points at — the author of
 * a resource, the seller on a listing, the target of an `authored_by` relation.
 * That set is `contentSnapshot.principals`, and what makes the check meaningful is
 * what is NOT in it: a reporter is referenced by an allegation and never by the
 * material (see `contentSnapshot.ts`), so a reporter cannot appeal a decision that
 * went against somebody else, and neither can an unrelated account the application
 * happens to know about.
 */
function assertAppellantIsAPrincipal(stored: CaseDocument, submission: AppealSubmission): void {
  const principals = new Set(
    stored.contentSnapshot.principals
      .map((principal) => principal.externalPrincipalId)
      .filter((id): id is string => id !== undefined),
  );

  if (!principals.has(submission.appellantExternalPrincipalId)) {
    throw new ApiError(
      'forbidden',
      'Only a principal the reported material identifies may appeal its decision.',
    );
  }
}

/** §9.8's structured context may only point at material already in the case. */
function assertContextResourcesBelongToTheCase(
  stored: CaseDocument,
  submission: AppealSubmission,
): void {
  const referenced = submission.authorContext?.resourceIds ?? [];
  if (referenced.length === 0) return;

  const known = new Set(stored.contentSnapshot.resources.map((resource) => resource.id));
  const unknown = referenced.filter((resourceId) => !known.has(resourceId));
  if (unknown.length > 0) {
    throw new ApiError(
      'invalid_request',
      'The additional context refers to resources that are not part of this case.',
      { unknownResourceCount: unknown.length },
    );
  }
}

function contextDocumentOf(context: NonNullable<AppealSubmission['authorContext']>) {
  const redacted = redactAuthorContext(context);
  return {
    statement: redacted.statement,
    resourceIds: [...(redacted.resourceIds ?? [])],
    fields: { ...(redacted.fields ?? {}) },
  };
}

/** The three numbers §9.4's appeal row turns into a threshold. */
export interface AppealStandardRecord {
  /** The votes the superseded decision had to carry. */
  readonly previousRequiredVotes: number;
  /** §9.4's "cuando la acción sea grave", judged on the decision under appeal. */
  readonly severeAction: boolean;
  /** The bar the appeal panel must clear. Never below the ordinary requirement. */
  readonly requiredAgreeingVotes: number;
}

/**
 * Resolves §9.4's appeal row for one filing, at the moment it is filed.
 *
 * All three numbers together, in one exported function, for two reasons. The bar
 * is stored on the appeal so it is auditable and fixed — a panel judged by a
 * threshold recomputed later would be judged by a rule nobody told the appellant
 * about — and the derivation is where the interesting failure modes are: a case
 * with no pool, a case with no sensitivity class, and an appeal OF an appeal,
 * whose predecessor sat on the appeal ladder rather than the first-instance one.
 *
 * The previous requirement is re-derived from the superseded decision's own jury
 * rather than read off it: the panel size says which rung of §8.6's ladder it
 * decided on, and the case's sensitivity says which of §9.4's risk rows applied.
 * Both are recorded, so the number this produces is the one that was in force.
 */
export function appealStandardFor(
  stored: Pick<CaseDocument, 'caseId' | 'reviewPool' | 'sensitivityClass' | 'currentRevision'>,
  decision: Pick<DecisionDocument, 'recommendedActions' | 'findings' | 'jury'>,
): AppealStandardRecord {
  const pool = stored.reviewPool;
  if (pool === null || pool === 'legal') {
    /**
     * Not reachable through the appeal route — a legal-pool case is never drawn a
     * jury (§7.5 row 1) and an untriaged one has no decision to appeal — and it
     * throws rather than defaulting, because every default here would be a
     * threshold invented for material the plan routed away from juries.
     */
    throw new Error(
      `Case '${stored.caseId}' has no community or specialist jury pool; an appeal standard cannot be derived.`,
    );
  }

  const sensitivity = stored.sensitivityClass;
  if (sensitivity === null) {
    throw new Error(
      `Case '${stored.caseId}' has a published decision but no sensitivity class; it cannot be appealed.`,
    );
  }

  const risk = riskOf(sensitivity);
  const severeAction = severeConsequence(decision);
  const previousRequiredVotes = requiredAgreeingVotes(
    panelRoundFor(pool, decision.jury.size, stored.currentRevision > 1),
    risk,
  );

  return {
    previousRequiredVotes,
    severeAction,
    requiredAgreeingVotes: appealRequiredVotes({
      /**
       * The round the APPEAL panel will open on, not the one the superseded panel
       * reached: §9.4's "mínimo 5" is what the new jury is, and the threshold has
       * to be the one that jury will be measured against.
       */
      round: APPEAL_MIN_ROUND,
      panelSeats: panelSpecFor(pool, APPEAL_MIN_ROUND, true).slots.length,
      risk,
      previousRequiredVotes,
      severeAction,
    }),
  };
}

/**
 * Recognises a filing already stored.
 *
 * Same content under the same key is the retry §7.1 requires and returns the
 * original appeal. DIFFERENT content under a key that was already used is a 409:
 * accepting it would either silently discard the new filing or file a second
 * appeal under a key an application believes identifies the first.
 */
function recogniseReplay(
  existing: AppealDocument,
  payloadHash: string,
  idempotencyKey: string,
): FiledAppeal {
  if (existing.payloadHash !== payloadHash) {
    throw new ApiError(
      'conflict',
      `Idempotency-Key '${idempotencyKey}' was already used for a different appeal.`,
    );
  }
  return { appeal: existing, replayed: true };
}

/**
 * The appeal in force for a case revision, or null.
 *
 * Read by consensus to learn which standard applies to the panel it is counting,
 * and by the decision path to name the appeal an outcome answers.
 */
export async function appealForRevision(
  context: TenantContext,
  caseId: string,
  revision: number,
): Promise<AppealDocument | null> {
  return appeals.findOne(context, { caseId, openedRevision: revision });
}

/**
 * The appeal as §10.2 and §10.6 write it.
 *
 * `status` is DERIVED from whether the revision the appeal opened has published a
 * decision. Nothing stores it, and that is the point: an appeal's outcome is the
 * decision at that revision, and a stored status would be a second copy of a fact
 * §9.9 keeps in exactly one place — one that would eventually disagree with it.
 *
 * The author's context is absent. The application supplied it, so echoing it back
 * adds nothing, and §13.5's minimisation applies to every copy of case content —
 * including the one a webhook receiver will store, retry and log.
 */
export function appealView(appeal: AppealDocument, decision: DecisionDocument | null): Appeal {
  return {
    id: appeal.appealId,
    caseId: appeal.caseId,
    status: decision === null ? 'open' : 'decided',
    reason: appeal.reason,
    supersededRevision: appeal.supersededRevision,
    supersededDecisionId: appeal.supersededDecisionId,
    openedRevision: appeal.openedRevision,
    requiredAgreeingVotes: appeal.requiredAgreeingVotes,
    filedAt: appeal.filedAt.toISOString(),
    ...(decision === null ? {} : { decision: decisionView(decision) }),
  };
}

/** The decision that answered an appeal, if the revision it opened has one. */
export async function appealDecision(
  context: TenantContext,
  appeal: AppealDocument,
): Promise<DecisionDocument | null> {
  return decisions.findOne(context, {
    caseId: appeal.caseId,
    revision: appeal.openedRevision,
  });
}
