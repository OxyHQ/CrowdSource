import type { ClientSession } from 'mongoose';
import { taxonomyFamilyOf, type TaxonomyCode, type TaxonomyFamily } from '@oxyhq/crowdsource-contracts';

import { withTransaction } from '../../db/transaction';
import type { TenantContext } from '../../db/tenantScope';
import { logger } from '../../utils/logger';
import { newPublicId } from '../../utils/identifiers';
import { cases, type CaseDocument } from '../cases/case.collection';
import {
  availabilityScore,
  eligibilityRejection,
  requiresAdultReviewer,
  SENSITIVE_EXPOSURE_WINDOW_HOURS,
  type CaseEligibilityCriteria,
  type ExposureFacts,
} from '../reviewer/eligibility';
import { calibrationRecency } from '../reviewer/calibration';
import type { ReviewPool } from '../triage/triage';
import {
  affinityPairKey,
  reviewerAffinities,
  reviewerProfiles,
  reviewerRelations,
  type ReviewerProfileDocument,
} from '../reviewer/reviewer.collection';
import {
  assignments,
  OPEN_ASSIGNMENT_STATUSES,
  type AssignmentDocument,
} from './assignment.collection';
import { mintAssignmentToken } from './assignmentToken';
import { sampleCandidates } from './candidatePool';
import {
  sortitionDraws,
  SORTITION_RULES_VERSION,
  type DrawCandidate,
  type DrawKind,
  type DrawRejection,
  type DrawSeat,
} from './draw.collection';
import { exclusionFor, MAX_CO_SERVICE, type CaseParties } from './exclusions';
import {
  MAX_PANEL_ROUND,
  panelSpecFor,
  satisfiesSlot,
  SLOT_TYPES,
  type PanelSpec,
  type SlotType,
} from './panelSpec';
import { encodeSeed, newSortitionSeed } from './seededRandom';
import { selectionWeight } from './selectionWeight';
import {
  drawPanel,
  type PanelRefusalReason,
  type SeatedReviewer,
  type WeightedCandidate,
} from './weightedSampling';

/**
 * The Sortition Service (§8.5) — assembling a jury for a case.
 *
 * Everything the plan asks for in one sequence: gather the eligible pool, remove
 * everybody entangled with the case, draw a seed, sample by slot with weights,
 * PERSIST the seed and the candidate snapshot, and only then issue temporary
 * assignments. The order at the end is not stylistic. A draw whose seed is
 * written after the panel is a draw somebody could have re-rolled; here the
 * record is written first and the assignments join it in the same transaction,
 * so a panel without its own audit record cannot exist.
 *
 * ## Refusing is a feature
 *
 * `openPanel` returns a refusal rather than a small panel. The system this
 * replaces has no minimum-pool guard: it opens whatever it can and the result
 * expires, which is why twenty of twenty-one civic validation requests in
 * production expired without a single vote. A panel below its own threshold
 * cannot decide anything — it only consumes the case's clock while reporting
 * progress — so refusing is both more honest and more recoverable. The refusal
 * is recorded with its reason and its counts, and the case stays where it was,
 * ready to be drawn again when the pool grows.
 *
 * ## How much a draw costs
 *
 * Counted rather than estimated, for an initial draw on a case with no incident
 * and no incumbents — nine reads at most:
 *
 *   1. the case;
 *   2. the panel's existing seats;
 *   3. prior jurors on the case (+1 more when it belongs to an incident);
 *   4. declared relations against the case's principals;
 *   5. participants who are also reviewers, for the subject and cluster checks;
 *   6. the candidate window (+1 when it wraps past zero);
 *   7. open and recent assignments across the sampled candidates;
 *   8. high-affinity pairs within the sampled set.
 *
 * A replacement adds one more, for the incumbents' profiles. NONE of them is per
 * candidate, and every one is indexed. §8.8 warns that the civic selector runs
 * about ten sequential round trips PER CANDIDATE over an unordered `limit(500)`;
 * the shape here is constant in the size of the reviewer population and linear
 * only in the sample size, which is configuration.
 */

/** How long a reviewer has to accept and complete an assignment (§8.7). */
export const ASSIGNMENT_TTL_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export interface PanelSeatSummary {
  readonly reviewerId: string;
  readonly assignmentId: string;
  readonly slotType: SlotType;
  readonly filledAs: SlotType;
}

export type PanelOutcome =
  | {
      readonly status: 'drawn';
      readonly drawId: string;
      readonly seats: readonly PanelSeatSummary[];
    }
  | {
      readonly status: 'refused';
      readonly drawId: string;
      readonly reason: PanelRefusalReason | 'legal_pool';
      readonly slot?: SlotType;
      readonly eligibleCount: number;
    };

/** The case facts a draw is a function of. Derived, never supplied. */
interface CaseFacts {
  readonly criteria: CaseEligibilityCriteria;
  /** The single family a specialist slot is about, when the case has one. */
  readonly specialistFamily: TaxonomyFamily | null;
}

/**
 * What the case is about, in the terms eligibility is expressed in.
 *
 * The specialist family is the STRICTEST family present rather than the most
 * common one, for the same reason `triage.ts` takes the strictest route: a case
 * carrying nine spam allegations and one child-safety allegation needs a
 * child-safety specialist. `null` when the case alleges nothing that maps to a
 * family, which makes specialist slots unfillable — correctly, since there is
 * nothing to specialise in.
 */
function caseFactsOf(stored: CaseDocument): CaseFacts {
  const families = [
    ...new Set(stored.allegationCodes.map((code) => taxonomyFamilyOf(code as TaxonomyCode))),
  ];

  const primary = stored.contentSnapshot.resources.find(
    (resource) => resource.id === stored.primaryResourceId,
  );
  const language =
    primary?.language ??
    stored.contentSnapshot.resources.find((resource) => resource.language !== undefined)
      ?.language ??
    null;

  if (stored.sensitivityClass === null) {
    throw new Error(`Case '${stored.caseId}' has not been triaged; it has no sensitivity class.`);
  }

  return {
    criteria: {
      families,
      language,
      sensitivity: stored.sensitivityClass,
      requiresAdult: requiresAdultReviewer(families),
    },
    // Sorted so the choice is deterministic rather than dependent on the order
    // allegations happened to merge in.
    specialistFamily: families.length === 0 ? null : [...families].sort()[0],
  };
}

/** Everybody already seated on this panel, whatever state their seat is in. */
async function panelAssignments(
  caseId: string,
  caseRevision: number,
): Promise<AssignmentDocument[]> {
  return assignments.find({ caseId, caseRevision });
}

/**
 * §8.5's parties, in four queries.
 *
 * Never one query per candidate. The whole set is assembled once and the
 * exclusion predicate then runs in memory over the sample, which is the
 * difference between a draw that costs the same at ten million profiles and one
 * that does not.
 */
async function gatherParties(stored: CaseDocument): Promise<CaseParties> {
  const subjectPrincipalIds = new Set(
    stored.contentSnapshot.principals
      .map((principal) => principal.externalPrincipalId)
      .filter((id): id is string => id !== undefined),
  );

  const principalIds = [...subjectPrincipalIds];

  const [onThisCase, onThisIncident, relations, participants] = await Promise.all([
    assignments.find({ caseId: stored.caseId }),
    stored.incidentId === null
      ? Promise.resolve<AssignmentDocument[]>([])
      : assignments.find({ incidentId: stored.incidentId }),
    principalIds.length === 0
      ? Promise.resolve([])
      : reviewerRelations.find({
          applicationId: stored.applicationId,
          externalPrincipalId: { $in: principalIds },
        }),
    principalIds.length === 0
      ? Promise.resolve<ReviewerProfileDocument[]>([])
      : reviewerProfiles.find({
          principalLinks: {
            $elemMatch: {
              applicationId: stored.applicationId,
              externalPrincipalId: { $in: principalIds },
            },
          },
        }),
  ]);

  return {
    applicationId: stored.applicationId,
    subjectPrincipalIds,
    reporterFingerprints: new Set(stored.reporterFingerprints),
    priorJurorIds: new Set(
      [...onThisCase, ...onThisIncident].map((assignment) => assignment.reviewerId),
    ),
    partyRiskClusterIds: new Set(
      participants
        .map((participant) => participant.riskClusterId)
        .filter((cluster): cluster is string => cluster !== null),
    ),
    relatedReviewerIds: new Set(relations.map((relation) => relation.reviewerId)),
  };
}

/** The start of the current UTC day, for §13.7's daily limits. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * §13.7's exposure, for every sampled candidate, in one query.
 *
 * Counted from the assignments themselves rather than from counters on the
 * profile. A counter drifts every time a write fails between the two documents,
 * and the drift always runs the same way — toward believing somebody has done
 * less than they have, which is the direction that overloads a person.
 */
async function gatherExposure(
  reviewerIds: readonly string[],
  now: Date,
): Promise<ReadonlyMap<string, ExposureFacts>> {
  const exposure = new Map<string, ExposureFacts>();
  for (const reviewerId of reviewerIds) {
    exposure.set(reviewerId, {
      openAssignments: 0,
      reviewsToday: 0,
      sensitiveReviewsInWindow: 0,
    });
  }
  if (reviewerIds.length === 0) return exposure;

  const dayStart = startOfUtcDay(now);
  const rows = await assignments.find({
    reviewerId: { $in: [...reviewerIds] },
    $or: [
      { status: { $in: [...OPEN_ASSIGNMENT_STATUSES] } },
      { completedAt: { $gte: dayStart } },
    ],
  });

  const windowStart = new Date(now.getTime() - SENSITIVE_EXPOSURE_WINDOW_HOURS * HOUR_MS);

  for (const row of rows) {
    const facts = exposure.get(row.reviewerId);
    if (!facts) continue;

    const openAssignments =
      facts.openAssignments +
      (OPEN_ASSIGNMENT_STATUSES.includes(row.status) && row.expiresAt.getTime() > now.getTime()
        ? 1
        : 0);
    const completedToday = row.completedAt !== null && row.completedAt >= dayStart;
    const sensitiveInWindow =
      completedToday &&
      row.sensitivityClass !== 'standard' &&
      row.completedAt !== null &&
      row.completedAt >= windowStart;

    exposure.set(row.reviewerId, {
      openAssignments,
      reviewsToday: facts.reviewsToday + (completedToday ? 1 : 0),
      sensitiveReviewsInWindow: facts.sensitiveReviewsInWindow + (sensitiveInWindow ? 1 : 0),
    });
  }

  return exposure;
}

/**
 * §8.5's high-affinity pairs, restricted to the people who could actually be
 * drawn together.
 *
 * One query over the sampled set rather than the whole affinity collection: a
 * pair matters only if both halves are in this draw.
 */
async function gatherAffinity(
  reviewerIds: readonly string[],
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const blocked = new Map<string, Set<string>>();
  if (reviewerIds.length < 2) return blocked;

  const ids = [...reviewerIds];
  const pairs = await reviewerAffinities.find({
    reviewerIdA: { $in: ids },
    reviewerIdB: { $in: ids },
    coServedCount: { $gte: MAX_CO_SERVICE },
  });

  const link = (from: string, to: string): void => {
    const set = blocked.get(from) ?? new Set<string>();
    set.add(to);
    blocked.set(from, set);
  };

  for (const pair of pairs) {
    link(pair.reviewerIdA, pair.reviewerIdB);
    link(pair.reviewerIdB, pair.reviewerIdA);
  }

  return blocked;
}

/** Which slot classes this profile could fill for this case. */
function eligibleSlotsFor(
  profile: ReviewerProfileDocument,
  facts: CaseFacts,
  family: TaxonomyFamily | null,
): SlotType[] {
  const slotFacts = {
    state: profile.state,
    reliability: reliabilityFor(profile, facts),
    completedReviewCount: profile.completedReviewCount,
    specialistCategories: profile.specialistCategories,
  };
  return SLOT_TYPES.filter((slot) => satisfiesSlot(slot, slotFacts, family));
}

/**
 * The reliability that counts for this case.
 *
 * The MINIMUM across the families alleged, not the mean. A reviewer who is
 * excellent on spam and poor on harassment should not fill a reliable slot on a
 * case that alleges both — averaging would let a strong score in an unrelated
 * family carry them onto a panel they are not ready for. A family with no
 * measurement contributes 0, which is the honest value: nobody has measured it.
 */
function reliabilityFor(profile: ReviewerProfileDocument, facts: CaseFacts): number {
  if (facts.criteria.families.length === 0) return 0;
  return facts.criteria.families.reduce(
    (lowest, family) => Math.min(lowest, profile.reliabilityByCategory[family] ?? 0),
    1,
  );
}

interface PreparedPool {
  readonly candidates: readonly WeightedCandidate[];
  readonly rejections: readonly DrawRejection[];
  readonly sampledCount: number;
}

/** Samples, filters and weights the pool. Pure once the queries have returned. */
async function preparePool(
  facts: CaseFacts,
  parties: CaseParties,
  now: Date,
): Promise<PreparedPool> {
  const sample = await sampleCandidates(facts.criteria, now);
  const exposure = await gatherExposure(
    sample.profiles.map((profile) => profile.reviewerId),
    now,
  );

  const candidates: WeightedCandidate[] = [];
  const rejections: DrawRejection[] = [];

  for (const profile of sample.profiles) {
    const carrying = exposure.get(profile.reviewerId) ?? {
      openAssignments: 0,
      reviewsToday: 0,
      sensitiveReviewsInWindow: 0,
    };

    const ineligible = eligibilityRejection(profile, facts.criteria, carrying, now);
    if (ineligible !== null) {
      rejections.push({ reviewerId: profile.reviewerId, reason: ineligible });
      continue;
    }

    const excluded = exclusionFor(profile, parties);
    if (excluded !== null) {
      rejections.push({ reviewerId: profile.reviewerId, reason: excluded });
      continue;
    }

    const reliability = reliabilityFor(profile, facts);
    candidates.push({
      reviewerId: profile.reviewerId,
      selectionWeight: selectionWeight({
        categoryReliability: reliability,
        recentCalibration: calibrationRecency(profile.calibrationPassedAt, now),
        personhoodConfidence: profile.personhoodConfidence,
        availabilityScore: availabilityScore(profile, carrying),
      }),
      reliability,
      riskClusterId: profile.riskClusterId,
      eligibleSlots: eligibleSlotsFor(profile, facts, facts.specialistFamily),
    });
  }

  return { candidates, rejections, sampledCount: sample.sampledCount };
}

/** The incumbents of a panel, as the draw needs to see them. */
async function seatedIncumbents(
  panel: readonly AssignmentDocument[],
  facts: CaseFacts,
): Promise<SeatedReviewer[]> {
  const serving = panel.filter(
    (assignment) => assignment.status !== 'recused' && assignment.status !== 'expired',
  );
  if (serving.length === 0) return [];

  const profiles = await reviewerProfiles.find({
    reviewerId: { $in: serving.map((assignment) => assignment.reviewerId) },
  });
  const byId = new Map(profiles.map((profile) => [profile.reviewerId, profile]));

  return serving.map((assignment) => {
    const profile = byId.get(assignment.reviewerId);
    return {
      reviewerId: assignment.reviewerId,
      slotType: assignment.slotType,
      filledAs: assignment.filledAs,
      reliability: profile ? reliabilityFor(profile, facts) : 0,
      riskClusterId: profile?.riskClusterId ?? null,
    };
  });
}

export interface OpenPanelInput {
  readonly context: TenantContext;
  readonly caseId: string;
  readonly kind: DrawKind;
  /** For a replacement: the slot the departing juror held. */
  readonly slots?: readonly SlotType[];
  /** For an expansion: the round to reach. Defaults to the current one. */
  readonly round?: number;
  /**
   * A fixed seed. Only a test supplies one — production always draws a fresh
   * CSPRNG seed, because a seed anybody can choose is a panel anybody can pick.
   */
  readonly seed?: Buffer;
}

/**
 * Draws a panel for a case, or refuses.
 *
 * The transaction covers the draw record, the assignments, the case's state and
 * the affinity counters, which is what makes a replayed event safe: either all
 * of it happened or none of it did, and the unique index on
 * `caseId + reviewerId + caseRevision` rejects a second attempt to seat the same
 * person.
 */
export async function openPanel(input: OpenPanelInput): Promise<PanelOutcome> {
  const { context, caseId, kind } = input;
  const now = new Date();

  const stored = await cases.findOne(context, { caseId });
  if (!stored) {
    throw new Error(`Sortition was asked for case '${caseId}', which this tenant does not own.`);
  }
  const reviewPool = stored.reviewPool;
  if (reviewPool === null) {
    throw new Error(`Case '${caseId}' has no review pool; it has not been triaged.`);
  }

  const drawId = newPublicId('sortitionDraw');

  /**
   * §7.5 row 1: material routed to the legal pool is never delivered to a jury.
   *
   * Recorded as a refused draw rather than silently skipped, because "no panel
   * was ever opened for this case" and "this case is waiting for a specialist
   * team under legal protocol" look identical from the outside otherwise, and
   * only one of them is correct.
   */
  if (reviewPool === 'legal') {
    await recordRefusal({
      drawId,
      stored,
      pool: 'legal',
      round: input.round ?? 1,
      kind,
      panelSpecId: 'none.legal',
      slots: [],
      seed: encodeSeed(newSortitionSeed()),
      candidates: [],
      rejections: [],
      sampledCount: 0,
      reason: 'legal_pool',
      now,
    });
    return { status: 'refused', drawId, reason: 'legal_pool', eligibleCount: 0 };
  }

  const panel = await panelAssignments(stored.caseId, stored.currentRevision);
  const round = input.round ?? currentRound(reviewPool, panel, kind);
  if (round > MAX_PANEL_ROUND) {
    throw new Error(`Case '${caseId}' cannot expand past round ${MAX_PANEL_ROUND} (§8.6).`);
  }

  const spec = panelSpecFor(reviewPool, round);
  const facts = caseFactsOf(stored);
  const parties = await gatherParties(stored);
  const incumbents = await seatedIncumbents(panel, facts);
  const slots = input.slots ?? slotsStillToFill(spec, incumbents);

  if (slots.length === 0) {
    throw new Error(`Case '${caseId}' has no seat to fill at round ${round}.`);
  }

  const pool = await preparePool(facts, parties, now);
  const affinityBlocked = await gatherAffinity([
    ...pool.candidates.map((candidate) => candidate.reviewerId),
    ...incumbents.map((seat) => seat.reviewerId),
  ]);

  /**
   * §8.5's order, and the only order that is auditable: the seed is drawn here
   * and written below BEFORE any assignment exists. Everything the draw depends
   * on is already fixed by this point.
   */
  const seed = input.seed ?? newSortitionSeed();
  const outcome = drawPanel({
    spec,
    candidates: pool.candidates,
    seed,
    slots,
    incumbents,
    affinityBlocked,
  });

  const snapshot: DrawCandidate[] = pool.candidates.map((candidate) => ({
    reviewerId: candidate.reviewerId,
    selectionWeight: candidate.selectionWeight,
    reliability: candidate.reliability,
    eligibleSlots: candidate.eligibleSlots,
  }));

  if (!outcome.ok) {
    await recordRefusal({
      drawId,
      stored,
      pool: reviewPool,
      round,
      kind,
      panelSpecId: spec.panelSpecId,
      slots,
      seed: encodeSeed(seed),
      candidates: snapshot,
      rejections: pool.rejections,
      sampledCount: pool.sampledCount,
      reason: outcome.reason,
      now,
    });

    logger.warn(
      {
        caseId,
        drawId,
        reason: outcome.reason,
        slot: outcome.slot,
        eligibleCount: snapshot.length,
        sampledCount: pool.sampledCount,
      },
      'Sortition refused to open a panel',
    );

    return {
      status: 'refused',
      drawId,
      reason: outcome.reason,
      ...(outcome.slot ? { slot: outcome.slot } : {}),
      eligibleCount: snapshot.length,
    };
  }

  const incumbentIds = new Set(incumbents.map((seat) => seat.reviewerId));
  const drawn = outcome.seats.filter((seat) => !incumbentIds.has(seat.reviewerId));

  const issued = drawn.map((seat) => ({
    seat,
    assignmentId: newPublicId('assignment'),
    token: mintAssignmentToken(),
  }));

  const selected: DrawSeat[] = issued.map((entry) => ({
    reviewerId: entry.seat.reviewerId,
    slotType: entry.seat.slotType,
    filledAs: entry.seat.filledAs,
    assignmentId: entry.assignmentId,
  }));

  await withTransaction(async (session) => {
    await sortitionDraws.insertOne(
      {
        drawId,
        organizationId: stored.organizationId,
        applicationId: stored.applicationId,
        caseId: stored.caseId,
        caseRevision: stored.currentRevision,
        pool: reviewPool,
        round,
        kind,
        panelSpecId: spec.panelSpecId,
        rulesVersion: SORTITION_RULES_VERSION,
        seed: encodeSeed(seed),
        requestedSlots: [...slots],
        candidateSnapshot: snapshot,
        rejections: [...pool.rejections],
        selected,
        sampledCount: pool.sampledCount,
        eligibleCount: snapshot.length,
        status: 'drawn',
        refusalReason: null,
        drawnAt: now,
        createdAt: now,
        updatedAt: now,
      },
      session,
    );

    for (const entry of issued) {
      await assignments.insertOne(
        {
          assignmentId: entry.assignmentId,
          organizationId: stored.organizationId,
          applicationId: stored.applicationId,
          caseId: stored.caseId,
          caseRevision: stored.currentRevision,
          drawId,
          incidentId: stored.incidentId,
          reviewerId: entry.seat.reviewerId,
          slotType: entry.seat.slotType,
          filledAs: entry.seat.filledAs,
          status: 'offered',
          tokenHash: entry.token.tokenHash,
          sensitivityClass: facts.criteria.sensitivity,
          offeredAt: now,
          acceptedAt: null,
          expiresAt: new Date(now.getTime() + ASSIGNMENT_TTL_HOURS * HOUR_MS),
          completedAt: null,
          recusalReason: null,
          replacementAssignmentId: null,
          createdAt: now,
          updatedAt: now,
        },
        session,
      );
    }

    await bumpAffinities(outcome.seats, now, session);

    /**
     * The case moves to `awaiting_review` only from a state that has not
     * already moved past it. A replacement draw for a case somebody is already
     * reviewing must not drag its lifecycle backwards.
     */
    await cases.updateOne(
      context,
      { caseId, status: { $in: ['triaged', 'escalated'] } },
      { set: { status: 'awaiting_review', updatedAt: now } },
      session,
    );
  });

  return {
    status: 'drawn',
    drawId,
    seats: issued.map((entry) => ({
      reviewerId: entry.seat.reviewerId,
      assignmentId: entry.assignmentId,
      slotType: entry.seat.slotType,
      filledAs: entry.seat.filledAs,
    })),
  };
}

/**
 * The round this panel is at, from the seats it already has.
 *
 * Derived rather than stored on the case, so a replayed event cannot advance the
 * ladder twice: the seats are the record, and counting them twice gives the same
 * answer while incrementing a counter twice does not.
 */
function currentRound(
  pool: ReviewPool,
  panel: readonly AssignmentDocument[],
  kind: DrawKind,
): number {
  const seated = panel.filter(
    (assignment) => assignment.status !== 'recused' && assignment.status !== 'expired',
  ).length;

  const reached = [1, 2, 3].reduce(
    (highest, round) => (panelSpecFor(pool, round).slots.length <= seated ? round : highest),
    1,
  );
  return kind === 'expansion' ? Math.min(MAX_PANEL_ROUND, reached + 1) : reached;
}

/** The slots of `spec` that nobody is sitting in. */
function slotsStillToFill(
  spec: PanelSpec,
  incumbents: readonly SeatedReviewer[],
): readonly SlotType[] {
  const remaining = [...spec.slots];
  for (const seat of incumbents) {
    const index = remaining.indexOf(seat.slotType);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

/**
 * §8.5's affinity counters, incremented for every pair on the finished panel.
 *
 * Both the newly drawn and the incumbents, because affinity is about who SAT
 * TOGETHER — a replacement who joins two people who always serve together has
 * served with both of them.
 */
async function bumpAffinities(
  seats: readonly SeatedReviewer[],
  now: Date,
  session: ClientSession,
): Promise<void> {
  for (let left = 0; left < seats.length; left += 1) {
    for (let right = left + 1; right < seats.length; right += 1) {
      const a = seats[left].reviewerId;
      const b = seats[right].reviewerId;
      await reviewerAffinities.findOneAndUpdate(
        { pairKey: affinityPairKey(a, b) },
        {
          $setOnInsert: {
            pairKey: affinityPairKey(a, b),
            reviewerIdA: a < b ? a : b,
            reviewerIdB: a < b ? b : a,
          },
          $inc: { coServedCount: 1 },
          $set: { lastServedAt: now },
        },
        { upsert: true },
        session,
      );
    }
  }
}

interface RefusalRecord {
  readonly drawId: string;
  readonly stored: CaseDocument;
  readonly pool: ReviewPool;
  readonly round: number;
  readonly kind: DrawKind;
  readonly panelSpecId: string;
  readonly slots: readonly SlotType[];
  readonly seed: string;
  readonly candidates: readonly DrawCandidate[];
  readonly rejections: readonly DrawRejection[];
  readonly sampledCount: number;
  readonly reason: PanelRefusalReason | 'legal_pool';
  readonly now: Date;
}

/**
 * Writes the record of a draw that produced no panel.
 *
 * Outside a transaction, on purpose: there is no domain write to be atomic
 * with, and a refusal that failed to record because a transaction aborted would
 * leave exactly the silence this is meant to break.
 */
async function recordRefusal(record: RefusalRecord): Promise<void> {
  await sortitionDraws.insertOne({
    drawId: record.drawId,
    organizationId: record.stored.organizationId,
    applicationId: record.stored.applicationId,
    caseId: record.stored.caseId,
    caseRevision: record.stored.currentRevision,
    pool: record.pool,
    round: record.round,
    kind: record.kind,
    panelSpecId: record.panelSpecId,
    rulesVersion: SORTITION_RULES_VERSION,
    seed: record.seed,
    requestedSlots: [...record.slots],
    candidateSnapshot: [...record.candidates],
    rejections: [...record.rejections],
    selected: [],
    sampledCount: record.sampledCount,
    eligibleCount: record.candidates.length,
    status: 'refused',
    refusalReason: record.reason,
    drawnAt: record.now,
    createdAt: record.now,
    updatedAt: record.now,
  });
}

/**
 * Re-runs a persisted draw and reports whether it reproduces (§16.3).
 *
 * The audit entry point, and the reason the snapshot stores weights and
 * eligible slots rather than only ids: everything `drawPanel` reads is in the
 * record, so this needs no access to the reviewer profiles as they are today —
 * which is essential, because they will have changed.
 */
export async function replayDraw(drawId: string): Promise<readonly string[] | null> {
  const record = await sortitionDraws.findOne({ drawId });
  if (!record || record.status !== 'drawn') return null;

  const panel = await assignments.find({
    caseId: record.caseId,
    caseRevision: record.caseRevision,
  });
  const drawnHere = new Set(record.selected.map((seat) => seat.reviewerId));
  const incumbents: SeatedReviewer[] = panel
    .filter((assignment) => assignment.drawId !== record.drawId && !drawnHere.has(assignment.reviewerId))
    .map((assignment) => ({
      reviewerId: assignment.reviewerId,
      slotType: assignment.slotType,
      filledAs: assignment.filledAs,
      reliability:
        record.candidateSnapshot.find((candidate) => candidate.reviewerId === assignment.reviewerId)
          ?.reliability ?? 1,
      riskClusterId: null,
    }));

  const outcome = drawPanel({
    spec: panelSpecFor(record.pool, record.round),
    candidates: record.candidateSnapshot.map((candidate) => ({
      reviewerId: candidate.reviewerId,
      selectionWeight: candidate.selectionWeight,
      reliability: candidate.reliability,
      riskClusterId: null,
      eligibleSlots: candidate.eligibleSlots,
    })),
    seed: Buffer.from(record.seed, 'hex'),
    slots: record.requestedSlots,
    incumbents,
    affinityBlocked: new Map(),
  });

  if (!outcome.ok) return null;
  const incumbentIds = new Set(incumbents.map((seat) => seat.reviewerId));
  return outcome.seats
    .filter((seat) => !incumbentIds.has(seat.reviewerId))
    .map((seat) => seat.reviewerId);
}
