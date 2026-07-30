#!/usr/bin/env bun

/**
 * Every published package is CommonJS-only, deliberately, and every export
 * condition resolves to the same file.
 *
 * ## The decision this encodes
 *
 * On 2026-07-30 `@oxyhq/crowdsource-express@0.3.0` took a consumer's backend
 * down. It ships CommonJS and points `exports["."].import` at that CJS file; a
 * bundler targeting ESM inlines it and rewrites each `require()` of an external
 * into a shim that throws on first call:
 *
 *     Error: Dynamic require of "zod" is not supported
 *
 * The obvious fix — ship a real ESM build behind `import` — was considered and
 * REJECTED, and this check exists so nobody quietly does it later. A dual
 * package makes two copies of a module reachable through condition resolution,
 * and the failure that produces is one this repo already pays to detect: two
 * copies of `contracts` yield no type error and no diagnostic, only every
 * webhook answering `400 malformed_event`. `check-peer-contracts.mjs` counts
 * INSTALLED copies; it cannot see a second copy created by resolution. Adding a
 * dual build would introduce that hazard and blind the detector in one change.
 *
 * The packages are not broken for Node — its ESM loader imports a CJS package
 * correctly, measured. The break is specific to a bundler INLINING them, and
 * `--external:@oxyhq/*` is the ordinary configuration for a Node server bundle
 * rather than a workaround. That is documented in `packages/app/README.md`, and
 * asserted below, because a mitigation nobody can find is not a mitigation.
 *
 * ## What this asserts
 *
 * 1. Each published package declares `"type": "commonjs"`.
 * 2. Every condition in each export entry resolves to the SAME file — so a
 *    partial ESM build cannot appear without this failing.
 * 3. The adopter guide carries the externalise flag AND the verbatim error
 *    text, because the next person finds this by pasting a stack trace.
 *
 * Run against a different tree with `bun scripts/check-module-format.mjs <root>`,
 * which is how `test-check-module-format.mjs` mutation-tests it.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISHED = ["contracts", "sdk", "sdk-express", "testing", "app"];
/** Conditions that select code. `types` selects declarations and is exempt. */
const CODE_CONDITIONS = ["import", "require", "default", "node", "browser"];

const GUIDE = "packages/app/README.md";
const GUIDE_REQUIREMENTS = [
  { text: "--external:@oxyhq/*", why: "the flag a consumer has to set" },
  {
    text: 'Dynamic require of "zod" is not supported',
    why: "the verbatim error, which is how it gets found by search",
  },
];

const repositoryRoot =
  process.argv[2] === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
    : resolve(process.argv[2]);

const failures = [];
let entriesChecked = 0;

for (const name of PUBLISHED) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "packages", name, "package.json"), "utf8"),
    );
  } catch {
    failures.push(`packages/${name}/package.json is missing or unreadable.`);
    continue;
  }

  const label = manifest.name ?? `packages/${name}`;

  if (manifest.type !== "commonjs") {
    failures.push(
      `${label} declares "type": ${JSON.stringify(manifest.type)}. Every published package here ` +
        'is CommonJS-only by decision — see the comment at the top of this script for why a dual ' +
        "build was rejected rather than overlooked.",
    );
  }

  for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
    if (typeof conditions !== "object" || conditions === null) continue;
    const targets = new Map();
    for (const condition of CODE_CONDITIONS) {
      const target = conditions[condition];
      if (typeof target === "string") targets.set(condition, target);
    }
    if (targets.size === 0) continue;
    entriesChecked += 1;

    const distinct = new Set(targets.values());
    if (distinct.size > 1) {
      const detail = [...targets]
        .map(([condition, target]) => `${condition} -> ${target}`)
        .join(", ");
      failures.push(
        `${label} resolves "${subpath}" to more than one file (${detail}). That is a dual package: ` +
          "a consumer resolving two conditions gets two copies of the module, which produces no " +
          "type error and no diagnostic — the same failure `check-peer-contracts.mjs` guards " +
          "against, but reachable through resolution, where a copy count cannot see it. If a " +
          "consumer genuinely cannot externalise, change this deliberately and answer the " +
          "Zod-identity question first.",
      );
    }
  }
}

let guide = "";
try {
  guide = await readFile(resolve(repositoryRoot, GUIDE), "utf8");
} catch {
  failures.push(`${GUIDE} is missing; the bundler mitigation has nowhere to live.`);
}
for (const { text, why } of GUIDE_REQUIREMENTS) {
  if (guide !== "" && !guide.includes(text)) {
    failures.push(
      `${GUIDE} no longer contains ${JSON.stringify(text)} — ${why}. The packages are CJS-only ` +
        "on purpose, so this note is the only thing standing between a bundling consumer and a " +
        "container that dies at startup with green CI.",
    );
  }
}

/** A traversal that silently examined nothing must not pass. */
if (entriesChecked < PUBLISHED.length) {
  failures.push(
    `only ${entriesChecked} export entr(ies) were examined across ${PUBLISHED.length} published ` +
      "packages; expected at least one each. The manifests or this check's package list have drifted.",
  );
}

if (failures.length > 0) {
  console.error("The module-format check failed:\n");
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}

console.log(
  `All ${PUBLISHED.length} published package(s) are CommonJS-only across ${entriesChecked} export ` +
    "entr(ies), and the adopter guide carries the bundler mitigation.",
);
