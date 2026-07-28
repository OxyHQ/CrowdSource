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
#   GET  /zones?name={zone}
#   GET  /zones/{zone}/dns_records?name.exact={fqdn}
#   POST /zones/{zone}/dns_records   {type,name,content,proxied,ttl}
#
# Attaching a Pages custom domain is only half the operation: Cloudflare does
# not create the DNS record for it, so the attachment sits `pending` forever
# until one exists. `ensure-dns-record` closes that gap.

command_name="${1:-}"

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${PAGES_PROJECT_NAME:?PAGES_PROJECT_NAME is required}"

CLOUDFLARE_API_BASE="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
projects_path="/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects"

response_body="$(mktemp)"
trap 'rm -f -- "$response_body"' EXIT

# Prints the HTTP status on stdout and leaves the response in $response_body.
# Nothing here ever echoes the token, and no response body is printed whole —
# only named fields — so this repository being public cannot turn an unexpected
# API response into a leaked build log.
api_root() {
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

api() {
  local method="$1" path="$2"
  shift 2
  api_root "$method" "${projects_path}${path}" "$@"
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

ensure_dns_record() {
  : "${PAGES_CUSTOM_DOMAIN:?PAGES_CUSTOM_DOMAIN is required}"
  : "${PAGES_DNS_ZONE:?PAGES_DNS_ZONE is required}"

  # The CNAME target is read back from the project, never assumed: Cloudflare
  # disambiguates a taken project name, so the origin is not necessarily
  # <project>.pages.dev.
  local status
  status="$(api GET "/${PAGES_PROJECT_NAME}")"
  if ! is_ok "$status"; then
    echo "::error::Could not read ${PAGES_PROJECT_NAME} to resolve the DNS target (HTTP $status)."
    print_api_errors
    exit 1
  fi
  local target
  target="$(jq -r '.result.subdomain // empty' "$response_body")"
  if [[ -z "$target" ]]; then
    echo "::error::Cloudflare reported no production subdomain for ${PAGES_PROJECT_NAME}; refusing to guess a CNAME target."
    exit 1
  fi

  status="$(api_root GET "/zones?name=${PAGES_DNS_ZONE}")"
  if ! is_ok "$status"; then
    echo "::error::Could not list the ${PAGES_DNS_ZONE} zone (HTTP $status). The API token needs Zone:Read on that zone."
    print_api_errors
    exit 1
  fi
  local zone_id
  zone_id="$(jq -r '.result[0].id // empty' "$response_body")"
  if [[ -z "$zone_id" ]]; then
    echo "::error::Zone ${PAGES_DNS_ZONE} is not visible to this API token; cannot manage ${PAGES_CUSTOM_DOMAIN}."
    exit 1
  fi

  status="$(api_root GET "/zones/${zone_id}/dns_records?name.exact=${PAGES_CUSTOM_DOMAIN}")"
  if ! is_ok "$status"; then
    echo "::error::Could not read DNS records for ${PAGES_CUSTOM_DOMAIN} (HTTP $status)."
    print_api_errors
    exit 1
  fi

  local existing_count
  existing_count="$(jq '.result | length' "$response_body")"
  if [[ "$existing_count" != "0" ]]; then
    local existing_type existing_content existing_proxied
    existing_type="$(jq -r '.result[0].type // ""' "$response_body")"
    existing_content="$(jq -r '.result[0].content // ""' "$response_body")"
    existing_proxied="$(jq -r '.result[0].proxied // false' "$response_body")"

    # Trailing dots and case are presentation, not intent.
    local normalized_content="${existing_content%.}"
    if [[ "$existing_type" == "CNAME" ]] &&
       [[ "${normalized_content,,}" == "${target,,}" ]] &&
       [[ "$existing_proxied" == "true" ]]; then
      echo "DNS record ${PAGES_CUSTOM_DOMAIN} already points at ${target} (proxied)."
      return 0
    fi

    # This zone carries production DNS for the whole ecosystem. A record this
    # workflow did not create is somebody's deliberate configuration, and the
    # correct move is to stop and let a human look — never to overwrite.
    echo "::error::${PAGES_CUSTOM_DOMAIN} already has a DNS record this workflow did not create, and it does not match what is needed."
    echo "::error::found ${existing_count} record(s); first is type=${existing_type} content=${normalized_content} proxied=${existing_proxied}"
    echo "::error::expected type=CNAME content=${target} proxied=true. Refusing to modify or delete an existing record in ${PAGES_DNS_ZONE}; resolve it by hand."
    exit 1
  fi

  echo "Creating proxied CNAME ${PAGES_CUSTOM_DOMAIN} -> ${target} in ${PAGES_DNS_ZONE}."
  # ttl 1 is Cloudflare's "automatic", which is the only value a proxied record
  # accepts; `ttl` is a required field on create.
  status="$(api_root POST "/zones/${zone_id}/dns_records" --data "$(jq -cn \
    --arg name "$PAGES_CUSTOM_DOMAIN" \
    --arg content "$target" \
    '{type: "CNAME", name: $name, content: $content, proxied: true, ttl: 1}')")"

  if ! is_ok "$status"; then
    if [[ "$status" == "401" || "$status" == "403" ]]; then
      # Zone READ demonstrably works, so an auth failure here is specifically a
      # missing write scope. Saying so beats a generic failure nobody can act on.
      echo "::error::The API token cannot create DNS records in ${PAGES_DNS_ZONE} (HTTP $status). It needs Zone:DNS:Edit on that zone; Zone:Read alone is not enough."
    else
      echo "::error::Could not create the CNAME for ${PAGES_CUSTOM_DOMAIN} (HTTP $status)."
    fi
    print_api_errors
    exit 1
  fi

  echo "::notice::Created proxied CNAME ${PAGES_CUSTOM_DOMAIN} -> ${target}. The Pages custom domain validates once this record resolves."
}

case "$command_name" in
  ensure-project) ensure_project ;;
  capture-production) capture_production ;;
  attach-domain) attach_domain ;;
  ensure-dns-record) ensure_dns_record ;;
  *)
    echo "usage: cloudflare-pages.sh <ensure-project|capture-production|attach-domain|ensure-dns-record>" >&2
    exit 2
    ;;
esac
