#!/usr/bin/env bash

set -euo pipefail

# Every assertion runs against the API origin, which is the ECS service this
# deploy just rolled out. The apex is a separate hosting surface and converges
# on its own schedule, so asserting it here would make an unrelated surface
# able to roll the backend back.
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
  if ! grep -Eiq '^content-type: *application/(activity\+json|ld\+json|json)' \
    "$smoke_dir/$name.headers"; then
    echo "::error::$name did not return a JSON/ActivityPub content type."
    exit 1
  fi
}

status="$(request readiness "$API_ORIGIN/health/ready")"
expect_status "$status" 200 "readiness"

status="$(request anonymous-feed "$API_ORIGIN/feed/mtn?descriptor=for_you&limit=1")"
expect_status "$status" 200 "anonymous feed"

# The ActivityPub routers mount unconditionally on /ap and resolve by username,
# so an unknown account is a 404 regardless of the configured federation domain.
status="$(request actor \
  --header 'Accept: application/activity+json' \
  "$API_ORIGIN/ap/users/__smoke_missing__")"
expect_status "$status" 404 "ActivityPub actor"
expect_json_response actor

status="$(request inbox \
  --request POST \
  --header 'Accept: application/activity+json' \
  --header 'Content-Type: application/activity+json' \
  --data '{}' \
  "$API_ORIGIN/ap/users/__smoke_missing__/inbox")"
expect_status "$status" 404 "ActivityPub inbox"
expect_json_response inbox

echo "CrowdSource post-deploy smoke checks passed."
