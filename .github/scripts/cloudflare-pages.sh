#!/usr/bin/env bash

set -euo pipefail

# Cloudflare Pages bootstrap and release helpers.
#
# A push to a repository that has never deployed must publish the app without a
# manual setup step, so everything here is idempotent: run 1 and run N take the
# same path, and there is no bootstrap ritual anyone can forget or perform
# twice. `wrangler pages deploy` publishes assets INTO a project and cannot
# create one, which is why `ensure-project` exists at all.
#
# Endpoints used (Cloudflare API v4):
#   GET  /accounts/{account}/pages/projects/{project}
#   POST /accounts/{account}/pages/projects              {name, production_branch}
#   GET  /accounts/{account}/pages/projects/{project}/deployments?env=production
#   GET  /accounts/{account}/pages/projects/{project}/domains
#   POST /accounts/{account}/pages/projects/{project}/domains   {name}

command_name="${1:-}"

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${PAGES_PROJECT_NAME:?PAGES_PROJECT_NAME is required}"

CLOUDFLARE_API_BASE="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
projects_url="${CLOUDFLARE_API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects"

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
    "${projects_url}${path}"
}

print_api_errors() {
  jq -r '.errors[]? | "  cloudflare error \(.code // "?"): \(.message // "unknown")"' \
    "$response_body" 2>/dev/null || true
}

is_ok() {
  [[ "$1" == "200" || "$1" == "201" ]]
}

write_output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

report_production_origin() {
  local subdomain
  subdomain="$(jq -r '.result.subdomain // empty' "$response_body")"

  # `subdomain` is optional in the API and may not be populated in the immediate
  # create response, so re-read once before giving up.
  if [[ -z "$subdomain" ]]; then
    local status
    status="$(api GET "/${PAGES_PROJECT_NAME}")"
    if is_ok "$status"; then
      subdomain="$(jq -r '.result.subdomain // empty' "$response_body")"
    fi
  fi

  if [[ -z "$subdomain" ]]; then
    # Informational only: the release does not depend on this value, so a
    # missing one must not fail a deployment that is otherwise healthy.
    echo "::warning::Cloudflare did not report a production subdomain for ${PAGES_PROJECT_NAME}; read it from the dashboard if something needs the origin."
    return 0
  fi

  # Read back rather than assumed: Cloudflare disambiguates a taken project
  # name, so the origin is not necessarily <project>.pages.dev.
  echo "Pages production origin: https://${subdomain}"
  write_output production_origin "https://${subdomain}"
}

ensure_project() {
  : "${PAGES_PRODUCTION_BRANCH:?PAGES_PRODUCTION_BRANCH is required}"

  local status
  status="$(api GET "/${PAGES_PROJECT_NAME}")"

  if is_ok "$status"; then
    echo "Pages project ${PAGES_PROJECT_NAME} already exists."
    report_production_origin
    return 0
  fi

  # Only a definite "not found" may lead to a create. Any other status is an
  # unknown state — a revoked token, a permissions gap, an outage — and creating
  # a project from there would turn a credential fault into a second project.
  if [[ "$status" != "404" ]]; then
    echo "::error::Could not determine whether Pages project ${PAGES_PROJECT_NAME} exists (HTTP $status)."
    print_api_errors
    exit 1
  fi

  echo "Pages project ${PAGES_PROJECT_NAME} does not exist; creating it."
  status="$(api POST "" --data "$(jq -cn \
    --arg name "$PAGES_PROJECT_NAME" \
    --arg branch "$PAGES_PRODUCTION_BRANCH" \
    '{name: $name, production_branch: $branch}')")"

  if ! is_ok "$status"; then
    # A concurrent release may have created it between the GET and the POST.
    # Re-read rather than interpreting error codes, which are not a documented
    # contract for this case.
    local recheck
    recheck="$(api GET "/${PAGES_PROJECT_NAME}")"
    if ! is_ok "$recheck"; then
      echo "::error::Could not create Pages project ${PAGES_PROJECT_NAME} (HTTP $status)."
      print_api_errors
      exit 1
    fi
    echo "::warning::Create returned HTTP $status but ${PAGES_PROJECT_NAME} now exists; another run created it."
  else
    echo "::notice::Created Pages project ${PAGES_PROJECT_NAME} on production branch ${PAGES_PRODUCTION_BRANCH}."
  fi

  report_production_origin
}

capture_production() {
  local status
  status="$(api GET "/${PAGES_PROJECT_NAME}/deployments?env=production&per_page=1")"

  # The distinction this whole subcommand exists for: a transport, permission or
  # outage fault must never be read as "there is nothing to roll back to". That
  # reading would disarm the rollback silently, and it would do so on every run
  # after the first — exactly when a rollback is the thing protecting production.
  if ! is_ok "$status"; then
    echo "::error::Could not read the current production deployment (HTTP $status). Refusing to release without knowing whether a rollback target exists."
    print_api_errors
    exit 1
  fi

  local deployment_id
  deployment_id="$(jq -r '.result[0].id // empty' "$response_body")"

  if [[ -z "$deployment_id" ]]; then
    # Legitimate exactly once, and only for a project that has never had a
    # production deployment. The API answered, and its answer was "none".
    echo "::notice::No previous production deployment exists; this release has no rollback target."
    write_output has_previous false
    write_output deployment_id ""
    return 0
  fi

  echo "Current production deployment: ${deployment_id}"
  write_output has_previous true
  write_output deployment_id "$deployment_id"
}

domain_attached() {
  jq -e --arg name "$PAGES_CUSTOM_DOMAIN" \
    'any(.result[]?; .name == $name)' "$response_body" >/dev/null 2>&1
}

domain_status() {
  jq -r --arg name "$PAGES_CUSTOM_DOMAIN" \
    '[.result[]? | select(.name == $name) | .status][0] // "unknown"' \
    "$response_body" 2>/dev/null || echo unknown
}

attach_domain() {
  : "${PAGES_CUSTOM_DOMAIN:?PAGES_CUSTOM_DOMAIN is required}"

  local status
  status="$(api GET "/${PAGES_PROJECT_NAME}/domains")"
  if ! is_ok "$status"; then
    echo "::error::Could not list the custom domains of ${PAGES_PROJECT_NAME} (HTTP $status)."
    print_api_errors
    exit 1
  fi

  if domain_attached; then
    echo "Custom domain ${PAGES_CUSTOM_DOMAIN} is already attached (status: $(domain_status))."
    return 0
  fi

  echo "Attaching custom domain ${PAGES_CUSTOM_DOMAIN} to ${PAGES_PROJECT_NAME}."
  status="$(api POST "/${PAGES_PROJECT_NAME}/domains" --data "$(jq -cn \
    --arg name "$PAGES_CUSTOM_DOMAIN" '{name: $name}')")"

  if ! is_ok "$status"; then
    local recheck
    recheck="$(api GET "/${PAGES_PROJECT_NAME}/domains")"
    if is_ok "$recheck" && domain_attached; then
      echo "::warning::Attach returned HTTP $status but ${PAGES_CUSTOM_DOMAIN} is attached; treating as already configured."
      return 0
    fi
    echo "::error::Could not attach ${PAGES_CUSTOM_DOMAIN} to ${PAGES_PROJECT_NAME} (HTTP $status)."
    print_api_errors
    exit 1
  fi

  # Cloudflare provisions DNS and the certificate asynchronously, so a fresh
  # attachment reports `initializing`/`pending` for a while. That convergence is
  # not something a release can wait on or influence, and failing here would red
  # a deployment whose assets are already live and verified.
  echo "::notice::Attached ${PAGES_CUSTOM_DOMAIN} (status: $(domain_status)). DNS and certificate provisioning continue asynchronously."
}

case "$command_name" in
  ensure-project) ensure_project ;;
  capture-production) capture_production ;;
  attach-domain) attach_domain ;;
  *)
    echo "usage: cloudflare-pages.sh <ensure-project|capture-production|attach-domain>" >&2
    exit 2
    ;;
esac
