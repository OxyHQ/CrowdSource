#!/usr/bin/env bun

// Exercises check-lockfile-sync.mjs against fixture workspaces that resolve
// entirely through the workspace protocol, so every case runs offline.
//
// A synced fixture and a desynced one are both required: a gate that cannot fail
// is indistinguishable from a gate that cannot pass, and this check is the only
// thing standing between a manifest bump and a lockfile that never got committed
// with it.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkScript = resolve(dirname(fileURLToPath(import.meta.url)), "check-lockfile-sync.mjs");
const decoder = new TextDecoder();
const createdFixtures = [];
const failures = [];

async function writeManifest(root, workspacePath, manifest) {
  const directory = join(root, workspacePath);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "crowdsource-lockfile-sync-"));
  createdFixtures.push(root);
  await writeManifest(root, ".", {
    name: "fixture-root",
    private: true,
    version: "0.0.0",
    packageManager: `bun@${Bun.version}`,
    workspaces: ["packages/*"],
    devDependencies: { alpha: "workspace:*", beta: "workspace:*" },
  });
  await writeManifest(root, "packages/alpha", {
    name: "alpha",
    private: true,
    version: "1.0.0",
    dependencies: { beta: "workspace:*" },
  });
  await writeManifest(root, "packages/beta", { name: "beta", private: true, version: "2.0.0" });

  const install = Bun.spawnSync({
    cmd: [process.execPath, "install", "--ignore-scripts"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `Fixture install failed: ${decoder.decode(install.stdout)}${decoder.decode(install.stderr)}`,
    );
  }
  return root;
}

function runCheck(root) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, checkScript],
    cwd: root,
    env: { ...process.env, LOCKFILE_SYNC_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
  };
}

async function expectVerdict(caseName, root, expectedExitCode, expectedFragment) {
  const lockfileBefore = await readFile(join(root, "bun.lock"), "utf8");
  const { exitCode, output } = runCheck(root);
  if (exitCode !== expectedExitCode) {
    failures.push(`${caseName}: expected exit ${expectedExitCode}, got ${exitCode}.\n${output}`);
    return;
  }
  if (!output.includes(expectedFragment)) {
    failures.push(`${caseName}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`);
    return;
  }
  // The check installs to reach its verdict, so it must hand back the lockfile it
  // was asked to judge. A check that leaves a repaired lockfile behind turns a
  // second run into a false pass.
  const lockfileAfter = await readFile(join(root, "bun.lock"), "utf8");
  if (lockfileAfter !== lockfileBefore) {
    failures.push(`${caseName}: the check left bun.lock modified.`);
  }
}

// A lockfile that matches its manifests must pass, or nothing below means anything.
const syncedFixture = await createFixture();
await expectVerdict("synced", syncedFixture, 0, "bun.lock is in sync");

// The mode a plain install cannot see: bun leaves a workspace's stale version in
// the lockfile and reports no changes, so only a direct comparison catches it.
const versionFixture = await createFixture();
await writeManifest(versionFixture, "packages/alpha", {
  name: "alpha",
  private: true,
  version: "1.0.1",
  dependencies: { beta: "workspace:*" },
});
await expectVerdict(
  "workspace-version-bumped",
  versionFixture,
  1,
  'packages/alpha is at version "1.0.1" but bun.lock records "1.0.0"',
);

// A renamed workspace leaves every dependent's recorded range pointing at a name
// that no longer exists.
const renameFixture = await createFixture();
await writeManifest(renameFixture, "packages/beta", {
  name: "beta-renamed",
  private: true,
  version: "2.0.0",
});
await expectVerdict(
  "workspace-renamed",
  renameFixture,
  1,
  'packages/beta is named "beta-renamed" but bun.lock records "beta"',
);

// A new package that no install has recorded yet: the lockfile describes a
// workspace set that is no longer the repository's.
const addedFixture = await createFixture();
await writeManifest(addedFixture, "packages/gamma", {
  name: "gamma",
  private: true,
  version: "3.0.0",
});
await expectVerdict(
  "workspace-added",
  addedFixture,
  1,
  "packages/gamma has a package.json that bun.lock does not record",
);

// A dependency removed from a manifest while the lockfile still resolves it. This
// one is invisible to the manifest comparison and is caught by the install
// reproduction instead.
const removedDependencyFixture = await createFixture();
await writeManifest(removedDependencyFixture, "packages/alpha", {
  name: "alpha",
  private: true,
  version: "1.0.0",
});
await expectVerdict(
  "dependency-removed",
  removedDependencyFixture,
  1,
  "two independent `bun install` runs rewrote it the same way",
);

// An override changed without reinstalling silently pins a different version of a
// transitive dependency than the lockfile resolves.
const overrideFixture = await createFixture();
await writeManifest(overrideFixture, ".", {
  name: "fixture-root",
  private: true,
  version: "0.0.0",
  packageManager: `bun@${Bun.version}`,
  workspaces: ["packages/*"],
  devDependencies: { alpha: "workspace:*", beta: "workspace:*" },
  overrides: { beta: "workspace:*" },
});
await expectVerdict("override-added", overrideFixture, 1, "override beta is");

// The pin protects the verdict itself: a lockfile written by another bun can
// differ on formatting alone, and this check must refuse rather than report a
// difference it caused.
const pinFixture = await createFixture();
const pinnedManifest = JSON.parse(await readFile(join(pinFixture, "package.json"), "utf8"));
await writeManifest(pinFixture, ".", { ...pinnedManifest, packageManager: "bun@0.0.1" });
await expectVerdict("bun-pin-mismatch", pinFixture, 1, "pins bun@0.0.1 but bun");

for (const fixture of createdFixtures) {
  if (fixture.startsWith(join(tmpdir(), "crowdsource-lockfile-sync-"))) {
    await rm(fixture, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error("Lockfile sync check tests failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Lockfile sync check discriminated ${createdFixtures.length} fixture case(s).`);
