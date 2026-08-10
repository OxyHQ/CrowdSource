#!/usr/bin/env bash

set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER:?CLUSTER is required}"
: "${APP:?APP is required}"
: "${IMAGE_URI:?IMAGE_URI is required}"
if [[ ! "$IMAGE_URI" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "::error::IMAGE_URI must pin an immutable OCI digest (repository@sha256:<64 hex characters>)."
  exit 1
fi

CONTAINER_NAME="${CONTAINER_NAME:-$APP}"
MAX_WAIT_SECS="${MAX_WAIT_SECS:-1200}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"
INTERNAL_METRICS_PARAMETER="${INTERNAL_METRICS_PARAMETER:-}"
TASK_SECRET_OVERRIDES_JSON="${TASK_SECRET_OVERRIDES_JSON:-}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
AWS_PARTITION="${AWS_PARTITION:-aws}"
POST_DEPLOY_SMOKE_SCRIPT="${POST_DEPLOY_SMOKE_SCRIPT:-}"
POST_DEPLOY_TASK_COMMAND_JSON="${POST_DEPLOY_TASK_COMMAND_JSON:-}"
# The migration one-shot runs against its OWN task definition family, never the
# service's, and the reason is the credential rather than tidiness. Migrations
# are applied by a role that OWNS every table; a table's owner is exempt from
# its own row-security policies and can DROP POLICY in one statement. ECS
# container overrides cannot inject a secret, so the only way to hand the
# migrator its credential without also handing it to every serving task is a
# second task definition carrying it.
MIGRATION_TASK_DEFINITION_FAMILY="${MIGRATION_TASK_DEFINITION_FAMILY:-}"
MIGRATION_CONTAINER_NAME="${MIGRATION_CONTAINER_NAME:-$CONTAINER_NAME}"
MIGRATION_TARGET_DATABASE="${MIGRATION_TARGET_DATABASE:-}"
MIGRATION_COMMAND_JSON="${MIGRATION_COMMAND_JSON:-}"
DEPLOY_HEAD_GUARD_SCRIPT="${DEPLOY_HEAD_GUARD_SCRIPT:-.github/scripts/require-current-main.sh}"

if ! [[ "$MAX_WAIT_SECS" =~ ^[0-9]+$ ]] || (( MAX_WAIT_SECS < 1 )); then
  echo "::error::MAX_WAIT_SECS must be a positive integer."
  exit 1
fi
if ! [[ "$POLL_INTERVAL" =~ ^[0-9]+$ ]] || (( POLL_INTERVAL < 1 )); then
  echo "::error::POLL_INTERVAL must be a positive integer."
  exit 1
fi
if [[ "$RUN_MIGRATIONS" != "true" && "$RUN_MIGRATIONS" != "false" ]]; then
  echo "::error::RUN_MIGRATIONS must be either 'true' or 'false'."
  exit 1
fi
# Every one of these refuses rather than defaulting, because each default would
# be silently wrong. Falling back to the service's task definition would run the
# migrator under the application role, which owns nothing — or, against a
# single-role database, would succeed and leave row security enforcing nothing.
# Omitting --target-database is the guard whose absence exits 0 against the
# wrong database: a migrator pointed elsewhere finds an empty ledger, applies
# the whole journal and logs a success line.
if [[ "$RUN_MIGRATIONS" == "true" ]]; then
  if [[ -z "$MIGRATION_TASK_DEFINITION_FAMILY" ]]; then
    echo "::error::RUN_MIGRATIONS is true but MIGRATION_TASK_DEFINITION_FAMILY is unset; refusing to run migrations on the service's own task definition, which does not carry the migrator credential."
    exit 1
  fi
  if [[ -z "$MIGRATION_TARGET_DATABASE" ]]; then
    echo "::error::RUN_MIGRATIONS is true but MIGRATION_TARGET_DATABASE is unset; --target-database is required on every run."
    exit 1
  fi
  if [[ -z "$MIGRATION_COMMAND_JSON" ]]; then
    echo "::error::RUN_MIGRATIONS is true but MIGRATION_COMMAND_JSON is unset."
    exit 1
  fi
  if ! jq -e '
       type == "array" and
       length > 0 and
       all(.[]; type == "string" and length > 0)
     ' <<<"$MIGRATION_COMMAND_JSON" >/dev/null; then
    echo "::error::MIGRATION_COMMAND_JSON must be a non-empty JSON string array."
    exit 1
  fi
fi
if [[ -n "$POST_DEPLOY_SMOKE_SCRIPT" && ! -f "$POST_DEPLOY_SMOKE_SCRIPT" ]]; then
  echo "::error::POST_DEPLOY_SMOKE_SCRIPT does not exist: $POST_DEPLOY_SMOKE_SCRIPT"
  exit 1
fi
if [[ -n "${DEPLOY_SHA:-}" && ! -f "$DEPLOY_HEAD_GUARD_SCRIPT" ]]; then
  echo "::error::DEPLOY_HEAD_GUARD_SCRIPT does not exist: $DEPLOY_HEAD_GUARD_SCRIPT"
  exit 1
fi
if [[ -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]] &&
   ! jq -e '
     type == "array" and
     length > 0 and
     all(.[]; type == "string" and length > 0)
   ' <<<"$POST_DEPLOY_TASK_COMMAND_JSON" >/dev/null; then
  echo "::error::POST_DEPLOY_TASK_COMMAND_JSON must be a non-empty JSON string array."
  exit 1
fi
if [[ -z "$TASK_SECRET_OVERRIDES_JSON" ]]; then
  TASK_SECRET_OVERRIDES_JSON='{}'
fi
if ! jq -e '
  type == "object" and
  length <= 20 and
  all(
    to_entries[];
    (.key | type == "string" and test("^[A-Z][A-Z0-9_]{0,127}$")) and
    (
      .value
      | type == "string" and
        test("^arn:aws(-[a-z]+)?:ssm:[a-z0-9-]+:[0-9]{12}:parameter/[A-Za-z0-9_.\\-/]+$")
    )
  )
' <<<"$TASK_SECRET_OVERRIDES_JSON" >/dev/null; then
  echo "::error::TASK_SECRET_OVERRIDES_JSON must map environment variable names to complete SSM parameter ARNs."
  exit 1
fi

service_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$APP")"
if [[ "$(jq '.failures | length' <<<"$service_json")" != "0" ||
      "$(jq '.services | length' <<<"$service_json")" != "1" ]]; then
  echo "::error::ECS did not return exactly one service named $APP."
  jq '.failures' <<<"$service_json"
  exit 1
fi
service_status="$(jq -r '.services[0].status // "NONE"' <<<"$service_json")"
if [[ "$service_status" != "ACTIVE" ]]; then
  echo "::error::ECS service $APP is not ACTIVE (status: $service_status)."
  exit 1
fi

current_task_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"$service_json")"
if [[ -z "$current_task_definition" ]]; then
  echo "::error::ECS service $APP has no task definition."
  exit 1
fi

# The running revision is the rollback target, and the family it belongs to is
# what the release renders from — see the render base selection below. Both are
# derived from what ECS reports rather than from configuration, so neither can
# drift away from the service this script is deploying.
current_task_definition_name="${current_task_definition##*/}"
task_definition_family="${current_task_definition_name%:*}"
current_task_definition_revision="${current_task_definition_name##*:}"
if [[ "$current_task_definition_name" != *:* ||
      ! "$task_definition_family" =~ ^[A-Za-z0-9_-]{1,255}$ ||
      ! "$current_task_definition_revision" =~ ^[0-9]+$ ]]; then
  echo "::error::Could not read a task definition family and revision from $current_task_definition."
  exit 1
fi

service_desired_count="$(jq -r '.services[0].desiredCount // empty' <<<"$service_json")"
if ! [[ "$service_desired_count" =~ ^[0-9]+$ ]] ||
   (( service_desired_count < 1 )); then
  echo "::error::ECS service $APP must have a positive desiredCount before deployment (current: ${service_desired_count:-missing}). Scale the service up explicitly before retrying."
  exit 1
fi

task_definition_file="$(mktemp)"
running_task_definition_file="$(mktemp)"
rendered_task_definition_file="$(mktemp)"
active_one_shot_task_arn=""
active_one_shot_task_stopped=true
active_one_shot_label=""

cleanup() {
  if [[ "$active_one_shot_task_stopped" != "true" &&
        -n "$active_one_shot_task_arn" ]]; then
    echo "::warning::Unfinished $active_one_shot_label task $active_one_shot_task_arn may still be running; the deploy role cannot call ecs:StopTask."
  fi
  rm -f \
    "$task_definition_file" \
    "$running_task_definition_file" \
    "$rendered_task_definition_file"
}
trap cleanup EXIT

wait_for_task_stop() {
  local task_arn="$1"
  local label="$2"
  local max_wait_secs="$3"
  local elapsed=0
  local task_json last_status

  while (( elapsed < max_wait_secs )); do
    task_json="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn")"
    if [[ "$(jq '.failures | length' <<<"$task_json")" != "0" ]]; then
      echo "::error::ECS could not describe $label task $task_arn."
      jq '.failures' <<<"$task_json"
      return 1
    fi
    last_status="$(jq -r '.tasks[0].lastStatus // "MISSING"' <<<"$task_json")"
    echo "($elapsed s) $label task status=$last_status"
    if [[ "$last_status" == "STOPPED" ]]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "::error::$label task did not stop within ${max_wait_secs}s. The deploy role cannot call ecs:StopTask; task $task_arn may still be running."
  return 1
}

wait_for_service_rollout() {
  local task_definition="$1"
  local label="$2"
  local elapsed=0
  local deployment_json="$service_json"
  local deployment_state rollout_state running desired service_desired

  while (( elapsed < MAX_WAIT_SECS )); do
    if ! deployment_json="$(aws ecs describe-services \
      --cluster "$CLUSTER" \
      --services "$APP")"; then
      echo "::warning::Unable to inspect the $label rollout; retrying."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi
    if [[ "$(jq '.failures | length' <<<"$deployment_json")" != "0" ]]; then
      echo "::warning::ECS returned a failure while inspecting the $label rollout; retrying."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi
    if ! deployment_state="$(jq -r --arg task "$task_definition" '
      .services[0] as $service
      |
      [
        $service.deployments[]
        | select(.taskDefinition == $task and .status == "PRIMARY")
        | [.rolloutState, .runningCount, .desiredCount, $service.desiredCount]
        | @tsv
      ][0] // empty
    ' <<<"$deployment_json")"; then
      echo "::warning::ECS returned malformed rollout data for $label; retrying."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi

    if [[ -z "$deployment_state" ]]; then
      echo "($elapsed s) waiting for the $label PRIMARY deployment"
    else
      IFS=$'\t' read -r rollout_state running desired service_desired <<<"$deployment_state"
      echo "($elapsed s) $label rolloutState=$rollout_state running=$running desired=$desired serviceDesired=$service_desired"
      if ! [[ "$running" =~ ^[0-9]+$ &&
              "$desired" =~ ^[0-9]+$ &&
              "$service_desired" =~ ^[0-9]+$ ]]; then
        echo "::warning::ECS returned non-numeric task counts for the $label rollout; retrying."
      elif (( service_desired < 1 )); then
        echo "::error::ECS service $APP reached desiredCount=0 during the $label rollout."
        return 1
      elif [[ "$rollout_state" == "COMPLETED" ]]; then
        if (( desired < 1 )); then
          echo "::error::ECS $label rollout for $APP completed at desiredCount=0; refusing to accept a zero-task steady state."
          return 1
        fi
        if [[ "$running" == "$desired" ]]; then
          return 0
        fi
      elif (( desired < 1 )); then
        echo "::warning::ECS has not assigned desired tasks to the $label PRIMARY deployment yet; waiting."
      fi
      if [[ "$rollout_state" == "FAILED" ]]; then
        echo "::error::ECS $label rollout for $APP failed."
        echo "::group::Recent ECS service events"
        jq -r '
          .services[0].events[:10][]?
          | "\(.createdAt // "unknown") \(.message // "unknown")"
        ' <<<"$deployment_json"
        echo "::endgroup::"
        return 1
      fi
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "::error::ECS $label rollout for $APP did not complete within ${MAX_WAIT_SECS}s."
  echo "::group::Recent ECS service events"
  jq -r '
    .services[0].events[:10][]?
    | "\(.createdAt // "unknown") \(.message // "unknown")"
  ' <<<"$deployment_json"
  echo "::endgroup::"
  return 1
}

print_one_shot_logs() {
  local task_arn="$1"
  local label="$2"
  local task_id log_group log_stream_prefix log_stream log_json

  task_id="${task_arn##*/}"
  log_group="$(jq -r --arg name "$CONTAINER_NAME" '
    .containerDefinitions[]
    | select(.name == $name)
    | .logConfiguration.options["awslogs-group"] // empty
  ' "$rendered_task_definition_file")"
  log_stream_prefix="$(jq -r --arg name "$CONTAINER_NAME" '
    .containerDefinitions[]
    | select(.name == $name)
    | .logConfiguration.options["awslogs-stream-prefix"] // empty
  ' "$rendered_task_definition_file")"

  if [[ -z "$task_id" || -z "$log_group" || -z "$log_stream_prefix" ]]; then
    echo "::warning::Unable to derive the CloudWatch log stream for failed $label task $task_arn."
    return 0
  fi

  log_stream="$log_stream_prefix/$CONTAINER_NAME/$task_id"
  if ! log_json="$(aws logs get-log-events \
    --log-group-name "$log_group" \
    --log-stream-name "$log_stream" \
    --limit 200 \
    --start-from-head)"; then
    echo "::warning::Unable to read CloudWatch logs for failed $label task $task_arn."
    return 0
  fi

  echo "::group::$label CloudWatch logs"
  jq -r '.events[]?.message' <<<"$log_json"
  echo "::endgroup::"
}

# Names every field in which the revision this release renders from differs from
# the revision the service is running. Values are deliberately omitted: an
# environment variable can carry a URL with a credential in it, and this output
# lands in a public job log.
print_task_definition_drift() {
  local running_definition_file="$1"
  local base_definition_file="$2"

  jq -rn \
    --arg name "$CONTAINER_NAME" \
    --slurpfile running "$running_definition_file" \
    --slurpfile base "$base_definition_file" \
    '
      def container($document):
        ($document.containerDefinitions // [])
        | map(select(.name == $name))
        | first // {};
      def keyed($entries):
        ($entries // [])
        | map({key: .name, value: ((.value // .valueFrom) // null)})
        | from_entries;
      def taskFields($document):
        $document
        | del(
            .containerDefinitions,
            .taskDefinitionArn,
            .revision,
            .status,
            .requiresAttributes,
            .compatibilities,
            .registeredAt,
            .registeredBy
          );
      def differing($before; $after):
        ((($before | keys) + ($after | keys)) | unique)
        | map(select(($before[.] | tojson) != ($after[.] | tojson)));
      def report($label; $before; $after):
        differing($before; $after) as $names
        | if ($names | length) == 0 then empty
          else "\($label): \($names | join(", "))"
          end;

      ($running[0]) as $runningDocument
      | ($base[0]) as $baseDocument
      | container($runningDocument) as $runningContainer
      | container($baseDocument) as $baseContainer
      | [
          report("task fields"; taskFields($runningDocument); taskFields($baseDocument)),
          report(
            "container fields";
            ($runningContainer | del(.image, .environment, .secrets));
            ($baseContainer | del(.image, .environment, .secrets))
          ),
          report(
            "environment";
            keyed($runningContainer.environment);
            keyed($baseContainer.environment)
          ),
          report(
            "secrets";
            keyed($runningContainer.secrets);
            keyed($baseContainer.secrets)
          )
        ]
      | if length == 0 then
          "nothing outside the container image differs"
        else .[]
        end
    '
}

run_one_shot_command() {
  local label="$1"
  local task_definition_to_run="$2"
  local container_to_override="$3"
  local command_json="$4"
  local overrides run_json task_json exit_code stopped_reason container_reason

  overrides="$(jq -cn \
    --arg name "$container_to_override" \
    --argjson command "$command_json" \
    '{
      containerOverrides: [{
        name: $name,
        command: $command
      }]
    }')"

  if ! run_json="$(aws "${one_shot_run_task_args[@]}" \
      --task-definition "$task_definition_to_run" \
      --overrides "$overrides")"; then
    echo "::error::ECS failed to start the $label task."
    return 1
  fi
  if [[ "$(jq '.failures | length' <<<"$run_json")" != "0" ]]; then
    echo "::error::ECS refused to start the $label task."
    jq '.failures' <<<"$run_json"
    return 1
  fi

  active_one_shot_task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$run_json")"
  if [[ -z "$active_one_shot_task_arn" ]]; then
    echo "::error::ECS returned no task ARN for $label."
    return 1
  fi
  active_one_shot_label="$label"
  active_one_shot_task_stopped=false

  echo "Running $label with $task_definition_to_run"
  if ! wait_for_task_stop "$active_one_shot_task_arn" "$label" "$MAX_WAIT_SECS"; then
    return 1
  fi
  active_one_shot_task_stopped=true

  task_json="$(aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$active_one_shot_task_arn")"
  exit_code="$(jq -r --arg name "$container_to_override" '
    .tasks[0].containers[] | select(.name == $name) | .exitCode // -1
  ' <<<"$task_json")"
  if [[ "$exit_code" != "0" ]]; then
    print_one_shot_logs "$active_one_shot_task_arn" "$label"
    stopped_reason="$(jq -r '.tasks[0].stoppedReason // "unknown"' <<<"$task_json")"
    container_reason="$(jq -r --arg name "$container_to_override" '
      .tasks[0].containers[] | select(.name == $name) | .reason // "unknown"
    ' <<<"$task_json")"
    echo "::error::$label task failed (exit=$exit_code, stopped=$stopped_reason, container=$container_reason)."
    return 1
  fi
  echo "$label completed successfully"
}

# Rolls back to the revision that was actually serving traffic, which is not
# necessarily the revision this release rendered from — the render base can be a
# newer revision the service never adopted, and restoring that would put
# untested configuration into production as a "rollback".
rollback_service() {
  echo "::warning::Rolling $APP back to $current_task_definition."
  if ! aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$APP" \
    --task-definition "$current_task_definition" \
    --desired-count "$service_desired_count" \
    --deployment-configuration '{
      "deploymentCircuitBreaker": {"enable": true, "rollback": true},
      "minimumHealthyPercent": 100,
      "maximumPercent": 200
    }' \
    >/dev/null; then
    echo "::error::ECS rejected the rollback to $current_task_definition."
    return 1
  fi
  wait_for_service_rollout "$current_task_definition" "rollback"
}

internal_metrics_secret_arn=""
if [[ -n "$INTERNAL_METRICS_PARAMETER" ]]; then
  if [[ "$INTERNAL_METRICS_PARAMETER" == arn:* ]]; then
    internal_metrics_secret_arn="$INTERNAL_METRICS_PARAMETER"
  else
    if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
      echo "::error::AWS_ACCOUNT_ID must be a 12-digit account id when INTERNAL_METRICS_PARAMETER is a parameter name."
      exit 1
    fi
    if [[ ! "$AWS_PARTITION" =~ ^aws(-[a-z]+)?$ ||
          ! "$INTERNAL_METRICS_PARAMETER" =~ ^/[A-Za-z0-9_.\-/]+$ ]]; then
      echo "::error::AWS partition or INTERNAL_METRICS_PARAMETER name is invalid."
      exit 1
    fi
    internal_metrics_secret_arn="arn:${AWS_PARTITION}:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/${INTERNAL_METRICS_PARAMETER#/}"
  fi
  if [[ ! "$internal_metrics_secret_arn" =~ ^arn:aws(-[a-z]+)?:ssm:[a-z0-9-]+:[0-9]{12}:parameter/.+$ ]]; then
    echo "::error::Unable to construct a valid SSM parameter ARN for the task definition."
    exit 1
  fi
fi

task_secret_overrides="$(jq -c '
  [
    to_entries[]
    | {name: .key, valueFrom: .value}
  ]
' <<<"$TASK_SECRET_OVERRIDES_JSON")"

# The release renders from the family's latest ACTIVE revision, NOT from the
# revision the service happens to be running.
#
# Terraform owns this task definition but the service is declared with
# `ignore_changes = [task_definition]`, deliberately, so Terraform never fights
# CI over image tags. The cost of that is that a Terraform-authored change — a
# new environment variable, a role, a memory bump — registers a revision the
# service never adopts. Rendering from the running revision therefore discards
# it, silently and permanently: it is exactly how OXY_API_URL was added to this
# family, never reached a task, and would have been dropped again by the next
# deploy.
#
# This widens what a release adopts to include any out-of-band
# register-task-definition, so the divergence is reported rather than
# reconciled in silence. A stale image in the adopted revision is harmless
# because the image is always overwritten below; every other difference is
# printed with the revision's registrant, so an unexplained change is visible in
# the job log of the deploy that adopted it.
aws ecs describe-task-definition \
  --task-definition "$task_definition_family" \
  --query taskDefinition \
  >"$task_definition_file"

base_task_definition="$(jq -r '.taskDefinitionArn // empty' "$task_definition_file")"
base_task_definition_family="$(jq -r '.family // empty' "$task_definition_file")"
base_task_definition_status="$(jq -r '.status // empty' "$task_definition_file")"
base_task_definition_name="${base_task_definition##*/}"
base_task_definition_revision="${base_task_definition_name##*:}"
if [[ -z "$base_task_definition" ||
      "$base_task_definition_name" != *:* ||
      ! "$base_task_definition_revision" =~ ^[0-9]+$ ]]; then
  echo "::error::ECS returned no usable latest task definition for family $task_definition_family."
  exit 1
fi
if [[ "$base_task_definition_family" != "$task_definition_family" ]]; then
  echo "::error::A lookup of family $task_definition_family returned family $base_task_definition_family ($base_task_definition); refusing to render a release from another family."
  exit 1
fi
# describe-task-definition resolves a bare family to its latest ACTIVE revision,
# so anything else means the assumption this selection rests on no longer holds.
if [[ "$base_task_definition_status" != "ACTIVE" ]]; then
  echo "::error::Latest revision $base_task_definition of family $task_definition_family is $base_task_definition_status rather than ACTIVE."
  exit 1
fi
if (( base_task_definition_revision < current_task_definition_revision )); then
  echo "::error::The latest ACTIVE revision of $task_definition_family is $base_task_definition_revision but $APP is running revision $current_task_definition_revision; refusing to render a release from a configuration older than the one serving traffic."
  exit 1
fi

if [[ "$base_task_definition" == "$current_task_definition" ]]; then
  echo "Rendering the release from $base_task_definition, which is both the latest ACTIVE revision of $task_definition_family and the revision $APP is running."
else
  echo "::warning::ECS service $APP is running $current_task_definition but the latest ACTIVE revision of $task_definition_family is $base_task_definition. The release renders from the latest revision so configuration registered outside CI reaches the service; its differences are listed below."
  echo "Revision $base_task_definition_revision was registered at $(jq -r '.registeredAt // "an unreported time"' "$task_definition_file") by $(jq -r '.registeredBy // "an unreported principal"' "$task_definition_file")."
  aws ecs describe-task-definition \
    --task-definition "$current_task_definition" \
    --query taskDefinition \
    >"$running_task_definition_file"
  echo "::group::Configuration this release adopts from $base_task_definition"
  print_task_definition_drift \
    "$running_task_definition_file" \
    "$task_definition_file"
  echo "::endgroup::"
fi

container_matches="$(jq --arg name "$CONTAINER_NAME" '[.containerDefinitions[] | select(.name == $name)] | length' "$task_definition_file")"
if [[ "$container_matches" != "1" ]]; then
  available_containers="$(jq -r '[.containerDefinitions[].name] | join(", ")' "$task_definition_file")"
  echo "::error::Expected exactly one container named $CONTAINER_NAME; found $container_matches. Available: $available_containers"
  exit 1
fi

jq \
  --arg name "$CONTAINER_NAME" \
  --arg image "$IMAGE_URI" \
  --arg internalMetricsSecretArn "$internal_metrics_secret_arn" \
  --argjson taskSecretOverrides "$task_secret_overrides" \
  '
    del(
      .taskDefinitionArn,
      .revision,
      .status,
      .requiresAttributes,
      .compatibilities,
      .registeredAt,
      .registeredBy
    )
    | ($taskSecretOverrides | map(.name)) as $taskSecretNames
    | .containerDefinitions |= map(
        if .name == $name then
          .image = $image
          | if $internalMetricsSecretArn != "" then
              .secrets = (
                (.secrets // [])
                | map(select(.name != "INTERNAL_METRICS_TOKEN"))
                + [{
                    name: "INTERNAL_METRICS_TOKEN",
                    valueFrom: $internalMetricsSecretArn
                  }]
              )
              | .environment = (
                  (.environment // [])
                  | map(select(.name != "INTERNAL_METRICS_ENABLED"))
                  + [{name: "INTERNAL_METRICS_ENABLED", value: "true"}]
                )
            else .
            end
          | .secrets = (
              ((.secrets // [])
                | map(
                    select(
                      .name as $existingName
                      | ($taskSecretNames | index($existingName)) == null
                    )
                  ))
              + $taskSecretOverrides
            )
        else . end
      )
  ' \
  "$task_definition_file" >"$rendered_task_definition_file"

new_task_definition="$(aws ecs register-task-definition \
  --cli-input-json "file://$rendered_task_definition_file" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

one_shot_run_task_args=()
if [[ "$RUN_MIGRATIONS" == "true" || -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]]; then
  network_configuration="$(jq -c '.services[0].networkConfiguration' <<<"$service_json")"
  if [[ -z "$network_configuration" || "$network_configuration" == "null" ]]; then
    echo "::error::ECS service $APP has no network configuration for the migration task."
    exit 1
  fi

  # No --task-definition here: the migration one-shot and the post-deploy task
  # run against DIFFERENT definitions, so each call names its own.
  one_shot_run_task_args=(
    ecs run-task
    --cluster "$CLUSTER"
    --count 1
    --network-configuration "$network_configuration"
  )

  capacity_provider_strategy="$(jq -c '.services[0].capacityProviderStrategy // []' <<<"$service_json")"
  if [[ "$capacity_provider_strategy" != "[]" ]]; then
    one_shot_run_task_args+=(--capacity-provider-strategy "$capacity_provider_strategy")
  else
    launch_type="$(jq -r '.services[0].launchType // "FARGATE"' <<<"$service_json")"
    one_shot_run_task_args+=(--launch-type "$launch_type")
    platform_version="$(jq -r '.services[0].platformVersion // empty' <<<"$service_json")"
    if [[ -n "$platform_version" ]]; then
      one_shot_run_task_args+=(--platform-version "$platform_version")
    fi
  fi
fi

# The migration family gets its own revision carrying THIS release's image.
#
# `run-task` cannot override an image — `containerOverrides` accepts a command,
# an environment and sizing, and nothing else — so the only way the one-shot
# applies the migrations from the release being deployed is to register a
# revision of the migration family pointing at the same digest. Rendered from
# the family's own latest revision so the credential and networking oxy-infra
# put there are carried forward untouched; the image is the only field replaced.
migration_task_definition=""
if [[ "$RUN_MIGRATIONS" == "true" ]]; then
  migration_task_definition_file="$(mktemp)"
  rendered_migration_task_definition_file="$(mktemp)"

  aws ecs describe-task-definition \
    --task-definition "$MIGRATION_TASK_DEFINITION_FAMILY" \
    --query taskDefinition \
    >"$migration_task_definition_file"

  migration_container_matches="$(jq --arg name "$MIGRATION_CONTAINER_NAME" \
    '[.containerDefinitions[] | select(.name == $name)] | length' \
    "$migration_task_definition_file")"
  if [[ "$migration_container_matches" != "1" ]]; then
    echo "::error::Expected exactly one container named $MIGRATION_CONTAINER_NAME in $MIGRATION_TASK_DEFINITION_FAMILY; found $migration_container_matches."
    exit 1
  fi

  # A migration task definition that does not carry the migrator credential
  # would run the one-shot as whatever role it does carry. Refuse: the entire
  # point of the split is that exactly one of the two roles reaches this
  # container, and a migration applied by the application role leaves every
  # table owned by it and row security enforcing nothing.
  if ! jq -e --arg name "$MIGRATION_CONTAINER_NAME" '
       [.containerDefinitions[] | select(.name == $name) | (.secrets // [])[].name]
       | index("MIGRATOR_DATABASE_URL") != null
     ' "$migration_task_definition_file" >/dev/null; then
    echo "::error::$MIGRATION_TASK_DEFINITION_FAMILY does not carry MIGRATOR_DATABASE_URL; the migration one-shot would run without the credential that owns the tables."
    exit 1
  fi

  jq \
    --arg name "$MIGRATION_CONTAINER_NAME" \
    --arg image "$IMAGE_URI" \
    '
      del(
        .taskDefinitionArn,
        .revision,
        .status,
        .requiresAttributes,
        .compatibilities,
        .registeredAt,
        .registeredBy
      )
      | .containerDefinitions |= map(
          if .name == $name then .image = $image else . end
        )
    ' \
    "$migration_task_definition_file" >"$rendered_migration_task_definition_file"

  migration_task_definition="$(aws ecs register-task-definition \
    --cli-input-json "file://$rendered_migration_task_definition_file" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)"
  echo "Registered migration task definition $migration_task_definition"

  # `pre` only, and only what is additive. This runs while the PREVIOUS image is
  # still serving, so anything that takes a column away would be an outage on it.
  if ! run_one_shot_command \
    "Migration (pre)" \
    "$migration_task_definition" \
    "$MIGRATION_CONTAINER_NAME" \
    "$(jq -cn --argjson base "$MIGRATION_COMMAND_JSON" --arg db "$MIGRATION_TARGET_DATABASE" \
        '$base + ["--target-database=" + $db, "--phase=pre"]')"; then
    exit 1
  fi
fi

if [[ -n "${DEPLOY_SHA:-}" ]]; then
  echo "Re-verifying origin/main immediately before the ECS service update."
  bash "$DEPLOY_HEAD_GUARD_SCRIPT"
fi

if ! aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$APP" \
  --task-definition "$new_task_definition" \
  --desired-count "$service_desired_count" \
  --deployment-configuration '{
    "deploymentCircuitBreaker": {"enable": true, "rollback": true},
    "minimumHealthyPercent": 100,
    "maximumPercent": 200
  }' \
  >/dev/null; then
  echo "::error::ECS rejected the service update; restoring the previous task definition defensively."
  if ! rollback_service; then
    echo "::error::The defensive rollback also failed; manual intervention is required."
  fi
  exit 1
fi

echo "Deploying immutable image $IMAGE_URI with task definition $new_task_definition"

if ! wait_for_service_rollout "$new_task_definition" "deployment"; then
  if ! rollback_service; then
    echo "::error::Deployment and explicit rollback both failed; manual intervention is required."
  fi
  exit 1
fi
echo "ECS rollout reached a healthy steady state at $new_task_definition"

if [[ -n "$POST_DEPLOY_SMOKE_SCRIPT" ]]; then
  echo "Running post-deploy smoke checks with $POST_DEPLOY_SMOKE_SCRIPT"
  if ! bash "$POST_DEPLOY_SMOKE_SCRIPT"; then
    echo "::error::Post-deploy smoke checks failed."
    if rollback_service; then
      echo "::warning::Rollback completed after smoke failure."
    else
      echo "::error::Rollback also failed; manual intervention is required."
    fi
    exit 1
  fi
fi

# `post` runs once the NEW image is live, which is what makes a DROP or a
# narrowed constraint safe: the image that still selected the removed column is
# gone. It BLOCKS if a `pre` migration is somehow still pending, which fails this
# task and rolls the service back — the correct repair, said out loud.
if [[ "$RUN_MIGRATIONS" == "true" ]]; then
  if ! run_one_shot_command \
    "Migration (post)" \
    "$migration_task_definition" \
    "$MIGRATION_CONTAINER_NAME" \
    "$(jq -cn --argjson base "$MIGRATION_COMMAND_JSON" --arg db "$MIGRATION_TARGET_DATABASE" \
        '$base + ["--target-database=" + $db, "--phase=post"]')"; then
    echo "::error::Post-rollout migration failed; rolling back to the image whose schema is on disk."
    if ! rollback_service; then
      echo "::error::The post migration and the rollback both failed; manual intervention is required."
    fi
    exit 1
  fi
fi

if [[ -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]]; then
  if ! run_one_shot_command \
    "Post-deploy reconciliation" \
    "$new_task_definition" \
    "$CONTAINER_NAME" \
    "$POST_DEPLOY_TASK_COMMAND_JSON"; then
    echo "::error::Post-deploy reconciliation failed."
    if ! rollback_service; then
      echo "::error::Reconciliation and rollback both failed; manual intervention is required."
    fi
    exit 1
  fi
fi

echo "Deployed $APP at $new_task_definition"
