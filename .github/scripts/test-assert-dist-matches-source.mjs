#!/usr/bin/env bun

// Mutation-tests the stale-artefact gate against fixture workspaces.
//
// The gate exists because a stale `dist/` file does not error, it ships. So the
// case that matters is `orphaned-emit`: a `dist/` file whose source is gone must
// fail and name the file. If that case ever passes, the gate is decorative.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "assert-dist-matches-source.mjs",
);
const fixturePrefix = join(tmpdir(), "crowdsource-dist-source-");
const decoder = new TextDecoder();
const createdFixtures = [];
const failures = [];

function runCheck(root) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, checkScript],
    cwd: root,
    env: { ...process.env, DIST_SOURCE_CHECK_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
  };
}

async function write(root, relativePath, contents = "") {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function createFixture({ withOrphan = false, withDist = true } = {}) {
  const root = await mkdtemp(fixturePrefix);
  createdFixtures.push(root);
  await write(
    root,
    "package.json",
    `${JSON.stringify({ name: "fixture-root", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
  );
  await write(root, "packages/alpha/package.json", `${JSON.stringify({ name: "alpha" }, null, 2)}\n`);
  await write(root, "packages/alpha/src/index.ts", "export const a = 1;\n");
  await write(root, "packages/alpha/src/nested/deep.ts", "export const d = 1;\n");
  // An entrypoint beside the package root rather than under src/, like the
  // backend's server.ts.
  await write(root, "packages/alpha/server.ts", "export const s = 1;\n");
  if (withDist) {
    await write(root, "packages/alpha/dist/index.js", "");
    await write(root, "packages/alpha/dist/index.d.ts", "");
    await write(root, "packages/alpha/dist/index.js.map", "");
    await write(root, "packages/alpha/dist/nested/deep.js", "");
    await write(root, "packages/alpha/dist/server.js", "");
    // Not an emitted artefact — must be ignored rather than reported.
    await write(root, "packages/alpha/dist/schema.json", "{}");
  }
  if (withOrphan) {
    await write(root, "packages/alpha/dist/uploads.js", "");
    await write(root, "packages/alpha/dist/uploads.js.map", "");
    await write(root, "packages/alpha/dist/uploads.d.ts", "");
  }
  return root;
}

async function expectVerdict(caseName, root, expectedExitCode, expectedFragment) {
  const { exitCode, output } = runCheck(root);
  if (exitCode !== expectedExitCode) {
    failures.push(`${caseName}: expected exit ${expectedExitCode}, got ${exitCode}.\n${output}`);
    return;
  }
  if (!output.includes(expectedFragment)) {
    failures.push(`${caseName}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`);
  }
}

// A dist whose every file has a source passes, or nothing below means anything.
await expectVerdict("clean-dist", await createFixture(), 0, "Every emitted file has a source.");

// The incident: a source deleted, its emitted files left behind.
const orphanFixture = await createFixture({ withOrphan: true });
await expectVerdict(
  "orphaned-emit",
  orphanFixture,
  1,
  "packages/alpha/dist/uploads.js",
);
// The sourcemap and the declaration are part of what ships, so both are named too.
for (const orphan of ["packages/alpha/dist/uploads.js.map", "packages/alpha/dist/uploads.d.ts"]) {
  const { output } = runCheck(orphanFixture);
  if (!output.includes(orphan)) failures.push(`orphaned-emit: did not name ${orphan}.`);
}

// Nothing built at all: a silent pass would read as "the artefacts are clean".
await expectVerdict(
  "nothing-built",
  await createFixture({ withDist: false }),
  1,
  "No package has a dist/ directory",
);

// A non-emitted file in dist/ (a copied JSON schema) is not an orphan.
const jsonFixture = await createFixture();
const jsonVerdict = runCheck(jsonFixture);
if (jsonVerdict.exitCode !== 0 || jsonVerdict.output.includes("schema.json")) {
  failures.push(`non-emitted-file: schema.json should be ignored.\n${jsonVerdict.output}`);
}

for (const fixture of createdFixtures) {
  if (fixture.startsWith(fixturePrefix)) await rm(fixture, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("Stale-artefact gate tests failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Stale-artefact gate discriminated ${createdFixtures.length} fixture case(s).`);
