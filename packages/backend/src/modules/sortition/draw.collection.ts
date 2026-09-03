import { defineUnscopedCollection } from '../../db/collections';
import type { DrawKind, DrawStatus } from '../../db/postgres/schema/sortition';
import type { ReviewPool } from '../triage/triage';
import type { EligibilityRejection } from '../reviewer/eligibility';
import type { ExclusionReason } from './exclusions';
import type { SlotType } from './panelSpec';
import type { PanelRefusalReason } from './weightedSampling';

/**
 * The audit record of one draw (§8.5).
 *
 * §8.5's algorithm ends with `persist(seed, candidateSnapshot, selected,
 * rulesVersion)` BEFORE `issueTemporaryAssignments(selected)`, and that ordering
 * is the entire reason a sortition can be trusted after the fact. A draw whose
 * seed was never written is a draw nobody can check; a draw whose seed was
 * written after the panel could have been re-rolled until it came out well.
 * Here the record and the assignments commit in ONE transaction, with the record
 * written first, so neither exists without the other.
 *
 * What this makes possible: give an auditor this row and they can re-run
 * `drawPanel` and get the same panel. The candidate snapshot is the input, the
 * seed is the randomness, `rulesVersion` says which version of the algorithm and
 * the constraints were in force, and nothing else went into the decision.
 *
 * A REFUSED draw is recorded too, with the reason and the counts. A case that
 * could not open a panel is the single most important thing for an operator to
 * see — it is the difference between "the pool is too small" and "moderation
 * silently stopped" — and the system it replaces recorded nothing at all,
 * leaving twenty expired requests as the only evidence.
 */

/**
 * Bumped whenever the algorithm, the panel table or the constraints change.
 *
 * §8.5 requires it on the record because a decision is only explainable under
 * the rules it was made with. Two draws with the same seed and different rules
 * versions are not expected to agree, and without this field nobody could tell
 * that apart from a bug.
 */
export const SORTITION_RULES_VERSION = '2026.1';

/** One candidate as the draw saw them. §8.5's `candidateSnapshot`. */
export interface DrawCandidate {
  readonly reviewerId: string;
  /**
   * §8.4's weight at draw time.
   *
   * This is the ONE place a selection weight is persisted, and it is persisted
   * because an audit of a draw is impossible without it. It is never copied onto
   * an assignment or a review — see `selectionWeight.ts` for why that separation
   * is structural rather than a matter of care.
   */
  readonly selectionWeight: number;
  readonly reliability: number;
  readonly eligibleSlots: readonly SlotType[];
}

/** A candidate the pool contained but the rules removed, and why. */
export interface DrawRejection {
  readonly reviewerId: string;
  readonly reason: EligibilityRejection | ExclusionReason;
}

export interface DrawSeat {
  readonly reviewerId: string;
  readonly slotType: SlotType;
  readonly filledAs: SlotType;
  readonly assignmentId: string;
}

/**
 * `DRAW_STATUSES` and `DRAW_KINDS` now live in
 * `db/postgres/schema/sortition.ts` and are imported above, for the reason given
 * there: this file goes away at the switch, and the CHECK constraints restoring
 * both value sets are rendered from the same tuples the `enum`s below validate.
 */

export interface SortitionDrawDocument {
  drawId: string;
  organizationId: string;
  applicationId: string;

  caseId: string;
  caseRevision: number;
  /** Which pool the case was routed to (§7.5), so a replay picks the same table. */
  pool: ReviewPool;
  round: number;
  kind: DrawKind;

  panelSpecId: string;
  rulesVersion: string;
  /** §8.5's seed, hex-encoded. Written before any assignment exists. */
  seed: string;

  /** The slots this draw was asked to fill. */
  requestedSlots: SlotType[];
  candidateSnapshot: DrawCandidate[];
  rejections: DrawRejection[];
  selected: DrawSeat[];

  /** How the sample was reached, for §8.8's cost story and for operators. */
  sampledCount: number;
  eligibleCount: number;

  status: DrawStatus;
  refusalReason: PanelRefusalReason | 'legal_pool' | null;

  drawnAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const sortitionDraws = defineUnscopedCollection<SortitionDrawDocument>('SortitionDraw', {
  why: 'A draw records reviewers, who belong to no tenant, alongside the case they were drawn for; it is written by the sortition worker and never returned to an application-API caller.',
});
