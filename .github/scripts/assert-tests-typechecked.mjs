#!/usr/bin/env bun

// Refuses a package whose test files sit outside every type-checked project.
//
// `packages/backend`'s emitting tsconfig EXCLUDES `src/__tests__` and
// `**/*.test.ts` — correct, because tests must not reach the `dist/` the ECS image
// runs — and its `lint` was that config alone. So 48 test files were never
// type-checked, and a change that broke only test files passed lint. Whether it
// was caught depended entirely on whether the suite happened to run.
//
// The instance is easy to fix once. The CLASS is what this guards: a new package,
// or a new test directory outside an existing `include`, reopens the hole in
// exactly the same invisible way — nothing fails, the files are simply not looked
// at.
//
// tsc itself is the authority. `tsc -p <config> --showConfig` resolves the include
// and exclude globs to a concrete file list, so this never re-implements glob
// semantics and cannot disagree with the compiler about what is covered.

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  process.env.TYPECHECK_COVERAGE_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const typescriptBin = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;
const decoder = new TextDecoder();

function die(summary, details = []) {
  console.error(`::error::${summary}`);
  for (const detail of details) console.error(detail);
  process.exit(1);
}

async function walk(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".expo") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

// The tsconfigs a package's own gate scripts actually run. A config that exists
// but is never invoked covers nothing, so the scripts — not the directory
// listing — are what this reads.
function configsFromScripts(scripts) {
  const configs = new Set();
  for (const name of ["lint", "typecheck"]) {
    const script = scripts?.[name];
    if (typeof script !== "string") continue;
    for (const invocation of script.split("&&")) {
      if (!/(^|\s|\/)tsc(\s|$)/.test(invocation)) continue;
      const projectMatch = /-p\s+(\S+)|--project\s+(\S+)/.exec(invocation);
      configs.add(projectMatch ? (projectMatch[1] ?? projectMatch[2]) : "tsconfig.json");
    }
  }
  return [...configs];
}

async function filesCoveredBy(packageDirectory, configName) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, typescriptBin, "-p", configName, "--showConfig"],
    cwd: packageDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    die(
      `tsc could not resolve ${configName} in ${relative(repositoryRoot, packageDirectory)}, so what it covers is unknown.`,
      [decoder.decode(result.stderr)],
    );
  }
  let resolved;
  try {
    resolved = JSON.parse(decoder.decode(result.stdout));
  } catch (error) {
    die(`Could not parse --showConfig output for ${configName}: ${error.message}`);
  }
  return new Set(
    (resolved.files ?? []).map((file) => resolve(packageDirectory, file)),
  );
}

const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const patterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [];
if (patterns.length === 0) die("package.json declares no workspaces.");

const workspacePaths = [];
for (const pattern of patterns) {
  const globMatch = /^([A-Za-z0-9._-]+)\/\*$/.exec(String(pattern));
  if (!globMatch) {
    workspacePaths.push(String(pattern).replace(/\/+$/, ""));
    continue;
  }
  const [, directory] = globMatch;
  for (const entry of await readdir(join(repositoryRoot, directory), { withFileTypes: true })) {
    if (entry.isDirectory()) workspacePaths.push(`${directory}/${entry.name}`);
  }
}

const uncovered = [];
const report = [];
for (const workspacePath of workspacePaths) {
  const packageDirectory = join(repositoryRoot, workspacePath);
  const manifestPath = join(packageDirectory, "package.json");
  try {
    if (!(await stat(manifestPath)).isFile()) continue;
  } catch {
    continue;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const testFiles = (await walk(packageDirectory)).filter((path) =>
    TEST_FILE_PATTERN.test(path),
  );
  if (testFiles.length === 0) continue;

  const configs = configsFromScripts(manifest.scripts);
  if (configs.length === 0) {
    uncovered.push(
      `${workspacePath} has ${testFiles.length} test file(s) but neither its lint nor its typecheck script runs tsc, so none of them is type-checked.`,
    );
    continue;
  }

  const covered = new Set();
  for (const configName of configs) {
    for (const file of await filesCoveredBy(packageDirectory, configName)) covered.add(file);
  }
  const missing = testFiles.filter((file) => !covered.has(resolve(file)));
  if (missing.length > 0) {
    uncovered.push(
      `${workspacePath}: ${missing.length} of ${testFiles.length} test file(s) are outside every type-checked project (${configs.join(", ")}), starting with ${relative(repositoryRoot, missing[0])}`,
    );
  }
  report.push(
    `${workspacePath}: ${testFiles.length} test file(s), ${testFiles.length - missing.length} type-checked via ${configs.join(" + ")}.`,
  );
}

// Vacuity floor: this repository has test files in most packages, so an empty
// report means the traversal broke and every assertion above examined nothing.
if (report.length < 2) {
  die(
    `Only ${report.length} package(s) with test files were found; this repository has more, so the traversal is broken and nothing was verified.`,
  );
}

for (const line of report) console.log(line);

if (uncovered.length > 0) {
  die("Test files are not type-checked:", [
    ...uncovered.map((entry) => `  - ${entry}`),
    "",
    "A test that does not compile is a test nobody is running, and lint passing is",
    "not evidence that it does. Add a type-check-only project covering the tests",
    "(see packages/backend/tsconfig.test.json) and run it from the package's lint.",
  ]);
}

console.log("Every package's test files are type-checked.");
