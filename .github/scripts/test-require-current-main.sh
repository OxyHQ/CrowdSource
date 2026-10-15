#!/usr/bin/env bash
# Fixture tests for require-current-main.sh. `gh` is a stub on PATH answering
# each endpoint from FAKE_* variables, so both the refusals and the releases
# that keep a commit from being stranded can be driven.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repository_root/.github/scripts/require-current-main.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

mkdir "$work/bin"
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"/actions/workflows/"*"/runs"*)
    [[ "${FAKE_FAIL_RUNS:-}" == 1 ]] && exit 1
    sha="$(grep -oE 'head_sha=[0-9a-f]{40}' <<<"$args" | cut -d= -f2)"
    if [[ " ${FAKE_CI_RUNS_FOR:-} " == *" $sha "* ]]; then
      echo '{"total_count":1,"workflow_runs":[{"status":"completed","conclusion":"success"}]}'
    elif [[ " ${FAKE_CI_LIVE_FOR:-} " == *" $sha "* ]]; then
      echo '{"total_count":1,"workflow_runs":[{"status":"queued","conclusion":null}]}'
    elif [[ " ${FAKE_CI_DEAD_FOR:-} " == *" $sha "* ]]; then
      echo '{"total_count":2,"workflow_runs":[{"status":"completed","conclusion":"failure"},{"status":"completed","conclusion":"cancelled"}]}'
    else
      echo '{"total_count":0,"workflow_runs":[]}'
    fi ;;
  *"/compare/"*)
    [[ "${FAKE_FAIL_COMPARE:-}" == 1 ]] && exit 1
    printf '%s\n' "$FAKE_COMPARE" ;;
  *"/git/ref/heads/main"*)
    [[ "${FAKE_FAIL_HEAD:-}" == 1 ]] && exit 1
    printf '%s\n' "$FAKE_HEAD" ;;
  *) echo "unexpected gh call: $args" >&2; exit 2 ;;
esac
STUB
chmod +x "$work/bin/gh"

# A real repository whose HEAD is the candidate, for the checkout check.
git -C "$work" init -q repo
git -C "$work/repo" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m candidate
sha="$(git -C "$work/repo" rev-parse HEAD)"
older=2222222222222222222222222222222222222222
newer=3333333333333333333333333333333333333333

failures=0
# run <expected exit> <expected output line or ''> <env...> -- <args...>
run() {
  local want_rc="$1" want_line="$2"
  shift 2
  local -a env=()
  while [[ "$1" != -- ]]; do
    env+=("$1")
    shift
  done
  shift
  local output="$work/output" rc=0
  : >"$output"
  (cd "$work/repo" && env PATH="$work/bin:$PATH" DEPLOY_SHA="$sha" GITHUB_REPOSITORY=OxyHQ/CrowdSource \
    GITHUB_OUTPUT="$output" GH_TOKEN=x "${env[@]}" bash "$script" "$@") >"$work/log" 2>&1 || rc=$?
  if [[ "$rc" != "$want_rc" ]] || { [[ -n "$want_line" ]] && ! grep -qxF "$want_line" "$output"; }; then
    echo "FAIL: $* (${env[*]}): exit $rc, output: $(tr '\n' ' ' <"$output")"
    sed 's/^/    /' "$work/log"
    failures=$((failures + 1))
  fi
}
ahead() { printf 'ahead\n%s\n' "$#"; printf '%s\n' "$@"; }

# main's head: release.
run 0 '' FAKE_HEAD="$sha" --
run 0 current=true FAKE_HEAD="$sha" -- --decide
# A newer commit has a live or successful CI run: hold (refuse, or skip).
run 1 '' FAKE_HEAD=$newer "FAKE_COMPARE=$(ahead $newer)" FAKE_CI_RUNS_FOR=$newer --
run 0 current=false FAKE_HEAD=$newer "FAKE_COMPARE=$(ahead $newer)" FAKE_CI_RUNS_FOR=$newer -- --decide
run 1 '' FAKE_HEAD=$newer "FAKE_COMPARE=$(ahead $older $newer)" FAKE_CI_LIVE_FOR=$older --
# The newer commits start no CI (auto-merge pushes) or theirs failed or was
# cancelled: release the newest CI-tested commit rather than strand it.
run 0 '' FAKE_HEAD=$newer "FAKE_COMPARE=$(ahead $older $newer)" --
run 0 current=true FAKE_HEAD=$newer "FAKE_COMPARE=$(ahead $older $newer)" -- --decide
run 0 current=true FAKE_HEAD=$newer "FAKE_COMPARE=$(ahead $older $newer)" "FAKE_CI_DEAD_FOR=$older $newer" -- --decide
# Anything that cannot prove the newer commits are CI-less: hold or fail.
run 1 '' FAKE_HEAD=$newer "FAKE_COMPARE=$(printf 'diverged\n1\n%s' $newer)" --
run 0 current=false FAKE_HEAD=$newer "FAKE_COMPARE=$(printf 'diverged\n1\n%s' $newer)" -- --decide
run 1 '' FAKE_HEAD=$newer "FAKE_COMPARE=$(printf 'ahead\n250\n%s' $newer)" --
run 1 '' FAKE_HEAD=$newer FAKE_FAIL_COMPARE=1 -- --decide
run 1 '' FAKE_HEAD=$newer "FAKE_COMPARE=$(ahead $newer)" FAKE_FAIL_RUNS=1 -- --decide
run 1 '' FAKE_FAIL_HEAD=1 -- --decide
# The checkout must be the candidate, and the candidate a full commit id.
run 1 '' FAKE_HEAD=$older DEPLOY_SHA=$older --
run 1 '' FAKE_HEAD="$sha" DEPLOY_SHA=main --
run 2 '' FAKE_HEAD="$sha" -- --sideways

if ((failures > 0)); then
  echo "test-require-current-main: $failures case(s) failed"
  exit 1
fi
echo "test-require-current-main: OK"
