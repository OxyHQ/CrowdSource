#!/usr/bin/env bun

/**
 * No published package ships build output for a source file that no longer
 * exists.
 *
 * `tsc` never prunes. It writes `dist/x.js` for `src/x.ts` and leaves that
 * output in place forever after `src/x.ts` is deleted or renamed — and the
 * published `files` array is `dist/**` plus `src/**`, so the orphan ships. A
 * consumer then installs a module the source tree does not contain, with a
 * sourcemap pointing at a path that is not in the tarball.
 *
 * This is not hypothetical. `0.3.0` removed `packages/sdk/src/uploads.ts`, and
 * the first pack of it shipped `dist/uploads.js`, `dist/uploads.d.ts` and both
 * their maps — the whole abandoned presigned-upload client, in a release whose
 * entire point was removing it. It was caught by inspecting the tarball by hand,
 * which is exactly the check nobody runs when they are not expecting a problem.
 *
 * Two things made it invisible:
 *
 *   1. `bun run clean` was `rm -rf dist`, but the incremental build state lives
 *      in `tsconfig.tsbuildinfo` at the PACKAGE ROOT for these packages, so it
 *      survived. `tsc` then read a buildinfo claiming its outputs were current,
 *      emitted nothing at all, and reported success — leaving the previous
 *      `dist` untouched. That is fixed in each `clean` script now, but a fix
 *      that depends on somebody remembering to run `clean` is not a guarantee.
 *   2. Nothing compared `dist` to `src`. This does, and it runs inside
 *      `bun run check`, so CI answers the question on every pull request.
 *
 * Run against a different tree with `bun scripts/check-dist-orphans.mjs <root>`,
 * which is how `test-check-dist-orphans.mjs` mutation-tests it.
 */

import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The packages whose `dist` is published. */
const PUBLISHED = ["contracts", "sdk", "sdk-express", "testing"];

/** Output suffixes, longest first so `.d.ts.map` is stripped before `.map`. */
const OUTPUT_SUFFIXES = [".d.ts.map", ".d.ts", ".js.map", ".js"];

const repositoryRoot =
  process.argv[2] === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
    : resolve(process.argv[2]);

const failures = [];
let distFilesChecked = 0;
let packagesWithDist = 0;

for (const name of PUBLISHED) {
  const packageRoot = resolve(repositoryRoot, "packages", name);
  const distRoot = join(packageRoot, "dist");
  const srcRoot = join(packageRoot, "src");

  if (!(await isDirectory(distRoot))) {
    // Not built. Nothing to compare, and not a failure on its own — `check`
    // builds before it lints, so a real run always has one.
    continue;
  }
  packagesWithDist += 1;

  for (const file of await walk(distRoot)) {
    const fromDist = relative(distRoot, file);

    // `tsconfig.tsbuildinfo` inside dist is build state, not output.
    if (fromDist.endsWith(".tsbuildinfo")) continue;

    const suffix = OUTPUT_SUFFIXES.find((candidate) => fromDist.endsWith(candidate));
    if (suffix === undefined) {
      failures.push(
        `packages/${name}/dist/${fromDist} is not a recognised build output. ` +
          "Either it is stale, or this check needs to learn about a new emit kind.",
      );
      continue;
    }

    distFilesChecked += 1;
    const stem = fromDist.slice(0, -suffix.length);
    if (!(await exists(join(srcRoot, `${stem}.ts`))) && !(await exists(join(srcRoot, `${stem}.tsx`)))) {
      failures.push(
        `packages/${name}/dist/${fromDist} has no source: packages/${name}/src/${stem}.ts is gone. ` +
          "Delete the stale output (`bun run --cwd packages/" +
          name +
          " clean && bun run --cwd packages/" +
          name +
          " build`) — publishing it would ship a module this repository no longer contains.",
      );
    }
  }
}

/**
 * Vacuity floor. A traversal that silently found nothing would otherwise report
 * success for every possible tree, which is the failure mode this whole script
 * exists to prevent in the build.
 */
if (packagesWithDist > 0 && distFilesChecked === 0) {
  failures.push(
    `${packagesWithDist} package(s) have a dist directory but zero build outputs were examined; ` +
      "the traversal is broken and this check proves nothing.",
  );
}

if (failures.length > 0) {
  console.error("Stale build output found in a published package:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  packagesWithDist === 0
    ? "No package is built yet; nothing to compare."
    : `${distFilesChecked} build output(s) across ${packagesWithDist} published package(s) all have a source file.`,
);

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else found.push(full);
  }
  return found;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
