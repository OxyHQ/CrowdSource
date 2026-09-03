# CrowdSource backend PostgreSQL cutover

This runbook recovers the service-owned CrowdSource data from its sole surviving
final S3 archive and imports it into the PostgreSQL-only backend. The Mongo host
was retired; there is no live Mongo source and this procedure does not add a
Mongo runtime or fallback.

No step deletes or mutates the versioned S3 object. Keep the source bundle,
receipt and final manifest on the approved encrypted evidence volume through the
observation window and a separately authorised evidence-retention change.

## Preconditions

Stop before the maintenance window unless all of these are true:

1. The operator uses the exact source object, version and database pinned in
   `FINAL_BACKUP_RECOVERY_PROFILE`; none can be supplied by name, order or a
   command-line override. The fixed object is version
   `blYwlJUWMzs2QshDbwQ3JJbeMkmFcXBb`, database
   `crowdsource-production`, 3,728 bytes and SHA-256
   `4417e03de8c98d55637e4d5aac8462414c98f2b7191dd3309ab9af11bf25a994`.
2. PostgreSQL is separately named, empty, and provisioned with two roles:
   `crowdsource_migrator` owns the database and therefore reaches the `public`
   schema through PostgreSQL's `pg_database_owner` pseudo-role;
   `crowdsource_app` owns nothing, has an explicit `USAGE` grant on `public`,
   receives DML through the migrator's default privileges, and is subject to
   forced RLS. Do not add a redundant direct `CREATE`/`USAGE` schema grant to
   the migrator: it adds an ACL row without changing its effective authority.
   Neither connection string is written into the manifest.
3. The migration image and journal digest are pinned. The serving task never
   receives `MIGRATOR_DATABASE_URL`. Archive parsing uses only the pinned
   MongoDB 8.2.11 image digest from the recovery profile, matching the archive
   producer; a cross-version restore is not acceptable evidence.
4. The approved local Docker runner uses the default Unix-socket context and a
   MongoDB-compatible Linux kernel. Kernels 6.19 through 7.0.13 fail closed.
5. The reviewed exporter, importer and PostgreSQL re-exporter in
   `scripts/crowdsource-backend-cutover*.mjs` are built from the same fixed
   mapping and implement `crowdsource-backend-domain/v1`. A repository merge
   installs none of the required credentials and runs none of them.
6. The S3 VersionId, archive SHA-256, archive byte size, source fingerprint,
   target fingerprint, database names, recovery image digest, migration image
   digest and change id are written in the maintenance change by two operators
   before any import command runs.

## Fixed dataset mapping

There are exactly 26 source collections and 27 target tables. The only one-to-two
mapping is `reviewer_profiles`: its embedded `principalLinks` array is normalized
into `reviewer_principal_links`. The executable authority is
`BACKEND_DATASETS` in `scripts/crowdsource-backend-cutover-lib.mjs`; missing,
extra, duplicated or renamed entries are a refusal.

The 26 source names are:

`appeals`, `app_trust_snapshots`, `application_credentials`, `applications`,
`assignments`, `audit_events`, `case_reports`, `cases`, `decisions`,
`organization_members`, `organizations`, `outbox_events`, `policy_sets`,
`reports`, `reviewer_affinities`, `reviewer_profiles`, `reviewer_relations`,
`reviews`, `sortition_draws`, `staff_audit_events`, `trust_safety_staff`,
`usage_counters`, `webhook_attempts`, `webhook_deliveries`,
`webhook_endpoints`, and `webhook_secrets`.

`mongosh`, `mongorestore` and `mongod` run only inside the pinned, networkless
recovery container. They are not backend dependencies, are not in `bun.lock`,
are not copied into the runtime image and provide no rollback runtime. The
serving process remains PostgreSQL-only. Its image contains only the common
contract and PostgreSQL halves so the migrator one-shot can import and
re-export.

## Identity and canonical bytes

Export one newline-delimited canonical JSON stream per source collection. BSON
ObjectIds are exact 24-character lowercase hexadecimal strings; dates are UTC
ISO-8601 strings; binary values are base64 with an explicit type tag. A missing
Mongo property mapped to a nullable PostgreSQL column normalizes to SQL `NULL`
before hashing, because PostgreSQL has no separate absent-column state; explicit
null produces the same canonical value. Sort object keys recursively,
sort rows by the dataset's fixed identity projection, preserve array order unless
the domain declares the array a set, and terminate every record with `\n`.

The canonical shape contains the domain/public/idempotency identifiers used by
the running service. Do not regenerate any of them. Two legacy collections had
no domain id, so their Mongo document `_id` becomes the PostgreSQL key verbatim:

- `organization_members._id` -> `organization_members.membership_id`;
- `reviewer_relations._id` -> `reviewer_relations.reviewer_relation_id`.

Embedded reviewer principal links explicitly used `_id: false`. PostgreSQL
therefore uses the exact natural composite key `(reviewer_id, application_id,
external_principal_id)` and has no synthetic link id. A mapper that invents one
must be rejected.

For documents that already have a domain primary key, Mongo's storage-only
`_id` remains in the preserved source archive but is not substituted for the
domain key. The PostgreSQL re-exporter must reconstruct the same canonical
domain bytes, including merging `reviewer_principal_links` back into each
profile. Any unknown source field, duplicate identity, lossy date or unhandled
BSON type stops the export; it is never dropped silently.

For each stream record:

- SHA-256 of the complete canonical bytes;
- SHA-256 of the sorted identity projection only;
- exact record count.

## Manifest

The recovery tool writes an immutable `source-manifest.json`; the PostgreSQL
re-exporter writes a separate final manifest. The verifier accepts archive
`schemaVersion: 2` for the pinned final backup. It can still authenticate an
already-existing signed schema-v1 evidence bundle for audit, but this repository
contains no live-source connector or exporter. Both formats require the checkout's
calculated journal digest, a non-empty total, the fixed positional mapping and
real non-placeholder hashes. The abbreviated v2 source identity is:

```json
{
  "format": "crowdsource-backend-cutover/v1",
  "schemaVersion": 2,
  "canonicalShape": "crowdsource-backend-domain/v1",
  "migrationPhase": "all",
  "migrationJournalSha256": "calculated SHA-256",
  "source": {
    "evidenceKind": "verified_mongodump_archive",
    "databaseName": "crowdsource-production",
    "databaseFingerprint": "calculated SHA-256",
    "capturedAt": "2026-08-10T08:26:45.000Z",
    "sourceRetired": true,
    "archiveFile": "source.archive.gz",
    "archiveObjectUri": "exact pinned S3 URI",
    "archiveObjectVersionId": "exact pinned VersionId",
    "archiveSha256": "exact pinned SHA-256",
    "archiveBytes": 3728,
    "archiveCreatedByMongoVersion": "8.2.11",
    "archiveCensusFile": "archive-census.json",
    "archiveCensusSha256": "calculated SHA-256",
    "recoveryImage": "exact pinned image digest",
    "networkIsolatedRestore": true,
    "exactNamespaceCensus": true,
    "totalCount": 2
  },
  "target": {
    "databaseName": "operator-approved exact name",
    "databaseFingerprint": "calculated SHA-256",
    "checkedAt": "canonical UTC timestamp",
    "migratorRole": "crowdsource_migrator",
    "emptyBeforeImport": true,
    "isolationLevel": "serializable",
    "schemaAndOwnerVerified": true,
    "migrationLedgerVerified": true,
    "postgresCatalogSha256": "exact pinned canonical catalog SHA-256",
    "totalCount": "same positive safe integer",
    "importReceiptSha256": "calculated SHA-256"
  },
  "datasets": [
    {
      "name": "appeals",
      "sourceCollection": "appeals",
      "sourceFile": "source/appeals.ndjson",
      "targetTables": ["appeals"],
      "sourceCount": "safe integer",
      "sourceSha256": "calculated SHA-256",
      "sourceIdentitySha256": "calculated SHA-256",
      "targetCount": "same safe integer",
      "targetSha256": "same calculated SHA-256",
      "targetIdentitySha256": "same calculated SHA-256",
      "tables": [
        {
          "name": "appeals",
          "sourceCount": "safe integer",
          "sourceSha256": "calculated SHA-256",
          "sourceIdentitySha256": "calculated SHA-256",
          "targetCount": "same safe integer",
          "targetSha256": "same calculated SHA-256",
          "targetIdentitySha256": "same calculated SHA-256"
        }
      ]
    }
  ]
}
```

Database fingerprints identify the operator-approved endpoints without storing
a hostname, username, credential or URL. Source and target fingerprints must
differ.

Run:

```bash
bun scripts/verify-backend-cutover-manifest.mjs \
  "$FINAL_MANIFEST" "$CUTOVER_BUNDLE" "$IMPORT_RECEIPT"
```

The command refuses anything except the exact 26-entry/27-table map, the pinned
archive source (or a signed historical v1 source), separately identified empty
target, current journal digest, equal counts, equal content digests and equal
identity digests. For v2 it additionally requires exactly two
`reviewer_profiles` and zero rows in every other collection. A source with zero
rows across all 26 datasets is refused so a wrong empty endpoint cannot produce
a vacuous success.

Before reading or writing rows, the PostgreSQL importer hashes a canonical
catalog projection and compares it with the digest pinned in this checkout. The
projection covers every `crowdsource_*` role and membership, database/role
settings, database/schema ownership, and every non-system schema/object/ACL
regardless of owner; tables are always addressed as `public.<exact name>`;
column types, nullability, defaults, identity and collation; constraints and
indexes; `ENABLE` and `FORCE` RLS; policy roles, commands, `USING` and
`WITH CHECK`; database/schema/table/sequence/function/column/default grants;
inheritance; domain/enum/range/composite types with owners, ACLs, collations and
domain constraints; standalone collations, sequence parameters, aggregate
definitions; and any user-defined triggers/functions. PostgreSQL-owned
internal namespaces are excluded from this service-owned census. Locale names
normalize only the equivalent terminal UTF-8 spellings (`.utf8`, `.UTF8` and
`.UTF-8`); language, territory, provider and modifiers remain exact. The host's
libc/ICU release string is intentionally not portable catalog identity. Instead,
every run compares PostgreSQL's recorded database collation version with
`pg_database_collation_actual_version(...)` and refuses a mismatch, so an
unreindexed provider upgrade cannot pass merely because version strings are not
hashed. Explicit ACL rows remain exact: a redundant direct grant is drift and is
refused even when ownership already supplies the same effective privilege. It
then compares every Drizzle ledger hash and timestamp with the checked-in SQL
journal.
Any difference is a refusal, and the final manifest records the exact catalog
digest that passed.

## Canonical archive recovery

Run from the reviewed checkout with `umask 077`. Put the downloaded archive,
bundle and receipts on an approved encrypted evidence volume, never in the
repository. The AWS CLI uses the operator's audited `oxy` profile; the profile
name and VersionId are not secrets, and no access key is placed in an argument,
environment variable or log.

```bash
umask 077
set -euo pipefail
read -r -p 'Approved encrypted evidence directory: ' RECOVERY_ROOT
RECOVERY_ARCHIVE="$RECOVERY_ROOT/crowdsource-production.archive.gz"
CUTOVER_BUNDLE="$RECOVERY_ROOT/crowdsource-source-bundle"
test -d "$RECOVERY_ROOT"
test ! -e "$RECOVERY_ARCHIVE"
test ! -e "$CUTOVER_BUNDLE"

docker pull \
  'mongo@sha256:951c2ff9fc6bdb6cb89b1dfea4a0e8ae3ee4fb287c0bf579b2bba54c7803f75d'
aws s3api get-object \
  --bucket oxy-mongo-backups-usw2-237343248947 \
  --key final/2026-08-10-pre-drop/crowdsource-production.archive.gz \
  --version-id blYwlJUWMzs2QshDbwQ3JJbeMkmFcXBb \
  --profile oxy \
  --region us-west-2 \
  "$RECOVERY_ARCHIVE"
chmod 0400 "$RECOVERY_ARCHIVE"

bun scripts/crowdsource-backend-recover-archive.mjs \
  --archive="$RECOVERY_ARCHIVE" \
  --output="$CUTOVER_BUNDLE"
```

The entrypoint exposes only `--archive` and `--output`. Before starting a
parser, it checks the exact 3,728 bytes and SHA-256. It refuses database URL
environment variables, Docker endpoint overrides, non-local contexts, a mutable
image tag and incompatible kernels. The exact MongoDB 8.2.11 container has no
network, capabilities, writable root or persistent database volume; the archive
is piped on standard input, indexes are not replayed, and the container is
removed after extraction. The extractor then requires exactly one non-system
database, all 26 exact collection names in the fixed census, exactly two rows in
`reviewer_profiles`, zero rows elsewhere and no duplicate/missing domain
identity. The bundle re-hashes its included archive and census whenever it is
loaded. The pinned census proves the credential- and webhook-secret collections
are empty, and the tooling never adds a connection URL or cloud credential to
the bundle. It still contains two reviewer profiles and is sensitive evidence,
so retain its private modes and encrypted-volume boundary.

## Historical signed-bundle compatibility

The retired schema-v1 live-source exporter is not shipped or retained. An old
signed bundle may be verified as historical evidence, but it cannot be used to
reintroduce a Mongo connection path. The sole source-creation route is the
network-isolated, pinned archive recovery above.

## Migrate, import and reconcile

1. Create the schema-v2 source bundle through **Canonical archive recovery**
   above. Do not substitute the historical live exporter. Scale the serving
   task to zero and keep the deploy gate closed until every check below passes.
2. Apply all pinned backend migrations as `crowdsource_migrator`, with the exact
   target database guard. A dry run precedes apply. Never fall back to
   `DATABASE_URL`. For the first empty target, run `--phase=all` while every
   writer remains stopped: the journal's historical `0009` is `post`, while
   later schema additions are `pre`, and the high-water-mark ledger correctly
   refuses to skip `0009` during a plain `--phase=pre` run. This first cut cannot
   be introduced by the ordinary rolling-deploy sequence.

   The supported two-role provisioning in oxy-infra runbook 30 §2A is the exact
   ACL authority. On PostgreSQL 15+, a database owner is implicitly the member
   of `pg_database_owner` for that database, which owns `public`; therefore no
   direct schema grant to `crowdsource_migrator` is required. Verify both the
   effective privilege and absence of a redundant direct ACL before migrating:

   ```sql
   SELECT has_schema_privilege('crowdsource_migrator', 'public', 'CREATE, USAGE');
   -- expect: true

   SELECT privilege.privilege_type
     FROM pg_namespace namespace
     CROSS JOIN LATERAL aclexplode(
       COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
     ) privilege
     JOIN pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE namespace.nspname = 'public'
      AND grantee.rolname = 'crowdsource_migrator';
   -- expect: 0 rows; authority is inherited from ownership, not a direct ACL
   ```

   ```bash
   MIGRATOR_DATABASE_URL="$TARGET_MIGRATOR_URL" DRY_RUN=true \
     bun packages/backend/scripts/migrate.ts \
       --target-database="$TARGET_DATABASE" --phase=all

   MIGRATOR_DATABASE_URL="$TARGET_MIGRATOR_URL" \
     bun packages/backend/scripts/migrate.ts \
       --target-database="$TARGET_DATABASE" --phase=all
   ```

3. Import as the exact `crowdsource_migrator` role:

   ```bash
   printf '%s' "$TARGET_MIGRATOR_URL" | \
     bun scripts/crowdsource-backend-cutover.mjs import-postgres \
     --bundle="$CUTOVER_BUNDLE" \
     --receipt="$IMPORT_RECEIPT" \
     --target-database="$TARGET_DATABASE" \
     --expected-target-fingerprint="$TARGET_FINGERPRINT" \
     --phase=all
   ```

   The command proves the connected database, non-superuser/non-bypass role,
   database/table ownership, exact 27-table column census and complete migration
   ledger. Under an advisory lock and `SERIALIZABLE` transaction it takes
   `ACCESS EXCLUSIVE` locks, counts all 27 tables as the owner and refuses one
   row anywhere. It writes a `prepared` receipt after that check but before the
   first insert, imports all rows in the same transaction, re-exports and
   reconciles before commit, then seals the receipt as `committed`. A crash after
   commit can resume only with that matching receipt and byte-exact target; an
   exact completed retry is a no-op. Any other non-empty target is refused.
4. Re-export PostgreSQL in a separate repeatable-read, read-only transaction and
   write a new final manifest:

   ```bash
   printf '%s' "$TARGET_MIGRATOR_URL" | \
     bun scripts/crowdsource-backend-cutover.mjs reexport-postgres \
     --bundle="$CUTOVER_BUNDLE" \
     --receipt="$IMPORT_RECEIPT" \
     --output-manifest="$FINAL_MANIFEST" \
     --target-database="$TARGET_DATABASE" \
     --expected-target-fingerprint="$TARGET_FINGERPRINT" \
     --phase=all

   bun scripts/crowdsource-backend-cutover.mjs verify-manifest \
     --manifest="$FINAL_MANIFEST" \
     --bundle="$CUTOVER_BUNDLE" \
     --receipt="$IMPORT_RECEIPT"
   bun scripts/verify-backend-cutover-manifest.mjs \
     "$FINAL_MANIFEST" "$CUTOVER_BUNDLE" "$IMPORT_RECEIPT"
   ```

   Both independent verifier entrypoints must pass. They re-read the immutable
   source files, verify the pinned archive/census identity (or the freeze
   signature for a pre-existing historical v1 bundle), bind the source projection to the final
   manifest and bind the committed receipt's canonical bytes to its final
   digest. Record the final manifest and receipt digests in the maintenance
   change. One row, byte, identity, table binding or journal disagreement is a
   failed cutover.
5. Connect as `crowdsource_app` and verify forced RLS/catalogue ownership,
   readiness, tenant isolation, report+outbox atomicity, outbox claims, sortition,
   webhook claims and the immutable-decision constraint.
6. Only after the final manifest, committed receipt and application-role checks
   are accepted, set the exact GitHub repository variable
   `CROWDSOURCE_POSTGRES_CUTOVER_COMPLETE=true`. Its absence keeps the backend
   deploy job skipped even after a merge to `main`; do not use a similarly named
   variable or a truthy spelling. Restore the ECS service's intended
   `desired_count` through its reviewed infrastructure authority, then rerun the
   successful `main` CI workflow so the PostgreSQL-only image deploys. Verify
   the exact task definition, image digest, desired/running counts and live
   probes. Keep the archive bundle and audit evidence intact through the
   rollback window.

## Abort, rollback boundary and retirement

This repository has no Mongo runtime and this procedure does not add one. Before
traffic resumes, abort means leave CrowdSource parked at zero, discard/recreate
the failed PostgreSQL target, keep the immutable archive bundle intact and
correct the import under a new receipt. It does not mean deploying a hidden
legacy fallback. After PostgreSQL has accepted writes, rollback requires a
separately reviewed reverse data migration; never point two runtimes at writable
stores or restore an unreviewed source-backed image.

Stop immediately if the archive object/version/hash/size differs, its database
or 26-collection census differs, the target is not empty, a role is wrong, a
migration/journal digest differs, an ID cannot be represented exactly, an
unknown field appears, or any manifest count/digest differs. Recreate the target
and repeat from the preserved archive; do not edit evidence to make it pass.

Do not set `CROWDSOURCE_POSTGRES_CUTOVER_COMPLETE` for an uninitialised target.
The normal workflow's `pre -> rollout -> post` sequence assumes the journal has
already crossed the older post migration; the initial target needs the frozen
`all` procedure above. The deploy job's repository-variable condition is a
merge-time safety barrier, not evidence that the cutover happened.

The migration entrypoint's scoped `MIGRATOR_DATABASE_URL` assignment is the
only exception because the same entrypoint is used by the isolated ECS
migration task; it is not exported or inherited by any other process. Archive
recovery accepts no database URL at all. Immediately after the final receipt is
accepted, unset the unexported target variable and destroy the ephemeral
operator environment according to the evidence retention policy:

```bash
unset TARGET_MIGRATOR_URL
```

The live-source exporter and its source-only commands have been removed. The
source remains archived and read-only; deleting the connector does not delete
the evidence. Verify that no live-source path or driver returns:

```bash
test ! -e scripts/crowdsource-backend-export-mongo.mongosh.js
! rg -n "from ['\"](?:mongodb|mongoose)['\"]|require\(['\"](?:mongodb|mongoose)['\"]\)" \
  packages/backend scripts
! rg -n '"(?:mongodb|mongoose)"[[:space:]]*:' packages/backend/package.json
test ! -e /app/scripts/crowdsource-backend-export-mongo.mongosh.js
```

The last assertion is run inside the built runtime image. After the observation
window and separately authorised evidence handoff, remove the archive recovery
entrypoint/extractor and the remaining three cutover scripts from the Docker
image, their dedicated real-database CI entry and
`test:backend-cutover:realdb`. Keep the exact versioned archive, source bundle,
final manifest, receipt and their recorded SHA-256 values in the approved audit
store. The ordinary backend PostgreSQL-only gate remains permanently.

## Current blocker

The exact archive/version/hash/census and supported archive-to-bundle route are
verified, including an isolated same-version MongoDB 8.2.11 restore and local
PostgreSQL import/retry/re-export of the two real reviewer rows. No production
PostgreSQL action has occurred and the deploy gate therefore remains closed.
The remaining blockers are an authorised maintenance window, target migrator
credential, exact target identity, production migrations, production
import/re-export evidence, final manifest/receipt, application-role checks and
live post-cutover probes. Repository CI cannot manufacture or truthfully attest
those production facts.
