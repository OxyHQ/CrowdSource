# Canonical organization identity

Oxy owns company identity and organization authority. CrowdSource stores a canonical
`oxy_account_id` on its existing tenant root. The tenant id, stable console handle,
applications, service credential hashes, RLS keys, moderation seats, decisions and
webhook history retain their meanings and identifiers. A console `owner` manages
this moderation workspace; it does not confer Oxy company ownership.

Company names are read from Oxy in deduplicated batches of at most 100. Missing or
suppressed identities have no display name; directory failure is a 503. Historical
names are never a serving fallback. Registration requires the original verified
human bearer, an active claimed organization, live owner/admin membership and the
`account:update` permission, including explicit revocations. Oxy membership alone
does not grant access to existing CrowdSource tenants.

## One-time cutover

The reviewed production inventory contained one tenant and one application, with
no service credentials. Tenant `org_d7139127ac384a1da3963564cb592549` owns the sole
application `app_61e5372b942a493c94904a7d697c942b`, bound to Oxy application
`6a2f851751b784a86fd0e916`. The independent Oxy inventory establishes that this
application's owner is organization `69b2d3df5d12f58c9800d651`. Review evidence:
CrowdSource inventory task `9bf215c7`; Oxy owner inventory task `b74bb8cf`.
Neither the company name nor the `oxy` console handle is identity evidence.

1. Deploy Oxy organization API and publish the reviewed shared SDK first. Adopt
   the published registry version and lockfile in this consumer before merging.
2. Run the standard deployment's pre migration as `crowdsource_migrator` with an
   explicit target database. `0018` freezes old identity writers, captures immutable
   source evidence and links only the exact tenant + sole application + binding
   tuple above. Reference-only inserts are valid during rollout. Creating an old
   company card is intentionally unavailable while the previous image drains.
3. Roll out the new image. Its runtime reads only canonical references. The known
   production tuple is mapped before rollout, so there is no unmapped live window.
4. After the old image drains, the standard post phase runs `0019`. Any unexpected
   unmapped row or source-evidence mismatch aborts before dropping `name`. Stop and
   review changed provenance; do not infer mappings by name or bypass the guard.
   An account deletion between pre and post also stops this guard for operator
   review; do not reconnect a deleted identity. No general legacy import or
   compatibility endpoint is shipped.

The pre archive is migration evidence only, protected against all row writes and
TRUNCATE. It is not a second company registry. Reference-only rows created by the
new image have no archived identity. The post migration removes the old runtime
column. Tenant and application reference counts are unchanged by both migrations;
populated replay tests preserve linked moderation decisions and test malformed
provenance. Rollback before post may require temporarily withholding old company
creation. After post, roll forward with the canonical model; do not restore an
image that queries the removed name column.

An `account.deleted` event uses the existing signature/audience-verified erasure
pipeline to clear the canonical reference and suspend its tenant. Console access,
service credentials and Oxy application tokens all reject suspended tenants.
Historical moderation records stay intact, and replay is idempotent. The database
refuses to reactivate a tenant without an identity or reassign its organization.

## First-party provisioning

The compiled `dist/scripts/bootstrapFirstParty.js` requires
`--oxy-organization-id`, in addition to application id/name. An operator's
`OXY_ADMIN_ACCESS_TOKEN` arrives through secret environment injection. The canonical
SDK checks both live organization administration and the application's exact
`ownerAccountId` before any write. It resolves the workspace by canonical account
id; the console handle is only a route key. No token is printed or persisted.
