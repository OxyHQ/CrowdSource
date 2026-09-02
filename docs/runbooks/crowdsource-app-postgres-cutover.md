# `@oxyhq/crowdsource-app` PostgreSQL cutover

This runbook is for an application moving from `@oxyhq/crowdsource-app` 0.6.x
to the PostgreSQL-only 0.7.x line. It does **not** cut over the CrowdSource ECS
service; that backend still has a separate MongoDB-to-PostgreSQL program.

The application owns its report model and any extra fields. CrowdSource cannot
infer those columns, primary keys or transformations, so this repository does
not provide a generic copier that could silently discard them. The application
team must provide the exporter/importer for its own schema, and both tools must
emit the manifest below.

## Non-negotiable preconditions

1. Pin the running application to `@oxyhq/crowdsource-app` 0.6.x while exporting.
2. Create a separately named PostgreSQL target. Never point the importer at a
   shared or existing application database by resemblance of its name.
3. Apply the adopter's Drizzle migrations, including the report table and the
   three `moderation_*` tables.
4. Prove every target table named in the manifest contains zero rows. The
   importer must fail before its first write if any count is non-zero.
5. Freeze writes or use an application-owned change-capture procedure. A dump
   taken while writes continue is not a cutover snapshot.

No step deletes the source. Keep it read-only until the PostgreSQL release has
been observed and rollback is no longer required.

## Canonical export

Export one newline-delimited canonical JSON stream per dataset:

- the application's report collection, with its exact existing primary key and
  every application-owned extra field;
- moderation outbox rows;
- inbound webhook event rows;
- enforcement rows.

Encode BSON values explicitly before canonicalisation: ObjectId as its exact
24-character lowercase hexadecimal string, dates as UTC ISO-8601 strings, binary
as base64 with an explicit type tag, and absent fields as absent rather than
`null`. Sort rows by their exact source primary key, sort object keys
recursively, terminate every record with `\n`, then compute SHA-256 over the
resulting bytes. The importer must preserve those public/idempotency IDs exactly;
it must not regenerate them.

## Evidence manifest

The exporter writes a JSON manifest with this shape. Values shown here are type
descriptions, not deployment identifiers:

```json
{
  "format": "crowdsource-app-cutover/v1",
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
      "name": "application-owned stable dataset name",
      "sourceCount": 0,
      "sourceSha256": "sha256:<64 lowercase hex>",
      "targetCount": 0,
      "targetSha256": "sha256:<64 lowercase hex>"
    }
  ]
}
```

Database fingerprints identify endpoints without recording a hostname,
credential or connection string. Derive them from a canonical, non-secret
operator-approved database identity. Source and target fingerprints must differ.

After import, re-export PostgreSQL into the same canonical row shape and fill the
target count/digest. `bun scripts/verify-cutover-manifest.mjs <manifest.json>`
fails unless writes were frozen, the target was empty, every dataset has equal
counts and hashes, timestamps are valid, and source/target identities differ.

## Cutover

1. Run the application-specific importer in one PostgreSQL transaction. Refuse
   unknown fields, duplicate IDs and an already-populated target.
2. Reconcile and validate the manifest.
3. Run the package's PostgreSQL tests and `store.ensureSchema()` against the
   target using a credential with only the application's normal privileges.
4. Deploy the application release that imports only
   `@oxyhq/crowdsource-app/postgres`.
5. Probe report creation, outbox claim/complete, signed webhook replay and one
   reversible enforcement path. Confirm the exact deployed artifact separately.
6. Keep the source intact for the approved rollback window. Data deletion is a
   separate, explicitly authorised operation.

## Fail closed

Stop before deployment if the exporter and target re-export disagree by one row
or one byte, if a target table was non-empty, if writes were not frozen, or if an
ID cannot be represented exactly. Do not repair a manifest by editing counts or
digests. Recreate the target and repeat from the preserved source.
