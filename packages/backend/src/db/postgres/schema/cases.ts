import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * A moderation case: the unit a jury decides.
 *
 * The first tenant-owned table to be ported, chosen deliberately rather than for
 * convenience. It carries the composite tenant key and it is the jury's own
 * material, so if the boundary is ever wrong here the damage is one organization
 * reading another's cases. Proving the isolation machinery on this table means
 * every later table lands against a gate already demonstrated on the material
 * that matters.
 *
 * Column names are written out explicitly rather than left to drizzle's
 * derivation, which mangles a capital run — `caseS3Key` becomes `case_s_3_key`.
 * The exception is `@oxyhq/db`'s `timestamptz` family, which takes no name and
 * derives through the one shared `DATABASE_CASING` value, so the DDL and the
 * queries cannot disagree about it.
 */
export const cases = pgTable(
  'cases',
  {
    caseId: text('case_id').primaryKey(),

    /**
     * The tenant, as a PAIR. Neither column carries a foreign key: both name a
     * row in a table this service owns, but the pair is also the RLS predicate,
     * and the point of the migration is that the DATABASE decides visibility
     * rather than a join. They are `NOT NULL` because a row outside every tenant
     * would be invisible to the application role and immortal — no policy would
     * ever match it, so nothing could read or delete it.
     */
    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    /** The subject under moderation, in the reporting application's own id space. */
    subjectExternalId: text('subject_external_id').notNull(),

    status: text('status').notNull(),

    /**
     * No name argument, unlike every column above it. `@oxyhq/db`'s `timestamptz`
     * takes none by design and derives `opened_at` through the one shared
     * `DATABASE_CASING`, which is what keeps the runtime's column reference and
     * the generated DDL from disagreeing.
     */
    openedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * ONE CASE PER SUBJECT — WHICH IS **NOT** §7.3's DEDUPLICATION RULE.
     *
     * ## Read this before writing the upsert
     *
     * This constraint is two columns. Mongo's is four:
     * `case.collection.ts:181` declares
     * `{applicationId, externalSubjectId, contentHash, policyVersion}` unique,
     * commented "§12.7's case dedup constraint, and the thing that actually
     * enforces §7.3. The four fields are the plan's, verbatim."
     *
     * **The difference is not a narrowing. It is a different rule, pointing the
     * other way.** `(application_id, subject_external_id)` says one case per
     * subject FOREVER. §7.3 deliberately opens a NEW case when the content hash
     * changes (the material was edited) or the policy version changes (it is being
     * judged under different rules) — so under Mongo a second report about edited
     * content is a second case, and under this constraint it is not.
     *
     * **Which way it breaks depends on how the switch spells the write, and both
     * ways are wrong.** An upsert keyed on these two columns silently MERGES an
     * edited-content report into the old case — `case.service.ts` documents that
     * the loser of the race merges, so nothing errors and nothing logs. A plain
     * insert instead COLLIDES on this unique. Neither is §7.3, neither names its
     * cause, and neither is what the previous version of this comment promised.
     *
     * ## Latent today, and this is the moment it is cheap
     *
     * `case.service.ts:157` still upserts on the four-field key against Mongo, and
     * `repositories/scoped/cases.ts` has a plain `insertCase` with no upsert path
     * at all — so nothing reaches this constraint yet. It becomes live the moment
     * the ingestion switch is written, which is why the decision is recorded here
     * rather than left to whoever writes it.
     *
     * ## The decision: four columns, restored before the switch
     *
     * `content_hash` and `policy_version` DO NOT EXIST as columns on this table —
     * it has 8 against the Mongoose model's 40 — so this is three columns plus an
     * upsert, not an index change, and it belongs to the `cases` slice rather than
     * to a schema tidy.
     *
     * The tempting alternative was rejected deliberately: `caseDedupKey` is a
     * sha256 of exactly those four inputs, already computed by
     * `attachReportToCase` and already stored in Mongo, so `unique(application_id,
     * case_dedup_key)` would be one column instead of three. It is not taken
     * because **Mongo has both and gives them different jobs** — the four-field
     * unique is the arbiter, and `{applicationId, caseDedupKey}` is NON-unique and
     * described as "for lookup and for future cross-application correlation".
     * Promoting a lookup key to arbiter is a design change, not a port, and it
     * makes every non-equality question ("which cases are on policy version N")
     * unanswerable without recomputation.
     *
     * The Mongo lookup index is NOT ported either, and that is measured rather
     * than assumed: `case_dedup_key` has **no reader anywhere** — it is written at
     * insert and returned to the caller, and nothing queries by it. An index
     * nobody reads is a guess at an access path.
     *
     * Scoped by APPLICATION, not by organization — one customer's staging and
     * production products must be able to report the same subject id
     * independently, exactly as two unrelated customers can. That part of the
     * original reasoning survives and applies to the four-column form too.
     */
    uniqueIndex('cases_application_subject_key').on(
      table.applicationId,
      table.subjectExternalId,
    ),

    /**
     * The tenant-first ordering matters: every application query is filtered by
     * the pair before anything else, and RLS adds that predicate to statements
     * that did not write it themselves, so an index that does not lead with the
     * tenant is one the planner cannot use for the common read.
     */
    index('cases_tenant_status_idx').on(
      table.organizationId,
      table.applicationId,
      table.status,
    ),
  ],
);
