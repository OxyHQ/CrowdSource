#!/usr/bin/env bun

// A manifest change and its bun.lock update must land in ONE commit. Nothing in
// CI enforced that, and the omission is what let @oxyhq/services@23.0.0 and
// @oxyhq/core@14.0.0 be published from states that were never committed — two
// version numbers npm will never hand out again.
//
// `bun install --frozen-lockfile` cannot be that gate. Measured in this
// repository on bun 1.3.14: with the root manifest's `yaml` range widened from
// ^2.9.0 to >=2.9.0 and bun.lock left untouched, it exits 0 and reports "no
// changes", while a plain install rewrites the lockfile. It fails only when a
// range resolves to nothing at all, which is a resolution error rather than a
// sync check.
//
// Two things are checked here, because neither covers the other.
//
//   1. What bun.lock records about each workspace, against the manifest at that
//      path. A workspace's own `version` bumped without regenerating the lockfile
//      is NOT repaired by a plain install — measured: bun leaves the stale value
//      in place and reports "no changes" — so an install-based check is blind to
//      this mode, and it is the mode that survived six commits on main in
//      OxyHQServices.
//   2. Whether a plain install rewrites the lockfile, which is what covers
//      dependency ranges, added and removed dependencies, and resolution drift.
//
// The second check has to tell a property of the commit apart from bun's own
// churn, because a gate that fails a green commit is switched off by whoever hits
// it first. So a rewrite is reproduced: the lockfile is restored, a second
// independent install runs, and only a change BOTH installs make is treated as
// the commit's. A change one run makes and the other does not is reported and
// does not fail.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// LOCKFILE_SYNC_ROOT exists so this check can be exercised against fixture
// workspaces (see test-check-lockfile-sync.mjs). Nothing in CI sets it, so a
// release is always measured against this repository.
const repositoryRoot = resolve(
  process.env.LOCKFILE_SYNC_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const lockfilePath = join(repositoryRoot, "bun.lock");
const ROOT_WORKSPACE = "";
const MAX_REPORTED_CHANGES = 40;
const decoder = new TextDecoder();

function die(summary, details = []) {
  console.error(`::error::${summary}`);
  for (const detail of details) console.error(detail);
  process.exit(1);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    die(`Could not read ${path} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// bun writes bun.lock as JSON with trailing commas, which JSON.parse rejects. The
// substitution only removes a comma that is followed by whitespace and a closing
// brace or bracket; no package name, version range or integrity hash in a
// lockfile contains that sequence. A format change that defeats it surfaces as a
// parse failure or as the vacuity floor below, never as a check that quietly
// compares nothing.
function parseLockfile(text) {
  try {
    return JSON.parse(text.replace(/,(?=\s*[}\]])/g, ""));
  } catch (error) {
    die(
      `bun.lock could not be parsed, so what it records about each workspace cannot be compared: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const rootManifest = await readJson(join(repositoryRoot, "package.json"));

// A lockfile written by a different bun can differ on formatting alone, so a
// difference this runtime caused must never be reported as the commit's.
const pinnedBunVersion = String(rootManifest.packageManager ?? "").replace(/^bun@/, "");
if (!pinnedBunVersion) {
  die(
    "package.json must declare packageManager as bun@<version>; without that pin a lockfile difference cannot be told apart from one the running bun introduced.",
  );
}
if (Bun.version !== pinnedBunVersion) {
  die(
    `This repository pins bun@${pinnedBunVersion} but bun ${Bun.version} is running. Install the pinned version before checking or regenerating bun.lock.`,
  );
}

const lockfileText = await readFile(lockfilePath, "utf8");
const lockfile = parseLockfile(lockfileText);
const recordedWorkspaces = lockfile.workspaces;
if (typeof recordedWorkspaces !== "object" || recordedWorkspaces === null) {
  die("bun.lock records no workspaces object, so there is nothing to compare against the manifests.");
}

// Vacuity floor: this is a workspace repository, so a lockfile that records only
// the root means the traversal or the lockfile format changed and every
// comparison below would pass by examining nothing.
const recordedWorkspacePaths = Object.keys(recordedWorkspaces);
if (recordedWorkspacePaths.length < 2) {
  die(
    `bun.lock records ${recordedWorkspacePaths.length} workspace(s); a workspace repository must record the root and every package, so this check cannot verify anything.`,
  );
}

const declaredPatterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [];
if (declaredPatterns.length === 0) {
  die("package.json declares no workspaces array, so the packages bun.lock should describe cannot be enumerated.");
}

const manifestWorkspacePaths = [ROOT_WORKSPACE];
for (const pattern of declaredPatterns) {
  const patternMatch = /^([A-Za-z0-9._-]+)\/\*$/.exec(String(pattern));
  if (!patternMatch) {
    die(
      `Unsupported workspace pattern ${pattern}. This check only models <directory>/*; teach it the new shape rather than letting it stop comparing workspaces.`,
    );
  }
  const [, workspaceDirectory] = patternMatch;
  const entries = await readdir(join(repositoryRoot, workspaceDirectory), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = `${workspaceDirectory}/${entry.name}`;
    if (!(await Bun.file(join(repositoryRoot, workspacePath, "package.json")).exists())) continue;
    manifestWorkspacePaths.push(workspacePath);
  }
}

const staleRecords = [];
for (const workspacePath of manifestWorkspacePaths) {
  if (!(workspacePath in recordedWorkspaces)) {
    staleRecords.push(`${workspacePath || "the repository root"} has a package.json that bun.lock does not record.`);
  }
}
for (const workspacePath of recordedWorkspacePaths) {
  if (!manifestWorkspacePaths.includes(workspacePath)) {
    staleRecords.push(`bun.lock records ${workspacePath}, which has no package.json.`);
  }
}

for (const workspacePath of manifestWorkspacePaths) {
  const recorded = recordedWorkspaces[workspacePath];
  if (typeof recorded !== "object" || recorded === null) continue;
  const label = workspacePath || "the repository root";
  const manifest = await readJson(join(repositoryRoot, workspacePath, "package.json"));

  if (manifest.name !== recorded.name) {
    staleRecords.push(
      `${label} is named ${JSON.stringify(manifest.name)} but bun.lock records ${JSON.stringify(recorded.name)}.`,
    );
  }

  // bun does not record a version for the root workspace, which is private and
  // never resolved by anything. For every other workspace it does, so a missing
  // one means the comparison silently stopped covering this mode.
  if (workspacePath === ROOT_WORKSPACE || manifest.version === undefined) continue;
  if (recorded.version === undefined) {
    staleRecords.push(
      `${label} declares version ${JSON.stringify(manifest.version)} but bun.lock records no version for it.`,
    );
  } else if (manifest.version !== recorded.version) {
    staleRecords.push(
      `${label} is at version ${JSON.stringify(manifest.version)} but bun.lock records ${JSON.stringify(recorded.version)}.`,
    );
  }
}

// bun merges `resolutions` into the overrides it records. Nothing here uses that
// spelling, and a check that compared only `overrides` while a manifest declared
// `resolutions` would report a difference that is not one.
if (rootManifest.resolutions !== undefined) {
  die(
    "package.json declares resolutions, which this check does not model alongside overrides. Extend it before adopting that spelling.",
  );
}
const declaredOverrides = rootManifest.overrides ?? {};
const recordedOverrides = lockfile.overrides ?? {};
for (const name of [...new Set([...Object.keys(declaredOverrides), ...Object.keys(recordedOverrides)])].sort()) {
  if (declaredOverrides[name] !== recordedOverrides[name]) {
    staleRecords.push(
      `override ${name} is ${JSON.stringify(declaredOverrides[name] ?? null)} in package.json but ${JSON.stringify(recordedOverrides[name] ?? null)} in bun.lock.`,
    );
  }
}

if (staleRecords.length > 0) {
  die("bun.lock does not match the manifests it describes:", [
    ...staleRecords.map((record) => `- ${record}`),
    "",
    "Run `bun install` and commit bun.lock in the SAME commit as the manifest change.",
  ]);
}

function runInstall(label) {
  // --ignore-scripts matches how CI installs and keeps the root postinstall from
  // building packages; it has no effect on resolution or on what bun writes to
  // the lockfile.
  const result = Bun.spawnSync({
    cmd: [process.execPath, "install", "--ignore-scripts"],
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`;
  if (result.exitCode !== 0) {
    return {
      ok: false,
      summary: `The ${label} \`bun install\` exited ${result.exitCode}, so the lockfile it would have produced cannot be compared.`,
      details: output.split("\n"),
    };
  }
  // bun has reported `error: Fail extracting tarball for "<package>"` and still
  // exited 0, leaving that package absent from the tree. A gate that trusts the
  // exit code measures an install that never completed.
  const reportedErrors = output.split("\n").filter((line) => /^\s*error:/.test(line));
  if (reportedErrors.length > 0) {
    return {
      ok: false,
      summary: `The ${label} \`bun install\` reported an error while exiting 0, so its lockfile cannot be trusted.`,
      details: reportedErrors,
    };
  }
  return { ok: true };
}

function tallyLines(text) {
  const counts = new Map();
  for (const line of text.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

// A multiset difference rather than a positional diff: what matters is which
// lines an install added or removed, so the same change made at a different
// offset still compares equal between two runs.
function changesBetween(before, after) {
  const beforeCounts = tallyLines(before);
  const afterCounts = tallyLines(after);
  const changes = new Map();
  for (const [line, count] of beforeCounts) {
    const surplus = count - (afterCounts.get(line) ?? 0);
    if (surplus > 0) changes.set(`-${line}`, surplus);
  }
  for (const [line, count] of afterCounts) {
    const surplus = count - (beforeCounts.get(line) ?? 0);
    if (surplus > 0) changes.set(`+${line}`, surplus);
  }
  return changes;
}

function changesInBoth(firstChanges, secondChanges) {
  const shared = new Map();
  for (const [change, count] of firstChanges) {
    const both = Math.min(count, secondChanges.get(change) ?? 0);
    if (both > 0) shared.set(change, both);
  }
  return shared;
}

// Attributes a lockfile line to the workspace or package whose block it sits in,
// so a failure names what to fix instead of printing anonymous JSON.
function ownersByLine(text) {
  const owners = new Map();
  let section = "";
  let entry = null;
  for (const line of text.split("\n")) {
    const sectionMatch = /^ {2}"([^"]+)": [{[]$/.exec(line);
    if (sectionMatch) {
      [, section] = sectionMatch;
      entry = null;
    } else {
      const entryMatch = /^ {4}"([^"]*)":/.exec(line);
      if (entryMatch) [, entry] = entryMatch;
    }
    if (!owners.has(line)) {
      owners.set(
        line,
        section === ""
          ? "lockfile metadata"
          : entry === null
            ? section
            : `${section} → ${entry || "the repository root"}`,
      );
    }
  }
  return owners;
}

function describeChanges(changes, baselineOwners, candidateOwners) {
  const described = [];
  for (const change of changes.keys()) {
    const line = change.slice(1);
    const owners = change.startsWith("+") ? candidateOwners : baselineOwners;
    described.push(`- ${owners.get(line) ?? "an unattributed block"}: ${change}`);
  }
  described.sort();
  if (described.length > MAX_REPORTED_CHANGES) {
    const hidden = described.length - MAX_REPORTED_CHANGES;
    return [...described.slice(0, MAX_REPORTED_CHANGES), `- …and ${hidden} more changed line(s).`];
  }
  return described;
}

const baseline = lockfileText;
let restoreLockfile = false;
let firstInstall;
let secondInstall;
let firstCandidate = baseline;
let secondCandidate = baseline;
try {
  firstInstall = runInstall("first");
  if (firstInstall.ok) {
    firstCandidate = await readFile(lockfilePath, "utf8");
    if (firstCandidate !== baseline) {
      restoreLockfile = true;
      await writeFile(lockfilePath, baseline);
      secondInstall = runInstall("second");
      if (secondInstall.ok) secondCandidate = await readFile(lockfilePath, "utf8");
    }
  }
} finally {
  if (restoreLockfile) await writeFile(lockfilePath, baseline);
}

if (!firstInstall.ok) die(firstInstall.summary, firstInstall.details);
if (secondInstall && !secondInstall.ok) die(secondInstall.summary, secondInstall.details);

if (firstCandidate === baseline) {
  console.log(
    "bun.lock is in sync: it matches every manifest it describes, and a plain `bun install` left it byte-identical.",
  );
  process.exit(0);
}

const firstChanges = changesBetween(baseline, firstCandidate);
const secondChanges = changesBetween(baseline, secondCandidate);
const reproducedChanges = changesInBoth(firstChanges, secondChanges);
const baselineOwners = ownersByLine(baseline);

if (reproducedChanges.size > 0) {
  die("bun.lock is not the lockfile these manifests produce: two independent `bun install` runs rewrote it the same way.", [
    ...describeChanges(reproducedChanges, baselineOwners, ownersByLine(firstCandidate)),
    "",
    "Run `bun install` and commit bun.lock in the SAME commit as the manifest change.",
  ]);
}

// Every line the two runs changed, they changed differently, so nothing here is a
// property of the commit. Reported rather than failed: this is exactly the shape
// that makes a gate untrustworthy, and it needs to be visible when it happens.
console.log(
  `::warning::A plain \`bun install\` rewrote bun.lock, but the two runs agreed on none of the lines they changed (${firstChanges.size} and ${secondChanges.size} respectively), so the rewrite is not attributable to these manifests.`,
);
for (const line of describeChanges(firstChanges, baselineOwners, ownersByLine(firstCandidate))) {
  console.log(`first run ${line}`);
}
for (const line of describeChanges(secondChanges, baselineOwners, ownersByLine(secondCandidate))) {
  console.log(`second run ${line}`);
}
