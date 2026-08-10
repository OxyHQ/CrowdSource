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

import { REVIEWER_STATES } from '@oxyhq/crowdsource-contracts';

import { createdAt, inList, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * Where a reviewer's declared relationship came from (§8.5).
 *
 * Declared HERE rather than in `reviewer.collection.ts`, following the same move
 * `OUTBOX_STATUSES` made: the Mongoose file is what goes away at the switch, and
 * the CHECK below has to be rendered from the same tuple the Mongoose `enum`
 * validates. Two copies of a closed value set is how they drift, and the copy
 * that survives should be the one in the store that survives.
 *
 * `REVIEWER_STATES` does NOT move and is imported from the contracts package
 * instead. It crosses the reviewer API boundary — the app renders it — so
 * contracts is already its one home, and relocating it here would take a
 * published value set out of the published package.
 */
export const REVIEWER_RELATION_SOURCES = ['declared', 'recusal'] as const;
export type ReviewerRelationSource = (typeof REVIEWER_RELATION_SOURCES)[number];

/**
 * The reviewer tables: the people juries are drawn from.
 *
 * A case belongs to a tenant; a reviewer belongs to NONE. Juries are cross-tenant
 * by design (§8.2, and `candidatePool.ts` has no tenant filter deliberately), so
 * three of these four tables carry no tenant column at all.
 *
 * The fourth is the one worth reading twice. `reviewer_principal_links` has no
 * Mongo counterpart — it is `ReviewerProfile.principalLinks`, an embedded array,
 * extracted into a table because the draw QUERIES INTO IT:
 *
 *   principalLinks: { $elemMatch: { applicationId: …,
 *                                   externalPrincipalId: { $in: [...] } } }
 *
 * That is the one predicate shape jsonb containment cannot serve — GIN answers
 * `@>`, and an `$in` over an element field becomes either N OR'd containments or
 * a lateral over `jsonb_array_elements`. As a table it is
 * `application_id = $1 AND external_principal_id = ANY($2)`: one btree, exactly
 * the predicate, on the draw's hot path.
 *
 * It also follows this schema's existing rule rather than departing from it —
 * jsonb here is for structures NOTHING queries into (`envelope`, `rules`,
 * `findings`, `author_context`). Something queries into this one.
 */

export const reviewerProfiles = pgTable(
  'reviewer_profiles',
  {
    reviewerId: text('reviewer_id').primaryKey(),
    /** The Oxy account. One profile per person. */
    oxyUserId: text('oxy_user_id').notNull(),

    state: text('state').notNull(),

    accountActive: boolean('account_active').notNull(),
    oxyAccountVerified: boolean('oxy_account_verified').notNull(),
    /**
     * §8.2's age compatibility as the single bit routing needs. §13.5
     * minimisation: a date of birth would let this service answer questions
     * nobody asked it.
     */
    isAdult: boolean('is_adult').notNull(),

    suspectedSockPuppet: boolean('suspected_sock_puppet').notNull(),
    /** Precomputed OUTSIDE the draw (§8.5, §8.8). Null for most people. */
    riskClusterId: text('risk_cluster_id'),

    /** Scalar arrays. `languages` and `categories` are queried; see the indexes. */
    languages: text('languages').array().notNull(),
    categories: text('categories').array().notNull(),
    specialistCategories: text('specialist_categories').array().notNull(),

    /**
     * §7.5/§13.7 consent, stored as the RANK rather than the name so the
     * eligibility filter is a comparison on a number.
     */
    maxSensitivityRank: integer('max_sensitivity_rank').notNull(),
    consentedSensitiveCategories: text('consented_sensitive_categories').array().notNull(),

    declaredConflictApplications: text('declared_conflict_applications').array().notNull(),

    /**
     * When this person accepted the reviewing rules — an instant, not a boolean,
     * because §13.7's consent model only works if a person can be shown WHAT they
     * consented to and when. Null means never accepted, which is a closed gate.
     */
    rulesAcceptedAt: timestamptz(),

    available: boolean('available').notNull(),
    dailyReviewLimit: integer('daily_review_limit').notNull(),

    trainingCompletedModules: text('training_completed_modules').array().notNull(),
    trainingCompletedAt: timestamptz(),
    calibrationPassedAt: timestamptz(),
    calibrationScore: doublePrecision('calibration_score'),
    calibrationAttempts: integer('calibration_attempts').notNull(),
    lastCalibrationAt: timestamptz(),

    /**
     * Per-family reliability in [0, 1]. `jsonb` because nothing queries INTO it —
     * every read is by a known family key in application code, which is the same
     * test `envelope` and `rules` passed. A child table would buy an index nobody
     * would use.
     */
    reliabilityByCategory: jsonb('reliability_by_category').notNull(),

    completedReviewCount: integer('completed_review_count').notNull(),
    personhoodConfidence: doublePrecision('personhood_confidence').notNull(),

    /**
     * A uniform draw in [0, 1), fixed at creation, and the reason the candidate
     * query is samplable at scale: a range scan from a random point on an indexed
     * uniform key gives a different unbiased window each draw at the same cost.
     */
    samplingKey: doublePrecision('sampling_key').notNull(),

    suspendedUntil: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('reviewer_profiles_oxy_user_id_key').on(table.oxyUserId),

    /**
     * §12.7's eligibility dimensions, as TWO indexes.
     *
     * In Mongo the reason for two was that a compound index cannot span two array
     * fields. In Postgres the reason is different and needs saying, because the
     * Mongo one no longer applies: these are GIN indexes over `text[]`, and GIN
     * serves the containment predicate the candidate query actually uses
     * (`categories @> ARRAY[$1]`). A btree here would be an index the planner
     * cannot use for containment — coverage in name only, which reads as
     * diligence while every draw sequential-scans.
     *
     * `sampling_key` is deliberately NOT part of them: GIN cannot carry an
     * ordered range column, so the bounded-window scan is a separate btree below.
     * That is a real difference from the Mongo shape and is why the two are
     * listed apart rather than transliterated.
     */
    index('reviewer_profiles_categories_idx').using('gin', table.categories),
    index('reviewer_profiles_languages_idx').using('gin', table.languages),

    /** The bounded random window the draw scans, once the dimension has filtered. */
    index('reviewer_profiles_state_sampling_key_idx').on(table.state, table.samplingKey),

    /** §8.3's cap of one panel member per risk cluster starts as a lookup. */
    index('reviewer_profiles_risk_cluster_id_idx').on(table.riskClusterId),

    /**
     * The port's replacement for Mongoose's `enum: REVIEWER_STATES`.
     *
     * §8.1's ladder is enforced in code by `assertTransition`, which decides
     * which MOVES are legal. This decides which VALUES exist at all, and the two
     * are not the same guarantee: `assertTransition` is reached through
     * `mutateProfile`, and `recordSubmittedReview` deliberately writes a
     * promotion outside it (documented on `assertTransition` itself, because it
     * is the only path that promotes anybody). A state written on that path had
     * exactly one thing standing between it and the column — this validator.
     *
     * `sql.raw` on the value list is REQUIRED, not stylistic: a value
     * interpolated into `check()` the ordinary way is emitted as the bound
     * parameter `$1` in the generated migration and fails at APPLY time with no
     * local signal. The COLUMN stays an interpolated drizzle column so its SQL
     * name still comes from the casing authority.
     *
     * NOTHING ELSE on this table gets a CHECK, and the asymmetry is deliberate.
     * `max_sensitivity_rank` is an integer whose meaning is an index into
     * `CONSENTABLE_SENSITIVITY`, and a range CHECK on it would be a NEW
     * restriction smuggled in under a port — Mongo constrained it with
     * `type: Number` and nothing more. `categories`, `languages` and the two
     * consent arrays were `[String]` with no `enum`, for the same reason.
     */
    check('reviewer_profiles_state_check', sql`${table.state} in (${sql.raw(inList(REVIEWER_STATES))})`),
  ],
);

/**
 * Which application account a reviewer says is theirs (§8.5's self-exclusion).
 *
 * Extracted from `ReviewerProfile.principalLinks`. It NAMES an application
 * without belonging to it: the row is a fact about a person, and the application
 * id says whose id space `external_principal_id` is written in.
 */
export const reviewerPrincipalLinks = pgTable(
  'reviewer_principal_links',
  {
    reviewerPrincipalLinkId: text('reviewer_principal_link_id').primaryKey(),

    reviewerId: text('reviewer_id').notNull(),
    applicationId: text('application_id').notNull(),
    /** The application's own id for this person. Never an Oxy user id. */
    externalPrincipalId: text('external_principal_id').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Claiming the same account twice is one link, not two. */
    uniqueIndex('reviewer_principal_links_reviewer_application_principal_key').on(
      table.reviewerId,
      table.applicationId,
      table.externalPrincipalId,
    ),
    /**
     * The draw's question, once per draw: "is anybody involved in this case also a
     * reviewer?" — `application_id = $1 AND external_principal_id = ANY($2)`.
     * Leading on the application narrows first and is the term the case supplies.
     */
    index('reviewer_principal_links_application_id_external_principal_id_idx').on(
      table.applicationId,
      table.externalPrincipalId,
    ),
    /** Loading one profile's links back, which `exclusions.ts` reads in memory. */
    index('reviewer_principal_links_reviewer_id_idx').on(table.reviewerId),
  ],
);

/**
 * A declared relationship between a reviewer and someone on an application
 * (§8.5's graph exclusion).
 *
 * Carries `application_id` REQUIRED and no `organization_id` — shape
 * `application_only`, the counterpart to `staff_audit_events`'s nullable one.
 */
export const reviewerRelations = pgTable(
  'reviewer_relations',
  {
    reviewerRelationId: text('reviewer_relation_id').primaryKey(),

    reviewerId: text('reviewer_id').notNull(),
    applicationId: text('application_id').notNull(),
    /** The application's own id for the other person. Never an Oxy user id. */
    externalPrincipalId: text('external_principal_id').notNull(),
    source: text('source').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Declaring the same conflict twice is one relation, not two. */
    uniqueIndex('reviewer_relations_reviewer_application_principal_key').on(
      table.reviewerId,
      table.applicationId,
      table.externalPrincipalId,
    ),
    /** The draw's question: which candidates know anyone in this case? */
    index('reviewer_relations_application_id_external_principal_id_idx').on(
      table.applicationId,
      table.externalPrincipalId,
    ),

    /**
     * The port's replacement for Mongoose's `enum: REVIEWER_RELATION_SOURCES`.
     *
     * Two members, and the narrowness is the point: `source` is what a later
     * reader uses to tell a conflict the reviewer DECLARED from one inferred
     * from a recusal, and §8.7 forbids penalising a recusal. A third value
     * arriving unchallenged — say from the Oxy relationship read this collection's
     * header anticipates — would be indistinguishable from either, and the
     * distinction is what stops a recusal being read as a penalty.
     *
     * Which is also why this CHECK is the right shape for it rather than an
     * over-reach: when that third source does arrive, adding it is a change to
     * the tuple above PLUS a migration in the same PR, which is exactly the
     * review this deserves.
     */
    check(
      'reviewer_relations_source_check',
      sql`${table.source} in (${sql.raw(inList(REVIEWER_RELATION_SOURCES))})`,
    ),
  ],
);

/**
 * How often two reviewers have served together (§8.3's panel diversity cap).
 *
 * No tenant column of any kind: co-service is a property of a PAIR of people
 * across every panel they have sat on, and panels span tenants.
 */
export const reviewerAffinities = pgTable(
  'reviewer_affinities',
  {
    /** `${lower}:${higher}` — sorted, so the pair has exactly one row. */
    pairKey: text('pair_key').primaryKey(),

    reviewerIdA: text('reviewer_id_a').notNull(),
    reviewerIdB: text('reviewer_id_b').notNull(),
    coServedCount: integer('co_served_count').notNull(),

    lastServedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Both directions, because the draw asks "who has this selected reviewer
     * served with too often" and the answer must be found whichever side of the
     * pair they are on. The sorted `pair_key` gives ONE row per pair; it does not
     * make either member findable, which is what these two are for.
     */
    index('reviewer_affinities_reviewer_id_a_co_served_count_idx').on(
      table.reviewerIdA,
      table.coServedCount,
    ),
    index('reviewer_affinities_reviewer_id_b_co_served_count_idx').on(
      table.reviewerIdB,
      table.coServedCount,
    ),
  ],
);
