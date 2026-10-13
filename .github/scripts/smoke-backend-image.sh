#!/usr/bin/env bash
#
# CI's image smoke for the backend: the image a pull request would deploy,
# built from the reviewed inputs and never pushed, must pass the deploy's own
# runtime audit, keep its files out of the app user's reach, apply every
# migration from an empty database and boot to a ready health check.
#
#   smoke-backend-image.sh <local image ID (sha256:...)>
#
# PG_CONTAINER names the job's PostgreSQL service container (its superuser is
# crowdsource/crowdsource, as in docker-compose.postgres.yml), reachable on
# 127.0.0.1:${PG_PORT:-5432}. Every credential below is a throwaway for that
# container.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${1:?usage: smoke-backend-image.sh <local image ID>}"
: "${PG_CONTAINER:?PG_CONTAINER must name the PostgreSQL service container}"
pg_port="${PG_PORT:-5432}"
database=crowdsource
migrator_password=crowdsource_migrator_smoke
app_password=crowdsource_app_smoke
expected_user=appuser
expected_uid=1001
server=crowdsource-image-smoke

fail() {
  echo "::error::$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  if docker container inspect "$server" >/dev/null 2>&1; then
    if [[ $status -ne 0 ]]; then
      echo "--- backend container logs ---"
      docker logs "$server" 2>&1 | tail -n 200 || true
    fi
    docker rm -f "$server" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 1. The deploy's own runtime audit, with the expectations read from the
#    deploy step itself so the two cannot drift apart.
audit_env() {
  yq -e ".jobs.deploy.steps[] | select(.name == \"Audit final backend runtime image\") | .env.$1" \
    "$repository_root/.github/workflows/deploy-aws.yml"
}
EXPECTED_RUNTIME_ENTRY="$(audit_env EXPECTED_RUNTIME_ENTRY)"
EXPECTED_WORKSPACE_PACKAGES="$(audit_env EXPECTED_WORKSPACE_PACKAGES)"
export EXPECTED_RUNTIME_ENTRY EXPECTED_WORKSPACE_PACKAGES
bash "$repository_root/.github/scripts/audit-runtime-image.sh" "$image"

# 2. The configured user, then ownership, writability, devDependencies and
#    install scripts, checked from inside the image as that user.
configured_user="$(docker image inspect --format '{{.Config.User}}' "$image")"
[[ "$configured_user" == "$expected_user" ]] ||
  fail "The image is configured to run as '${configured_user}', expected '${expected_user}'."
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges=true \
  --env EXPECTED_UID="$expected_uid" \
  --volume "$repository_root/.github/scripts/audit-image-filesystem.mjs:/tmp/audit-image-filesystem.mjs:ro" \
  --entrypoint bun "$image" /tmp/audit-image-filesystem.mjs

# 3. An empty database provisioned the way production is: the migrator owns
#    the database and every table, the application role owns nothing and gets
#    row access through default privileges (as in postgresTestDatabase.ts).
docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U crowdsource -d postgres <<SQL
CREATE ROLE crowdsource_migrator LOGIN PASSWORD '${migrator_password}' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE crowdsource_app LOGIN PASSWORD '${app_password}' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE ${database} OWNER crowdsource_migrator;
\connect ${database}
GRANT USAGE ON SCHEMA public TO crowdsource_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crowdsource_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crowdsource_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crowdsource_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crowdsource_app;
SQL

# 4. The image's migration entrypoint, as the migration task runs it, with the
#    frozen `--phase=all` an empty target needs. Read-only root filesystem and
#    no capabilities, like the serving container below.
docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges=true \
  --env MIGRATOR_DATABASE_URL="postgres://crowdsource_migrator:${migrator_password}@127.0.0.1:${pg_port}/${database}" \
  "$image" bun packages/backend/dist/scripts/migrate.js --target-database="$database" --phase=all
table_count="$(docker exec "$PG_CONTAINER" psql -U crowdsource -d "$database" -Atc \
  "select count(*) from pg_tables where schemaname = 'public' and tableowner = 'crowdsource_migrator'")"
[[ "$table_count" =~ ^[0-9]+$ && "$table_count" -gt 0 ]] ||
  fail "The migrator applied no tables (found '${table_count}')."
echo "Migrations applied: ${table_count} tables owned by crowdsource_migrator."

# 5. Boot the image's own CMD as the application role, read-only and without
#    capabilities, and wait for readiness from outside and for Docker's
#    HEALTHCHECK (busybox wget inside the image) from inside.
docker run -d --name "$server" --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges=true \
  --env NODE_ENV=production \
  --env PORT=3000 \
  --env DATABASE_URL="postgres://crowdsource_app:${app_password}@127.0.0.1:${pg_port}/${database}" \
  "$image" >/dev/null

ready=''
for _ in $(seq 1 60); do
  if [[ "$(docker container inspect --format '{{.State.Running}}' "$server")" != true ]]; then
    fail "The backend container exited during boot."
  fi
  if ready="$(curl -fsS --max-time 2 http://127.0.0.1:3000/health/ready 2>/dev/null)"; then
    break
  fi
  ready=''
  sleep 1
done
[[ -n "$ready" ]] || fail "/health/ready did not answer 200 within 60 seconds."
[[ "$(jq -r .status <<<"$ready")" == ready ]] || fail "/health/ready answered ${ready}."
echo "/health/ready: ${ready}"

health=''
for _ in $(seq 1 30); do
  health="$(docker container inspect --format '{{.State.Health.Status}}' "$server")"
  [[ "$health" == healthy ]] && break
  [[ "$health" == unhealthy ]] && fail "Docker reports the container unhealthy."
  sleep 3
done
[[ "$health" == healthy ]] || fail "The image HEALTHCHECK did not pass within 90 seconds (status '${health}')."
echo "Docker HEALTHCHECK: ${health}"

process_user="$(docker exec "$server" cat /proc/1/status | awk '/^Uid:/ { print $2 }')"
[[ "$process_user" == "$expected_uid" ]] ||
  fail "The serving process runs as uid ${process_user}, expected ${expected_uid}."

echo "Backend image smoke passed: ${image}"
