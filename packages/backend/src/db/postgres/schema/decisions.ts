import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { createdAt, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  APPEAL_REASONS,
  CONTEXT_SUFFICIENCIES,
  DECISION_OUTCOMES,
  DECISION_STATUSES,
} from '@oxyhq/crowdsource-contracts';

/**
 * A jury's decision on a case, and the appeal that can supersede it.
 */
export const decisions = pgTable(
  'decisions',
  {
    decisionId: text('decision_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    caseId: text('case_id').notNull(),
    revision: integer('revision').notNull(),

    status: text('status').notNull(),
    outcome: text('outcome').notNull(),
    contextSufficiency: text('context_sufficiency').notNull(),
    confidence: doublePrecision('confidence').notNull(),

    /**
     * Findings and recommended actions stay `jsonb`.
     *
     * Nothing queries or filters on either — every read is by `decision_id`,
     * `case_id` or `revision` — and their sub-fields are closed sets enforced by
     * zod rather than by Mongo, which declared them as bare strings. Flattening
     * them into child tables would move the vocabulary's authority out of the
     * contracts package for no read that needs it.
     */
    findings: jsonb('findings').notNull().default([]),
    recommendedActions: jsonb('recommended_actions').notNull().default([]),

    /**
     * The jury summary is FLATTENED, unlike the two above, because it is five
     * required scalars with fixed names rather than an open list. Columns make
     * the agreement arithmetic inspectable in SQL; a jsonb blob would hide it.
     */
    jurySize: integer('jury_size').notNull(),
    juryDecisiveVotes: integer('jury_decisive_votes').notNull(),
    juryWinningVotes: integer('jury_winning_votes').notNull(),
    juryAgreement: doublePrecision('jury_agreement').notNull(),
    jurySpecialistPresent: boolean('jury_specialist_present').notNull(),

    /** Three required strings, flattened for the same reason. */
    policyVersionTaxonomy: text('policy_version_taxonomy').notNull(),
    policyVersionApplication: text('policy_version_application').notNull(),
    policyVersionOxyConduct: text('policy_version_oxy_conduct').notNull(),

    supersedesDecisionId: text('supersedes_decision_id'),
    agreeingReviewerIds: text('agreeing_reviewer_ids').array().notNull().default([]),
    publishedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * NOT prefixed by the tenant, deliberately — the Mongo index was not either.
     * A case id is globally unique, and one revision number per case is the
     * invariant regardless of who owns it, so a tenant prefix would weaken the
     * constraint to "unique within a tenant" and let a bug mint a second
     * revision 3 under another tenant's case id.
     */
    uniqueIndex('decisions_case_revision_key').on(table.caseId, table.revision),
    index('decisions_application_case_revision_idx').on(
      table.applicationId,
      table.caseId,
      table.revision.desc(),
    ),

    /**
     * §9.6's three closed sets, restored as constraints.
     *
     * All three validators fired on Mongo — a decision is written through
     * `insertOne`, which reaches `Model.create()`. They render from the CONTRACTS
     * package rather than a schema-local tuple because they cross the reviewer
     * and console API boundaries, so contracts is already their one authority.
     *
     * `outcome` matters most of the three: §9.6 requires `inconclusive` to be its
     * own outcome and never to collapse into `no_violation`, and a column that
     * accepts any string is one bad write away from erasing that distinction in
     * the store rather than in the code that was careful about it.
     */
    check(
      'decisions_status_check',
      sql`${table.status} in (${sql.raw(inList(DECISION_STATUSES))})`,
    ),
    check(
      'decisions_outcome_check',
      sql`${table.outcome} in (${sql.raw(inList(DECISION_OUTCOMES))})`,
    ),
    check(
      'decisions_context_sufficiency_check',
      sql`${table.contextSufficiency} in (${sql.raw(inList(CONTEXT_SUFFICIENCIES))})`,
    ),
  ],
);

/**
 * An appeal against a decision revision.
 *
 * Append-only, and deliberately carries NO status column: an appeal's state is
 * derived from the decisions table. Adding one here would be a second answer to
 * a question `decisions` already answers.
 */
export const appeals = pgTable(
  'appeals',
  {
    appealId: text('appeal_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    caseId: text('case_id').notNull(),
    supersededRevision: integer('superseded_revision').notNull(),
    supersededDecisionId: text('superseded_decision_id').notNull(),
    openedRevision: integer('opened_revision').notNull(),
    reason: text('reason').notNull(),
    appellantExternalPrincipalId: text('appellant_external_principal_id').notNull(),

    /**
     * Nullable as a WHOLE, which is why it is one `jsonb` column rather than
     * three nullable ones: "no author context was supplied" is a different fact
     * from "a context was supplied with an empty statement", and three columns
     * cannot express the difference without a fourth discriminator.
     *
     * It carries the appellant's own statement — case material. Never log it,
     * never copy it into an audit row, a webhook body or an attestation.
     */
    authorContext: jsonb('author_context'),

    previousRequiredVotes: integer('previous_required_votes').notNull(),
    severeAction: boolean('severe_action').notNull(),
    requiredAgreeingVotes: integer('required_agreeing_votes').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    filedAt: timestamptz().notNull(),
    filedByCredentialId: text('filed_by_credential_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Refuses a SECOND appeal of one revision — the caller sees 409. */
    uniqueIndex('appeals_application_case_revision_key').on(
      table.applicationId,
      table.caseId,
      table.supersededRevision,
    ),
    /**
     * Makes a RETRY return the original appeal. Separately named from the one
     * above because the handler answers them differently, and a single merged
     * constraint would make a replay indistinguishable from a conflict.
     */
    uniqueIndex('appeals_application_idempotency_key').on(
      table.applicationId,
      table.idempotencyKey,
    ),
    index('appeals_application_case_opened_idx').on(
      table.applicationId,
      table.caseId,
      table.openedRevision,
    ),

    /**
     * §9.8's grounds for appeal, restored as a constraint.
     *
     * Mongoose enforced `enum: APPEAL_REASONS` and the validator DID fire — the
     * appeal is written through `insertOne`, which goes to `Model.create()`.
     * Everything in this repo that writes through `updateOne` or
     * `findOneAndUpdate` never ran its validators, because nothing passes
     * `runValidators`; those are recorded in the gate as not-applicable rather
     * than given a constraint they never had.
     *
     * `sql.raw` on the value list is required, not stylistic: an ordinary
     * interpolation into `check()` emits the bound parameter `$1` into the
     * generated migration, which then fails at APPLY time with no local signal.
     */
    check(
      'appeals_reason_check',
      sql`${table.reason} in (${sql.raw(inList(APPEAL_REASONS))})`,
    ),
  ],
);
