import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * The console's own tables: who may operate a tenant, who may operate the
 * platform, and what the latter did.
 *
 * Three tables, three DIFFERENT exemption kinds, which is why they are worth
 * reading together:
 *
 *  - `organization_members` DEFINES a tenant. `membership.service.ts:83` reads
 *    `find({ oxyUserId, status: 'active' })` to discover which organizations a
 *    person belongs to, and that read is what yields the tenant a console session
 *    acts on. A policy would be circular.
 *  - `trust_safety_staff` has NO tenant dimension. Staff act across every tenant
 *    by definition (§4.3); the row grants authority rather than belonging to a
 *    customer, and it carries neither tenant column.
 *  - `staff_audit_events` NAMES a tenant without belonging to one. Its
 *    `application_id` is the application acted on — nullable, because most
 *    actions name none — and the row is the operator's act, not the customer's
 *    data.
 */

export const organizationMembers = pgTable(
  'organization_members',
  {
    /**
     * A surrogate key. The natural key is `(organization_id, oxy_user_id)`, which
     * is the unique below; a membership has no id of its own in Mongo, so one is
     * minted here rather than making the pair the primary key — every other table
     * in this schema is addressed by a single text id and a lone exception would
     * be a shape somebody has to notice.
     */
    membershipId: text('membership_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    /** The Oxy account. Never an application principal. */
    oxyUserId: text('oxy_user_id').notNull(),

    /** A scalar array nothing queries into. */
    roles: text('roles').array().notNull(),
    status: text('status').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** One membership per person per organization — the Mongo unique, ported. */
    uniqueIndex('organization_members_organization_id_oxy_user_id_key').on(
      table.organizationId,
      table.oxyUserId,
    ),
    /**
     * The read that establishes a console session's tenants: every organization
     * this person is an active member of. Leads on `oxy_user_id` because that is
     * the only term the caller's credential supplies.
     */
    index('organization_members_oxy_user_id_status_idx').on(table.oxyUserId, table.status),
  ],
);

export const trustSafetyStaff = pgTable(
  'trust_safety_staff',
  {
    /**
     * The Oxy account IS the identity here — one staff row per person, which was
     * a `unique: true` path in Mongo and is the primary key in Postgres.
     */
    oxyUserId: text('oxy_user_id').primaryKey(),

    roles: text('roles').array().notNull(),
    status: text('status').notNull(),

    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // No index beyond the primary key: every read is `findOne({ oxyUserId })` from
  // `consoleAuth.ts`, which the key already serves. An index on `status` would
  // answer a question nothing asks.
  () => [],
);

export const staffAuditEvents = pgTable(
  'staff_audit_events',
  {
    staffAuditId: text('staff_audit_id').primaryKey(),

    action: text('action').notNull(),
    actorOxyUserId: text('actor_oxy_user_id').notNull(),

    /**
     * The roles the operator held WHEN they acted, copied rather than joined.
     *
     * A trail that read the roster at query time would answer "what may they do
     * now", and the question during an investigation is "what were they entitled
     * to then" — which changes the moment a role is revoked, exactly when the
     * trail matters most.
     */
    roles: text('roles').array().notNull(),

    /**
     * The application acted on, when the action names one. Never a case or a
     * person, and NULLABLE — most staff actions name no application at all.
     *
     * This is the whole of the table's tenant dimension, which is why the
     * registry declares it `application_nullable` rather than `application_only`.
     * The distinction is not cosmetic: `reviewer_relations` carries the same
     * single column REQUIRED, so a shape check that stopped at presence could not
     * tell the two tables apart.
     */
    applicationId: text('application_id'),

    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** The investigator's question: what did this operator do, recently. */
    index('staff_audit_events_actor_oxy_user_id_occurred_at_idx').on(
      table.actorOxyUserId,
      table.occurredAt,
    ),
    /** And its mirror: who has been looking at this application. */
    index('staff_audit_events_application_id_occurred_at_idx').on(
      table.applicationId,
      table.occurredAt,
    ),
  ],
);
