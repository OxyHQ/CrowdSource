import { and, desc, eq, sql } from 'drizzle-orm';

import { applicationCredentials, applications, organizations } from '../schema/tenancy';
import type { PgHandle } from '../withTenant';

/**
 * The three tables that DEFINE a tenant, as PostgreSQL repositories.
 *
 * EVERY function here takes a `PgHandle` first, and that is a convention the
 * whole repository layer keeps rather than a detail of this file. An unscoped
 * repository is called with the pool; a tenant-scoped one will be called with the
 * transaction `withTenant` provides. One signature shape means the scoped slice
 * introduces no new convention — it passes a different handle to the same kind of
 * function.
 *
 * `withTenant`'s own header states the cost of that choice and it is not repeated
 * here beyond the pointer: pool and transaction are one TYPE, so passing the pool
 * where a transaction belongs type-checks and runs on a different connection. The
 * type cannot catch it; only the call site can.
 *
 * NOTHING CALLS THIS IN PRODUCTION YET, and that is the reason
 * `tenancyRepositories.realdb.test.ts` exercises every exported function against a
 * real server. A repository that only type-checks is a set of statements whose
 * first execution is in production; the suite is what makes them statements that
 * have actually run.
 *
 * These three carry no row-security policy, and the suite reads them with NO
 * tenant parameters set on purpose — that is the empirical form of the
 * `defines_the_tenant` claim in `tableRegistry.ts`. A policy here would be
 * circular: the read is what produces the tenant the policy would filter by.
 */

/**
 * How many rows an UPDATE touched.
 *
 * Read off `RETURNING` rather than off the result's `count`, and never off
 * `rows.length` of a non-returning update — a drizzle/postgres.js UPDATE reports
 * `count` correctly while its `length` is 0 whether or not it applied, so the
 * obvious spelling reports "not applied" for every update that did apply. Using
 * `RETURNING` makes the count the number of rows in hand, which is unambiguous in
 * a way that does not depend on knowing that trap.
 *
 * MEASURED, because the Mongo semantics it replaces are not obviously the same:
 * the wrapper these ports return `modifiedCount`, and Postgres `rowCount` behaves
 * like `matchedCount`. Probed against a real mongod on 2026-08-10 —
 * `changed=1, unchangedSameValue=1, noMatch=0`. Mongoose's `timestamps: true`
 * stamps `updated_at` on every `updateOne`, so a matched row ALWAYS counts as
 * modified and the two are equivalent. No `status <> $new` predicate is needed,
 * and adding one would CHANGE behaviour rather than preserve it.
 *
 * One consequence worth carrying to the switch: `setOrganizationStatus` and
 * `setApplicationStatus` answer `not_found` with the message "No such
 * organization, or it already had that status". The second half of that sentence
 * is already false on Mongo — setting a status to the value it already holds
 * matches, counts as modified and succeeds. The port preserves the behaviour, not
 * the sentence.
 */
type UpdatedRowCount = number;

export interface NewOrganization {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
}

export async function insertOrganization(
  db: PgHandle,
  organization: NewOrganization,
): Promise<void> {
  await db.insert(organizations).values(organization);
}

export async function findOrganizationById(db: PgHandle, organizationId: string) {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.organizationId, organizationId))
    .limit(1);

  return row ?? null;
}

export async function updateOrganizationStatus(
  db: PgHandle,
  organizationId: string,
  status: string,
): Promise<UpdatedRowCount> {
  const rows = await db
    .update(organizations)
    .set({ status })
    .where(eq(organizations.organizationId, organizationId))
    .returning({ organizationId: organizations.organizationId });

  return rows.length;
}

export interface NewApplication {
  readonly applicationId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly status: string;
}

export async function insertApplication(
  db: PgHandle,
  application: NewApplication,
): Promise<void> {
  await db.insert(applications).values(application);
}

export async function findApplicationById(db: PgHandle, applicationId: string) {
  const [row] = await db
    .select()
    .from(applications)
    .where(eq(applications.applicationId, applicationId))
    .limit(1);

  return row ?? null;
}

export async function updateApplicationStatus(
  db: PgHandle,
  applicationId: string,
  status: string,
): Promise<UpdatedRowCount> {
  const rows = await db
    .update(applications)
    .set({ status })
    .where(eq(applications.applicationId, applicationId))
    .returning({ applicationId: applications.applicationId });

  return rows.length;
}

/** The console's per-organization application list — newest first, bounded. */
export async function listApplicationsByOrganization(
  db: PgHandle,
  organizationId: string,
  limit = 200,
) {
  return await db
    .select()
    .from(applications)
    .where(eq(applications.organizationId, organizationId))
    .orderBy(desc(applications.createdAt))
    .limit(limit);
}

export async function countApplicationsByOrganization(
  db: PgHandle,
  organizationId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(applications)
    .where(eq(applications.organizationId, organizationId));

  // `::int` in the query rather than `Number(...)` at the boundary: postgres.js
  // decodes a bigint as a STRING, so an uncast `count(*)` arrives as `'3'` and
  // arithmetic on it silently concatenates. The cast is the fix at the source.
  return row?.total ?? 0;
}

export interface NewApplicationCredential {
  readonly credentialId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly status: string;
  readonly expiresAt: Date | null;
}

export async function insertApplicationCredential(
  db: PgHandle,
  credential: NewApplicationCredential,
): Promise<void> {
  await db.insert(applicationCredentials).values({
    ...credential,
    scopes: [...credential.scopes],
  });
}

/**
 * The authenticating read: by the credential's OWN id, with no tenant term.
 *
 * This single query is why `application_credentials` is `defines_the_tenant`. The
 * tenant is what the row RETURNS; a policy keyed on the runtime parameters could
 * never be satisfied here, because nothing has set them yet and nothing could.
 */
export async function findApplicationCredentialById(db: PgHandle, credentialId: string) {
  const [row] = await db
    .select()
    .from(applicationCredentials)
    .where(eq(applicationCredentials.credentialId, credentialId))
    .limit(1);

  return row ?? null;
}

/**
 * Revoking is scoped by the full triple AND by `status = 'active'`.
 *
 * The status predicate is NOT the trap the `UpdatedRowCount` note describes. It is
 * carried over deliberately from the Mongo filter, where it distinguishes "no such
 * credential" from "already revoked" — both of which must answer `not_found`, and
 * neither of which may re-stamp `revoked_at` over the original revocation instant.
 */
export async function revokeApplicationCredential(
  db: PgHandle,
  owner: { readonly organizationId: string; readonly applicationId: string },
  credentialId: string,
  revokedAt: Date,
): Promise<UpdatedRowCount> {
  const rows = await db
    .update(applicationCredentials)
    .set({ status: 'revoked', revokedAt })
    .where(
      and(
        eq(applicationCredentials.credentialId, credentialId),
        eq(applicationCredentials.organizationId, owner.organizationId),
        eq(applicationCredentials.applicationId, owner.applicationId),
        eq(applicationCredentials.status, 'active'),
      ),
    )
    .returning({ credentialId: applicationCredentials.credentialId });

  return rows.length;
}

/**
 * Credential METADATA for one application — never a secret.
 *
 * The select list NAMES its columns and `secret_hash` is not among them, which is
 * the point rather than an optimisation: §13.4 makes a service secret visible
 * exactly once, and a console that could re-serve even the digest would hand every
 * `admin` seat an offline target. A `select()` here would return it and a
 * serializer would eventually forward it; naming the columns means the type has no
 * `secretHash` for anything downstream to reach for.
 */
export interface CredentialSummaryRow {
  readonly credentialId: string;
  readonly scopes: string[];
  readonly status: string;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export async function listCredentialSummaries(
  db: PgHandle,
  owner: { readonly organizationId: string; readonly applicationId: string },
  limit = 100,
): Promise<CredentialSummaryRow[]> {
  return await db
    .select({
      credentialId: applicationCredentials.credentialId,
      scopes: applicationCredentials.scopes,
      status: applicationCredentials.status,
      expiresAt: applicationCredentials.expiresAt,
      revokedAt: applicationCredentials.revokedAt,
      createdAt: applicationCredentials.createdAt,
    })
    .from(applicationCredentials)
    .where(
      and(
        eq(applicationCredentials.organizationId, owner.organizationId),
        eq(applicationCredentials.applicationId, owner.applicationId),
      ),
    )
    .orderBy(desc(applicationCredentials.createdAt))
    .limit(limit);
}
