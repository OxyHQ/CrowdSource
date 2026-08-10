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
     * Case deduplication, and the reason it is UNIQUE rather than a service-level
     * check: two reports about the same subject arriving together both read
     * nothing and both create a case, which is two cases and eventually two
     * penalties for one incident. The index is the arbiter, so the race has no
     * window.
     *
     * Scoped by APPLICATION, not by organization — one customer's staging and
     * production products must be able to report the same subject id
     * independently, exactly as two unrelated customers can.
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
