#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = await readJson("package.json");
const expectedBunVersion = String(rootManifest.packageManager || "").replace(/^bun@/, "");
const expectedNodeVersion = "22.17.0";
// The Bloom release the whole workspace is pinned to — manifest range, root
// override and installed copy must all agree on it. Bump this ONE constant when
// taking a new Bloom.
const expectedBloomVersion = "0.67.0";
const failures = [];

if (!expectedBunVersion) {
  failures.push("package.json must declare packageManager as bun@<version>.");
} else if (Bun.version !== expectedBunVersion) {
  failures.push(
    `Bun ${expectedBunVersion} is required, but ${Bun.version} is running. ` +
      "Install the pinned version before building or changing bun.lock.",
  );
}

const nodeVersionResult = Bun.spawnSync({
  cmd: ["node", "--version"],
  cwd: repositoryRoot,
  stdout: "pipe",
  stderr: "pipe",
});
const actualNodeVersion = new TextDecoder().decode(nodeVersionResult.stdout).trim().replace(/^v/, "");
if (nodeVersionResult.exitCode !== 0 || actualNodeVersion !== expectedNodeVersion) {
  failures.push(
    `Node ${expectedNodeVersion} is required for Jest/Expo, but ${actualNodeVersion || "no Node runtime"} is available.`,
  );
}

if (
  !Array.isArray(rootManifest.workspaces) ||
  rootManifest.workspaces.length !== 1 ||
  rootManifest.workspaces[0] !== "packages/*"
) {
  failures.push("package.json workspaces must be exactly packages/*.");
}

if (Object.keys(rootManifest.dependencies || {}).length > 0) {
  failures.push("Runtime dependencies must live in their owning workspace, not the repository root.");
}

const installedExpo = await readJson("node_modules/expo/package.json");
const installedBloom = await readJson("node_modules/@oxyhq/bloom/package.json");

if (!String(installedExpo.version || "").startsWith("56.")) {
  failures.push(`Installed Expo must be version 56.x (found ${String(installedExpo.version)}).`);
}
if (
  rootManifest.overrides?.["@oxyhq/bloom"] !== `^${expectedBloomVersion}` ||
  installedBloom.version !== expectedBloomVersion
) {
  failures.push(
    `Bloom must stay aligned at override ^${expectedBloomVersion} and installed ${expectedBloomVersion} ` +
      `(found ${String(rootManifest.overrides?.["@oxyhq/bloom"])}, ${String(installedBloom.version)}).`,
  );
}

/**
 * BOTH Expo apps, checked identically.
 *
 * The reviewer app and the console are separate exports of the same platform, and a
 * drift between them is worse than a drift from the pin: two apps on different React
 * Native versions inside one `node_modules` means whichever resolves first decides,
 * and the symptom is a runtime failure in one app after a change to the other.
 */
for (const appName of ["reviewer", "console"]) {
  const manifest = await readJson(`packages/${appName}/package.json`);

  if (!String(manifest.dependencies?.expo || "").startsWith("~56.")) {
    failures.push(`The ${appName} app must target Expo 56 (found ${String(manifest.dependencies?.expo)}).`);
  }
  if (manifest.dependencies?.react !== "19.2.3") {
    failures.push(`The ${appName} app must target React 19.2.3 (found ${String(manifest.dependencies?.react)}).`);
  }
  if (manifest.dependencies?.["react-native"] !== "0.85.3") {
    failures.push(
      `The ${appName} app must target React Native 0.85.3 (found ${String(manifest.dependencies?.["react-native"])}).`,
    );
  }
  if (manifest.dependencies?.["@oxyhq/bloom"] !== `^${expectedBloomVersion}`) {
    failures.push(
      `The ${appName} app must declare Bloom ^${expectedBloomVersion} ` +
        `(found ${String(manifest.dependencies?.["@oxyhq/bloom"])}).`,
    );
  }
}

// Every workspace that consumes the shared contracts must resolve them from
// this repository, never from a published version that can drift behind it.
for (const packageName of ["backend", "reviewer", "console", "sdk", "sdk-express", "testing"]) {
  const manifest = await readJson(`packages/${packageName}/package.json`);
  const range =
    manifest.dependencies?.["@oxyhq/crowdsource-contracts"] ??
    manifest.devDependencies?.["@oxyhq/crowdsource-contracts"];

  if (range !== "workspace:*") {
    failures.push(
      `packages/${packageName}/package.json must declare @oxyhq/crowdsource-contracts as workspace:* (found ${String(range)}).`,
    );
  }
}

// The image audit fails in BOTH directions, so the workspaces it expects must
// track the Dockerfile's `--filter` arguments. A rename that updates one and not
// the other passes locally and fails only during a production rollout.
const runtimeWorkspaces = ["@crowdsource/backend", "@oxyhq/crowdsource-contracts"];
const backendDockerfile = await readFile(
  resolve(repositoryRoot, "packages/backend/Dockerfile"),
  "utf8",
);
const deployWorkflow = await readFile(
  resolve(repositoryRoot, ".github/workflows/deploy-aws.yml"),
  "utf8",
);
for (const workspace of runtimeWorkspaces) {
  if (!backendDockerfile.includes(`--filter ${workspace}`)) {
    failures.push(`packages/backend/Dockerfile must build ${workspace} (--filter ${workspace} is missing).`);
  }
}
if (!deployWorkflow.includes(`EXPECTED_WORKSPACE_PACKAGES: '${runtimeWorkspaces.join(",")}'`)) {
  failures.push(
    `deploy-aws.yml must set EXPECTED_WORKSPACE_PACKAGES to '${runtimeWorkspaces.join(",")}' so the image audit matches the Dockerfile.`,
  );
}

if (failures.length > 0) {
  console.error("CrowdSource workspace doctor found configuration drift:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `CrowdSource workspace is reproducible: Bun ${Bun.version}, Node ${actualNodeVersion}, Expo ${installedExpo.version}, ` +
    `Bloom ${installedBloom.version}, workspace dependencies and the runtime image scope are aligned.`,
);

async function readJson(relativePath) {
  const contents = await readFile(resolve(repositoryRoot, relativePath), "utf8");
  return JSON.parse(contents);
}
