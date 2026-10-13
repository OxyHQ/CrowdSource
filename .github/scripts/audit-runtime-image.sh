#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
audit_module="$repository_root/.github/scripts/audit-runtime-image.mjs"
image_uri="${1:-${IMAGE_URI:-}}"

: "${EXPECTED_RUNTIME_ENTRY:?EXPECTED_RUNTIME_ENTRY is required}"
: "${EXPECTED_WORKSPACE_PACKAGES:?EXPECTED_WORKSPACE_PACKAGES is required}"
EXPECTED_RUNTIME_COMMANDS="${EXPECTED_RUNTIME_COMMANDS:-}"

# Two immutable forms, and nothing else. The deploy passes the registry digest
# it just pushed (`<registry>/<repo>@sha256:...`), which is pulled. CI's image
# smoke passes the image ID of a build it loaded and never pushed
# (`sha256:...`), which must already be in the local store: the same audit then
# runs on the same build inputs before a merge can reach the deploy.
if [[ "$image_uri" =~ ^sha256:[[:xdigit:]]{64}$ ]]; then
  image_source=local
elif [[ "$image_uri" =~ @sha256:[[:xdigit:]]{64}$ ]]; then
  image_source=registry
else
  echo "::error::Runtime image audit requires an immutable sha256 digest URI or a local sha256 image ID." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "::error::Docker is required to audit the final runtime image." >&2
  exit 1
fi

if [[ "$image_source" == registry ]]; then
  docker pull "$image_uri" >/dev/null
elif ! docker image inspect "$image_uri" >/dev/null 2>&1; then
  echo "::error::Local image $image_uri is not in the Docker image store." >&2
  exit 1
fi

configured_user="$(docker image inspect --format '{{.Config.User}}' "$image_uri")"
case "${configured_user,,}" in
  "" | 0 | 0:* | root | root:*)
    echo "::error::Final image is configured to run as root (${configured_user:-unset})." >&2
    exit 1
    ;;
esac

docker run \
  --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges=true \
  --env EXPECTED_RUNTIME_ENTRY \
  --env EXPECTED_WORKSPACE_PACKAGES \
  --env EXPECTED_RUNTIME_COMMANDS \
  --volume "$audit_module:/tmp/crowdsource-runtime-image-audit.mjs:ro" \
  --entrypoint bun \
  "$image_uri" \
  /tmp/crowdsource-runtime-image-audit.mjs

echo "Final runtime image passed non-root and dependency-boundary checks: $image_uri"
