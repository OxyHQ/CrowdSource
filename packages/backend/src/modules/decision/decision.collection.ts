import type {
  ContextSufficiency,
  DecisionFinding,
  DecisionOutcome,
  DecisionPolicyVersions,
  DecisionRecommendedAction,
  DecisionStatus,
} from '@oxyhq/crowdsource-contracts';

import { defineTenantCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';

/**
 * Decisions (§9.6, §9.9, §12.8, Appendix B).
 *
 * One row per REVISION of a case. Never per case, and never updated in place:
 * §9.9's worked example is a case with two decision rows, the first
 * `superseded` and the second `final`, and the interface showing the current one
 * while keeping the whole history. That is the storage shape the invariant "a
 * published decision is never edited, only superseded" needs — an `updateOne`
 * on the outcome of revision 1 would be indistinguishable from history if the
 * revisions shared a row.
 *
 * ## What is immutable, and what is not
 *
 * §9.9 is precise: "nunca se sobreescribe outcome, findings o policyVersion de
 * una decisión publicada". `status` is NOT on that list, and §9.9's own example
 * requires it to move — revision 1 becomes `superseded` when revision 2 lands.
 * So the rule is not "nothing about a decision changes", it is "nothing about
 * what was DECIDED changes", and `decision.service.ts` is where that is
 * enforced: it exposes exactly one write that touches an existing row, it sets
 * `status` and nothing else, and `decisionImmutability.test.ts` scans the source
 * tree to assert no other module writes here at all.
 *
 * ## Why it is tenant-scoped when reviews and assignments are not
 *
 * A decision is read back by the APPLICATION that owns the case, through a
 * service credential, and delivered to that application's webhook endpoints —
 * every reader of a decision carries a tenant. So the filter applies here in
 * full, and the one query that would NOT be tenant-scoped — "which decisions are
 * pending delivery" — does not exist, because delivery goes through the outbox.
 *
 * ## What a reviewer may be told, which is not nothing
 *
 * §9.1's hidden row is "votos anteriores o **resultado parcial**" — previous
 * votes, or a PARTIAL result. A published decision is neither, and §4.1's
 * Historial row requires the opposite: "resultados que ya puedan revelarse". So a
 * reviewer history surface may disclose the outcome of a revision that has been
 * decided, narrowly, and two constraints bind whoever builds one.
 *
 *  - **Key it on the revision the reviewer JUDGED** — `caseRevision` on their own
 *    review row — and never on `currentDecision`. After an appeal those are
 *    different rows, and a revision-1 juror shown the CURRENT decision would be
 *    shown an outcome they never voted on and told, by implication, that an appeal
 *    overturned them. Supersession leaves both rows intact and unedited, so
 *    `{ caseId, revision: review.caseRevision }` is unambiguous forever — but only
 *    if that is the query actually made. `currentDecision` is the trap here, not
 *    a convenience.
 *  - **Give the tally no field to travel in.** `DecisionJurySummary` — the counts
 *    and the agreement ratio — belongs to the application-facing DTO and must have
 *    no counterpart in a reviewer projection, because an agreement ratio IS a
 *    partial result seen from the far end. Absence is the enforcement: a field
 *    that exists gets filled eventually by somebody who does not know why it was
 *    empty, while a field that does not exist has to be added deliberately.
 *
 * `status` is not disclosable to a reviewer either, for a quieter reason:
 * `superseded` says a later revision exists, which tells a juror their case was
 * appealed and that somebody has already ruled on it.
 */

export interface DecisionJurySummary {
  /** Seats on the panel that produced this decision. */
  readonly size: number;
  /** Jurors who expressed an opinion — §9.5's denominator. */
  readonly decisiveVotes: number;
  /** Jurors who held the winning position — §9.5's numerator. */
  readonly winningVotes: number;
  /** `winningVotes / decisiveVotes`, stored so an audit can check the division. */
  readonly agreement: number;
  /** §9.4's high-risk row requires one; the decision records whether one sat. */
  readonly specialistPresent: boolean;
}

export interface DecisionDocument extends TenantContext {
  decisionId: string;
  caseId: string;
  /** §9.9's revision. Unique per case, and the compare-and-swap's other half. */
  revision: number;

  status: DecisionStatus;
  outcome: DecisionOutcome;
  contextSufficiency: ContextSufficiency;
  /** §9.5. Communicates quality; never multiplied into anything. */
  confidence: number;

  findings: DecisionFinding[];
  recommendedActions: DecisionRecommendedAction[];
  jury: DecisionJurySummary;

  /** §6.4's three, all of them, on every decision. */
  policyVersions: DecisionPolicyVersions;

  /** §9.9: null on revision 1, the previous revision's id on every later one. */
  supersedesDecisionId: string | null;

  /**
   * The jurors whose position this decision states.
   *
   * Kept for the audit trail an appeal needs — §9.8 forbids any member of the
   * original jury from sitting on the appeal panel, and the panel's assignments
   * are the record of who sat while this is the record of who agreed. It is
   * never returned by any surface: §9.1 keeps juror identities from the panel
   * itself, and an application learning which reviewers decided against its user
   * would be worse.
   */
  agreeingReviewerIds: string[];

  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const decisions = defineTenantCollection<DecisionDocument>('Decision');
