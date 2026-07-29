#!/usr/bin/env bun

/**
 * The four published packages agree about `@oxyhq/crowdsource-contracts`.
 *
 * `@oxyhq/crowdsource`, `-express` and `-testing` declare contracts as a PEER
 * dependency rather than a normal one, so an integrator installs exactly one copy
 * and owns its version. That is not a style preference — it is the fix for a
 * failure mode with no diagnostic. When two copies of contracts exist and their
 * schemas differ, `tsc` reports NOTHING (measured: exit 0 with
 * `skipLibCheck:false`) and the symptom is every webhook delivery answering
 * HTTP 400 `malformed_event`. Because the middleware deliberately answers non-2xx
 * to stay on the sender's retry schedule, that presents as a delivery problem:
 * whoever debugs it chases the signature, the secret and the clock. Nothing
 * anywhere says "duplicate dependency".
 *
 * Three ways to reintroduce it, so three assertions:
 *
 *   1. a peer RANGE that excludes the contracts version in this workspace — an
 *      integrator following it installs a copy the SDK was not built against;
 *   2. contracts back in `dependencies`, which is what pins a second nested copy
 *      into every adopter's tree;
 *   3. contracts missing from `devDependencies`, which does not break an
 *      adopter but does break this workspace's own build, since a peer is not
 *      installed for you.
 *
 * Run against a different tree with `bun scripts/check-peer-contracts.mjs <root>`,
 * which is how `test-check-peer-contracts.mjs` mutation-tests it.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACTS = "@oxyhq/crowdsource-contracts";
/** Every published package that consumes the contracts package. */
const CONSUMERS = ["sdk", "sdk-express", "testing"];

const repositoryRoot =
  process.argv[2] === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
    : resolve(process.argv[2]);

const failures = [];

const contracts = await readManifest("contracts");
const contractsVersion = contracts?.version;

if (typeof contractsVersion !== "string" || contractsVersion.length === 0) {
  failures.push("packages/contracts/package.json declares no version.");
}

for (const name of CONSUMERS) {
  const manifest = await readManifest(name);
  if (manifest === null) {
    failures.push(`packages/${name}/package.json is missing or unreadable.`);
    continue;
  }

  const label = `${manifest.name ?? `packages/${name}`}`;
  const range = manifest.peerDependencies?.[CONTRACTS];
  const asDependency = manifest.dependencies?.[CONTRACTS];
  const asDevDependency = manifest.devDependencies?.[CONTRACTS];

  if (asDependency !== undefined) {
    failures.push(
      `${label} declares ${CONTRACTS} in dependencies ("${asDependency}"). ` +
        "It must be a peerDependency, or an adopter who bumps contracts gets a second nested copy " +
        "and every webhook delivery starts answering 400 with no type error anywhere.",
    );
  }

  if (range === undefined) {
    failures.push(
      `${label} declares no peerDependency on ${CONTRACTS}. ` +
        "The types it returns come from that package; an adopter must own its version.",
    );
  } else if (typeof contractsVersion === "string" && !Bun.semver.satisfies(contractsVersion, range)) {
    failures.push(
      `${label} peer-depends on ${CONTRACTS}@"${range}", which does NOT admit ` +
        `${contractsVersion} — the version in this workspace. An adopter following that range ` +
        "installs a copy this package was never built against.",
    );
  }

  if (asDevDependency === undefined) {
    failures.push(
      `${label} must also declare ${CONTRACTS} in devDependencies ` +
        "(a peer is not installed for you, so this workspace could not build or test itself).",
    );
  }
}

if (failures.length > 0) {
  console.error("Contracts peer-dependency check failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `${CONTRACTS}@${contractsVersion} is admitted by the peer range of all ${CONSUMERS.length} consumers, ` +
    "and none of them bundles it as a normal dependency.",
);

async function readManifest(packageDirectory) {
  try {
    return JSON.parse(
      await readFile(resolve(repositoryRoot, "packages", packageDirectory, "package.json"), "utf8"),
    );
  } catch {
    return null;
  }
}
