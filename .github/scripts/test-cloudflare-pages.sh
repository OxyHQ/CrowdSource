#!/usr/bin/env bash

set -euo pipefail

# Behaviour tests for cloudflare-pages.sh.
#
# The assertion that matters most: an API fault must never be reported as "there
# is nothing to roll back to". Those two states produce the same empty
# deployment id, and conflating them disarms the rollback on every run after the
# first — silently, and precisely when the rollback is what protects production.
# Each case below drives the script against a scripted Cloudflare and asserts
# both the exit status and whether a write was attempted.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repository_root/.github/scripts/cloudflare-pages.sh"
work_root="$(mktemp -d)"
trap 'rm -rf -- "$work_root"' EXIT
failures=0

stub_bin="$work_root/bin"
mkdir -p "$stub_bin"
cat >"$stub_bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
method=GET
output=/dev/null
previous=""
for argument in "$@"; do
  case "$previous" in
    --request) method="$argument" ;;
    --output) output="$argument" ;;
  esac
  previous="$argument"
done
url="${!#}"
printf '%s %s\n' "$method" "$url" >>"$STUB_CALLS"
call_number=$(( $(cat "$STUB_COUNT") + 1 ))
printf '%s' "$call_number" >"$STUB_COUNT"
line="$(sed -n "${call_number}p" "$STUB_SCRIPT")"
if [[ -z "$line" ]]; then
  echo "stub curl: no scripted response for call ${call_number} ($method $url)" >&2
  exit 99
fi
printf '%s' "${line#*|}" >"$output"
printf '%s' "${line%%|*}"
STUB
chmod +x "$stub_bin/curl"

# Each case gets its own state so call counters never leak between them.
run_case() {
  local name="$1" subcommand="$2" script_body="$3"
  local case_dir="$work_root/$name"
  mkdir -p "$case_dir"
  printf '%s\n' "$script_body" >"$case_dir/script"
  : >"$case_dir/calls"
  printf '0' >"$case_dir/count"
  : >"$case_dir/output"

  set +e
  PATH="$stub_bin:$PATH" \
  STUB_SCRIPT="$case_dir/script" \
  STUB_CALLS="$case_dir/calls" \
  STUB_COUNT="$case_dir/count" \
  GITHUB_OUTPUT="$case_dir/output" \
  CLOUDFLARE_ACCOUNT_ID=test-account \
  CLOUDFLARE_API_TOKEN=test-token \
  PAGES_PROJECT_NAME=test-project \
  PAGES_PRODUCTION_BRANCH=main \
  PAGES_CUSTOM_DOMAIN=test.example \
  PAGES_DNS_ZONE=example \
    bash "$script" "$subcommand" >"$case_dir/stdout" 2>&1
  local status=$?
  set -e

  printf '%s' "$status" >"$case_dir/status"
  printf '%s' "$case_dir"
}

fail() {
  echo "FAIL: $1"
  shift
  [[ $# -gt 0 ]] && printf '  %s\n' "$@"
  failures=$((failures + 1))
}

expect_exit() {
  local case_dir="$1" expected="$2" name="$3"
  local actual
  actual="$(cat "$case_dir/status")"
  if [[ "$actual" != "$expected" ]]; then
    fail "$name: exited $actual, expected $expected" "$(cat "$case_dir/stdout")"
    return 1
  fi
}

expect_output_contains() {
  local case_dir="$1" expected="$2" name="$3"
  if ! grep -Fqx "$expected" "$case_dir/output"; then
    fail "$name: step output is missing '$expected'" "got: $(tr '\n' ' ' <"$case_dir/output")"
  fi
}

expect_no_write() {
  local case_dir="$1" name="$2"
  if grep -q '^POST ' "$case_dir/calls"; then
    fail "$name: issued a write against Cloudflare when it must not have" \
      "$(cat "$case_dir/calls")"
  fi
}

expect_write() {
  local case_dir="$1" name="$2"
  if ! grep -q '^POST ' "$case_dir/calls"; then
    fail "$name: did not issue the expected write" "$(cat "$case_dir/calls")"
  fi
}

# --- capture-production: the rollback-arming distinction --------------------

case_dir="$(run_case empty-production capture-production \
  '200|{"success":true,"result":[]}')"
if expect_exit "$case_dir" 0 "first run, no production deployment"; then
  expect_output_contains "$case_dir" "has_previous=false" "first run, no production deployment"
  expect_output_contains "$case_dir" "deployment_id=" "first run, no production deployment"
  echo "ok: an empty production history is accepted once, with rollback disarmed explicitly"
fi

case_dir="$(run_case existing-production capture-production \
  '200|{"success":true,"result":[{"id":"dep-123"}]}')"
if expect_exit "$case_dir" 0 "run N, production deployment present"; then
  expect_output_contains "$case_dir" "has_previous=true" "run N, production deployment present"
  expect_output_contains "$case_dir" "deployment_id=dep-123" "run N, production deployment present"
  echo "ok: an existing deployment arms the rollback"
fi

for failure_status in 500 403 404; do
  case_dir="$(run_case "capture-$failure_status" capture-production \
    "${failure_status}|{\"success\":false,\"errors\":[{\"code\":1,\"message\":\"nope\"}]}")"
  if expect_exit "$case_dir" 1 "capture HTTP $failure_status"; then
    if grep -Fq "has_previous=false" "$case_dir/output"; then
      fail "capture HTTP $failure_status: reported 'nothing to roll back to' for an API fault"
    else
      echo "ok: HTTP $failure_status fails the release instead of disarming rollback"
    fi
  fi
done

# --- ensure-project ---------------------------------------------------------

case_dir="$(run_case project-exists ensure-project \
  '200|{"success":true,"result":{"subdomain":"test-project.pages.dev"}}')"
if expect_exit "$case_dir" 0 "existing project"; then
  expect_no_write "$case_dir" "existing project"
  expect_output_contains "$case_dir" "production_origin=https://test-project.pages.dev" "existing project"
  echo "ok: an existing project is a read, and its real origin is read back"
fi

case_dir="$(run_case project-missing ensure-project \
  '404|{"success":false,"errors":[{"code":8000007,"message":"not found"}]}
200|{"success":true,"result":{"subdomain":"test-project-a1.pages.dev"}}')"
if expect_exit "$case_dir" 0 "missing project"; then
  expect_write "$case_dir" "missing project"
  expect_output_contains "$case_dir" "production_origin=https://test-project-a1.pages.dev" "missing project"
  echo "ok: a missing project is created, and a disambiguated origin is reported as given"
fi

case_dir="$(run_case project-unknown-state ensure-project \
  '500|{"success":false,"errors":[{"code":1,"message":"boom"}]}')"
if expect_exit "$case_dir" 1 "unknown project state"; then
  expect_no_write "$case_dir" "unknown project state"
  echo "ok: an unknown state refuses to create, so a credential fault cannot mint a second project"
fi

# --- attach-domain ----------------------------------------------------------

case_dir="$(run_case domain-present attach-domain \
  '200|{"success":true,"result":[{"name":"test.example","status":"active"}]}')"
if expect_exit "$case_dir" 0 "domain already attached"; then
  expect_no_write "$case_dir" "domain already attached"
  echo "ok: an attached domain is left alone"
fi

case_dir="$(run_case domain-absent attach-domain \
  '200|{"success":true,"result":[]}
200|{"success":true,"result":{"name":"test.example","status":"pending"}}')"
if expect_exit "$case_dir" 0 "domain absent"; then
  expect_write "$case_dir" "domain absent"
  echo "ok: an absent domain is attached, and a pending status does not fail the release"
fi

case_dir="$(run_case domain-race attach-domain \
  '200|{"success":true,"result":[]}
409|{"success":false,"errors":[{"code":1,"message":"exists"}]}
200|{"success":true,"result":[{"name":"test.example","status":"pending"}]}')"
if expect_exit "$case_dir" 0 "concurrent attach"; then
  echo "ok: a losing race re-reads and accepts the domain another run attached"
fi

case_dir="$(run_case domain-list-fails attach-domain \
  '403|{"success":false,"errors":[{"code":1,"message":"forbidden"}]}')"
if expect_exit "$case_dir" 1 "domain listing fails"; then
  expect_no_write "$case_dir" "domain listing fails"
  echo "ok: an unreadable domain list fails instead of blind-attaching"
fi

# The agent-side implementation resolves the CNAME target from the project
# itself, so every case starts by answering that read.
project='200|{"success":true,"result":{"subdomain":"test-project-a1.pages.dev"}}'
zone='200|{"success":true,"result":[{"id":"zone-1"}]}'

case_dir="$(run_case dns-absent ensure-dns-record \
  "$project
$zone
200|{\"success\":true,\"result\":[]}
200|{\"success\":true,\"result\":{\"id\":\"rec-1\"}}")"
if expect_exit "$case_dir" 0 "dns absent"; then
  expect_write "$case_dir" "dns absent"
  echo "ok: a missing DNS record is created"
fi

case_dir="$(run_case dns-present ensure-dns-record \
  "$project
$zone
200|{\"success\":true,\"result\":[{\"type\":\"CNAME\",\"content\":\"test-project-a1.pages.dev\",\"proxied\":true}]}")"
if expect_exit "$case_dir" 0 "dns already correct"; then
  expect_no_write "$case_dir" "dns already correct"
  echo "ok: a correct DNS record is left alone"
fi

# The case with real blast radius. This zone carries the ecosystem's production
# DNS, so a record pointing somewhere unexpected must stop the deploy rather
# than be overwritten.
case_dir="$(run_case dns-conflict ensure-dns-record \
  "$project
$zone
200|{\"success\":true,\"result\":[{\"type\":\"A\",\"content\":\"203.0.113.7\",\"proxied\":true}]}")"
if expect_exit "$case_dir" 1 "dns conflict"; then
  expect_no_write "$case_dir" "dns conflict"
  echo "ok: a record this deploy did not create is refused, not overwritten"
fi

case_dir="$(run_case dns-zone-unreadable ensure-dns-record \
  "$project
403|{\"success\":false,\"errors\":[{\"code\":1,\"message\":\"forbidden\"}]}")"
if expect_exit "$case_dir" 1 "zone unreadable"; then
  expect_no_write "$case_dir" "zone unreadable"
  echo "ok: an unreadable zone fails instead of guessing"
fi

case_dir="$(run_case dns-write-denied ensure-dns-record \
  "$project
$zone
200|{\"success\":true,\"result\":[]}
403|{\"success\":false,\"errors\":[{\"code\":1,\"message\":\"forbidden\"}]}
200|{\"success\":true,\"result\":[]}")"
if expect_exit "$case_dir" 1 "dns write denied"; then
  echo "ok: a token without DNS write fails loudly instead of silently skipping"
fi

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "$failures Cloudflare Pages helper check(s) failed."
  exit 1
fi

echo
echo "Cloudflare Pages helper tests passed."
