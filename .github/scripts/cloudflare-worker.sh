#!/usr/bin/env bash

set -euo pipefail

# Cloudflare Worker release helper.
#
# What is left of the Pages helper this replaces. `ensure-project` is gone
# because `wrangler deploy` creates the Worker if it does not exist;
# `attach-domain` and `ensure-dns-record` are gone because
# `[[routes]] custom_domain = true` in each app's wrangler.toml claims the
# hostname and Cloudflare writes the record itself. That last removal is not an
# economy, it is a requirement: a Worker custom domain REFUSES a hostname that
# already has externally managed records (`code: 100117`), so a release that
# keeps writing the proxied CNAME by hand can never take the domain.
#
# Only the rollback-arming question survives, and it survives unchanged: has
# this Worker ever been deployed? Answering it wrong in the "no" direction
# disarms the rollback silently, on every run after the first, which is exactly
# when the rollback is the thing protecting production. So a transport,
# permission or outage fault is a hard failure here and never an answer.
#
# Endpoint used (Cloudflare API v4):
#   GET /accounts/{account}/workers/services/{service}
#
# NOT `/workers/scripts/{script}`, which this used first and which answers 204
# — neither 200 nor 404 — for a Worker that has no script of its own. That is
# not an edge case here: it is what BOTH of this repository's Workers are.
# `packages/reviewer/wrangler.toml` and `packages/console/wrangler.toml` declare
# `[assets]` with no `main`, so there is no script body to return and the
# endpoint has nothing to send. Measured across the fleet, same token, same
# call:
#
#   crowdsource-frontend   scripts/ 204   services/ 200   (assets only)
#   crowdsource-console    scripts/ 204   services/ 200   (assets only)
#   allo-frontend          scripts/ 204   services/ 200   (assets only)
#   homiio-frontend        scripts/ 204   services/ 200   (assets only)
#   noted                  scripts/ 200   services/ 200   (has main)
#   clarity                scripts/ 200   services/ 200   (has main)
#   <no such worker>       scripts/ 404   services/ 404
#
# The 204 fell into the "unknown state" branch below and failed the release of a
# Worker that plainly existed. `services/` answers 200 or 404 for every one of
# them, which is the question this is asking.
#
# The rollback itself is `wrangler rollback`, run from the workflow: wrangler
# already resolves the previous version, and reimplementing that against the
# versions API would be a second, untested copy of it.

command_name="${1:-}"

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${WORKER_NAME:?WORKER_NAME is required}"

CLOUDFLARE_API_BASE="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"

response_body="$(mktemp)"
trap 'rm -f -- "$response_body"' EXIT

# Prints the HTTP status on stdout and leaves the response in $response_body.
# Nothing here ever echoes the token, and no response body is printed whole —
# only named fields — so this repository being public cannot turn an unexpected
# API response into a leaked build log.
api() {
  local method="$1" path="$2"
  shift 2
  curl \
    --silent \
    --show-error \
    --max-time 30 \
    --retry 3 \
    --retry-delay 2 \
    --request "$method" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header 'Content-Type: application/json' \
    --output "$response_body" \
    --write-out '%{http_code}' \
    "$@" \
    "${CLOUDFLARE_API_BASE}${path}"
}

print_api_errors() {
  jq -r '.errors[]? | "  cloudflare error \(.code // "?"): \(.message // "unknown")"' \
    "$response_body" 2>/dev/null || true
}

write_output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

# MUST run before the deploy. Afterwards the Worker exists whatever the answer
# was, so a capture placed after it reports `true` on the very first release and
# arms a rollback with nothing to roll back to.
capture_worker() {
  local status
  status="$(api GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/services/${WORKER_NAME}")"

  if [[ "$status" == "200" ]]; then
    echo "Worker ${WORKER_NAME} already exists; this release has a rollback target."
    write_output has_previous true
    return 0
  fi

  # Legitimate exactly once, and only before a Worker has ever been deployed.
  # The API answered, and its answer was "no such script".
  if [[ "$status" == "404" ]]; then
    echo "::notice::Worker ${WORKER_NAME} does not exist yet; this release has no rollback target and its custom domain is being issued a certificate for the first time."
    write_output has_previous false
    return 0
  fi

  # Any other status is an unknown state — a revoked token, a permissions gap,
  # an outage. Reading it as "no previous deployment" would disarm the rollback
  # and skip the certificate wait at the same time.
  echo "::error::Could not determine whether Worker ${WORKER_NAME} exists (HTTP $status). Refusing to release without knowing whether a rollback target exists."
  print_api_errors
  exit 1
}

case "$command_name" in
  capture-worker) capture_worker ;;
  *)
    echo "usage: cloudflare-worker.sh <capture-worker>" >&2
    exit 2
    ;;
esac
