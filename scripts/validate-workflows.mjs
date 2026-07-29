#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDirectory = resolve(repositoryRoot, ".github/workflows");
const workflowNames = (await readdir(workflowsDirectory))
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

const failures = [];
for (const workflowName of workflowNames) {
  const source = await readFile(resolve(workflowsDirectory, workflowName), "utf8");
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  for (const error of document.errors) {
    failures.push(`${workflowName}: ${error.message}`);
  }

  if (document.errors.length === 0) {
    const workflow = document.toJS();

    // This repository shares one AWS account, one ECS cluster and one SSM tree
    // with every other Oxy backend, so a release here is one wrong identifier
    // away from redeploying a different product. Pin the identifiers that
    // select the blast radius: APP names the ECS service, the ECR repository
    // and the /oxy/<app>/ parameter namespace all at once.
    for (const parameterNamespace of source.match(/\/oxy\/[A-Za-z0-9_.-]+\//g) ||
      []) {
      if (parameterNamespace !== "/oxy/crowdsource/") {
        failures.push(
          `${workflowName}: ${parameterNamespace} is outside this app's /oxy/crowdsource/ namespace; a release must never read or write another Oxy app's parameters`,
        );
      }
    }

    // The lockfile gate is the only thing enforcing that a manifest change and
    // its bun.lock update land in one commit. That rule was skipped once already,
    // and two npm versions were burned publishing from states that were never
    // committed. The gate needs a plain install so it runs in a job of its own,
    // which is why this assertion belongs here: `bun run check` runs in a
    // DIFFERENT job, so deleting the gate is caught by a job the deletion did not
    // touch.
    if (workflowName === "ci.yml") {
      const jobs = Object.entries(workflow?.jobs || {});
      const runsScript = (job, pattern) =>
        (job?.steps || []).some(
          (step) => typeof step?.run === "string" && pattern.test(step.run),
        );
      // The lookbehind is load-bearing: test-check-lockfile-sync.mjs contains
      // check-lockfile-sync.mjs, so a substring match accepts the gate's tests as
      // the gate itself and passes with the gate deleted.
      for (const [pattern, script, reason] of [
        [
          /(?<![\w-])check-lockfile-sync\.mjs/,
          "check-lockfile-sync.mjs",
          "nothing else enforces that a package.json change and its bun.lock update land in one commit",
        ],
        [
          /(?<![\w-])test-check-lockfile-sync\.mjs/,
          "test-check-lockfile-sync.mjs",
          "without its own tests the lockfile gate can stop discriminating without anything noticing",
        ],
      ]) {
        if (!jobs.some(([, job]) => runsScript(job, pattern))) {
          failures.push(`${workflowName}: CI must run scripts/${script}; ${reason}`);
        }
      }
    }

    if (source.includes("configure-aws-credentials")) {
      for (const [pinnedName, expectedValue] of [
        ["APP", "crowdsource"],
        ["CONTAINER_NAME", "crowdsource"],
        ["CLUSTER", "oxy-cluster"],
      ]) {
        if (workflow?.env?.[pinnedName] !== expectedValue) {
          failures.push(
            `${workflowName}: AWS production workflows must pin env.${pinnedName} to ${expectedValue}; it selects the deployment target shared with every other Oxy backend`,
          );
        }
      }
      for (const [jobName, job] of Object.entries(workflow?.jobs || {})) {
        if (job?.environment != null) {
          failures.push(
            `${workflowName}: AWS job ${jobName} must not attach a GitHub environment while the deploy-role trust only accepts the main ref subject`,
          );
        }
      }
      const currentMainGuardCount = source
        .split("require-current-main.sh")
        .length - 1;
      if (currentMainGuardCount < 2) {
        failures.push(
          `${workflowName}: AWS production workflows must verify current origin/main before build and execution`,
        );
      }
      if (source.includes("aws ecr describe-images")) {
        failures.push(
          `${workflowName}: deploy role lacks ecr:DescribeImages; consume the immutable build action digest instead`,
        );
      }
      if (source.includes("aws ecs stop-task")) {
        failures.push(
          `${workflowName}: deploy role lacks ecs:StopTask; workflow must not depend on it`,
        );
      }
      if (
        workflowName === "run-federated-text-backfill.yml" &&
        (!source.includes(
          '"busybox","timeout","-s","TERM","-k","30","3300"',
        ) ||
          !source.includes("EXPECTED_RUNTIME_COMMANDS: 'bun,busybox'"))
      ) {
        failures.push(
          `${workflowName}: backfill command must remain container-bounded and the image audit must verify BusyBox`,
        );
      }
    }
    if (workflow?.on?.workflow_run && workflowName.startsWith("deploy-")) {
      const currentMainGuardCount = source
        .split("require-current-main.sh")
        .length - 1;
      if (currentMainGuardCount < 2) {
        failures.push(
          `${workflowName}: production workflow_run releases must verify origin/main before both build and deploy`,
        );
      }
      if (
        source.includes("steps.changes.outputs.deploy") ||
        source.includes("git diff --quiet")
      ) {
        failures.push(
          `${workflowName}: production workflow_run releases must not skip artifacts from a single-commit path diff`,
        );
      }

      // deployment-scope.sh diffs the candidate against the `deployed/<target>`
      // marker and silently degrades to the single-commit diff when the marker
      // is absent, so the checkout must actually deliver the tag and history,
      // and a green rollout must move the marker forward.
      const jobs = Object.entries(workflow?.jobs || {});
      const stepRuns = (job) =>
        (job?.steps || []).map((step) =>
          typeof step?.run === "string" ? step.run : "",
        );

      const scopeJob = jobs.find(([, job]) =>
        stepRuns(job).some((run) => run.includes("deployment-scope.sh")),
      );
      if (!scopeJob) {
        failures.push(
          `${workflowName}: production workflow_run releases must resolve their scope through deployment-scope.sh`,
        );
      } else {
        const [scopeName, job] = scopeJob;
        const checkout = (job?.steps || []).find(
          (step) =>
            typeof step?.uses === "string" &&
            step.uses.startsWith("actions/checkout@"),
        );
        if (
          checkout?.with?.["fetch-depth"] !== 0 ||
          checkout?.with?.["fetch-tags"] !== true
        ) {
          failures.push(
            `${workflowName}: ${scopeName} must check out with fetch-depth: 0 and fetch-tags: true, otherwise the deployed/<target> marker is missing and the scope silently narrows to one commit`,
          );
        }
      }

      const recordJob = jobs.find(([, job]) =>
        stepRuns(job).some((run) => run.includes("record-deployment.sh")),
      );
      if (!recordJob) {
        failures.push(
          `${workflowName}: a successful rollout must move its deployed/<target> marker through record-deployment.sh`,
        );
      } else {
        const [recordName, job] = recordJob;
        if (job?.permissions?.contents !== "write") {
          failures.push(
            `${workflowName}: ${recordName} must request job-level contents: write to move the marker`,
          );
        }
        const needs = Array.isArray(job?.needs)
          ? job.needs
          : job?.needs
            ? [job.needs]
            : [];
        if (needs.length === 0) {
          failures.push(
            `${workflowName}: ${recordName} must depend on the deploy job so the marker only moves after a green rollout`,
          );
        }
        if (/\b(always|failure|cancelled)\s*\(/.test(String(job?.if ?? ""))) {
          failures.push(
            `${workflowName}: ${recordName} must not run on a failed or cancelled rollout; a marker moved past an undeployed change orphans it permanently`,
          );
        }
      }

      if (workflow?.permissions?.contents === "write") {
        failures.push(
          `${workflowName}: workflow-level contents: write would hand a push-capable token to the build job; scope it to the marker job instead`,
        );
      }

      if (workflowName === "deploy-aws.yml") {
        const buildIndex = source.indexOf("Build and push immutable");
        const auditIndex = source.indexOf("audit-runtime-image.sh");
        const productionChangesIndex = source.indexOf(
          "Verify current main before production changes",
        );
        if (
          buildIndex < 0 ||
          auditIndex < buildIndex ||
          productionChangesIndex < auditIndex
        ) {
          failures.push(
            `${workflowName}: final runtime image audit must run after the immutable build and before production changes`,
          );
        }
        for (const unsupportedElbSetting of [
          "HEALTH_CHECK_PATH:",
          "EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH:",
          "ENABLE_TARGET_STICKINESS:",
          "TARGET_STICKINESS_SECONDS:",
        ]) {
          if (source.includes(unsupportedElbSetting)) {
            failures.push(
              `${workflowName}: ${unsupportedElbSetting.slice(0, -1)} requires ELB permissions that the production deploy role does not have`,
            );
          }
        }
      }

      if (workflowName === "deploy-frontends.yml") {
        const buildIndex = source.indexOf("Build reviewer");
        const staticValidationIndex = source.indexOf(
          "validate-frontend-static-output.mjs",
        );
        const productionChangesIndex = source.indexOf(
          "Verify current main before production changes",
        );
        if (
          buildIndex < 0 ||
          staticValidationIndex < buildIndex ||
          productionChangesIndex < staticValidationIndex
        ) {
          failures.push(
            `${workflowName}: static hosting contract validation must run after export and before production changes`,
          );
        }

        const productionSmokeIndex = source.indexOf("id: production_smoke");
        const rollbackIndex = source.indexOf(
          "Roll back Cloudflare Pages after a failed production smoke",
        );
        if (productionSmokeIndex < 0 || rollbackIndex < productionSmokeIndex) {
          failures.push(
            `${workflowName}: the exact Pages smoke and its rollback must remain separate and ordered`,
          );
        }
        if (
          !source.includes("steps.production_smoke.outcome == 'failure'")
        ) {
          failures.push(
            `${workflowName}: only a failed Pages smoke may roll back a Pages deployment`,
          );
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error("GitHub Actions YAML validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Validated ${workflowNames.length} GitHub Actions workflow file(s).`);
