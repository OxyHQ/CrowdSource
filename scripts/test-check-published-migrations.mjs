#!/usr/bin/env bun

/**
 * Mutation-tests `check-published-migrations.mjs`.
 *
 * The healthy case is asserted first. Without it, a checker broken into always
 * failing would "pass" every case below — which is the shape the check itself
 * exists to catch, one level up.
 *
 * The fixtures are real packages: `bun pm pack --dry-run` resolves `files`
 * exactly as a publish does, and the whole point of this gate is that a path can
 * be present on disk and absent from the tarball, or the reverse.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checker = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-published-migrations.mjs",
);
const PACKAGES = ["contracts", "sdk", "sdk-express", "testing", "app"];

/** A package that ships its build output and its sources, minus its tests. */
function healthyTree() {
  return Object.fromEntries(
    PACKAGES.map((name) => [
      name,
      {
        manifest: {
          name: `@oxyhq/${name}`,
          version: "0.0.0",
          files: ["dist/**/*", "src/**/*", "!src/**/__tests__/**"],
        },
        files: {
          "dist/index.js": "module.exports = {};\n",
          "src/index.ts": "export const ok = true;\n",
          // Where this package's own migrations legitimately live: excluded by
          // `files`, so present on disk and absent from the tarball.
          "src/__tests__/support/postgres/migrations/0000_first.sql":
            "create table t ();\n",
          "src/__tests__/support/postgres/migrations/meta/_journal.json": "{}\n",
        },
      },
    ]),
  );
}

const cases = [
  { name: "a tree whose migrations are all under __tests__ passes", expectFailure: false, mutate: (t) => t },
  {
    name: "a migrations folder moved into the published source is caught",
    expectFailure: true,
    mustMention: "@oxyhq/app",
    // The exact edit the design document predicts: somebody tidies the folder out
    // of `__tests__/`, everything still works locally, and it ships.
    mutate: (tree) => {
      tree.app.files["src/postgres/migrations/0000_first.sql"] = "create table t ();\n";
      return tree;
    },
  },
  {
    name: "a stray .sql anywhere in the published tree is caught",
    expectFailure: true,
    mustMention: "@oxyhq/sdk",
    mutate: (tree) => {
      tree.sdk.files["src/backfill.sql"] = "update t set x = 1;\n";
      return tree;
    },
  },
  {
    name: "a Migrations folder with a capital M is caught too",
    expectFailure: true,
    mustMention: "@oxyhq/testing",
    mutate: (tree) => {
      tree.testing.files["dist/Migrations/index.js"] = "module.exports = {};\n";
      return tree;
    },
  },
  {
    name: "a package that packs nothing but its manifest trips the vacuity floor",
    expectFailure: true,
    mustMention: "packed nothing but its manifest",
    mutate: (tree) => {
      tree.contracts.manifest.files = ["does-not-exist/**/*"];
      return tree;
    },
  },
];

let failed = 0;
for (const testCase of cases) {
  const root = await mkdtemp(resolve(tmpdir(), "cs-migrations-"));
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
  console.error(
    `\n${failed} mutation case(s) failed: check-published-migrations.mjs is not a working guard.`,
  );
  process.exit(1);
}
console.log(`\nAll ${cases.length} mutation cases behaved correctly.`);
