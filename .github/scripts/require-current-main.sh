#!/usr/bin/env bash
# Refuses a production release of DEPLOY_SHA when a newer main commit will
# release instead.
#
# Usage:
#   require-current-main.sh            refuse (exit 1) when held
#   require-current-main.sh --decide   write `current=true|false` to
#                                      GITHUB_OUTPUT and exit 0 when held, so a
#                                      scope job can skip rather than fail
#
# Until 2026-10 this refused whenever DEPLOY_SHA was not origin/main's exact
# head. That strands a CI-green commit whenever the commits after it never get a
# CI run of their own, or get one that releases nothing: a pull request merged
# by GitHub auto-merge on behalf of GITHUB_TOKEN (automerge-first-party.yml) is
# pushed by github-actions[bot] and starts no workflow at all, so its deploy
# never comes, and this commit was refused. Measured on OxyHQ/Alia on
# 2026-10-15: a CI-green commit held as stale behind such a merge, with nothing
# ever coming to carry it.
#
# So hold only when some commit after DEPLOY_SHA has a CI push run on main that
# is queued, in progress or succeeded: that run's release carries this commit,
# and only then could an older rollout land over a newer one. Otherwise
# DEPLOY_SHA is the newest CI-tested commit and is released. History that is not
# a plain descendant, or too long to list, still holds. An API failure fails.
#
# Env: DEPLOY_SHA, GITHUB_REPOSITORY, GH_TOKEN (actions: read), CI_WORKFLOW
# (default ci.yml). Tested by test-require-current-main.sh.

set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
CI_WORKFLOW="${CI_WORKFLOW:-ci.yml}"
mode="${1:-}"
case "$mode" in
  "" | --decide) ;;
  *)
    echo "usage: require-current-main.sh [--decide]" >&2
    exit 2
    ;;
esac

if [[ ! "$DEPLOY_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  echo "::error::DEPLOY_SHA must be a full lowercase Git commit ID."
  exit 1
fi

checked_out_sha="$(git rev-parse --verify 'HEAD^{commit}')"
if [[ "$checked_out_sha" != "$DEPLOY_SHA" ]]; then
  echo "::error::The checked-out commit does not match DEPLOY_SHA; refusing a production release."
  exit 1
fi

release() {
  echo "$1"
  if [[ "$mode" == --decide ]]; then
    printf 'current=true\n' >>"${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  fi
  exit 0
}
hold() {
  if [[ "$mode" == --decide ]]; then
    echo "::notice::$1"
    printf 'current=false\n' >>"${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
    exit 0
  fi
  echo "::error::Stale production release blocked: $1"
  exit 1
}

# No fallback: if main's head cannot be read, an older commit could roll out
# over a newer one, so this fails rather than guessing.
head="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')"
if [[ "$head" == "$DEPLOY_SHA" ]]; then
  release "Production candidate $DEPLOY_SHA is the current main head."
fi

compare="$(gh api "repos/$GITHUB_REPOSITORY/compare/$DEPLOY_SHA...$head" \
  --jq '.status, .total_commits, (.commits[].sha)')"
status="$(sed -n 1p <<<"$compare")"
total="$(sed -n 2p <<<"$compare")"
if [[ "$status" != ahead || ! "$total" =~ ^[0-9]+$ ]] || ((total >= 250)); then
  hold "main has moved past $DEPLOY_SHA (head is $head, history '$status'); not releasing an older commit."
fi
while IFS= read -r newer; do
  [[ -z "$newer" ]] && continue
  runs="$(gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/$CI_WORKFLOW/runs" \
    -f head_sha="$newer" -f event=push -f branch=main -F per_page=20 |
    jq '[.workflow_runs[] | select(.status != "completed" or .conclusion == "success")] | length')"
  if [[ ! "$runs" =~ ^[0-9]+$ ]] || ((runs > 0)); then
    hold "main has moved past $DEPLOY_SHA to $newer, whose CI run releases it."
  fi
done < <(sed -n '3,$p' <<<"$compare")
release "main has moved past $DEPLOY_SHA (head is $head), but no newer commit has a live or successful CI run; releasing $DEPLOY_SHA as the newest CI-tested commit."
