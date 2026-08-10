#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* &&
        -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

export DEPLOY_TEST_LOG=""
export DEPLOY_TEST_EXPECT_METRICS_ARN=false
export DEPLOY_TEST_TASK_EXIT_CODE=0
export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN=false
export DEPLOY_TEST_SERVICE_DESIRED_COUNT=1
export DEPLOY_TEST_ROLLOUT_SCENARIO=healthy
# The revision the fake service runs, the latest ACTIVE revision of its family,
# and the revision a registration returns. Keeping them separate is what lets a
# case reproduce Terraform registering a revision the service never adopted.
export DEPLOY_TEST_RUNNING_REVISION=1
export DEPLOY_TEST_LATEST_REVISION=1
export DEPLOY_TEST_REGISTERED_REVISION=2
export DEPLOY_TEST_LATEST_STATUS=ACTIVE
export DEPLOY_TEST_LATEST_EXTRA_ENV=""
export DEPLOY_TEST_EXPECT_ADOPTED_ENV=""
export DEPLOY_TEST_RUNNING_TASK_DEFINITION=""

aws() {
  local family="crowdsource-test"
  local running_task_definition="arn:aws:ecs:test:task-definition/$family:$DEPLOY_TEST_RUNNING_REVISION"
  local registered_task_definition="arn:aws:ecs:test:task-definition/$family:$DEPLOY_TEST_REGISTERED_REVISION"
  if [[ -n "$DEPLOY_TEST_RUNNING_TASK_DEFINITION" ]]; then
    running_task_definition="$DEPLOY_TEST_RUNNING_TASK_DEFINITION"
  fi

  local service_json
  service_json="$(jq -n \
    --arg running "$running_task_definition" \
    --arg registered "$registered_task_definition" \
    --argjson desired "$DEPLOY_TEST_SERVICE_DESIRED_COUNT" \
    '{
      failures: [],
      services: [{
        status: "ACTIVE",
        taskDefinition: $running,
        desiredCount: $desired,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: ["subnet-test"],
            securityGroups: ["sg-test"]
          }
        },
        launchType: "FARGATE",
        deployments: [
          {
            taskDefinition: $registered,
            status: "PRIMARY",
            rolloutState: "COMPLETED",
            runningCount: 1,
            desiredCount: 1
          },
          {
            taskDefinition: $running,
            status: "PRIMARY",
            rolloutState: "COMPLETED",
            runningCount: 1,
            desiredCount: 1
          }
        ]
      }]
    }')"

  case "$1 $2" in
    "ecs describe-services")
      local describe_count_file="${DEPLOY_TEST_LOG}.describe-count"
      local describe_count=0
      if [[ -f "$describe_count_file" ]]; then
        describe_count="$(<"$describe_count_file")"
      fi
      describe_count=$((describe_count + 1))
      printf '%s\n' "$describe_count" >"$describe_count_file"
      if [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "transient-zero-deployment" &&
            "$describe_count" == "2" ]]; then
        service_json="$(jq --arg registered "$registered_task_definition" '
          .services[0].deployments |= map(
              if .taskDefinition == $registered
              then
                .rolloutState = "IN_PROGRESS"
                | .desiredCount = 0
                | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "zero-service-during-deploy" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq --arg registered "$registered_task_definition" '
          .services[0].desiredCount = 0
          | .services[0].deployments |= map(
              if .taskDefinition == $registered
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "completed-zero-deployment" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq --arg registered "$registered_task_definition" '
          .services[0].deployments |= map(
              if .taskDefinition == $registered
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      fi
      printf '%s\n' "$service_json"
      ;;
    "ecs describe-task-definition")
      local previous_argument=""
      local requested=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--task-definition" ]]; then
          requested="$argument"
          break
        fi
        previous_argument="$argument"
      done
      # Recorded separately from the mutating-call log so the existing expected
      # logs stay readable while a case can still assert which revisions a
      # release looked up.
      printf '%s\n' "$requested" >>"${DEPLOY_TEST_LOG}.lookups"

      local revision status extra_environment
      if [[ "$requested" == "$family" ]]; then
        # ECS resolves a bare family to its latest ACTIVE revision.
        revision="$DEPLOY_TEST_LATEST_REVISION"
        status="$DEPLOY_TEST_LATEST_STATUS"
        extra_environment="$DEPLOY_TEST_LATEST_EXTRA_ENV"
      elif [[ "$requested" == "$running_task_definition" ]]; then
        revision="$DEPLOY_TEST_RUNNING_REVISION"
        status=ACTIVE
        extra_environment=""
      elif [[ "$requested" == "crowdsource-test-migrate" ]]; then
        # The migration family, as oxy-infra registers it: the migrator's
        # credential and nothing else. `DEPLOY_TEST_MIGRATION_SECRET` lets a case
        # take it away and prove the release refuses rather than migrating as
        # whatever role the definition does carry.
        jq -n \
          --arg image "example.invalid/crowdsource-test:old" \
          --arg secret "${DEPLOY_TEST_MIGRATION_SECRET-MIGRATOR_DATABASE_URL}" \
          '{
            taskDefinitionArn: "arn:aws:ecs:test:task-definition/crowdsource-test-migrate:7",
            family: "crowdsource-test-migrate",
            revision: 7,
            status: "ACTIVE",
            registeredAt: "2026-07-29T12:00:00Z",
            registeredBy: "arn:aws:sts::123456789012:assumed-role/oxy-terraform/apply",
            networkMode: "awsvpc",
            requiresCompatibilities: ["FARGATE"],
            cpu: "256",
            memory: "512",
            containerDefinitions: [{
              name: "crowdsource-test",
              image: $image,
              essential: true,
              secrets: (
                if $secret == "" then []
                else [{
                  name: $secret,
                  valueFrom: "arn:aws:ssm:test:123456789012:parameter/oxy/crowdsource/MIGRATOR_DATABASE_URL"
                }]
                end
              ),
              logConfiguration: {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": "/ecs/crowdsource-test",
                  "awslogs-stream-prefix": "ecs"
                }
              }
            }]
          }'
        return 0
      else
        printf 'Mocked describe-task-definition received an unexpected revision: %s\n' \
          "$requested" >&2
        return 1
      fi

      jq -n \
        --arg family "$family" \
        --arg arn "arn:aws:ecs:test:task-definition/$family:$revision" \
        --argjson revision "$revision" \
        --arg status "$status" \
        --arg extraEnvironment "$extra_environment" \
        '{
          taskDefinitionArn: $arn,
          family: $family,
          revision: $revision,
          status: $status,
          registeredAt: "2026-07-29T12:00:00Z",
          registeredBy: "arn:aws:sts::123456789012:assumed-role/oxy-terraform/apply",
          networkMode: "awsvpc",
          requiresCompatibilities: ["FARGATE"],
          cpu: "256",
          memory: "512",
          containerDefinitions: [{
            name: "crowdsource-test",
            image: "example.invalid/crowdsource-test:old",
            essential: true,
            environment: (
              [{name: "PORT", value: "3000"}]
              + (
                if $extraEnvironment == "" then []
                else [{name: $extraEnvironment, value: "https://api.example.invalid"}]
                end
              )
            ),
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": "/ecs/crowdsource-test",
                "awslogs-stream-prefix": "ecs"
              }
            }
          }]
        }'
      ;;
    "ecs register-task-definition")
      local previous_argument=""
      local input_json=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--cli-input-json" ]]; then
          input_json="${argument#file://}"
          break
        fi
        previous_argument="$argument"
      done

      # The rendered revision must carry configuration that exists only in the
      # family's latest ACTIVE revision. A release rendered from the running
      # revision cannot satisfy this, which is what makes it a real assertion
      # rather than a restatement of the fixture.
      if [[ -n "$DEPLOY_TEST_EXPECT_ADOPTED_ENV" ]]; then
        if ! jq -e --arg name "$DEPLOY_TEST_EXPECT_ADOPTED_ENV" '
          .containerDefinitions[]
          | select(.name == "crowdsource-test")
          | .environment
          | map(.name)
          | index($name)
        ' "$input_json" >/dev/null; then
          printf 'Rendered task definition is missing %s, so the release was rendered from the running revision instead of the latest ACTIVE revision of the family.\n' \
            "$DEPLOY_TEST_EXPECT_ADOPTED_ENV" >&2
          return 1
        fi
        printf 'adopted-env:%s\n' "$DEPLOY_TEST_EXPECT_ADOPTED_ENV" >>"$DEPLOY_TEST_LOG"
      fi

      if [[ "$DEPLOY_TEST_EXPECT_METRICS_ARN" == "true" ]]; then
        jq -e '
          .containerDefinitions[]
          | select(.name == "crowdsource-test")
          | .secrets[]
          | select(
              .name == "INTERNAL_METRICS_TOKEN" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/crowdsource/INTERNAL_METRICS_TOKEN"
            )
        ' "$input_json" >/dev/null
        printf 'metrics:arn\n' >>"$DEPLOY_TEST_LOG"
      fi
      if [[ "$DEPLOY_TEST_EXPECT_TASK_SECRET_ARN" == "true" ]]; then
        jq -e '
          .containerDefinitions[]
          | select(.name == "crowdsource-test")
          | .secrets[]
          | select(
              .name == "EXAMPLE_TASK_SECRET" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/crowdsource/EXAMPLE_TASK_SECRET"
            )
        ' "$input_json" >/dev/null
        printf 'task-secret:arn\n' >>"$DEPLOY_TEST_LOG"
      fi
      # A registration of the MIGRATION family is logged distinctly, so a case
      # can prove the release rendered a migration revision carrying this
      # release's image rather than reusing the family's stale one.
      if jq -e '.family == "crowdsource-test-migrate"' "$input_json" >/dev/null; then
        jq -e --arg image "$DEPLOY_TEST_IMAGE_URI" '
          .containerDefinitions[]
          | select(.name == "crowdsource-test")
          | .image == $image
        ' "$input_json" >/dev/null
        printf 'migrate-register\n' >>"$DEPLOY_TEST_LOG"
        printf '%s\n' "arn:aws:ecs:test:task-definition/crowdsource-test-migrate:8"
        return 0
      fi
      printf '%s\n' "$registered_task_definition"
      ;;
    "ecs update-service")
      local previous_argument=""
      local task_definition=""
      local desired_count=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--task-definition" ]]; then
          task_definition="$argument"
        elif [[ "$previous_argument" == "--desired-count" ]]; then
          desired_count="$argument"
        fi
        previous_argument="$argument"
      done
      if [[ -z "$desired_count" ]]; then
        echo "Mocked update-service requires an explicit --desired-count." >&2
        return 1
      fi
      printf 'service:%s:desired=%s\n' \
        "$task_definition" \
        "$desired_count" \
        >>"$DEPLOY_TEST_LOG"
      printf '{}\n'
      ;;
    "ecs run-task")
      local rt_previous="" rt_task_definition="" rt_overrides=""
      local rt_argument
      for rt_argument in "$@"; do
        if [[ "$rt_previous" == "--task-definition" ]]; then
          rt_task_definition="$rt_argument"
        elif [[ "$rt_previous" == "--overrides" ]]; then
          rt_overrides="$rt_argument"
        fi
        rt_previous="$rt_argument"
      done
      # The whole point of the split: a migration must never run against the
      # SERVICE's task definition, which does not carry the migrator credential.
      if [[ "$rt_overrides" == *"migrate.js"* ]]; then
        printf 'migrate-run:%s:%s\n' \
          "$rt_task_definition" \
          "$(jq -r '[.containerOverrides[0].command[] | select(startswith("--phase="))] | join(",")' <<<"$rt_overrides")" \
          >>"$DEPLOY_TEST_LOG"
        printf '%s\n' '{
          "failures": [],
          "tasks": [{"taskArn": "arn:aws:ecs:test:task/crowdsource-migrate"}]
        }'
        return 0
      fi
      printf 'reconcile\n' >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "failures": [],
        "tasks": [{"taskArn": "arn:aws:ecs:test:task/crowdsource-postdeploy"}]
      }'
      ;;
    "ecs describe-tasks")
      printf '{
        "failures": [],
        "tasks": [{
          "lastStatus": "STOPPED",
          "stoppedReason": "Essential container exited",
          "containers": [{
            "name": "crowdsource-test",
            "exitCode": %s
          }]
        }]
      }\n' "$DEPLOY_TEST_TASK_EXIT_CODE"
      ;;
    "logs get-log-events")
      printf 'tasklogs\n' >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "events": [{
          "message": "[migration] fixture failure"
        }]
      }'
      ;;
    *)
      printf 'Unexpected mocked AWS call: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f aws

# Vacuity floor. On success this suite prints ONE line, so a traversal that
# silently stopped after two cases is indistinguishable from a full green run --
# and every guarantee below would read as verified while never having executed.
# A `set -e` abort mid-file exits non-zero, but an early `return` from a helper,
# a case list truncated by a bad merge, or a rewrite that drops cases does not.
#
# Raise this with the case count; lower it ONLY alongside a deletion you can
# name. A floor quietly adjusted to match whatever ran is not a floor.
cases_run=0
MINIMUM_CASES=17

run_release() {
  cases_run=$((cases_run + 1))
  local case_name="$1"
  local expect_success="$2"
  local run_migrations="${3:-false}"
  local inject_internal_metrics="${4:-false}"
  local task_exit_code="${5:-0}"
  local inject_task_secret="${6:-false}"
  local service_desired_count="${7:-1}"
  local rollout_scenario="${8:-healthy}"
  # Everything after the positional arguments is a DEPLOY_TEST_* override for the
  # task definition fixture. Each case starts from the defaults below, so a knob
  # one case sets can never leak into the next.
  local -a fixture_overrides=("${@:9}")
  local case_directory="$test_directory/$case_name"
  local output_file="$case_directory/output.log"
  local smoke_script="$case_directory/smoke.sh"

  mkdir -p "$case_directory"
  DEPLOY_TEST_LOG="$case_directory/aws.log"
  DEPLOY_TEST_EXPECT_METRICS_ARN="$inject_internal_metrics"
  DEPLOY_TEST_TASK_EXIT_CODE="$task_exit_code"
  DEPLOY_TEST_EXPECT_TASK_SECRET_ARN="$inject_task_secret"
  DEPLOY_TEST_SERVICE_DESIRED_COUNT="$service_desired_count"
  DEPLOY_TEST_ROLLOUT_SCENARIO="$rollout_scenario"
  DEPLOY_TEST_RUNNING_REVISION=1
  DEPLOY_TEST_LATEST_REVISION=1
  DEPLOY_TEST_REGISTERED_REVISION=2
  DEPLOY_TEST_LATEST_STATUS=ACTIVE
  DEPLOY_TEST_LATEST_EXTRA_ENV=""
  DEPLOY_TEST_EXPECT_ADOPTED_ENV=""
  DEPLOY_TEST_RUNNING_TASK_DEFINITION=""
  local fixture_override
  for fixture_override in ${fixture_overrides[@]+"${fixture_overrides[@]}"}; do
    if [[ ! "$fixture_override" =~ ^DEPLOY_TEST_[A-Z_]+=.*$ ]]; then
      echo "Unsupported fixture override for $case_name: $fixture_override" >&2
      return 1
    fi
    declare -g "$fixture_override"
  done

  export DEPLOY_TEST_LOG DEPLOY_TEST_EXPECT_METRICS_ARN
  export DEPLOY_TEST_TASK_EXIT_CODE
  export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN
  export DEPLOY_TEST_SERVICE_DESIRED_COUNT
  export DEPLOY_TEST_ROLLOUT_SCENARIO
  export DEPLOY_TEST_RUNNING_REVISION
  export DEPLOY_TEST_LATEST_REVISION
  export DEPLOY_TEST_REGISTERED_REVISION
  export DEPLOY_TEST_LATEST_STATUS
  export DEPLOY_TEST_LATEST_EXTRA_ENV
  export DEPLOY_TEST_EXPECT_ADOPTED_ENV
  export DEPLOY_TEST_RUNNING_TASK_DEFINITION

  # The generated smoke fixture expands this variable when it runs.
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "smoke\n" >>"$DEPLOY_TEST_LOG"' \
    >"$smoke_script"

  export DEPLOY_TEST_IMAGE_URI="example.invalid/crowdsource-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local -a release_environment=(
    AWS_REGION=test
    AWS_ACCOUNT_ID=123456789012
    CLUSTER=crowdsource-test
    APP=crowdsource-test
    CONTAINER_NAME=crowdsource-test
    IMAGE_URI="example.invalid/crowdsource-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    MAX_WAIT_SECS=5
    POLL_INTERVAL=1
    RUN_MIGRATIONS="$run_migrations"
    POST_DEPLOY_SMOKE_SCRIPT="$smoke_script"
    POST_DEPLOY_TASK_COMMAND_JSON='["reconcile"]'
  )
  if [[ "$run_migrations" == "true" && "${DEPLOY_TEST_OMIT_MIGRATION_INPUTS:-false}" != "true" ]]; then
    release_environment+=(
      MIGRATION_TASK_DEFINITION_FAMILY=crowdsource-test-migrate
      MIGRATION_TARGET_DATABASE=crowdsource
      MIGRATION_COMMAND_JSON='["bun","packages/backend/dist/scripts/migrate.js"]'
    )
  fi
  if [[ "$inject_internal_metrics" == "true" ]]; then
    release_environment+=(
      INTERNAL_METRICS_PARAMETER=/oxy/crowdsource/INTERNAL_METRICS_TOKEN
    )
  fi
  if [[ "$inject_task_secret" == "true" ]]; then
    release_environment+=(
      TASK_SECRET_OVERRIDES_JSON='{"EXAMPLE_TASK_SECRET":"arn:aws:ssm:test:123456789012:parameter/oxy/crowdsource/EXAMPLE_TASK_SECRET"}'
    )
  fi

  if env "${release_environment[@]}" \
    bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
    >"$output_file" 2>&1; then
    if [[ "$expect_success" != "true" ]]; then
      echo "Expected $case_name to fail." >&2
      return 1
    fi
  elif [[ "$expect_success" == "true" ]]; then
    echo "Expected $case_name to succeed." >&2
    sed -n '1,240p' "$output_file" >&2
    return 1
  fi
}

run_release success true false true
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/success/expected.log"
diff -u \
  "$test_directory/success/expected.log" \
  "$test_directory/success/aws.log"
# When the family's latest ACTIVE revision is the one the service runs there is
# nothing to reconcile, so the release says so, raises no drift warning, and does
# not spend a second lookup describing the revision it already has.
grep -F \
  "which is both the latest ACTIVE revision of crowdsource-test and the revision crowdsource-test is running" \
  "$test_directory/success/output.log" \
  >/dev/null
if grep -q 'is running arn:' "$test_directory/success/output.log"; then
  echo "A release with no revision drift reported drift anyway." >&2
  exit 1
fi
printf '%s\n' crowdsource-test >"$test_directory/success/expected-lookups.log"
diff -u \
  "$test_directory/success/expected-lookups.log" \
  "$test_directory/success/aws.log.lookups"

run_release explicit-task-secret true false false 0 true
printf '%s\n' \
  task-secret:arn \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/explicit-task-secret/expected.log"
diff -u \
  "$test_directory/explicit-task-secret/expected.log" \
  "$test_directory/explicit-task-secret/aws.log"

run_release reconciliation-failure false false false 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:2:desired=1' \
  smoke \
  reconcile \
  tasklogs \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:1:desired=1' \
  >"$test_directory/reconciliation-failure/expected.log"
diff -u \
  "$test_directory/reconciliation-failure/expected.log" \
  "$test_directory/reconciliation-failure/aws.log"

# A failed PRE migration must stop the release before the rollout, and it must
# have run against the MIGRATION family — the service's own definition does not
# carry the migrator credential, so a migration that ran there would either fail
# on a permission error or, against a single-role database, succeed and leave
# every table owned by the application role with row security enforcing nothing.
run_release migration-failure false true false 1
printf '%s\n' \
  migrate-register \
  'migrate-run:arn:aws:ecs:test:task-definition/crowdsource-test-migrate:8:--phase=pre' \
  tasklogs \
  >"$test_directory/migration-failure/expected.log"
diff -u \
  "$test_directory/migration-failure/expected.log" \
  "$test_directory/migration-failure/aws.log"
grep -F \
  "[migration] fixture failure" \
  "$test_directory/migration-failure/output.log" \
  >/dev/null
if grep -q '^service:' "$test_directory/migration-failure/aws.log"; then
  echo "Failed migration reached update-service." >&2
  exit 1
fi

# The phases straddle the rollout, and the ORDER is the property: `pre` is
# additive and safe against the image still serving, `post` takes something away
# and is an outage on it.
#
# `post` runs after the SMOKE CHECK, not merely after the rollout, and that is
# deliberate. A smoke failure rolls back to the previous image; if `post` had
# already dropped a column that image reads, the rollback would restore an image
# the schema can no longer serve — the one repair path turned into a second
# outage. So the drop waits until the new image is confirmed healthy.
#
# Both run against the migration family; the generic post-deploy reconciliation
# still runs on the service's own definition.
run_release migration-phases true true false 0
printf '%s\n' \
  migrate-register \
  'migrate-run:arn:aws:ecs:test:task-definition/crowdsource-test-migrate:8:--phase=pre' \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:2:desired=1' \
  smoke \
  'migrate-run:arn:aws:ecs:test:task-definition/crowdsource-test-migrate:8:--phase=post' \
  reconcile \
  >"$test_directory/migration-phases/expected.log"
diff -u \
  "$test_directory/migration-phases/expected.log" \
  "$test_directory/migration-phases/aws.log"

# Fail closed: migrations on with no migration family named. Defaulting to the
# service's task definition is the one outcome that must be unreachable, so this
# asserts the release refuses BEFORE any mutating AWS call.
DEPLOY_TEST_OMIT_MIGRATION_INPUTS=true \
  run_release migration-inputs-missing false true false 0
if ! grep -qF \
  "MIGRATION_TASK_DEFINITION_FAMILY is unset" \
  "$test_directory/migration-inputs-missing/output.log"; then
  echo "A release with migrations on and no migration family did not refuse by name." >&2
  exit 1
fi
if [[ -s "$test_directory/migration-inputs-missing/aws.log" ]]; then
  echo "A release with no migration task definition reached a mutating AWS call." >&2
  exit 1
fi

# Fail closed the other way: the family exists but carries no migrator
# credential. Running there would apply DDL as whatever role it does carry, and
# on a single-role database that SUCCEEDS — the failure that leaves no trace.
DEPLOY_TEST_MIGRATION_SECRET="" \
  run_release migration-credential-missing false true false 0
if ! grep -qF \
  "does not carry MIGRATOR_DATABASE_URL" \
  "$test_directory/migration-credential-missing/output.log"; then
  echo "A migration family without the migrator credential did not refuse by name." >&2
  exit 1
fi
# `-s` first: a refusal this early may leave no log at all, and `grep` on a
# missing file exits non-zero, which would read as "no service line" and pass
# for the wrong reason.
if [[ -s "$test_directory/migration-credential-missing/aws.log" ]] &&
   grep -q '^service:' "$test_directory/migration-credential-missing/aws.log"; then
  echo "A migration family without the migrator credential reached update-service." >&2
  exit 1
fi

# A service parked at desiredCount 0 — the state every store cutover leaves it
# in — must still land its image, because the release that would make the service
# bootable again is the one a refusal blocks.
#
# The exact log is the whole assertion, and what it does NOT contain matters more
# than what it does. Compare it against `migration-phases` above, which is the
# same release at desired=1: there, `service:` is followed by `smoke`,
# `--phase=post` and `reconcile`. Here the log must STOP at `service:`, because
# none of those three are real when nothing is running — a smoke check against a
# service with zero tasks, and a destructive `post` migration with no healthy
# image to confirm it, are exactly the plausible greens this gate exists to
# refuse. `diff -u` fails if any of them appears.
run_release zero-desired-count true true false 0 false 0
printf '%s\n' \
  migrate-register \
  'migrate-run:arn:aws:ecs:test:task-definition/crowdsource-test-migrate:8:--phase=pre' \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:2:desired=0' \
  >"$test_directory/zero-desired-count/expected.log"
diff -u \
  "$test_directory/zero-desired-count/expected.log" \
  "$test_directory/zero-desired-count/aws.log"
# `service:...crowdsource-test:2:...` is the REPOINT, and it is the half that is
# easy to drop: registering a revision does not point the service at it, so
# without this line a later scale-up would launch the OLD image and every
# subsequent deploy would render from the stale revision.
grep -F \
  "service:arn:aws:ecs:test:task-definition/crowdsource-test:2:desired=0" \
  "$test_directory/zero-desired-count/aws.log" \
  >/dev/null
grep -F \
  "NO ROLLOUT PERFORMED: ECS service crowdsource-test is at desiredCount=0" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
grep -F \
  "NO ROLLOUT PERFORMED: the task definition WAS registered and the service now points at it: arn:aws:ecs:test:task-definition/crowdsource-test:2" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
grep -F \
  "NO ROLLOUT PERFORMED: the 'post' migration phase was NOT applied" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
# The success line of an ordinary release. If it ever appears here, a reader of
# the workflow log six weeks from now cannot tell this run apart from one that
# actually shipped, which is the failure this whole case exists to prevent.
if grep -qF \
  "ECS rollout reached a healthy steady state" \
  "$test_directory/zero-desired-count/output.log"; then
  echo "A zero-capacity release claimed a healthy rollout it never performed." >&2
  exit 1
fi

# The negative control for the case above: desiredCount ABSENT is ECS declining
# to answer, which is not the same fact as a zero it reports confidently, and
# must still refuse. Without this, deleting the numeric check outright would
# leave the suite green.
run_release missing-desired-count false false false 0 false null
grep -F \
  "reported a non-numeric desiredCount" \
  "$test_directory/missing-desired-count/output.log" \
  >/dev/null
if [[ -s "$test_directory/missing-desired-count/aws.log" ]]; then
  echo "A service with an unreadable desiredCount reached a mutating AWS call." >&2
  exit 1
fi

run_release transient-zero-deployment true false false 0 false 1 transient-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/transient-zero-deployment/expected.log"
diff -u \
  "$test_directory/transient-zero-deployment/expected.log" \
  "$test_directory/transient-zero-deployment/aws.log"
grep -F \
  "has not assigned desired tasks" \
  "$test_directory/transient-zero-deployment/output.log" \
  >/dev/null

run_release zero-service-during-deploy false false false 0 false 1 zero-service-during-deploy
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:1:desired=1' \
  >"$test_directory/zero-service-during-deploy/expected.log"
diff -u \
  "$test_directory/zero-service-during-deploy/expected.log" \
  "$test_directory/zero-service-during-deploy/aws.log"
grep -F \
  "service crowdsource-test reached desiredCount=0 during the deployment rollout" \
  "$test_directory/zero-service-during-deploy/output.log" \
  >/dev/null

run_release completed-zero-deployment false false false 0 false 1 completed-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:1:desired=1' \
  >"$test_directory/completed-zero-deployment/expected.log"
diff -u \
  "$test_directory/completed-zero-deployment/expected.log" \
  "$test_directory/completed-zero-deployment/aws.log"
grep -F \
  "completed at desiredCount=0; refusing to accept a zero-task steady state" \
  "$test_directory/completed-zero-deployment/output.log" \
  >/dev/null

# Terraform registered a revision carrying a new environment variable and the
# service, excluded from Terraform's task_definition management, never adopted it.
# The release must render from that revision, not from the one serving traffic.
run_release terraform-added-variable true false false 0 false 1 healthy \
  DEPLOY_TEST_RUNNING_REVISION=5 \
  DEPLOY_TEST_LATEST_REVISION=6 \
  DEPLOY_TEST_REGISTERED_REVISION=7 \
  DEPLOY_TEST_LATEST_EXTRA_ENV=OXY_API_URL \
  DEPLOY_TEST_EXPECT_ADOPTED_ENV=OXY_API_URL
printf '%s\n' \
  adopted-env:OXY_API_URL \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:7:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/terraform-added-variable/expected.log"
diff -u \
  "$test_directory/terraform-added-variable/expected.log" \
  "$test_directory/terraform-added-variable/aws.log"
# Adopting the newer revision silently is the failure mode that hid the incident,
# so the drift, its registrant and the fields it carries must all be in the log.
grep -F \
  "is running arn:aws:ecs:test:task-definition/crowdsource-test:5 but the latest ACTIVE revision of crowdsource-test is arn:aws:ecs:test:task-definition/crowdsource-test:6" \
  "$test_directory/terraform-added-variable/output.log" \
  >/dev/null
grep -F \
  "Revision 6 was registered at 2026-07-29T12:00:00Z by arn:aws:sts::123456789012:assumed-role/oxy-terraform/apply" \
  "$test_directory/terraform-added-variable/output.log" \
  >/dev/null
grep -F \
  "environment: OXY_API_URL" \
  "$test_directory/terraform-added-variable/output.log" \
  >/dev/null
printf '%s\n' \
  crowdsource-test \
  arn:aws:ecs:test:task-definition/crowdsource-test:5 \
  >"$test_directory/terraform-added-variable/expected-lookups.log"
diff -u \
  "$test_directory/terraform-added-variable/expected-lookups.log" \
  "$test_directory/terraform-added-variable/aws.log.lookups"

# A rollback restores what was serving traffic. The revision the release rendered
# from was never deployed, so restoring it would ship untested configuration
# under the name of a rollback.
run_release adopted-revision-rollback false false false 1 false 1 healthy \
  DEPLOY_TEST_RUNNING_REVISION=5 \
  DEPLOY_TEST_LATEST_REVISION=6 \
  DEPLOY_TEST_REGISTERED_REVISION=7
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:7:desired=1' \
  smoke \
  reconcile \
  tasklogs \
  'service:arn:aws:ecs:test:task-definition/crowdsource-test:5:desired=1' \
  >"$test_directory/adopted-revision-rollback/expected.log"
diff -u \
  "$test_directory/adopted-revision-rollback/expected.log" \
  "$test_directory/adopted-revision-rollback/aws.log"

# Newer revisions having been deregistered leaves the latest ACTIVE revision
# behind the running one. Rendering from it would roll production configuration
# backwards while reporting a successful deployment.
run_release stale-latest-revision false false false 0 false 1 healthy \
  DEPLOY_TEST_RUNNING_REVISION=5 \
  DEPLOY_TEST_LATEST_REVISION=3
grep -F \
  "latest ACTIVE revision of crowdsource-test is 3 but crowdsource-test is running revision 5" \
  "$test_directory/stale-latest-revision/output.log" \
  >/dev/null
if [[ -s "$test_directory/stale-latest-revision/aws.log" ]]; then
  echo "A backwards render base reached a mutating AWS call." >&2
  exit 1
fi

# A bare family resolves to the latest ACTIVE revision, so any other status means
# the assumption this selection rests on no longer holds.
run_release inactive-latest-revision false false false 0 false 1 healthy \
  DEPLOY_TEST_RUNNING_REVISION=5 \
  DEPLOY_TEST_LATEST_REVISION=6 \
  DEPLOY_TEST_LATEST_STATUS=INACTIVE
grep -F \
  "crowdsource-test:6 of family crowdsource-test is INACTIVE rather than ACTIVE" \
  "$test_directory/inactive-latest-revision/output.log" \
  >/dev/null
if [[ -s "$test_directory/inactive-latest-revision/aws.log" ]]; then
  echo "An inactive render base reached a mutating AWS call." >&2
  exit 1
fi

# The family is read out of what ECS reports rather than out of configuration, so
# an unreadable identifier must stop the release instead of being guessed at.
run_release unreadable-task-definition false false false 0 false 1 healthy \
  DEPLOY_TEST_RUNNING_TASK_DEFINITION=arn:aws:ecs:test:task-definition/crowdsource-test
grep -F \
  "Could not read a task definition family and revision from arn:aws:ecs:test:task-definition/crowdsource-test" \
  "$test_directory/unreadable-task-definition/output.log" \
  >/dev/null
if [[ -s "$test_directory/unreadable-task-definition/aws.log" ||
      -e "$test_directory/unreadable-task-definition/aws.log.lookups" ]]; then
  echo "An unreadable task definition reached an AWS task definition call." >&2
  exit 1
fi

if (( cases_run < MINIMUM_CASES )); then
  echo "ASSERTION FAILED: only $cases_run release cases ran, expected at least $MINIMUM_CASES." >&2
  echo "The suite exited green without executing everything it claims to check." >&2
  exit 1
fi

echo "Deployment script transaction tests passed ($cases_run release cases)."
