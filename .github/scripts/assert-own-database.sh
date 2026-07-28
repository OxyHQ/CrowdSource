#!/usr/bin/env bash

set -euo pipefail

# CrowdSource shares one MongoDB instance with every other Oxy backend, and the
# database a release touches is NOT determined by its connection string:
# packages/backend/src/utils/database.ts passes `dbName` to mongoose.connect,
# and the driver applies it over the database named in MONGODB_URI
# (`const db = dbName != null ? client.db(dbName) : client.db()`). That value
# comes from packages/backend/src/config/databaseIdentity.ts, so source — not
# configuration — decides the target, and source is what this guard reads.
#
# A wrong value there does not fail to connect. It silently reads and writes
# another product's live data, which is why this runs BEFORE any AWS credential
# is issued rather than after a rollout has started.
#
# DATABASE_IDENTITY_SOURCE_FILE exists so the guard can be exercised against
# fixtures (see test-assert-own-database.sh). Nothing in the deploy workflow sets
# it, so a release is always checked against the real declaration.
source_file="${DATABASE_IDENTITY_SOURCE_FILE:-packages/backend/src/config/databaseIdentity.ts}"
expected_database_name='crowdsource'

if [[ ! -f "$source_file" ]]; then
  echo "::error::$source_file is missing; cannot determine which database this release would write to."
  exit 1
fi

database_name="$(sed -n "s/^const DATABASE_NAME = '\([^']*\)';$/\1/p" "$source_file")"

# An unreadable declaration must fail rather than pass: a guard that cannot
# observe the value it protects is worse than no guard at all.
if [[ -z "$database_name" ]]; then
  echo "::error::Could not read the DATABASE_NAME declaration from $source_file, so the database this release targets cannot be verified. Update this guard alongside that file."
  exit 1
fi

# More than one declaration means the value the runtime uses is ambiguous, and a
# single-match read would silently pick one of them.
declaration_count="$(grep -c "^const DATABASE_NAME = '" "$source_file")"
if [[ "$declaration_count" -ne 1 ]]; then
  echo "::error::$source_file declares DATABASE_NAME $declaration_count times; exactly one declaration is required for this guard to be meaningful."
  exit 1
fi

if [[ "$database_name" != "$expected_database_name" ]]; then
  echo "::error::$source_file sets DATABASE_NAME='$database_name', so this release would accept the '$database_name-<env>' database. Refusing to deploy until DATABASE_NAME is '$expected_database_name'."
  exit 1
fi

echo "Release targets the '$database_name-<env>' database."
