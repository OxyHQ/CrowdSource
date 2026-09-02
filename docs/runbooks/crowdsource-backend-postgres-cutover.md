# CrowdSource backend PostgreSQL cutover

This runbook moves the service-owned CrowdSource data from the legacy MongoDB
database into the PostgreSQL-only backend. It is a production procedure, not a
claim that the repository change already moved any live data.

No step deletes the source. Keep the frozen source intact until the observation
window and a separately authorised retirement change are complete.

## Preconditions

Stop before the maintenance window unless all of these are true:

1. The exact source deployment and database identity are recorded by an
   authorised operator. Do not choose either by a similar name.
2. PostgreSQL is separately named, empty, and provisioned with two roles:
   `crowdsource_migrator` owns the schema; `crowdsource_app` owns nothing and is
   subject to forced RLS. Neither connection string is written into the
   manifest.
3. The migration image and journal digest are pinned. The serving task never
   receives `MIGRATOR_DATABASE_URL`.
4. Every HTTP writer, dispatcher, webhook worker and assignment sweep can be
   stopped for one freeze. A dump taken while any writer continues is invalid.
5. The reviewed exporter, importer and PostgreSQL re-exporter implement
   `crowdsource-backend-domain/v1`. This repository deliberately does not guess
   production credentials or run those tools against a live database.

## Fixed dataset mapping

There are exactly 26 source collections and 27 target tables. The only one-to-two
mapping is `reviewer_profiles`: its embedded `principalLinks` array is normalized
into `reviewer_principal_links`. The executable authority is
`BACKEND_DATASETS` in `scripts/verify-backend-cutover-manifest.mjs`; missing,
extra, duplicated or renamed entries are a refusal.

The 26 source names are:

`appeals`, `app_trust_snapshots`, `application_credentials`, `applications`,
`assignments`, `audit_events`, `case_reports`, `cases`, `decisions`,
`organization_members`, `organizations`, `outbox_events`, `policy_sets`,
`reports`, `reviewer_affinities`, `reviewer_profiles`, `reviewer_relations`,
`reviews`, `sortition_draws`, `staff_audit_events`, `trust_safety_staff`,
`usage_counters`, `webhook_attempts`, `webhook_deliveries`,
`webhook_endpoints`, and `webhook_secrets`.

## Identity and canonical bytes

Export one newline-delimited canonical JSON stream per source collection. BSON
ObjectIds are exact 24-character lowercase hexadecimal strings; dates are UTC
ISO-8601 strings; binary values are base64 with an explicit type tag; absent
fields stay absent rather than becoming `null`. Sort object keys recursively,
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

The exporter starts a manifest with this shape; the importer and re-exporter
fill the target fields. Values below describe types, not real infrastructure:

```json
{
  "format": "crowdsource-backend-cutover/v1",
  "canonicalShape": "crowdsource-backend-domain/v1",
  "migrationJournalSha256": "sha256:<64 lowercase hex>",
  "source": {
    "capturedAt": "ISO-8601 UTC timestamp",
    "databaseFingerprint": "sha256:<64 lowercase hex>",
    "writesFrozen": true
  },
  "target": {
    "checkedAt": "ISO-8601 UTC timestamp",
    "databaseFingerprint": "sha256:<64 lowercase hex>",
    "emptyBeforeImport": true
  },
  "datasets": [
    {
      "name": "appeals",
      "sourceCollection": "appeals",
      "targetTables": ["appeals"],
      "sourceCount": 0,
      "sourceSha256": "sha256:<64 lowercase hex>",
      "sourceIdentitySha256": "sha256:<64 lowercase hex>",
      "targetCount": 0,
      "targetSha256": "sha256:<64 lowercase hex>",
      "targetIdentitySha256": "sha256:<64 lowercase hex>"
    }
  ]
}
```

Database fingerprints identify the operator-approved endpoints without storing
a hostname, username, credential or URL. Source and target fingerprints must
differ.

Run:

```bash
bun scripts/verify-backend-cutover-manifest.mjs ./backend-cutover-manifest.json
```

The command refuses anything except the exact 26-entry map, frozen source,
separately identified empty target, valid journal digest, equal counts, equal
content digests and equal identity digests.

## Freeze, migrate, import, reconcile

1. Scale the serving tasks and every writer/worker to zero using the approved
   maintenance procedure. Confirm no source write timestamp advances during a
   fixed observation interval. Record `writesFrozen: true` only after that
   evidence exists.
2. Export the canonical streams and source counts/digests. Keep the raw source
   export separately and read-only.
3. Apply all pinned backend migrations as `crowdsource_migrator`, with the exact
   target database guard. A dry run precedes apply. Never fall back to
   `DATABASE_URL`. For the first empty target, run `--phase=all` while every
   writer remains stopped: the journal's historical `0009` is `post`, while
   later schema additions are `pre`, and the high-water-mark ledger correctly
   refuses to skip `0009` during a plain `--phase=pre` run. This first cut cannot
   be introduced by the ordinary rolling-deploy sequence.
4. As the migrator role, prove every one of the 27 mapped target tables contains
   zero rows. RLS application-role counts are not proof: they can hide rows.
5. Import in one controlled transaction or in restartable batches whose manifest
   records each completed dataset. Refuse unknown fields, duplicate identities,
   a non-empty target and any value outside the PostgreSQL constraints. Never
   generate a replacement public, idempotency, membership or relation id.
6. Re-export PostgreSQL into the same 26 canonical source shapes. Reconcile the
   manifest. One row or one byte of disagreement is a failed cutover.
7. Connect as `crowdsource_app` and verify forced RLS/catalogue ownership,
   readiness, tenant isolation, report+outbox atomicity, outbox claims, sortition,
   webhook claims and the immutable-decision constraint.
8. Deploy the PostgreSQL-only image, then verify the exact task definition,
   image digest and live probes. Keep the source frozen and intact through the
   rollback window.

## Rollback and stop conditions

Before any PostgreSQL write after traffic resumes, rollback is: stop the new
tasks, restore the previous source-backed task definition, and unfreeze the
unchanged source. After PostgreSQL has accepted writes, rollback requires an
explicit reverse reconciliation plan; never point both runtimes at writable
stores and hope to merge them later.

Stop immediately if the source is not frozen, the target is not empty, a role is
wrong, a migration/journal digest differs, an ID cannot be represented exactly,
an unknown field appears, or any manifest count/digest differs. Recreate the
target and repeat from the preserved source; do not edit evidence to make it
pass.

Do not enable the normal deployment workflow for an uninitialised target. Its
`pre -> rollout -> post` sequence assumes the journal has already crossed the
older post migration; the initial target needs the frozen `all` procedure above.

## Current blocker

Repository runtime and tests can be PostgreSQL-only while production still holds
legacy data. This cutover is not complete until authorised operators provide the
reviewed three data tools, a maintenance window, separately verified credentials
and the resulting manifest. This PR performs none of those production actions.
