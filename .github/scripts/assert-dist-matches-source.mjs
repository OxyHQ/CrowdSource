#!/usr/bin/env bun

// Refuses a build whose `dist/` holds a file with no corresponding source.
//
// `bun run clean && bun run build` can silently no-op: `clean` removes `dist/`
// but not `tsconfig.tsbuildinfo`, so tsc believes its outputs are current and
// emits nothing. Whatever `dist/` is reconstructed from an incremental build is
// then whatever survived — and the first 0.3.0 pack shipped a stale
// `dist/uploads.js` whose source had been DELETED, with sourcemaps pointing at
// code that no longer exists. It was caught by a manual tarball inspection.
//
// A stale artefact does not error. It just ships. That is the whole problem: the
// defect is invisible by construction, so the only thing that finds it is a check
// that compares the emitted file set against the source file set.
//
// This asks one question per emitted file: is there a source that could have
// produced it? A file whose source is gone is the exact shape of the incident.
// The reverse direction — a source with no emitted file — is deliberately NOT
// checked here: `.d.ts`-only modules, type-only files erased by the compiler and
// test files excluded from the emitting project all legitimately produce nothing.

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// DIST_SOURCE_CHECK_ROOT exists so the check can be exercised against fixtures
// (see test-assert-dist-matches-source.mjs). Nothing in CI sets it, so a release
// is always measured against this repository.
const repositoryRoot = resolve(
  process.env.DIST_SOURCE_CHECK_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);

// Emitted extensions tsc and bob produce, paired with the source extensions that
// could have produced them.
const EMITTED_SUFFIXES = [".js", ".mjs", ".cjs", ".d.ts", ".d.mts", ".d.cts"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".json"];

function die(summary, details = []) {
  console.error(`::error::${summary}`);
  for (const detail of details) console.error(detail);
  process.exit(1);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

// Strips the emitted suffix, and a `.map` before it, so `x.d.ts.map`, `x.js.map`,
// `x.d.ts` and `x.js` all reduce to `x`.
function emittedBase(relativePath) {
  const withoutMap = relativePath.endsWith(".map")
    ? relativePath.slice(0, -".map".length)
    : relativePath;
  for (const suffix of EMITTED_SUFFIXES) {
    if (withoutMap.endsWith(suffix)) return withoutMap.slice(0, -suffix.length);
  }
  return null;
}

const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const patterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [];
if (patterns.length === 0) {
  die("package.json declares no workspaces, so there are no packages to check.");
}

const workspacePaths = [];
for (const pattern of patterns) {
  const globMatch = /^([A-Za-z0-9._-]+)\/\*$/.exec(String(pattern));
  if (!globMatch) {
    const path = String(pattern).replace(/\/+$/, "");
    if (/[*?[\]{}]/.test(path)) {
      die(
        `Unsupported workspace pattern ${pattern}. This check models an explicit path or <directory>/*; teach it the new shape rather than letting it stop checking packages.`,
      );
    }
    workspacePaths.push(path);
    continue;
  }
  const [, directory] = globMatch;
  for (const entry of await readdir(join(repositoryRoot, directory), { withFileTypes: true })) {
    if (entry.isDirectory()) workspacePaths.push(`${directory}/${entry.name}`);
  }
}

const orphans = [];
const checked = [];
for (const workspacePath of workspacePaths) {
  const packageDirectory = join(repositoryRoot, workspacePath);
  const distDirectory = join(packageDirectory, "dist");
  if (!(await isDirectory(distDirectory))) continue;

  const emitted = await walk(distDirectory);
  let inspected = 0;
  for (const emittedPath of emitted) {
    const base = emittedBase(relative(distDirectory, emittedPath));
    if (base === null) continue;
    inspected += 1;

    // A source root of `src/` covers the published packages; the bare package
    // root covers an entrypoint that lives beside it (the backend's `server.ts`).
    const candidates = [];
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(join(packageDirectory, "src", `${base}${extension}`));
      candidates.push(join(packageDirectory, `${base}${extension}`));
    }
    let sourceExists = false;
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) {
          sourceExists = true;
          break;
        }
      } catch {
        // Not this candidate; keep looking.
      }
    }
    if (!sourceExists) {
      orphans.push(`${workspacePath}/dist/${relative(distDirectory, emittedPath)}`);
    }
  }
  checked.push({ workspacePath, inspected, total: emitted.length });
}

if (checked.length === 0) {
  // Vacuity floor: nothing was built, so this check verified nothing. Reaching
  // here means the caller skipped the build, and a silent pass would read as
  // "the artefacts are clean".
  die(
    "No package has a dist/ directory, so nothing could be compared. Run the build before this check.",
  );
}

for (const { workspacePath, inspected, total } of checked) {
  console.log(`${workspacePath}: ${inspected} emitted file(s) checked of ${total} in dist/.`);
}

if (orphans.length > 0) {
  die("dist/ holds emitted file(s) with no corresponding source:", [
    ...orphans.map((orphan) => `  - ${orphan}`),
    "",
    "A stale artefact does not error, it ships — with sourcemaps pointing at code",
    "that no longer exists. `clean` removes dist/ but NOT tsconfig.tsbuildinfo, so",
    "tsc can believe its outputs are current and emit nothing.",
    "",
    "Fix: delete the package's tsconfig.tsbuildinfo along with dist/, then rebuild.",
  ]);
}

console.log("Every emitted file has a source.");
