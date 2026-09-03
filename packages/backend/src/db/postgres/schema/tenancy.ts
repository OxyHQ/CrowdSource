import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, inList, timestamptz, updatedAt } from '@oxyhq/db';

import {
  APPLICATION_STATUSES,
  CREDENTIAL_STATUSES,
  ORGANIZATION_STATUSES,
} from '../../../domain/closedValues';

/**
 * The three tables that DEFINE a tenant.
 *
 * Every other unscoped table is exempt for a reason about its reader or about
 * what the row means. These three are exempt for a reason about ORDER: reading
 * them is what produces a `TenantContext`, so a policy keyed on
 * `app.organization_id` / `app.application_id` could never be satisfied — the
 * runtime parameters are not set until after the read that would be filtered by
 * them. `credential.service.ts:106` is the clearest case, resolving a presented
 * credential with `findOne({ credentialId })` and no tenant term at all.
 *
 * They carry tenant COLUMNS regardless, and two of them carry both. That is the
 * trap the registry's `defines_the_tenant` kind exists to defuse: a table with
 * `organization_id` and `application_id` and no policy reads to an auditor as an
 * oversight, and "fixing" it here would leave the service unable to authenticate
 * anybody.
 *
 * Column names are written out explicitly rather than left to drizzle's
 * derivation, which mangles a capital run. The exception is `@oxyhq/db`'s
 * `timestamptz` family, which takes no name and derives through the one shared
 * `DATABASE_CASING`.
 */

export const organizations = pgTable(
  'organizations',
  {
    /**
     * The tenant root, and its own identity. There is no wider tenant to scope an
     * organization by, which is why this table carries `organization_id` and no
     * `application_id` — shape `organization_only` in the registry.
     */
    organizationId: text('organization_id').primaryKey(),

    name: text('name').notNull(),
    /** A human-readable console handle, unique across the deployment. */
    slug: text('slug').notNull(),
    status: text('status').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Unique so two organizations cannot present as one another to an operator.
     *
     * A FUNCTIONAL index on `lower(slug)`, not a plain unique on the column, and
     * the difference is load-bearing. The Mongoose path declared
     * `lowercase: true`, so that setter — not the index — is what made the
     * uniqueness case-insensitive. Drizzle has no setters, so porting the column
     * as plain `text` with a plain unique would let `Acme` and `acme` coexist
     * where Mongo folded them into one, silently widening the namespace
     * organizations are addressed by.
     *
     * A CHECK asserting the stored value is already lowercase was the other
     * candidate and is worse: it fails the backfill on any row a non-validating
     * path stored differently, where this just works.
     */
    uniqueIndex('organizations_slug_lower_key').on(sql`lower(${table.slug})`),
    check(
      'organizations_status_check',
      sql`${table.status} in (${sql.raw(inList(ORGANIZATION_STATUSES))})`,
    ),
  ],
);

export const applications = pgTable(
  'applications',
  {
    /** Its own identity, and the second half of every other table's tenant key. */
    applicationId: text('application_id').primaryKey(),

    /**
     * The owning organization. Not a tenant STAMP — this column is what makes the
     * pair resolvable in the first place, and `membership.service.ts` reads it off
     * the stored row precisely so a console caller cannot name a tenant.
     */
    organizationId: text('organization_id').notNull(),

    name: text('name').notNull(),
    status: text('status').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** "Which applications does this organization own" — the console's list. */
    index('applications_organization_id_idx').on(table.organizationId),
    check(
      'applications_status_check',
      sql`${table.status} in (${sql.raw(inList(APPLICATION_STATUSES))})`,
    ),
  ],
);

export const applicationCredentials = pgTable(
  'application_credentials',
  {
    /**
     * The public half of the service token, and the LOOKUP KEY.
     *
     * The primary key is the credential id and not the tenant pair, because the
     * authenticating read knows only this: a caller presents a credential and the
     * tenant is what the read returns.
     */
    credentialId: text('credential_id').primaryKey(),

    organizationId: text('organization_id').notNull(),
    applicationId: text('application_id').notNull(),

    /** SHA-256 of the secret half. See `credential.service.ts` for why not a KDF. */
    secretHash: text('secret_hash').notNull(),
    /** A scalar array nothing queries into; `text[]`, no index. */
    scopes: text('scopes').array().notNull(),
    status: text('status').notNull(),

    expiresAt: timestamptz(),
    revokedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Listing and revoking an application's credentials from the console. */
    index('application_credentials_application_id_idx').on(table.applicationId),
    index('application_credentials_organization_id_idx').on(table.organizationId),
    check(
      'application_credentials_status_check',
      sql`${table.status} in (${sql.raw(inList(CREDENTIAL_STATUSES))})`,
    ),
  ],
);
