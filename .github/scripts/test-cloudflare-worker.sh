#!/usr/bin/env bash

set -euo pipefail

# Behaviour tests for cloudflare-worker.sh.
#
# One assertion, and it is the one the Pages helper this replaces existed for:
# an API fault must never be reported as "there is nothing to roll back to".
# A 404 and a 500 both mean "no deployment id came back", and conflating them
# disarms the rollback on every run after the first — silently, and precisely
# when the rollback is what protects production. It now disarms the
# first-certificate wait at the same time.
#
# Each case drives the script against a scripted Cloudflare and asserts both the
# exit status and the step output.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repository_root/.github/scripts/cloudflare-worker.sh"
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
  WORKER_NAME=test-worker \
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
  if grep -qvE '^GET ' "$case_dir/calls"; then
    fail "$name: issued a non-GET request against Cloudflare; this subcommand only reads" \
      "$(cat "$case_dir/calls")"
  fi
}

# --- capture-worker: the rollback-arming distinction ------------------------

case_dir="$(run_case worker-missing capture-worker \
  '404|{"success":false,"errors":[{"code":10007,"message":"workers.api.error.script_not_found"}]}')"
if expect_exit "$case_dir" 0 "first run, Worker does not exist"; then
  expect_no_write "$case_dir" "first run, Worker does not exist"
  expect_output_contains "$case_dir" "has_previous=false" "first run, Worker does not exist"
  echo "ok: a never-deployed Worker is accepted once, with rollback disarmed explicitly"
fi

case_dir="$(run_case worker-present capture-worker \
  '200|{"success":true,"result":{"id":"test-worker"}}')"
if expect_exit "$case_dir" 0 "run N, Worker exists"; then
  expect_no_write "$case_dir" "run N, Worker exists"
  expect_output_contains "$case_dir" "has_previous=true" "run N, Worker exists"
  echo "ok: an existing Worker arms the rollback"
fi

# 403 is the one that matters most: a token whose Workers scope was narrowed
# answers exactly like a Worker that was never deployed, and reading it that way
# would disarm the rollback for the rest of the repository's life.
for failure_status in 500 403 401 429; do
  case_dir="$(run_case "capture-$failure_status" capture-worker \
    "${failure_status}|{\"success\":false,\"errors\":[{\"code\":1,\"message\":\"nope\"}]}")"
  if expect_exit "$case_dir" 1 "capture HTTP $failure_status"; then
    if grep -Fq "has_previous=false" "$case_dir/output"; then
      fail "capture HTTP $failure_status: reported 'nothing to roll back to' for an API fault"
    elif grep -Fq "has_previous=true" "$case_dir/output"; then
      fail "capture HTTP $failure_status: armed a rollback it could not confirm a target for"
    else
      echo "ok: HTTP $failure_status fails the release instead of guessing has_previous"
    fi
  fi
done

# --- usage ------------------------------------------------------------------

case_dir="$(run_case unknown-subcommand not-a-subcommand '')"
if expect_exit "$case_dir" 2 "unknown subcommand"; then
  echo "ok: an unknown subcommand exits 2 rather than silently doing nothing"
fi

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "cloudflare-worker.sh: $failures assertion(s) failed."
  exit 1
fi

echo
echo "cloudflare-worker.sh behaviour tests passed."
