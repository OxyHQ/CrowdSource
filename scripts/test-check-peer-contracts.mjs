#!/usr/bin/env bun

/**
 * Mutation-tests `check-peer-contracts.mjs`.
 *
 * A guard nobody has broken on purpose is a guard nobody knows works. Each case
 * below builds a throwaway manifest tree, introduces exactly one way of
 * reintroducing the duplicate-contracts bug, and asserts the checker FAILS **and
 * names the offending package** — because a non-zero exit that does not say which
 * package is wrong sends the next person reading three manifests by hand.
 *
 * The healthy case is asserted too. Without it, a checker broken into always
 * failing would pass every case here.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checker = resolve(dirname(fileURLToPath(import.meta.url)), "check-peer-contracts.mjs");
const CONTRACTS = "@oxyhq/crowdsource-contracts";

/** A tree that must pass: peers admit the workspace version, nothing bundles it. */
function healthyTree() {
  return {
    contracts: { name: CONTRACTS, version: "0.2.0" },
    sdk: {
      name: "@oxyhq/crowdsource",
      peerDependencies: { [CONTRACTS]: "^0.2.0" },
      devDependencies: { [CONTRACTS]: "workspace:*" },
    },
    "sdk-express": {
      name: "@oxyhq/crowdsource-express",
      peerDependencies: { [CONTRACTS]: "^0.2.0" },
      devDependencies: { [CONTRACTS]: "workspace:*" },
    },
    testing: {
      name: "@oxyhq/crowdsource-testing",
      peerDependencies: { [CONTRACTS]: "^0.2.0" },
      devDependencies: { [CONTRACTS]: "workspace:*" },
    },
    app: {
      name: "@oxyhq/crowdsource-app",
      peerDependencies: { [CONTRACTS]: "^0.2.0" },
      devDependencies: { [CONTRACTS]: "workspace:*" },
    },
  };
}

const cases = [
  {
    name: "the healthy tree passes",
    expectFailure: false,
    mutate: (tree) => tree,
  },
  {
    name: "a peer range that excludes the workspace version is caught",
    expectFailure: true,
    mustMention: "@oxyhq/crowdsource-express",
    // The exact shape that is strictly worse than an exact pin: ^0.1.0 refuses
    // 0.2.0, so the duplicate appears when the two copies differ MOST.
    mutate: (tree) => {
      tree["sdk-express"].peerDependencies[CONTRACTS] = "^0.1.0";
      return tree;
    },
  },
  {
    name: "contracts back in dependencies is caught",
    expectFailure: true,
    mustMention: "@oxyhq/crowdsource",
    mutate: (tree) => {
      tree.sdk.dependencies = { [CONTRACTS]: "0.2.0" };
      return tree;
    },
  },
  {
    name: "a missing peer declaration is caught",
    expectFailure: true,
    mustMention: "@oxyhq/crowdsource-testing",
    mutate: (tree) => {
      delete tree.testing.peerDependencies;
      return tree;
    },
  },
  {
    name: "a missing devDependency is caught",
    expectFailure: true,
    mustMention: "@oxyhq/crowdsource-testing",
    mutate: (tree) => {
      delete tree.testing.devDependencies;
      return tree;
    },
  },
  {
    name: "contracts as a normal dependency of the app package is caught",
    expectFailure: true,
    mustMention: "@oxyhq/crowdsource-app",
    // The app package is the one an adopter installs ALONGSIDE contracts, so a
    // nested second copy here is the shape that reaches production soonest.
    mutate: (tree) => {
      tree.app.dependencies = { [CONTRACTS]: "^0.2.0" };
      return tree;
    },
  },
  {
    name: "a contracts bump that outruns every peer range is caught",
    expectFailure: true,
    mustMention: "@oxyhq/crowdsource",
    // The lockstep failure the peer range exists to make loud: contracts moves
    // to 0.3.0 and nobody widened the ranges.
    mutate: (tree) => {
      tree.contracts.version = "0.3.0";
      return tree;
    },
  },
];

let failed = 0;

for (const testCase of cases) {
  const root = await mkdtemp(resolve(tmpdir(), "cs-peercheck-"));
  try {
    const tree = testCase.mutate(healthyTree());
    for (const [directory, manifest] of Object.entries(tree)) {
      await mkdir(resolve(root, "packages", directory), { recursive: true });
      await writeFile(
        resolve(root, "packages", directory, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
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
        `FAIL  ${testCase.name}\n      failed as expected but never named ${testCase.mustMention}\n${output}`,
      );
      continue;
    }

    console.log(`PASS  ${testCase.name}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} mutation case(s) failed: check-peer-contracts.mjs is not a working guard.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} mutation cases behaved correctly.`);
