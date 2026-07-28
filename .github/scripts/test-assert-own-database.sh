#!/usr/bin/env bash

set -euo pipefail

# Mutation test for assert-own-database.sh.
#
# The guard's whole value is that it FAILS on the cases it exists to catch, and a
# guard nobody has broken on purpose is indistinguishable from one that always
# passes. Each case below breaks the declaration in a specific way and asserts
# the guard rejects it AND names the offending file.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$repository_root/.github/scripts/assert-own-database.sh"
real_source="$repository_root/packages/backend/src/config/databaseIdentity.ts"
fixture_root="$(mktemp -d)"
trap 'rm -rf -- "$fixture_root"' EXIT
failures=0

run_guard() {
  local fixture="$1"
  DATABASE_IDENTITY_SOURCE_FILE="$fixture" bash "$guard" 2>&1
}

expect_reject() {
  local case_name="$1"
  local fixture="$2"
  local output

  if output="$(run_guard "$fixture")"; then
    echo "FAIL: $case_name was accepted; the guard cannot distinguish it from a correct release."
    failures=$((failures + 1))
    return
  fi
  if [[ "$output" != *"$fixture"* ]]; then
    echo "FAIL: $case_name was rejected without naming $fixture:"
    echo "$output"
    failures=$((failures + 1))
    return
  fi
  echo "ok: $case_name rejected"
}

expect_accept() {
  local case_name="$1"
  local fixture="$2"
  local output

  if ! output="$(run_guard "$fixture")"; then
    echo "FAIL: $case_name was rejected:"
    echo "$output"
    failures=$((failures + 1))
    return
  fi
  echo "ok: $case_name accepted"
}

# The real declaration must pass, or every other assertion here is vacuous.
expect_accept "the repository's own declaration" "$real_source"

printf "const DATABASE_NAME = 'mention';\n" >"$fixture_root/another-product.ts"
expect_reject "another product's database" "$fixture_root/another-product.ts"

printf "const DATABASE_NAME = process.env.DB_NAME;\n" >"$fixture_root/not-a-literal.ts"
expect_reject "a declaration the guard cannot read" "$fixture_root/not-a-literal.ts"

printf "// the declaration was removed\n" >"$fixture_root/missing-declaration.ts"
expect_reject "a missing declaration" "$fixture_root/missing-declaration.ts"

printf "const DATABASE_NAME = 'crowdsource';\nconst DATABASE_NAME = 'mention';\n" \
  >"$fixture_root/two-declarations.ts"
expect_reject "two competing declarations" "$fixture_root/two-declarations.ts"

expect_reject "a missing file" "$fixture_root/does-not-exist.ts"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures assert-own-database.sh case(s) failed."
  exit 1
fi

echo "assert-own-database.sh mutation checks passed."
