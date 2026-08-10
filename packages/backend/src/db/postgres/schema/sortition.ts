import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * The jury tables — and the worked example for the whole exemption vocabulary.
 *
 * These rows DO carry the tenant pair, and every one is stamped with the tenant
 * of its case, taken from the case document inside the draw's own transaction. So
 * the data is tenant-attributed and correct, and a missing policy looks like an
 * oversight.
 *
 * It is not. The exemption is about the READER, not the row: a case belongs to
 * one tenant, but a REVIEWER belongs to none. Reviewers are drawn across every
 * application, and the caller reading an assignment presents an Oxy session,
 * which carries no tenant to scope by — there is no `TenantContext` at that call
 * site to put in a filter, and none that could be. `sortition.service.ts:177`
 * reads `assignments.find({ caseId, caseRevision })` with no tenant term at all.
 *
 * So a policy keyed on `app.organization_id` / `app.application_id` would make
 * these tables unreadable by their only reader, because that reader can never set
 * them. This must not be "fixed" by a later tightening — see
 * `tenant_stamped_reached_through_parent` in `tableRegistry.ts`.
 */

export const assignments = pgTable(
  'assignments',
  {
    assignmentId: text('assignment_id').primaryKey(),

    /** Stamped from the case inside the draw's transaction. Never from a caller. */
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    caseId: text('case_id').notNull(),
    /** §9.9: an appeal opens a new revision, and an assignment belongs to one. */
    caseRevision: integer('case_revision').notNull(),
    /** The draw that produced this seat, for the audit trail back to the seed. */
    drawId: text('draw_id').notNull(),
    /** Denormalised so prior jurors across an incident are one indexed query. */
    incidentId: text('incident_id'),

    reviewerId: text('reviewer_id').notNull(),
    slotType: text('slot_type').notNull(),
    /** The class that actually filled the slot when a fallback was used (§8.3). */
    filledAs: text('filled_as').notNull(),

    status: text('status').notNull(),

    /**
     * SHA-256 of the live token. Never the token.
     *
     * Rotated every time the assignment is opened, so exactly one token works at a
     * time and a token captured from an old response stops working the moment the
     * reviewer opens the case again.
     */
    tokenHash: text('token_hash').notNull(),

    /** What the reviewer consented to see when this was issued (§13.7). */
    sensitivityClass: text('sensitivity_class').notNull(),

    offeredAt: timestamptz().notNull(),
    acceptedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    completedAt: timestamptz(),

    /** §8.7's structured recusal reason. Never free text about the case. */
    recusalReason: text('recusal_reason'),
    /** The assignment drawn to take this one's place, when it was vacated. */
    replacementAssignmentId: text('replacement_assignment_id'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** The panel for one revision — the read every consensus pass starts from. */
    index('assignments_case_id_case_revision_idx').on(table.caseId, table.caseRevision),
    /** Prior jurors across an incident, which is why `incident_id` is denormalised. */
    index('assignments_incident_id_idx').on(table.incidentId),
    /** A reviewer's open work, and the daily limit check. */
    index('assignments_reviewer_id_status_idx').on(table.reviewerId, table.status),
    /** The expiry sweep: assignments past their deadline, oldest first. */
    index('assignments_status_expires_at_idx').on(table.status, table.expiresAt),
  ],
);

export const sortitionDraws = pgTable(
  'sortition_draws',
  {
    drawId: text('draw_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    caseId: text('case_id').notNull(),
    caseRevision: integer('case_revision').notNull(),
    /** Which pool the case was routed to (§7.5), so a replay picks the same table. */
    pool: text('pool').notNull(),
    round: integer('round').notNull(),
    kind: text('kind').notNull(),

    panelSpecId: text('panel_spec_id').notNull(),
    rulesVersion: text('rules_version').notNull(),
    /** §8.5's seed, hex-encoded. Written before any assignment exists. */
    seed: text('seed').notNull(),

    /** The slots this draw was asked to fill. A scalar array nothing queries into. */
    requestedSlots: text('requested_slots').array().notNull(),

    /**
     * The three audit arrays, all `jsonb`.
     *
     * They are arrays of OBJECTS, unlike `requested_slots`, and nothing queries
     * into any of them: a draw is read by `findOne({ drawId })` as a whole record
     * (`sortition.service.ts:777`) and never searched by a candidate or a seat. So
     * they take the same treatment as `envelope` and `findings` — jsonb, no index
     * — rather than three child tables nothing would ever join to.
     *
     * `candidate_snapshot` carries §8.4's selection weight, and this is the ONE
     * place a weight is persisted: it is never copied onto an assignment or a
     * review, which `selectionWeight.ts` keeps structural rather than careful.
     */
    candidateSnapshot: jsonb('candidate_snapshot').notNull(),
    rejections: jsonb('rejections').notNull(),
    selected: jsonb('selected').notNull(),

    /** How the sample was reached, for §8.8's cost story and for operators. */
    sampledCount: integer('sampled_count').notNull(),
    eligibleCount: integer('eligible_count').notNull(),

    status: text('status').notNull(),
    refusalReason: text('refusal_reason'),

    drawnAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Every draw for a revision, newest first — the audit question, and the one
     * that finds the replacement draws after the initial panel.
     */
    index('sortition_draws_case_id_case_revision_drawn_at_idx').on(
      table.caseId,
      table.caseRevision,
      table.drawnAt,
    ),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    reviewId: text('review_id').primaryKey(),

    /** Stamped from the assignment, which was stamped from the case. */
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    assignmentId: text('assignment_id').notNull(),
    caseId: text('case_id').notNull(),
    /** §9.9's revision. An appeal opens a new one with a new panel. */
    caseRevision: integer('case_revision').notNull(),
    reviewerId: text('reviewer_id').notNull(),

    outcome: text('outcome').notNull(),
    contextSufficiency: text('context_sufficiency').notNull(),

    /** Objects nobody queries into — the `findings` treatment, already settled. */
    findings: jsonb('findings').notNull(),

    /**
     * The closed action vocabulary, as a scalar array.
     *
     * Typed rather than free text because consensus COUNTS them: §9.4's agreed
     * recommendation is the one a majority of the winning jurors ticked, and two
     * spellings of the same action would never reach a majority.
     */
    recommendedActions: text('recommended_actions').array().notNull(),

    /**
     * The reviewer's free-text note. Case content, and treated as such
     * everywhere: never logged, never in an audit row, never in an attestation.
     */
    notes: text('notes'),

    submittedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Consensus reads every submitted review for one revision. */
    index('reviews_case_id_case_revision_idx').on(table.caseId, table.caseRevision),
    /**
     * §4.1's "Historial" — a reviewer's own completed reviews, keyset-paginated on
     * `(submitted_at, review_id)` descending, which is the tuple
     * `reviewHistory.ts` decodes its cursor into.
     */
    index('reviews_reviewer_id_submitted_at_review_id_idx').on(
      table.reviewerId,
      table.submittedAt,
      table.reviewId,
    ),
    /** One review per assignment: a reviewer submits once. */
    uniqueIndex('reviews_assignment_id_key').on(table.assignmentId),
  ],
);
