#!/usr/bin/env bash

set -euo pipefail

# Every assertion runs against the API origin, which is the ECS service this
# deploy just rolled out. Other hosting surfaces converge on their own schedule,
# so asserting them here would make an unrelated surface able to roll the backend
# back.
#
# The service currently exposes health only. Each new module adds its assertion
# here as it ships; a smoke check that never grows is a check that stops meaning
# anything.
API_ORIGIN="${API_ORIGIN:-https://api.crowdsource.oxy.so}"
smoke_dir="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
smoke_dir="$(realpath "$smoke_dir")"

cleanup_smoke_dir() {
  if [[ "$smoke_dir" == "$temporary_root/"* && -d "$smoke_dir" ]]; then
    rm -rf -- "$smoke_dir"
  else
    echo "::warning::Refusing to remove unexpected smoke directory: $smoke_dir"
  fi
}
trap cleanup_smoke_dir EXIT

request() {
  local name="$1"
  shift
  curl \
    --silent \
    --show-error \
    --max-time 20 \
    --retry 4 \
    --retry-delay 2 \
    --retry-all-errors \
    --max-redirs 0 \
    --dump-header "$smoke_dir/$name.headers" \
    --output "$smoke_dir/$name.body" \
    --write-out '%{http_code}' \
    "$@"
}

expect_status() {
  local actual="$1"
  local expected="$2"
  local name="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "::error::$name returned HTTP $actual (expected $expected)."
    exit 1
  fi
}

expect_json_response() {
  local name="$1"
  if ! grep -Eiq '^content-type: *application/json' "$smoke_dir/$name.headers"; then
    echo "::error::$name did not return a JSON content type."
    exit 1
  fi
}

status="$(request readiness "$API_ORIGIN/health/ready")"
expect_status "$status" 200 "readiness"
expect_json_response readiness

status="$(request liveness "$API_ORIGIN/health/live")"
expect_status "$status" 200 "liveness"
expect_json_response liveness

# An unrouted path must produce the service's own structured error, not an HTML
# page from something in front of it. This is what proves the request reached
# this application.
status="$(request unrouted "$API_ORIGIN/__smoke_unrouted__")"
expect_status "$status" 404 "unrouted path"
expect_json_response unrouted
if ! grep -q '"not_found"' "$smoke_dir/unrouted.body"; then
  echo "::error::Unrouted path did not return the service's structured not_found error."
  exit 1
fi

echo "CrowdSource post-deploy smoke checks passed."
