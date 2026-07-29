import { Schema } from 'mongoose';
import {
  CONTEXT_SUFFICIENCIES,
  REVIEW_OUTCOMES,
  type ContextSufficiency,
  type ReviewFinding,
  type ReviewOutcome,
} from '@oxyhq/crowdsource-contracts';

import { defineUnscopedCollection } from '../../db/collections';

/**
 * One juror's review (§9.3, §12.6's `reviews`).
 *
 * Phase 3 owns this collection for one reason: §15.4's definition of done says a
 * user who was not selected "cannot open OR VOTE", and a vote needs somewhere to
 * land. What is here is the LEDGER — the record that this juror answered, once,
 * for this revision. The consensus engine that reads these rows and turns them
 * into a decision (§9.4, §9.6) belongs to the next phase, and nothing here
 * anticipates its shape.
 *
 * ## What is deliberately absent
 *
 * There is no weight, no reliability, no selection weight and no tier. §8.4
 * allows reliability to affect eligibility, the slot and the aggregate
 * confidence score, and forbids it turning one vote into several; the system
 * this replaces conflates the two by feeding one `validatorWeight` into both the
 * selection reservoir and the vote's stake. Here the two cannot be conflated
 * because the fields do not exist: a consensus engine reading these rows has
 * nothing to multiply by. `weightSeparation.test.ts` asserts that, so the
 * absence stays a property rather than an omission somebody helpfully corrects.
 *
 * `confidence` IS stored, and is not a weight. §9.5 uses it to decide whether a
 * panel needs escalating; a low-confidence violation and a high-confidence one
 * are both exactly one vote for violation.
 */

export interface ReviewDocument {
  reviewId: string;
  /** Stamped from the assignment, which was stamped from the case. */
  organizationId: string;
  applicationId: string;

  assignmentId: string;
  caseId: string;
  /** §9.9's revision. An appeal opens a new one with a new panel. */
  caseRevision: number;
  reviewerId: string;

  outcome: ReviewOutcome;
  contextSufficiency: ContextSufficiency;
  findings: ReviewFinding[];
  recommendedActions: string[];
  /**
   * The reviewer's free-text note.
   *
   * Case content, and treated as such everywhere: never logged, never put in an
   * audit row, never in an attestation. It is here because §9.3 includes it in a
   * review and a decision has to be explainable to the person it was about.
   */
  notes: string | null;

  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const reviewFindingSchema = new Schema<ReviewFinding>(
  {
    code: { type: String, required: true },
    resourceIds: { type: [String], required: true },
    severity: { type: String, required: true },
    confidence: { type: Number, required: true },
    policyRuleIds: { type: [String], default: undefined },
  },
  { _id: false },
);

const reviewSchema = new Schema<ReviewDocument>(
  {
    reviewId: { type: String, required: true, unique: true },
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },

    assignmentId: { type: String, required: true, unique: true },
    caseId: { type: String, required: true },
    caseRevision: { type: Number, required: true },
    reviewerId: { type: String, required: true },

    outcome: { type: String, required: true, enum: REVIEW_OUTCOMES },
    contextSufficiency: { type: String, required: true, enum: CONTEXT_SUFFICIENCIES },
    findings: { type: [reviewFindingSchema], required: true, default: [] },
    recommendedActions: { type: [String], required: true, default: [] },
    notes: { type: String, default: null },

    submittedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'reviews' },
);

/**
 * §12.7's `case_id + reviewer_id + decision_revision`, which is what makes "one
 * review per juror per revision" a property of the database rather than of the
 * code above it.
 *
 * The unique index on `assignmentId` is the same rule from the other direction:
 * an assignment authorises exactly one review. Both are needed — the first stops
 * a reviewer voting twice through two assignments, the second stops one
 * assignment producing two reviews.
 */
reviewSchema.index({ caseId: 1, reviewerId: 1, caseRevision: 1 }, { unique: true });

/** The consensus engine's read: every review of one revision of one case. */
reviewSchema.index({ caseId: 1, caseRevision: 1, submittedAt: 1 });

export const reviews = defineUnscopedCollection('Review', reviewSchema, {
  why: 'A review joins a tenant’s case to a reviewer who belongs to no tenant, and is written by a caller holding an Oxy session that carries no tenant to scope by; rows are stamped from the assignment.',
});
