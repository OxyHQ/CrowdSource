import {
  OXY_CONDUCT_POLICY_VERSION,
  taxonomyFamilyOf,
  type DecisionFinding,
  type DecisionOutcome,
  type DecisionPolicyVersions,
  type DecisionRecommendedAction,
  type RecommendedAction,
  type TaxonomyCode,
  type TaxonomyFamily,
} from '@oxyhq/crowdsource-contracts';

import type { TenantContext } from '../../db/tenantScope';
import { logger } from '../../utils/logger';
import type { AppealDocument } from '../appeals/appeal.collection';
import { appealForRevision } from '../appeals/appeal.service';
import { cases, type CaseDocument } from '../cases/case.collection';
import { decisions } from '../decision/decision.collection';
import { publishDecision, type PublishOutcome } from '../decision/decision.service';
import { policyVersionOfToken } from '../cases/caseDedupKey';
import { reviewerProfiles, type ReviewerProfileDocument } from '../reviewer/reviewer.collection';
import { categoryReliability } from '../reviewer/reliability';
import { reviews, type ReviewDocument } from '../review/review.collection';
import { OPEN_ASSIGNMENT_STATUSES } from '../../db/postgres/schema/sortition';
import { assignments, type AssignmentDocument } from '../sortition/assignment.collection';
import { MAX_PANEL_ROUND, panelRoundFor } from '../sortition/panelSpec';
import { openPanel } from '../sortition/sortition.service';
import {
  decisionOutcomeOf,
  evaluateConsensus,
  positionKey,
  positionOf,
  riskOf,
  type Ballot,
  type ConsensusVerdict,
} from './consensus';
import { confidenceScore } from './confidence';
import { findingAttributionOf, findingScopeOf } from './findingScope';

/**
 * The consensus worker's body (§9.4, §8.6, §12.11).
 *
 * One entry point, `evaluateCase`, called whenever a juror votes. It reads the
 * panel and the ballots, asks the pure engine what they add up to, and does one
 * of four things: nothing (the panel is still voting), publish, expand, or
 * publish a non-consensus outcome because the ladder is exhausted.
 *
 * ## It is safe to run twice, and safe to run twice AT THE SAME TIME
 *
 * Those are different guarantees and both are needed. Running twice in sequence
 * is handled by the state being derived rather than counted: the panel's seats
 * say which round it is at, the reviews say who voted, and re-reading both gives
 * the same answer. Running twice CONCURRENTLY is handled by
 * `publishDecision`'s compare-and-swap on the case revision, because two workers
 * can read identical state a microsecond apart and both conclude "publish" —
 * only one of them will be allowed to.
 *
 * Expansion has the same shape: the expansion is refused if the panel already
 * has the seats the next round asks for, so a replayed event cannot draw a
 * second wave of jurors.
 *
 * ## Why it waits for every seat
 *
 * A round-2 panel where four of five have voted the same way could be decided
 * without the fifth. It is not. A juror whose vote was discarded because the
 * result was already known has been told the result — and §9.1's list of what a
 * reviewer must never see begins with "votos anteriores o resultado parcial".
 * Waiting also keeps `decisiveVotes` honest: §9.5's denominator is the panel
 * that reviewed the case, not the subset that arrived first.
 */

/** What a full evaluation concluded, for the log and for the tests. */
export type CaseEvaluation =
  | { readonly status: 'waiting'; readonly pendingSeats: number }
  | {
      readonly status: 'published';
      readonly decisionId: string;
      readonly outcome: DecisionOutcome;
    }
  | { readonly status: 'already_decided' }
  | { readonly status: 'expanded'; readonly toRound: number }
  | { readonly status: 'expansion_refused'; readonly toRound: number }
  | { readonly status: 'no_panel' };

/** The seats that count toward a panel: nobody who left it. */
function servingSeats(panel: readonly AssignmentDocument[]): readonly AssignmentDocument[] {
  return panel.filter(
    (seat) =>
      OPEN_ASSIGNMENT_STATUSES.includes(seat.status) || seat.status === 'submitted',
  );
}

/**
 * Seats somebody left that nobody has replaced yet (§8.7).
 *
 * This is the difference between a panel of three where one juror recused and a
 * panel of two, and getting it wrong is not a small error. A recused seat
 * disappears from `servingSeats` immediately, so a panel of three that lost one
 * juror after the other two had voted would look COMPLETE at two ballots — and
 * two is below round 1's threshold of three, so consensus would conclude
 * "disagreement" and expand a panel that was never short of agreement. The
 * juror who stepped away would have changed the outcome by stepping away, which
 * is the one thing §8.7 says a recusal must not do.
 *
 * `replacementAssignmentId` is the honest signal: §8.7 promises a replacement,
 * the outbox guarantees the request survives, and until that field is filled the
 * panel is owed a juror. If the replacement draw REFUSES because the pool is too
 * small, the case waits — the same answer §8.8 gives for a first draw that
 * cannot be filled, and for the same reason: seating nobody is better than
 * deciding with a panel below its own threshold.
 */
function outstandingVacancies(
  panel: readonly AssignmentDocument[],
): readonly AssignmentDocument[] {
  return panel.filter(
    (seat) =>
      (seat.status === 'recused' || seat.status === 'expired') &&
      seat.replacementAssignmentId === null,
  );
}

/**
 * The families the case alleges, which is what a reviewer's reliability is
 * measured against.
 *
 * The allegations, not the findings. §9.5's `panelQuality` is about whether the
 * right people were asked, and that question was settled when the panel was
 * drawn — grading the panel on the families it eventually FOUND would make
 * confidence depend on the verdict, which is the loop §9.5 exists outside of.
 */
function allegedFamilies(stored: CaseDocument): readonly TaxonomyFamily[] {
  return [...new Set(stored.allegationCodes.map((code) => taxonomyFamilyOf(code as TaxonomyCode)))];
}

/** Turns stored reviews and profiles into the ballots the engine reads. */
function ballotsOf(
  submitted: readonly ReviewDocument[],
  profiles: ReadonlyMap<string, ReviewerProfileDocument>,
  families: readonly TaxonomyFamily[],
): readonly Ballot[] {
  return submitted.map((review) => {
    const profile = profiles.get(review.reviewerId);
    return {
      reviewerId: review.reviewerId,
      outcome: review.outcome,
      contextSufficiency: review.contextSufficiency,
      findings: review.findings,
      recommendedActions: review.recommendedActions,
      /**
       * A missing profile counts as the least capable state rather than
       * throwing. A juror whose profile vanished between voting and counting has
       * still voted, and their ballot is still one vote; what they cannot do is
       * satisfy §9.4's "at least one trusted reviewer" on somebody's behalf.
       */
      reviewerState: profile?.state ?? 'community',
      isSpecialist: (profile?.specialistCategories ?? []).some((family) =>
        families.includes(family),
      ),
    };
  });
}

/**
 * The findings a decision states, built from the position the panel agreed on.
 *
 * Only the findings of the AGREEING jurors, and only the ones whose code belongs
 * to the agreed family — a decision states what the panel agreed, not the union
 * of everything anybody wrote down. Deduplicated by code, because five jurors
 * agreeing on one finding is one finding.
 *
 * `scope` and `attribution` are added here and are absent from a review on
 * purpose: a reviewer classifies material, and it is consensus that decides the
 * classification is confirmed and therefore attributable (§6.1's third layer,
 * §11.7.5's gate).
 */
function decisionFindings(
  agreeing: readonly Ballot[],
  family: TaxonomyFamily | null,
  outcome: DecisionOutcome,
): readonly DecisionFinding[] {
  if (family === null) return [];

  const attribution = findingAttributionOf(outcome);
  const byCode = new Map<string, DecisionFinding>();

  for (const ballot of agreeing) {
    for (const finding of ballot.findings) {
      if (taxonomyFamilyOf(finding.code) !== family) continue;
      if (byCode.has(finding.code)) continue;

      byCode.set(finding.code, {
        code: finding.code,
        resourceIds: [...finding.resourceIds],
        severity: finding.severity,
        ...(finding.context === undefined ? {} : { context: finding.context }),
        scope: findingScopeOf(finding.code, finding.severity),
        ...(attribution === undefined ? {} : { attribution }),
        ...(finding.policyRuleIds === undefined
          ? {}
          : { policyRuleIds: [...finding.policyRuleIds] }),
      });
    }
  }

  return [...byCode.values()].sort((left, right) => (left.code < right.code ? -1 : 1));
}

/**
 * The actions the decision recommends, and the rule for which ones survive.
 *
 * An action is carried when MORE THAN HALF of the agreeing jurors recommended
 * it. A bare union would let one juror's opinion become the panel's
 * recommendation while the decision claims five of seven agreed; an
 * intersection would silently drop everything the moment one juror ticked an
 * extra box. A majority of the people who agreed on the finding is the same
 * standard the finding itself was held to.
 *
 * §9.3 and Appendix B differ in shape here — a review recommends bare action
 * tokens, a decision recommends objects that name their target — and the
 * difference is real: an application acting on "remove" without knowing what to
 * remove is guessing. The target is the agreed position's resources, and it is
 * omitted entirely for the case-level actions that have none.
 */
const CASE_LEVEL_ACTIONS: ReadonlySet<RecommendedAction> = new Set<RecommendedAction>([
  'escalate',
  'no_global_effect',
  'no_action',
  'allow',
  'hold',
  'request_more_context',
  'local_manual_review',
  'specialist_queue',
  'legal_queue',
  'safety_queue',
]);

function decisionActions(
  agreeing: readonly Ballot[],
  resourceIds: readonly string[],
): readonly DecisionRecommendedAction[] {
  const counts = new Map<RecommendedAction, number>();
  for (const ballot of agreeing) {
    for (const action of new Set(ballot.recommendedActions)) {
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }

  const majority = agreeing.length / 2;

  return [...counts.entries()]
    .filter(([, votes]) => votes > majority)
    .map(([action]) => action)
    .sort()
    .map((action) => ({
      action,
      ...(CASE_LEVEL_ACTIONS.has(action) || resourceIds.length === 0
        ? {}
        : { targetResourceIds: [...resourceIds] }),
    }));
}

/** §6.4's three versions, all of them, on every decision. */
function policyVersionsOf(stored: CaseDocument): DecisionPolicyVersions {
  return {
    taxonomy: stored.taxonomyVersion,
    application: policyVersionOfToken(stored.policyVersion, stored.policySetId),
    oxyConduct: OXY_CONDUCT_POLICY_VERSION,
  };
}

/**
 * Evaluates one case revision and acts on the verdict.
 *
 * Every read is scoped to the case's CURRENT revision. An appeal opens a new
 * one with a new panel (§9.9), and the previous revision's ballots must not
 * count toward it — which is also why the compare-and-swap compares the revision
 * rather than a boolean.
 */
export async function evaluateCase(
  context: TenantContext,
  caseId: string,
  now: Date = new Date(),
): Promise<CaseEvaluation> {
  const stored = await cases.findOne(context, { caseId });
  if (!stored) {
    throw new Error(`Consensus was asked for case '${caseId}', which this tenant does not own.`);
  }

  const reviewPool = stored.reviewPool;
  if (reviewPool === null || reviewPool === 'legal' || stored.sensitivityClass === null) {
    /**
     * No jury decides this case. A legal-pool case is §7.5 row 1 — sortition
     * refuses to draw for it — and an untriaged one has no panel yet. Either way
     * there is nothing to count, and counting nothing would be the one path that
     * could publish a decision for material the plan says a community jury never
     * sees.
     */
    return { status: 'no_panel' };
  }

  const revision = stored.currentRevision;
  const drawn = await assignments.find({ caseId, caseRevision: revision });
  const panel = servingSeats(drawn);
  if (panel.length === 0) return { status: 'no_panel' };

  const vacancies = outstandingVacancies(drawn);
  if (vacancies.length > 0) return { status: 'waiting', pendingSeats: vacancies.length };

  const pending = panel.filter((seat) => seat.status !== 'submitted');
  if (pending.length > 0) return { status: 'waiting', pendingSeats: pending.length };

  /**
   * §9.9: a revision past the first exists because an appeal opened it, so the
   * ladder the panel sits on is the appeal ladder — five seats at its lowest rung
   * (§9.4's "mínimo 5"). Reading the round off the first-instance ladder would
   * call a five-seat appeal panel round 2 correctly by accident today and wrongly
   * the moment either ladder changes.
   */
  const appealRevision = stored.currentRevision > 1;
  const round = panelRoundFor(reviewPool, panel.length, appealRevision);
  const appeal = appealRevision ? await appealForRevision(context, caseId, revision) : null;
  const submitted = await reviews.find({ caseId, caseRevision: revision });

  const families = allegedFamilies(stored);
  const profiles = await reviewerProfiles.find({
    reviewerId: { $in: submitted.map((review) => review.reviewerId) },
  });
  const byReviewer = new Map(profiles.map((profile) => [profile.reviewerId, profile]));
  const ballots = ballotsOf(submitted, byReviewer, families);

  const verdict = evaluateConsensus({
    ballots,
    round,
    risk: riskOf(stored.sensitivityClass),
    finalRound: MAX_PANEL_ROUND,
    /**
     * §9.4's appeal row: the bar recorded on the appeal when it was filed. Absent
     * — for a first-instance revision, or for a revision opened by an audit rather
     * than an appeal — the ordinary threshold applies unchanged.
     */
    appeal: appeal === null ? null : { requiredAgreeingVotes: appeal.requiredAgreeingVotes },
  });

  if (verdict.status === 'expand') {
    return expandPanel(context, stored, round, verdict);
  }

  return publish(context, stored, panel, ballots, byReviewer, families, verdict, appeal, now);
}

/** §8.6: a disagreement expands the panel to the next rung of the ladder. */
async function expandPanel(
  context: TenantContext,
  stored: CaseDocument,
  round: number,
  verdict: Extract<ConsensusVerdict, { status: 'expand' }>,
): Promise<CaseEvaluation> {
  const toRound = round + 1;

  logger.info(
    {
      caseId: stored.caseId,
      round,
      toRound,
      reason: verdict.reason,
      unmet: verdict.unmet,
      leadingVotes: verdict.leadingVotes,
      decisiveVotes: verdict.decisiveVotes,
    },
    'Consensus was not reached; expanding the panel',
  );

  const outcome = await openPanel({
    context,
    caseId: stored.caseId,
    kind: 'expansion',
    round: toRound,
  });

  if (outcome.status === 'refused') {
    /**
     * The pool could not supply the extra jurors. The case keeps its state and
     * its ballots and is expanded again when the pool grows — which is the same
     * answer §8.8 gives for a first draw that cannot be filled, and for the same
     * reason: a panel below its own threshold decides nothing, so seating one
     * would only consume the case's clock while reporting progress.
     */
    logger.warn(
      { caseId: stored.caseId, drawId: outcome.drawId, reason: outcome.reason, toRound },
      'The panel could not be expanded',
    );
    return { status: 'expansion_refused', toRound };
  }

  return { status: 'expanded', toRound };
}

/** Builds the decision the verdict describes and publishes it exactly once. */
async function publish(
  context: TenantContext,
  stored: CaseDocument,
  panel: readonly AssignmentDocument[],
  ballots: readonly Ballot[],
  profiles: ReadonlyMap<string, ReviewerProfileDocument>,
  families: readonly TaxonomyFamily[],
  verdict: Exclude<ConsensusVerdict, { status: 'expand' }>,
  appeal: AppealDocument | null,
  now: Date,
): Promise<CaseEvaluation> {
  const agreed = verdict.status === 'consensus' ? verdict.position : null;
  const agreeingReviewerIds =
    verdict.status === 'consensus' ? verdict.agreeingReviewerIds : [];
  const agreedKey = agreed === null ? null : positionKey(agreed);
  const agreeing = ballots.filter(
    (ballot) => agreedKey !== null && positionKey(positionOf(ballot)) === agreedKey,
  );

  const outcome: DecisionOutcome =
    verdict.status === 'consensus'
      ? decisionOutcomeOf(verdict.position.outcome)
      : verdict.outcome;

  /**
   * A non-consensus decision reports the context sufficiency the panel could
   * not agree about as `insufficient`.
   *
   * Not a verdict about the material — §9.6 keeps `inconclusive` and
   * `insufficient_context` distinct, and this is the former — but the honest
   * value for §9.5's `contextFactor`: whatever the panel had, it was not enough
   * to produce an answer, and a confidence score that claimed otherwise would
   * overstate a decision nobody reached.
   */
  const contextSufficiency = agreed === null ? 'insufficient' : agreed.contextSufficiency;

  const winningVotes = verdict.status === 'consensus' ? verdict.winningVotes : 0;
  const decisiveVotes = verdict.decisiveVotes;

  const findings =
    agreed === null ? [] : decisionFindings(agreeing, agreed.family, outcome);
  const recommendedActions =
    agreed === null ? [] : decisionActions(agreeing, agreed.resourceIds);

  const published: PublishOutcome = await publishDecision({
    context,
    caseId: stored.caseId,
    revision: stored.currentRevision,
    outcome,
    contextSufficiency,
    confidence: confidenceScore({
      winningDecisiveVotes: winningVotes,
      decisiveVotes,
      reviewerQuality: ballots.map((ballot) => {
        const profile = profiles.get(ballot.reviewerId);
        return profile === undefined ? 0 : categoryReliability(profile, families);
      }),
      contextSufficiency,
    }),
    findings,
    recommendedActions,
    jury: {
      size: panel.length,
      decisiveVotes,
      winningVotes,
      /**
       * Stored to the same two places the contract compares it at, so an audit
       * that re-derives `winningVotes / decisiveVotes` and one that reads the
       * stored value agree. The contract's tolerance is 1e-6, which a raw float
       * division satisfies; rounding it here would not.
       */
      agreement: decisiveVotes === 0 ? 0 : winningVotes / decisiveVotes,
      specialistPresent: ballots.some((ballot) => ballot.isSpecialist),
    },
    policyVersions: policyVersionsOf(stored),
    agreeingReviewerIds,
    supersedes: await supersededDecision(context, stored, appeal),
    now,
  });

  if (!published.published) {
    // Another worker published this revision between our read and our write.
    // Exactly what §12.11's compare-and-swap is for, and not an error.
    return { status: 'already_decided' };
  }

  logger.info(
    {
      caseId: stored.caseId,
      decisionId: published.decisionId,
      revision: stored.currentRevision,
      outcome,
      winningVotes,
      decisiveVotes,
    },
    'A decision was published',
  );

  return { status: 'published', decisionId: published.decisionId, outcome };
}

/**
 * The decision this one replaces, if any (§9.9).
 *
 * Null on revision 1 and never null after it: the contract refuses a revision
 * past the first that supersedes nothing, because "revision 2 that supersedes
 * nothing" is an edit wearing a new number. Marking the predecessor
 * `superseded` happens when the revision is OPENED, not here — by then the old
 * decision has already stopped being the current one, and a case whose appeal
 * was accepted must not still be showing the decision under appeal as final.
 */
async function supersededDecision(
  context: TenantContext,
  stored: CaseDocument,
  appeal: AppealDocument | null,
): Promise<
  { decisionId: string; outcome: DecisionOutcome; appealId: string | null } | null
> {
  if (stored.currentRevision <= 1) return null;

  const [previous] = await decisions.find(
    context,
    { caseId: stored.caseId, revision: stored.currentRevision - 1 },
    { limit: 1 },
  );
  if (!previous) return null;

  /**
   * The appeal id travels with the supersession so the decision module can emit
   * §10.6's `appeal.decided` in the same transaction as `case.decided`, without
   * reading the appeals collection itself. It is null for a revision that no
   * appeal opened — there is no event to emit and nobody waiting for one.
   */
  return {
    decisionId: previous.decisionId,
    outcome: previous.outcome,
    appealId: appeal?.appealId ?? null,
  };
}
