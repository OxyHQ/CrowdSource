#!/usr/bin/env bun

/**
 * Mutation-tests `check-module-format.mjs`.
 *
 * The healthy case is asserted first. Without it, a checker broken into always
 * failing would "pass" every case below — which is the shape the check itself
 * exists to catch, one level up.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checker = resolve(dirname(fileURLToPath(import.meta.url)), "check-module-format.mjs");
const PACKAGES = ["contracts", "sdk", "sdk-express", "testing", "app"];

const GUIDE = [
  "Externalise them: --external:@oxyhq/*",
  'Otherwise: Dynamic require of "zod" is not supported',
].join("\n");

/** A tree that must pass: CJS-only, one file per entry, guide intact. */
function healthyTree() {
  return {
    packages: Object.fromEntries(
      PACKAGES.map((name) => [
        name,
        {
          name: `@oxyhq/${name}`,
          type: "commonjs",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/index.js",
              require: "./dist/index.js",
              default: "./dist/index.js",
            },
          },
        },
      ]),
    ),
    guide: GUIDE,
  };
}

const cases = [
  { name: "a CJS-only tree with the guide intact passes", expectFailure: false, mutate: (t) => t },
  {
    name: "a dual package is caught",
    expectFailure: true,
    mustMention: "@oxyhq/sdk-express",
    // The fix that was rejected: import -> a separate ESM build.
    mutate: (tree) => {
      tree.packages["sdk-express"].exports["."].import = "./dist/index.mjs";
      return tree;
    },
  },
  {
    name: "a dual package on a SUBPATH is caught, not only the root",
    expectFailure: true,
    mustMention: "./server",
    mutate: (tree) => {
      tree.packages.app.exports["./server"] = {
        import: "./dist/server.mjs",
        require: "./dist/server.js",
      };
      return tree;
    },
  },
  {
    name: 'a package flipping to "type": "module" is caught',
    expectFailure: true,
    mustMention: "@oxyhq/sdk",
    mutate: (tree) => {
      tree.packages.sdk.type = "module";
      return tree;
    },
  },
  {
    name: "losing the externalise flag from the guide is caught",
    expectFailure: true,
    mustMention: "--external:@oxyhq/*",
    // The mitigation is the only thing protecting a bundling consumer, so the
    // guide losing it is a regression even though no manifest changed.
    mutate: (tree) => {
      tree.guide = tree.guide.replace("--external:@oxyhq/*", "keep them external");
      return tree;
    },
  },
  {
    name: "losing the verbatim error text from the guide is caught",
    expectFailure: true,
    mustMention: "verbatim error",
    // Paraphrasing it breaks the only way most people find it: pasting a stack
    // trace into a search box.
    mutate: (tree) => {
      tree.guide = tree.guide.replace(
        'Dynamic require of "zod" is not supported',
        "a dynamic require error",
      );
      return tree;
    },
  },
  {
    name: "removing every export entry trips the vacuity floor",
    expectFailure: true,
    mustMention: "export entr",
    mutate: (tree) => {
      for (const name of PACKAGES) delete tree.packages[name].exports;
      return tree;
    },
  },
  {
    name: "a types condition differing from the code conditions is not a dual package",
    expectFailure: false,
    // `types` selects declarations, never code. Flagging it would make the
    // check cry wolf on every correctly-configured package.
    mutate: (tree) => {
      tree.packages.testing.exports["."].types = "./dist/types/index.d.ts";
      return tree;
    },
  },
];

let failed = 0;
for (const testCase of cases) {
  const root = await mkdtemp(resolve(tmpdir(), "cs-modfmt-"));
  try {
    const tree = testCase.mutate(healthyTree());
    for (const [directory, manifest] of Object.entries(tree.packages)) {
      const base = resolve(root, "packages", directory);
      await mkdir(base, { recursive: true });
      await writeFile(resolve(base, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await mkdir(resolve(root, "packages", "app"), { recursive: true });
    await writeFile(resolve(root, "packages", "app", "README.md"), tree.guide);

    const run = Bun.spawnSync({ cmd: ["bun", checker, root] });
    const output = `${new TextDecoder().decode(run.stdout)}${new TextDecoder().decode(run.stderr)}`;
    const didFail = run.exitCode !== 0;

    if (didFail !== testCase.expectFailure) {
      failed += 1;
      console.error(
        `FAIL  ${testCase.name}\n      expected ${testCase.expectFailure ? "a failure" : "a pass"}, ` +
          `got exit ${run.exitCode}\n${output}`,
      );
      continue;
    }
    if (testCase.mustMention !== undefined && !output.includes(testCase.mustMention)) {
      failed += 1;
      console.error(
        `FAIL  ${testCase.name}\n      failed correctly but never named ` +
          `'${testCase.mustMention}'\n${output}`,
      );
      continue;
    }
    console.log(`PASS  ${testCase.name}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} mutation case(s) failed: check-module-format.mjs is not a working guard.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} mutation cases behaved correctly.`);
