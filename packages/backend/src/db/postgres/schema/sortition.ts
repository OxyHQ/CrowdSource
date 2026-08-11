import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { createdAt, inList, timestamptz, updatedAt } from '@oxyhq/db';

import { SLOT_TYPES } from '../../../modules/sortition/panelSpec';
import { REVIEW_POOLS } from '../../../modules/triage/triage';

/**
 * §8.7's assignment lifecycle.
 *
 * `offered` and `accepted` are separate because §8.7 describes both routes: an
 * assignment may be offered and accepted, or created directly when the reviewer
 * asks for their next case. Both end in the same place; what differs is whether
 * the reviewer has yet looked at it.
 *
 * Declared HERE rather than in `assignment.collection.ts`, following the move
 * `OUTBOX_STATUSES` and `REVIEWER_RELATION_SOURCES` already made: the Mongoose
 * file is what goes away at the switch, and the CHECK below has to be rendered
 * from the same tuple the Mongoose `enum` validates. Two copies of a closed value
 * set is how they drift, and the copy that survives should be the one in the
 * store that survives.
 *
 * `SLOT_TYPES` and `REVIEW_POOLS` do NOT move, and are imported above from
 * `panelSpec` and `triage` instead. Their homes are domain modules that survive
 * the switch — `panelSpec` is §8.3's panel table and `triage` is §7.5's routing —
 * so moving them would take a live domain vocabulary into the persistence layer
 * for no reason beyond where a CHECK happens to be written.
 */
export const ASSIGNMENT_STATUSES = [
  'offered',
  'accepted',
  'submitted',
  'recused',
  'expired',
  /** Superseded by a replacement, e.g. after the case revision moved on. */
  'replaced',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/**
 * Statuses in which the reviewer still holds the case.
 *
 * A SUBSET rather than a value set of its own, and it takes no CHECK: every
 * member is already admitted by `assignments_status_check`, and a column
 * constrained to this narrower set would refuse `submitted`, which is where every
 * completed assignment ends up. It moved with `ASSIGNMENT_STATUSES` because it is
 * derived from it and because the repositories below read it — a Postgres
 * repository importing it from the Mongoose file would point the surviving module
 * at the dying one.
 */
export const OPEN_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ['offered', 'accepted'];

export const DRAW_STATUSES = ['drawn', 'refused'] as const;
export type DrawStatus = (typeof DRAW_STATUSES)[number];

/**
 * The status the cardinality constraint below keys on, ANNOTATED rather than
 * inlined.
 *
 * The annotation is the point: written as a bare `'drawn'` inside the `check()`,
 * a rename of that member would leave a constraint keyed on a status no row can
 * ever hold — which does not error, it simply stops constraining anything, and
 * every `drawn` row then satisfies the implication vacuously. Typed as
 * `DrawStatus`, the same rename is a `tsc` failure here.
 */
const DRAWN_STATUS: DrawStatus = 'drawn';

/** Why a draw ran at all: the first panel, a replacement, or an escalation. */
export const DRAW_KINDS = ['initial', 'replacement', 'expansion'] as const;
export type DrawKind = (typeof DRAW_KINDS)[number];

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
    /**
     * ONE SEAT PER PERSON PER CASE REVISION, enforced by the database.
     *
     * The Mongo counterpart of this line —
     * `assignmentSchema.index({ caseId, reviewerId, caseRevision }, { unique: true })`
     * — had no PostgreSQL equivalent until now, which is a preserved prohibition
     * that the port silently dropped. It is not decorative: `openPanel`'s own
     * header names it as the reason a replayed draw is safe ("the unique index on
     * `caseId + reviewerId + caseRevision` rejects a second attempt to seat the
     * same person"), and §12.7's `case_id + reviewer_id + decision_revision`
     * constraint on reviews is only meaningful if the assignment authorising them
     * is unique the same way. A replacement for a recused juror must not be the
     * same person, and a replayed draw must not seat somebody twice.
     *
     * Restored as a `unique()` CONSTRAINT rather than a `uniqueIndex()`, matching
     * the house rule: drizzle-kit emits every foreign key before every
     * `CREATE UNIQUE INDEX`, so an index cannot be an FK target. Nothing points at
     * this today, but the constraint form costs nothing and removes the trap.
     *
     * Uniqueness here is TOTAL rather than partial. A recused or expired seat
     * still occupies the person's place on that revision — the replacement is a
     * different person by construction — so there is no status for which a second
     * row would be legitimate, and a partial unique would admit exactly the replay
     * this exists to reject.
     */
    unique('assignments_case_id_reviewer_id_case_revision_key').on(
      table.caseId,
      table.reviewerId,
      table.caseRevision,
    ),

    /** The panel for one revision — the read every consensus pass starts from. */
    index('assignments_case_id_case_revision_idx').on(table.caseId, table.caseRevision),
    /** Prior jurors across an incident, which is why `incident_id` is denormalised. */
    index('assignments_incident_id_idx').on(table.incidentId),
    /** A reviewer's open work, and the daily limit check. */
    index('assignments_reviewer_id_status_idx').on(table.reviewerId, table.status),
    /** The expiry sweep: assignments past their deadline, oldest first. */
    index('assignments_status_expires_at_idx').on(table.status, table.expiresAt),

    /**
     * The three closed value sets this table carried in Mongo, restored.
     *
     * Each is rendered from its tuple through `inList` + `sql.raw` rather than
     * spelled out, so adding a member is a code change PLUS a migration in the
     * same PR. `sql.raw` is not a style choice: an ordinary interpolation into
     * `check()` emits the bound parameter `$1`, which type-checks, generates, and
     * fails at APPLY time with no local signal.
     *
     * `slot_type` and `filled_as` take the SAME tuple and are still two
     * constraints, because they are two facts — §8.3's fallback means the class
     * that filled a seat need not be the class the seat asked for, and a single
     * constraint could not tell a reader that both are separately closed.
     *
     * `sensitivity_class` deliberately gets NO CHECK. Mongo declared it
     * `{ type: String, required: true }` with no `enum`, so constraining it here
     * would be a NEW restriction smuggled in under a port rather than a preserved
     * one. The asymmetry is recorded so a later reader does not "fix" it.
     */
    check('assignments_status_check', sql`${table.status} in (${sql.raw(inList(ASSIGNMENT_STATUSES))})`),
    check('assignments_slot_type_check', sql`${table.slotType} in (${sql.raw(inList(SLOT_TYPES))})`),
    check('assignments_filled_as_check', sql`${table.filledAs} in (${sql.raw(inList(SLOT_TYPES))})`),
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

    /** The three scalar value sets, restored from their tuples. */
    check('sortition_draws_status_check', sql`${table.status} in (${sql.raw(inList(DRAW_STATUSES))})`),
    check('sortition_draws_kind_check', sql`${table.kind} in (${sql.raw(inList(DRAW_KINDS))})`),
    check('sortition_draws_pool_check', sql`${table.pool} in (${sql.raw(inList(REVIEW_POOLS))})`),

    /**
     * `requested_slots` is `text[]`, so its value set is CONTAINMENT, not `in`.
     *
     * Mongo's `{ type: [String], enum: SLOT_TYPES }` puts the validator on the
     * CASTER — it constrains each element, not the array — and `<@` is the
     * operator that says the same thing. An `in (...)` here would not compile
     * against an array column, and a per-element check written any other way
     * would need an unnest.
     *
     * Note what this does NOT say: `<@` is vacuously TRUE for `{}`, so this
     * constraint admits the empty array. That is correct and deliberate — see the
     * cardinality constraint below, which is the only thing in this file that has
     * anything to say about empty.
     */
    check(
      'sortition_draws_requested_slots_check',
      sql`${table.requestedSlots} <@ array[${sql.raw(inList(SLOT_TYPES))}]::text[]`,
    ),

    /**
     * A drawn panel asked for at least one seat. A REFUSAL may ask for none.
     *
     * ## Read the asymmetry before simplifying it
     *
     * `sortition.service.ts:433-450` records the §7.5 row-1 legal-pool refusal
     * with `slots: []`, DELIBERATELY, and returns before the ordinary path's
     * `slots.length === 0` throw at `:471`. That row is how "no panel was ever
     * opened for this case" stays distinguishable from "this case is under legal
     * protocol" — the two look identical from the outside otherwise, and only one
     * of them is correct. A flat `cardinality(requested_slots) >= 1` would refuse
     * that write, which is a refusal of a legitimate production path.
     *
     * So the enforceable relationship is the IMPLICATION, keyed on `status`,
     * which is the discriminant: `drawn` rows must name a seat, `refused` rows
     * need not. Both the `drawn` writer (`:560`, non-empty past the `:471` throw)
     * and both refusal writers (`:435` with `[]`, `:506` with the real slots)
     * satisfy it today.
     *
     * `cardinality()`, never `array_length(col, 1)`. `array_length` is NULL on an
     * empty array, a CHECK rejects only FALSE, and NULL is not FALSE — so the
     * `array_length` spelling would ADMIT `{}` on a `drawn` row and enforce
     * nothing at all, while reading exactly like this line.
     *
     * ## This one is a NEW restriction, and is the only one in this file
     *
     * Said plainly because the other six were preserved and this one is not.
     * Mongoose's `required: true` on an array does not mean non-empty, so no
     * validator ever enforced this; the invariant lived in `:471`'s throw, which
     * is application code. It is worth making structural — a `drawn` draw with no
     * requested seat is a panel seated for nothing, and §8.5's audit story rests
     * on the record being coherent — but it is an addition, not a restoration,
     * and the next reader should not have to work that out.
     */
    check(
      'sortition_draws_requested_slots_cardinality_check',
      sql`${table.status} <> ${sql.raw(inList([DRAWN_STATUS]))} or cardinality(${table.requestedSlots}) >= 1`,
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
