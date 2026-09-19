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
const PACKAGES = ["contracts", "core"];

const ESM = "import { z } from 'zod';\nexport const schema = z.string();\n";
const CJS = '"use strict";\nconst zod = require("zod");\nexports.schema = zod.z.string();\n';

/**
 * A tree that must pass: both formats, each condition on the right one.
 *
 * `core` publishes four SUBPATHS as well, because the real one does — the
 * Express receiver, the outbox, the outbox's PostgreSQL half and the test
 * sandbox. `./outbox/postgres`'s ESM entry sits two directories deeper than the
 * `{"type":"module"}` marker, which is correct and is what Node resolves by
 * walking upward, so a healthy tree with only root entries would leave that path
 * unexercised. The count also has to match the per-package floor: a fixture with
 * fewer entries than the real manifest fails the tree it exists to accept.
 */
function healthyTree() {
  const tree = Object.fromEntries(
    PACKAGES.map((name) => [
      name,
      {
        manifest: {
          name: `@crowdsource.you/${name}`,
          type: "commonjs",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/esm/index.js",
              require: "./dist/index.js",
              default: "./dist/index.js",
            },
          },
        },
        files: {
          "dist/index.js": CJS,
          "dist/esm/index.js": ESM,
          "dist/esm/package.json": '{"type":"module"}\n',
        },
      },
    ]),
  );
  for (const subpath of ["express", "outbox", "outbox/postgres", "testing"]) {
    tree.core.manifest.exports[`./${subpath}`] = {
      types: `./dist/${subpath}/index.d.ts`,
      import: `./dist/esm/${subpath}/index.js`,
      require: `./dist/${subpath}/index.js`,
      default: `./dist/${subpath}/index.js`,
    };
    tree.core.files[`dist/${subpath}/index.js`] = CJS;
    tree.core.files[`dist/esm/${subpath}/index.js`] = ESM;
  }
  return tree;
}

const cases = [
  { name: "a correctly dual-published tree passes", expectFailure: false, mutate: (t) => t },
  {
    name: "import and require resolving to the SAME file is caught",
    expectFailure: true,
    mustMention: "@crowdsource.you/core",
    // The exact 0.3.0 defect that took a backend down, on the subpath that
    // inherited that package's code.
    mutate: (tree) => {
      tree.core.manifest.exports["./express"].import = "./dist/express/index.js";
      return tree;
    },
  },
  {
    name: "an import condition pointing at CommonJS content is caught",
    expectFailure: true,
    mustMention: "which is CommonJS",
    // The condition looks dual but the file behind it is not.
    mutate: (tree) => {
      tree.core.files["dist/esm/index.js"] = CJS;
      return tree;
    },
  },
  {
    name: "a missing {\"type\":\"module\"} marker is caught",
    expectFailure: true,
    mustMention: "package.json beside its ESM entry",
    // One absent file makes the whole ESM half parse as CommonJS.
    mutate: (tree) => {
      delete tree.contracts.files["dist/esm/package.json"];
      return tree;
    },
  },
  {
    name: "a marker that does not say type module is caught",
    expectFailure: true,
    mustMention: '"type": "module"',
    mutate: (tree) => {
      tree.core.files["dist/esm/package.json"] = '{"type":"commonjs"}\n';
      return tree;
    },
  },
  {
    name: "declaring only one of import/require is caught",
    expectFailure: true,
    mustMention: "only one of import/require",
    mutate: (tree) => {
      delete tree.contracts.manifest.exports["."].require;
      return tree;
    },
  },
  {
    name: "a require condition pointing at ESM content is caught",
    expectFailure: true,
    mustMention: "does not look like",
    mutate: (tree) => {
      tree.contracts.files["dist/index.js"] = ESM;
      return tree;
    },
  },
  {
    name: "removing every export entry trips the vacuity floor",
    expectFailure: true,
    mustMention: "export entr",
    mutate: (tree) => {
      for (const name of PACKAGES) delete tree[name].manifest.exports;
      return tree;
    },
  },
  {
    /**
     * The marker is written ONCE, at the ESM root, and governs everything
     * beneath it — so a subpath entry needs none of its own. Looking only beside
     * the entry reported a false failure claiming the whole ESM half was inert,
     * for a package that was perfectly fine. Three levels deep, because a walk
     * that stopped short would pass the shallower cases by accident.
     */
    name: "an ESM entry nested below the marker is governed by it",
    expectFailure: false,
    mutate: (tree) => {
      tree.core.manifest.exports["./outbox/postgres/store"] = {
        import: "./dist/esm/outbox/postgres/store/index.js",
        require: "./dist/outbox/postgres/store/index.js",
      };
      tree.core.files["dist/esm/outbox/postgres/store/index.js"] = ESM;
      tree.core.files["dist/outbox/postgres/store/index.js"] = CJS;
      return tree;
    },
  },
  {
    /**
     * The other direction, and the reason the walk stops BELOW the package root:
     * the root manifest is the `"type": "commonjs"` that makes the ESM half
     * inert, so finding it must read as "no marker" rather than as an answer.
     */
    name: "an ESM entry with no marker anywhere is still caught",
    expectFailure: true,
    mustMention: "package.json beside its ESM entry",
    mutate: (tree) => {
      delete tree.core.files["dist/esm/package.json"];
      return tree;
    },
  },
  {
    /**
     * The floor that used to be a scalar. `entriesChecked < PUBLISHED.length`
     * counted in aggregate, so a package that LOST a subpath still cleared it on
     * a sibling's second entry — the manifest silently stops resolving that
     * import and nothing says so. It matters more now than it did: four of the
     * five entries a consumer imports live behind subpaths of ONE package, so
     * there is no sibling package left whose absence would be noticed instead.
     */
    name: "a package that loses a declared subpath is caught by name",
    expectFailure: true,
    mustMention: "packages/core",
    mutate: (tree) => {
      delete tree.core.manifest.exports["./outbox/postgres"];
      return tree;
    },
  },
  {
    name: "a subpath export is checked too, not only the root",
    expectFailure: true,
    mustMention: "./server",
    mutate: (tree) => {
      tree.core.manifest.exports["./server"] = {
        import: "./dist/server.js",
        require: "./dist/server.js",
      };
      tree.core.files["dist/server.js"] = CJS;
      return tree;
    },
  },
];

let failed = 0;
for (const testCase of cases) {
  const root = await mkdtemp(resolve(tmpdir(), "cs-modfmt-"));
  try {
    const tree = testCase.mutate(healthyTree());
    for (const [directory, { manifest, files }] of Object.entries(tree)) {
      const base = resolve(root, "packages", directory);
      await mkdir(base, { recursive: true });
      await writeFile(resolve(base, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      for (const [relative, contents] of Object.entries(files)) {
        await mkdir(dirname(resolve(base, relative)), { recursive: true });
        await writeFile(resolve(base, relative), contents);
      }
    }

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
