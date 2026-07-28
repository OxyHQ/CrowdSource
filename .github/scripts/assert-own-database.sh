#!/usr/bin/env bash

set -euo pipefail

# packages/backend/src/utils/database.ts composes the Mongo database name as
# `${APP_NAME}-${NODE_ENV}` and hands it to mongoose.connect as `dbName`, which
# OVERRIDES the database component of the connection URI. No value of
# /oxy/crowdsource/MONGODB_URI can redirect it, and the deployment's migration
# one-shot (RUN_MIGRATIONS) runs through the same connect path
# (scripts/migrate.ts -> runMigrationTask -> connectToDatabase). While APP_NAME
# still carries the forked value, a release here would apply schema and data
# migrations to another product's live database.
source_file='packages/backend/src/utils/database.ts'
expected_app_name='crowdsource'

if [[ ! -f "$source_file" ]]; then
  echo "::error::$source_file is missing; cannot determine which database this release would write to."
  exit 1
fi

app_name="$(sed -n "s/^const APP_NAME = '\([^']*\)';$/\1/p" "$source_file")"

# An unreadable declaration must fail rather than pass: a guard that cannot
# observe the value it protects is worse than no guard at all.
if [[ -z "$app_name" ]]; then
  echo "::error::Could not read the APP_NAME declaration from $source_file, so the database this release targets cannot be verified. Update this guard alongside that file."
  exit 1
fi

if [[ "$app_name" != "$expected_app_name" ]]; then
  echo "::error::$source_file sets APP_NAME='$app_name', so this release would connect to the '$app_name-<env>' database and migrate it. Refusing to deploy until APP_NAME is '$expected_app_name'."
  exit 1
fi

echo "Release targets the '$app_name-<env>' database."
