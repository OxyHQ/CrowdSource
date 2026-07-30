#!/usr/bin/env bun

/**
 * Mutation-tests `check-dist-orphans.mjs`.
 *
 * The case that matters is the first one: it reproduces the exact `0.3.0` near
 * miss — `src/uploads.ts` deleted, `dist/uploads.*` left behind — and requires
 * the checker to fail AND to name the offending path, because a non-zero exit
 * that does not say which file is stale sends the next person listing four dist
 * directories by hand.
 *
 * The healthy case and the vacuity case are asserted too. Without the healthy
 * case a checker broken into always-failing would pass everything here; without
 * the vacuity case a broken traversal would report success for every tree, which
 * is the same class of defect the checker itself is guarding against.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checker = resolve(dirname(fileURLToPath(import.meta.url)), "check-dist-orphans.mjs");

/** A built `sdk` whose every output has a source. */
function healthyTree() {
  return {
    "packages/sdk/src/index.ts": "export const a = 1;\n",
    "packages/sdk/src/client.ts": "export const b = 2;\n",
    "packages/sdk/dist/index.js": "exports.a = 1;\n",
    "packages/sdk/dist/index.d.ts": "export declare const a: number;\n",
    "packages/sdk/dist/index.js.map": "{}\n",
    "packages/sdk/dist/index.d.ts.map": "{}\n",
    "packages/sdk/dist/client.js": "exports.b = 2;\n",
    "packages/sdk/dist/client.d.ts": "export declare const b: number;\n",
  };
}

const cases = [
  { name: "a fully-sourced dist passes", expectFailure: false, mutate: (t) => t },
  {
    name: "the 0.3.0 near miss is caught: source deleted, output left behind",
    expectFailure: true,
    mustMention: "packages/sdk/dist/uploads.js",
    mutate: (t) => ({
      ...t,
      "packages/sdk/dist/uploads.js": "exports.upload = () => {};\n",
      "packages/sdk/dist/uploads.d.ts": "export declare const upload: () => void;\n",
      "packages/sdk/dist/uploads.js.map": "{}\n",
    }),
  },
  {
    name: "a stale output in a nested directory is caught",
    expectFailure: true,
    mustMention: "internal/gone.js",
    mutate: (t) => ({ ...t, "packages/sdk/dist/internal/gone.js": "exports.x = 1;\n" }),
  },
  {
    name: "a stale declaration map alone is caught",
    expectFailure: true,
    mustMention: "removed.d.ts.map",
    mutate: (t) => ({ ...t, "packages/sdk/dist/removed.d.ts.map": "{}\n" }),
  },
  {
    name: "an unrecognised file in dist is reported rather than ignored",
    expectFailure: true,
    mustMention: "not a recognised build output",
    mutate: (t) => ({ ...t, "packages/sdk/dist/notes.txt": "hello\n" }),
  },
  {
    name: "buildinfo inside dist is build state, not a stale output",
    expectFailure: false,
    mutate: (t) => ({ ...t, "packages/sdk/dist/tsconfig.tsbuildinfo": "{}\n" }),
  },
  {
    name: "a dist with no recognised outputs at all trips the vacuity floor",
    expectFailure: true,
    mustMention: "traversal is broken",
    // Only buildinfo present: the directory exists, so the check ran, but it
    // examined nothing. Reporting success here would mean the check passes on a
    // tree it never looked at.
    mutate: () => ({
      "packages/sdk/src/index.ts": "export const a = 1;\n",
      "packages/sdk/dist/tsconfig.tsbuildinfo": "{}\n",
    }),
  },
  {
    name: "a .tsx source satisfies its output",
    expectFailure: false,
    mutate: (t) => ({
      ...t,
      "packages/sdk/src/widget.tsx": "export const W = null;\n",
      "packages/sdk/dist/widget.js": "exports.W = null;\n",
    }),
  },
];

let failed = 0;

for (const testCase of cases) {
  const root = await mkdtemp(resolve(tmpdir(), "cs-distorphan-"));
  try {
    for (const [path, contents] of Object.entries(testCase.mutate(healthyTree()))) {
      const full = resolve(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }

    const run = Bun.spawnSync({ cmd: ["bun", checker, root] });
    const output = `${new TextDecoder().decode(run.stdout)}${new TextDecoder().decode(run.stderr)}`;
    const didFail = run.exitCode !== 0;

    if (didFail !== testCase.expectFailure) {
      failed += 1;
      console.error(
        `FAIL  ${testCase.name}\n      expected ${testCase.expectFailure ? "a failure" : "a pass"}, got exit ${run.exitCode}\n${output}`,
      );
      continue;
    }
    if (testCase.mustMention !== undefined && !output.includes(testCase.mustMention)) {
      failed += 1;
      console.error(
        `FAIL  ${testCase.name}\n      failed as expected but never mentioned "${testCase.mustMention}"\n${output}`,
      );
      continue;
    }
    console.log(`PASS  ${testCase.name}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} mutation case(s) failed: check-dist-orphans.mjs is not a working guard.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} mutation cases behaved correctly.`);
