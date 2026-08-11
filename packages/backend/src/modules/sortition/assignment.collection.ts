import { Schema } from 'mongoose';

import { defineUnscopedCollection } from '../../db/collections';
import {
  ASSIGNMENT_STATUSES,
  type AssignmentStatus,
} from '../../db/postgres/schema/sortition';
import type { SensitivityClass } from '../triage/triage';
import { SLOT_TYPES, type SlotType } from './panelSpec';

/**
 * Temporary assignments (§8.7, §12.6's `assignments`).
 *
 * An assignment is the ONLY thing that authorises a reviewer to see a case. It
 * is issued by the server after a draw; there is no queue to browse, no case to
 * search for and no link to share. "Nobody chooses the case they review" is
 * enforced here, by there being no other door.
 *
 * ## Why this collection is not tenant-scoped
 *
 * It sits on the boundary between the two worlds. A case belongs to one
 * application; a reviewer belongs to none. The reads that matter are by REVIEWER
 * — "which assignment is this person holding" — and the caller making them
 * presents an Oxy session, which carries no tenant to scope by. Every row is
 * still stamped with the tenant of its case, taken from the case document inside
 * the draw's transaction and never from anything a caller supplied, so a leak
 * would have to be a leak of the reviewer surface rather than of the tenant
 * filter.
 *
 * ## The token
 *
 * §8.7 requires the token to authorise that case and to reveal no ids usable
 * elsewhere. Only its hash is stored, so the database cannot hand anybody a
 * working token, and it is minted fresh whenever an assignment is (re-)opened —
 * which makes the previous token dead and gives "reuse a token" an unambiguous
 * answer.
 */

/**
 * §8.7's lifecycle now lives in `db/postgres/schema/sortition.ts`, with
 * `OPEN_ASSIGNMENT_STATUSES`, and both are imported above.
 *
 * They moved because THIS file is the one that goes away at the switch, and the
 * CHECK constraint restoring the value set has to be rendered from the same tuple
 * the `enum` below validates. Two copies is how they drift.
 */

export interface AssignmentDocument {
  assignmentId: string;
  /** Stamped from the case inside the draw's transaction. Never from a caller. */
  organizationId: string;
  applicationId: string;

  caseId: string;
  /** §9.9: an appeal opens a new revision, and an assignment belongs to one. */
  caseRevision: number;
  /** The draw that produced this seat, for the audit trail back to the seed. */
  drawId: string;
  /** Denormalised so prior jurors across an incident are one indexed query. */
  incidentId: string | null;

  reviewerId: string;
  slotType: SlotType;
  /** The class that actually filled the slot when a fallback was used (§8.3). */
  filledAs: SlotType;

  status: AssignmentStatus;

  /**
   * SHA-256 of the live token. Never the token.
   *
   * Rotated every time the assignment is opened, so exactly one token works at
   * a time and a token captured from an old response stops working the moment
   * the reviewer opens the case again.
   */
  tokenHash: string;

  /** What the reviewer consented to see when this was issued (§13.7). */
  sensitivityClass: SensitivityClass;

  offeredAt: Date;
  acceptedAt: Date | null;
  expiresAt: Date;
  completedAt: Date | null;

  /** §8.7's structured recusal reason. Never free text about the case. */
  recusalReason: string | null;
  /** The assignment drawn to take this one's place, when it was vacated. */
  replacementAssignmentId: string | null;

  createdAt: Date;
  updatedAt: Date;
}

const assignmentSchema = new Schema<AssignmentDocument>(
  {
    assignmentId: { type: String, required: true, unique: true },
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },

    caseId: { type: String, required: true },
    caseRevision: { type: Number, required: true },
    drawId: { type: String, required: true },
    incidentId: { type: String, default: null },

    reviewerId: { type: String, required: true },
    slotType: { type: String, required: true, enum: SLOT_TYPES },
    filledAs: { type: String, required: true, enum: SLOT_TYPES },

    status: { type: String, required: true, enum: ASSIGNMENT_STATUSES },
    tokenHash: { type: String, required: true },
    sensitivityClass: { type: String, required: true },

    offeredAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },

    recusalReason: { type: String, default: null },
    replacementAssignmentId: { type: String, default: null },
  },
  { timestamps: true, collection: 'assignments' },
);

/**
 * One seat per person per case revision, enforced by the database.
 *
 * A replacement for a recused juror must not be the same person, a replayed
 * draw must not seat somebody twice, and §12.7's `case_id + reviewer_id +
 * decision_revision` constraint on reviews is only meaningful if the assignment
 * that authorises them is unique the same way.
 */
assignmentSchema.index({ caseId: 1, reviewerId: 1, caseRevision: 1 }, { unique: true });

/** "What is this reviewer holding?" — the reviewer surface's only question. */
assignmentSchema.index({ reviewerId: 1, status: 1, expiresAt: 1 });

/** "Who is on this panel?" — consensus, replacement and prior-juror checks. */
assignmentSchema.index({ caseId: 1, caseRevision: 1, status: 1 });

/** §8.5's prior jurors across an incident, without a join. */
assignmentSchema.index({ incidentId: 1, reviewerId: 1 });

/** The expiry sweep: open assignments whose time has run out (§8.7). */
assignmentSchema.index({ status: 1, expiresAt: 1 });

/** §13.7's exposure counting: what has this reviewer completed, and when. */
assignmentSchema.index({ reviewerId: 1, completedAt: -1 });

export const assignments = defineUnscopedCollection('Assignment', assignmentSchema, {
  why: 'An assignment joins a tenant’s case to a reviewer who belongs to no tenant, and is read by an Oxy session that carries no tenant to scope by; rows are stamped from the case inside the draw transaction.',
});
