#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
sha="${DEPLOY_SHA:-HEAD}"

case "$target" in
  backend | frontend) ;;
  *)
    echo "usage: deployment-scope.sh <backend|frontend>" >&2
    exit 2
    ;;
esac

git cat-file -e "${sha}^{commit}"

# A deployment is state, not a per-commit event. Compare the candidate against
# the revision this target last shipped, so a commit that only repairs CI still
# releases whatever an earlier failed run left undeployed. The marker is moved
# by record-deployment.sh, and only after the deploy job succeeds.
deployed_ref="refs/tags/deployed/$target"
if base="$(git rev-parse --verify --quiet "${deployed_ref}^{commit}")"; then
  echo "Comparing $sha against the last deployed $target revision $base"
  changed_output="$(git diff --name-only "$base".."$sha" | sort -u)"
else
  # A missing marker means one of two things, and they are not the same: an
  # earlier deploy dropped its tag, or this target has never deployed at all.
  # Scoping from a single commit answers the first and gets the second wrong —
  # a first release whose commit happens to touch another package is skipped,
  # and skipped silently, because "nothing to deploy" and "nothing deployed
  # yet" produce the same `deploy=false`. So the first release is forced.
  echo "::warning::$deployed_ref is missing; treating $target as never deployed and releasing unconditionally."
  printf 'deploy=true\n' >>"${GITHUB_OUTPUT:-/dev/null}"
  echo "target=$target deploy=true (first release)"
  exit 0
fi
mapfile -t changed_paths <<<"$changed_output"

deploy=false
for path in "${changed_paths[@]}"; do
  case "$target:$path" in
    backend:packages/backend/* | \
    backend:packages/contracts/* | \
    backend:.github/scripts/deploy-ecs-image.sh | \
    backend:.github/scripts/audit-runtime-image.sh | \
    backend:.github/scripts/require-current-main.sh | \
    backend:.github/scripts/smoke-crowdsource.sh | \
    backend:.github/scripts/assert-own-database.sh | \
    frontend:packages/reviewer/* | \
    frontend:packages/contracts/* | \
    frontend:.github/scripts/require-current-main.sh | \
    frontend:.github/scripts/smoke-frontend.sh | \
    frontend:.github/scripts/cloudflare-pages.sh | \
    frontend:.github/scripts/validate-frontend-static-output.mjs)
      deploy=true
      break
      ;;
    backend:package.json | backend:bun.lock | backend:bunfig.toml | backend:tsconfig.json | backend:.dockerignore | backend:patches/* | \
    frontend:package.json | frontend:bun.lock | frontend:bunfig.toml | frontend:tsconfig.json | frontend:patches/*)
      deploy=true
      break
      ;;
  esac
done

echo "target=$target deploy=$deploy"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "deploy=$deploy" >>"$GITHUB_OUTPUT"
fi
