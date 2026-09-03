import type { TransactionSession } from '../../db/collections';
import type {
  ContextSufficiency,
  Decision,
  DecisionFinding,
  DecisionOutcome,
  DecisionPolicyVersions,
  DecisionRecommendedAction,
} from '@oxyhq/crowdsource-contracts';

import { duplicateKeyViolation, withTransaction } from '../../db/transaction';
import type { TenantContext } from '../../db/tenantScope';
import { newPublicId } from '../../utils/identifiers';
import { cases } from '../cases/case.collection';
import { appendOutboxEvent, OUTBOX_EVENT_TYPES } from '../outbox/outbox.collection';
import { decisions, type DecisionDocument, type DecisionJurySummary } from './decision.collection';

/**
 * Publishing a decision, exactly once (§9.9, §12.11).
 *
 * ## The compare-and-swap is the whole file
 *
 * §12.11: "publicar una decisión con compare and swap sobre case revision para
 * impedir dobles resoluciones… el consensus worker puede ejecutarse varias veces
 * sin duplicar decisiones." The outbox is at-least-once by construction, a lease
 * can expire while a handler is still running, and two application instances run
 * the same dispatcher — so two workers evaluating the same case at the same
 * instant is the NORMAL case, not a pathological one.
 *
 * The swap is the first statement inside the transaction:
 *
 *     { caseId, currentRevision: R, decidedRevision: { $lt: R } }
 *       →  { decidedRevision: R, status: 'decided' }
 *
 * and a `modifiedCount` of zero means somebody else got there first, at which
 * point this returns without writing anything. Two concurrent transactions
 * cannot both see the pre-state: PostgreSQL serializes the guarded case update
 * document, the loser's transaction is retried by the driver, and on the retry
 * its filter no longer matches. That is why the swap must come BEFORE the
 * insert — a decision written first and swapped afterwards would leave the loser
 * having to delete a row it already wrote, inside a transaction it is about to
 * lose.
 *
 * `decidedRevision` is a dedicated monotonic number rather than a status check,
 * and the difference matters. `status` has three other writers — sortition sets
 * `awaiting_review`, opening an assignment sets `under_review`, triage sets
 * `triaged` — so a swap conditioned on it would be racing those writers as well,
 * and a compare-and-swap whose comparison is ambiguous is not a compare-and-swap.
 *
 * The unique index on `caseId + revision` is the second lock, and it is not
 * redundant: it is what makes a future caller that publishes WITHOUT the swap
 * fail loudly rather than deliver two contradictory `case.decided` webhooks for
 * one case.
 *
 * ## Immutability
 *
 * This module exports one write against an existing decision — `markSuperseded`
 * — and it sets `status` and nothing else. There is no update path for
 * `outcome`, `findings`, `confidence`, `jury` or `policyVersions`, because §9.9
 * says those are never overwritten and the most reliable way to honour that is
 * for the function that would do it not to exist. `decisionImmutability.test.ts`
 * scans the source tree to assert that no module outside this file writes to the
 * collection at all.
 */

export interface PublishDecisionInput {
  readonly context: TenantContext;
  readonly caseId: string;
  /** The revision being decided. The other half of the compare-and-swap. */
  readonly revision: number;
  readonly outcome: DecisionOutcome;
  readonly contextSufficiency: ContextSufficiency;
  readonly confidence: number;
  readonly findings: readonly DecisionFinding[];
  readonly recommendedActions: readonly DecisionRecommendedAction[];
  readonly jury: DecisionJurySummary;
  readonly policyVersions: DecisionPolicyVersions;
  readonly agreeingReviewerIds: readonly string[];
  /**
   * The decision this one replaces. Null on revision 1 and never null after it.
   *
   * The predecessor's OUTCOME travels with its id because §9.8 makes the two
   * cases different events: a second jury that reaches the same conclusion has
   * confirmed the decision, and a second jury that reaches a different one has
   * corrected it. Only the second is `decision.corrected`, which §9.8 attaches
   * reverting the conduct effect and asking for restoration to.
   *
   * `appealId` is the appeal this revision answers, supplied by the caller rather
   * than looked up here: the appeals module owns that record, and a decision
   * module that read it would be reaching across a boundary to learn something it
   * only needs in order to name it in an event. Null when no appeal opened the
   * revision, in which case there is nobody waiting for `appeal.decided`.
   */
  readonly supersedes: {
    readonly decisionId: string;
    readonly outcome: DecisionOutcome;
    readonly appealId: string | null;
  } | null;
  readonly now: Date;
}

export type PublishOutcome =
  | { readonly published: true; readonly decisionId: string }
  /** Somebody else published this revision. Not an error — the point of the swap. */
  | { readonly published: false; readonly reason: 'already_decided' };

export async function publishDecision(input: PublishDecisionInput): Promise<PublishOutcome> {
  const decisionId = newPublicId('decision');

  try {
    return await withTransaction<PublishOutcome>(async (session) => {
      const swapped = await cases.updateOne(
        input.context,
        {
          caseId: input.caseId,
          currentRevision: input.revision,
          /**
           * `$not: { $gte }` rather than `$lt`, because the two differ on a
           * document where the field is ABSENT: `$lt` skips it, `$not` matches
           * it. A case created before this field existed would otherwise be
           * permanently undecidable — silently, with the worker reporting
           * "already decided" forever and no decision ever appearing. Keeping
           * the tolerant predicate also makes a backfilled legacy row safe.
           */
          decidedRevision: { $not: { $gte: input.revision } },
        },
        { set: { decidedRevision: input.revision, status: 'decided', updatedAt: input.now } },
        session,
      );

      if (swapped === 0) {
        return { published: false, reason: 'already_decided' };
      }

      await decisions.insertOne(
        input.context,
        {
          decisionId,
          caseId: input.caseId,
          revision: input.revision,
          /**
           * §3.2's `final`. A decision is final the moment it is published and
           * stays that way until a later revision supersedes it — `provisional`
           * describes the ENFORCEMENT an application may keep while an appeal is
           * pending (§9.8), not the state of the record, and `corrected` belongs
           * to the revision that replaced one, not to this one.
           */
          status: 'final',
          outcome: input.outcome,
          contextSufficiency: input.contextSufficiency,
          confidence: input.confidence,
          findings: [...input.findings],
          recommendedActions: [...input.recommendedActions],
          jury: input.jury,
          policyVersions: input.policyVersions,
          supersedesDecisionId: input.supersedes?.decisionId ?? null,
          agreeingReviewerIds: [...input.agreeingReviewerIds],
          publishedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        },
        session,
      );

      /**
       * §10.6's `case.decided`, through the outbox and in this transaction.
       *
       * Never enqueued directly: the queue is a single-node Valkey with no
       * replica, and a decision whose delivery existed only as a job would be a
       * decision the application never learns about with nothing recording that
       * it should have. Committing the row with the decision makes a lost job a
       * delay.
       */
      await appendOutboxEvent(input.context, session, {
        type: OUTBOX_EVENT_TYPES.caseDecided,
        payload: { caseId: input.caseId, decisionId },
      });

      /**
       * §9.8's correction, IN ADDITION to `case.decided` and never instead of it.
       *
       * A correction is still a decision, and an application subscribed only to
       * `case.decided` must not miss the revision that overturned the one it
       * already acted on. Emitting both is also what lets §9.8's separate
       * consequences — reverting the conduct effect, requesting restoration —
       * hang off a subscription an application can choose independently.
       *
       * Only when the outcome actually changed. A second jury that reached the
       * same conclusion has confirmed the decision, not corrected it, and
       * telling an application to restore something nobody overturned would be
       * an enforcement instruction generated by a rejected appeal.
       */
      if (input.supersedes !== null && input.supersedes.outcome !== input.outcome) {
        await appendOutboxEvent(input.context, session, {
          type: OUTBOX_EVENT_TYPES.decisionCorrected,
          payload: { caseId: input.caseId, decisionId },
        });
      }

      /**
       * §10.6's `appeal.decided`, when this revision is the answer to an appeal.
       *
       * Emitted whether or not the outcome changed, which is what separates it
       * from `decision.corrected`: an appeal that UPHELD the original decision has
       * still produced the result §9.8 owes the appellant, and an application that
       * subscribed to corrections alone would leave them waiting forever for an
       * answer that already exists.
       */
      if (input.supersedes !== null && input.supersedes.appealId !== null) {
        await appendOutboxEvent(input.context, session, {
          type: OUTBOX_EVENT_TYPES.appealDecided,
          payload: {
            caseId: input.caseId,
            decisionId,
            appealId: input.supersedes.appealId,
          },
        });
      }

      return { published: true, decisionId };
    });
  } catch (error: unknown) {
    /**
     * The second lock firing. Reachable only if a caller published without the
     * swap — which is exactly the case worth surviving rather than crashing, so
     * it is reported as the same "somebody else got there first" the swap
     * reports and the outbox row is marked done rather than retried forever.
     */
    if (duplicateKeyViolation(error)) {
      return { published: false, reason: 'already_decided' };
    }
    throw error;
  }
}

/**
 * §9.9's supersession: the previous revision stops being current.
 *
 * The ONLY write in this service against an already-published decision, and it
 * touches `status` alone. §9.9 requires exactly this — its worked example has
 * revision 1 at `status = superseded` — while forbidding any change to what was
 * decided, so the filter names the decision by revision and the update names one
 * field. Idempotent: a replay finds the status already moved and modifies
 * nothing.
 */
export async function markSuperseded(
  context: TenantContext,
  caseId: string,
  revision: number,
  now: Date,
  session?: TransactionSession,
): Promise<number> {
  return decisions.updateOne(
    context,
    { caseId, revision, status: 'final' },
    { set: { status: 'superseded', updatedAt: now } },
    session,
  );
}

/** The decision currently in force for a case, or null before one is published. */
export async function currentDecision(
  context: TenantContext,
  caseId: string,
): Promise<DecisionDocument | null> {
  const [latest] = await decisions.find(context, { caseId }, { sort: { revision: -1 }, limit: 1 });
  return latest ?? null;
}

/** Every revision of a case's outcome, oldest first (§9.9's "historial completo"). */
export async function decisionHistory(
  context: TenantContext,
  caseId: string,
): Promise<readonly DecisionDocument[]> {
  return decisions.find(context, { caseId }, { sort: { revision: 1 } });
}

/**
 * The stored decision as §10.7 and Appendix B write it.
 *
 * `agreeingReviewerIds` is dropped here and that is the reason this function
 * exists rather than the document being serialised directly: it is on the row
 * for the appeal path (§9.8's "ningún miembro del jurado original"), and an
 * application that learned which reviewers decided against its user would have
 * everything it needs to retaliate. §9.1 withholds juror identities from the
 * jury itself.
 */
export function decisionView(stored: DecisionDocument): Decision {
  return {
    id: stored.decisionId,
    caseId: stored.caseId,
    revision: stored.revision,
    status: stored.status,
    outcome: stored.outcome,
    contextSufficiency: stored.contextSufficiency,
    confidence: stored.confidence,
    findings: stored.findings,
    recommendedActions: stored.recommendedActions,
    jury: { ...stored.jury },
    policyVersions: { ...stored.policyVersions },
    ...(stored.supersedesDecisionId === null
      ? {}
      : { supersedesDecisionId: stored.supersedesDecisionId }),
    publishedAt: stored.publishedAt.toISOString(),
  };
}
