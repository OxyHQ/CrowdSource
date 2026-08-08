#!/usr/bin/env bun

/**
 * Every published package ships BOTH formats, and each condition resolves to the
 * format it names.
 *
 * ## Why this exists
 *
 * On 2026-07-30 `@oxyhq/crowdsource-express@0.3.0` took a consumer's backend
 * down. Every package shipped CommonJS only, with `exports["."].import` pointing
 * at the CommonJS file. Plain Node survives that — its ESM loader handles a CJS
 * package — so a `node -e "import(...)"` smoke test goes green. A bundler
 * targeting ESM does not: it inlines the CJS and rewrites each `require()` of an
 * external into a shim that throws on first call.
 *
 *     Error: Dynamic require of "zod" is not supported
 *
 * The first response was to document a consumer-side workaround
 * (`--external:@oxyhq/*`). That was reversed, and rightly: it pushed a permanent
 * special case onto seven consumer builds whose failure mode is a container that
 * starts and dies, to avoid fixing a misconfiguration that was ours. A
 * TypeScript library publishing real ESM is the ordinary thing.
 *
 * ## What this asserts
 *
 * 1. `import` resolves to a file under the ESM output, `require` to the
 *    CommonJS one, and they are DIFFERENT files. A single file behind both is
 *    the defect above.
 * 2. The ESM output carries its `{"type":"module"}` marker. The root manifest
 *    says `"type": "commonjs"`, which Node applies to every `.js` beneath it, so
 *    without that one file the entire ESM half is parsed as CommonJS and fails
 *    on its first `import`.
 * 3. The ESM entry really is ESM, and the CommonJS entry really is CommonJS —
 *    checked by content, because a condition can point anywhere.
 *
 * ## What it deliberately does not assert
 *
 * The dual-package hazard is real: a consumer resolving both conditions gets two
 * copies of a module, which produces no type error and no diagnostic. That is
 * bounded elsewhere — `check-peer-contracts.mjs` keeps contracts a peer so an
 * adopter installs exactly one — and it is a cost every dual-published library
 * carries. It is not a reason to ship a broken `import` condition.
 *
 * Run against a different tree with `bun scripts/check-module-format.mjs <root>`,
 * which is how `test-check-module-format.mjs` mutation-tests it.
 */

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every published package, and the MINIMUM number of code-selecting export
 * entries each must declare.
 *
 * A per-package floor rather than a total. The total was
 * `entriesChecked < PUBLISHED.length` — a scalar that does not rise when a
 * package gains a subpath, so a manifest that silently LOST one still cleared
 * it as long as some other package had two. Every entry a package is supposed
 * to publish is named here, so losing one fails by name.
 */
const PUBLISHED = {
  contracts: 1,
  sdk: 1,
  "sdk-express": 1,
  testing: 1,
  // ".", "./mongoose" and "./postgres".
  app: 3,
};
/** Conditions that select code. `types` selects declarations and is exempt. */


const repositoryRoot =
  process.argv[2] === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
    : resolve(process.argv[2]);

const failures = [];
let entriesChecked = 0;

/** Syntactic markers. A real ES module contains none of them. */
const COMMONJS_MARKERS = [
  { pattern: /(^|[^.\w])require\s*\(/m, name: "a require() call" },
  { pattern: /(^|\s)exports\s*\./m, name: "an exports.* assignment" },
  { pattern: /module\s*\.\s*exports/m, name: "a module.exports assignment" },
];

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The nearest `package.json` at or above `fromDirectory`, STOPPING BELOW the
 * package root.
 *
 * Node resolves a file's module type by walking upward to the first
 * `package.json`, so a marker at `dist/esm/` governs `dist/esm/mongoose/` too —
 * which is why a subpath entry needs no marker of its own, and why looking only
 * beside the entry reported a false failure the moment one existed.
 *
 * The package root is deliberately NOT a candidate. That file is the
 * `"type": "commonjs"` manifest itself, so finding it is exactly the case where
 * there is no marker at all; treating it as an answer would turn "the ESM half
 * is inert" into "the marker says commonjs", which is the same fault described
 * less usefully.
 */
async function nearestModuleMarker(packageDir, fromDirectory) {
  const root = resolve(packageDir);
  let current = resolve(packageDir, fromDirectory);
  while (current !== root && current.startsWith(root)) {
    const contents = await readIfPresent(resolve(current, "package.json"));
    if (contents !== undefined) return { directory: current, contents };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

for (const [name, minimumEntries] of Object.entries(PUBLISHED)) {
  const packageDir = resolve(repositoryRoot, "packages", name);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
  } catch {
    failures.push(`packages/${name}/package.json is missing or unreadable.`);
    continue;
  }
  const label = manifest.name ?? `packages/${name}`;
  let entriesForPackage = 0;

  for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
    if (typeof conditions !== "object" || conditions === null) continue;
    const esm = conditions.import;
    const cjs = conditions.require;
    if (typeof esm !== "string" && typeof cjs !== "string") continue;
    entriesChecked += 1;
    entriesForPackage += 1;

    if (typeof esm !== "string" || typeof cjs !== "string") {
      failures.push(
        `${label} "${subpath}" declares only one of import/require. Both must be present so a ` +
          "consumer of either module system resolves the format it can actually load.",
      );
      continue;
    }

    if (esm === cjs) {
      failures.push(
        `${label} resolves "${subpath}" to the same file for import and require (${esm}). That is ` +
          "the defect that took a backend down on 2026-07-30: a bundler targeting ESM inlines the " +
          'CommonJS and throws `Dynamic require of "..." is not supported` at container start, ' +
          "with green CI. Point import at the ESM build.",
      );
      continue;
    }

    const esmSource = await readIfPresent(resolve(packageDir, esm));
    if (esmSource !== undefined) {
      const found = COMMONJS_MARKERS.filter(({ pattern }) => pattern.test(esmSource));
      if (found.length > 0) {
        failures.push(
          `${label} maps the import condition of "${subpath}" to ${esm}, which is CommonJS ` +
            `(${found.map((marker) => marker.name).join(", ")}).`,
        );
      }
    }

    const cjsSource = await readIfPresent(resolve(packageDir, cjs));
    if (cjsSource !== undefined && !COMMONJS_MARKERS.some(({ pattern }) => pattern.test(cjsSource))) {
      failures.push(
        `${label} maps the require condition of "${subpath}" to ${cjs}, which does not look like ` +
          "CommonJS. A CommonJS consumer would fail to load it.",
      );
    }

    /**
     * The marker governing the ESM entry. Without one Node reads the root
     * manifest's `"type": "commonjs"` and parses the ESM emit as CommonJS — one
     * absent file makes the whole half inert, and nothing else in the tree would
     * show it.
     */
    const marker = await nearestModuleMarker(packageDir, dirname(esm));
    if (esmSource !== undefined) {
      if (marker === undefined) {
        failures.push(
          `${label} has no ${dirname(esm)}/package.json beside its ESM entry. The root manifest is ` +
            '"type": "commonjs", so Node parses that output as CommonJS and fails on its first ' +
            "import statement.",
        );
      } else if (JSON.parse(marker.contents).type !== "module") {
        failures.push(
          `${label}'s ${relative(packageDir, marker.directory)}/package.json does not declare ` +
            '"type": "module".',
        );
      }
    }
  }

  /**
   * Every entry this package is supposed to publish is still declared. A
   * manifest that loses a subpath resolves to nothing for that import — the same
   * class of failure as pointing it at the wrong file, with no build error.
   */
  if (entriesForPackage < minimumEntries) {
    failures.push(
      `packages/${name} (${label}) declares ${entriesForPackage} code-selecting export ` +
        `entr(ies); expected at least ${minimumEntries}. A subpath that disappears from the ` +
        "manifest resolves to nothing for anyone importing it.",
    );
  }
}

/** A traversal that silently examined nothing must not pass. */
const expectedEntries = Object.values(PUBLISHED).reduce((total, count) => total + count, 0);
if (entriesChecked < expectedEntries) {
  failures.push(
    `only ${entriesChecked} export entr(ies) were examined across ` +
      `${Object.keys(PUBLISHED).length} published packages; expected at least ${expectedEntries}. ` +
      "The manifests or this check's package list have drifted.",
  );
}

if (failures.length > 0) {
  console.error("The module-format check failed:\n");
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}

console.log(
  `All ${Object.keys(PUBLISHED).length} published package(s) ship both formats correctly across ` +
    `${entriesChecked} export entr(ies).`,
);
