#!/usr/bin/env bun

/**
 * Every published JSON Schema name converts, verified on the PACKED TARBALL.
 *
 * `crowdSourceJsonSchema(name)` calls `z.toJSONSchema` lazily, so a schema that
 * cannot be converted throws at the moment an integrator asks for it — not at
 * build time, not at pack time, and not in any check that merely imports the
 * package. A `.superRefine` that Zod cannot represent, a recursive shape it
 * refuses, or a name added to one structure and not the other all reach the
 * adopter first. That is the gap this closes.
 *
 * It runs against the packed artefact rather than the workspace tree because
 * those are not the same thing: `files` decides what ships, and this session has
 * already seen `dist` hold a module the source no longer contained. The workspace
 * answers "does it work here"; only the tarball answers "does it work for them".
 *
 * The assertions are deliberately NOT a count literal. A literal is a fourth
 * place to update when a schema is added — and a three-way merge resolving it to
 * a plausible wrong number is exactly how a missing name passes. Instead:
 *
 *   * `CONTRACT_JSON_SCHEMA_NAMES` and the keys of `CONTRACT_SCHEMAS` must be the
 *     same SET, in both directions. They are maintained separately, so a name
 *     added to one and not the other is a real defect this catches without
 *     knowing how many there are supposed to be.
 *   * every name must convert without throwing, and yield a non-empty document.
 *   * a floor and a duplicate check, so a broken import returning an empty array,
 *     or a duplicate inflating a count while hiding an omission, cannot pass.
 *
 * The assertion logic is exported and pure so `test-check-published-json-schemas.mjs`
 * can mutation-test it without packing anything; the CLI half only does the I/O.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fewest names this package has ever published. A floor, not an equality —
 * it exists so a broken import or a failed install cannot report success by
 * finding nothing, and it never needs updating when a schema is ADDED. If a name
 * is ever deliberately removed and the count drops below this, that is worth the
 * deliberate edit.
 */
const MINIMUM_PUBLISHED_NAMES = 13;

/**
 * Checks the JSON-Schema surface of an imported contracts module.
 *
 * Takes the module rather than a path so it can be handed a synthetic object in
 * a test. Returns the failures; an empty array means the surface is sound.
 */
export function assertJsonSchemaSurface(contracts) {
  const failures = [];

  const names = contracts.CONTRACT_JSON_SCHEMA_NAMES;
  const schemas = contracts.CONTRACT_SCHEMAS;
  const convert = contracts.crowdSourceJsonSchema;

  if (!Array.isArray(names)) {
    failures.push("CONTRACT_JSON_SCHEMA_NAMES is not an array; the package surface is not what this check expects.");
    return failures;
  }
  if (schemas === null || typeof schemas !== "object") {
    failures.push("CONTRACT_SCHEMAS is not an object; the package surface is not what this check expects.");
    return failures;
  }
  if (typeof convert !== "function") {
    failures.push("crowdSourceJsonSchema is not a function; the package surface is not what this check expects.");
    return failures;
  }

  // Vacuity floor: a broken import or a partial install must not read as a pass.
  if (names.length < MINIMUM_PUBLISHED_NAMES) {
    failures.push(
      `only ${names.length} published schema name(s) found, below the floor of ${MINIMUM_PUBLISHED_NAMES}. ` +
        "Either the import is broken or names were removed; neither should pass silently.",
    );
  }

  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    failures.push(
      `duplicate published name(s): ${[...new Set(duplicates)].join(", ")}. ` +
        "A duplicate inflates the count while hiding an omission.",
    );
  }

  // The load-bearing assertion, and the reason this needs no count literal: two
  // separately-maintained structures must agree, both directions.
  const declared = new Set(names);
  const registered = new Set(Object.keys(schemas));
  const missingSchema = [...declared].filter((name) => !registered.has(name));
  const missingName = [...registered].filter((name) => !declared.has(name));

  if (missingSchema.length > 0) {
    failures.push(
      `named in CONTRACT_JSON_SCHEMA_NAMES but absent from CONTRACT_SCHEMAS: ${missingSchema.join(", ")}. ` +
        "Asking for one of these throws.",
    );
  }
  if (missingName.length > 0) {
    failures.push(
      `present in CONTRACT_SCHEMAS but not published in CONTRACT_JSON_SCHEMA_NAMES: ${missingName.join(", ")}. ` +
        "An integrator enumerating the published names never learns it exists.",
    );
  }

  // The lazy conversion, forced for every name.
  for (const name of declared) {
    if (!registered.has(name)) continue;
    let document;
    try {
      document = convert(name);
    } catch (error) {
      failures.push(
        `crowdSourceJsonSchema('${name}') THREW: ${error instanceof Error ? error.message : String(error)}. ` +
          "Conversion is lazy, so this reaches an integrator rather than a build.",
      );
      continue;
    }
    if (document === null || typeof document !== "object" || Object.keys(document).length === 0) {
      failures.push(`crowdSourceJsonSchema('${name}') returned no usable document.`);
    }
  }

  return failures;
}

if (import.meta.main) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const contractsDirectory = resolve(repositoryRoot, "packages", "contracts");
  const scratch = await mkdtemp(resolve(tmpdir(), "cs-jsonschema-"));

  try {
    const pack = Bun.spawnSync({
      cmd: ["bun", "pm", "pack", "--destination", scratch],
      cwd: contractsDirectory,
    });
    if (pack.exitCode !== 0) {
      console.error("Packing @oxyhq/crowdsource-contracts failed:");
      console.error(new TextDecoder().decode(pack.stderr));
      process.exit(1);
    }

    const tarball = (await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: scratch, absolute: true })))[0];
    if (tarball === undefined) {
      console.error("Packing reported success but produced no tarball.");
      process.exit(1);
    }

    await writeFile(
      resolve(scratch, "package.json"),
      `${JSON.stringify({ name: "cs-jsonschema-probe", private: true, version: "0.0.0" }, null, 2)}\n`,
    );

    // Installed for real, the way an adopter does. A failure here is a failure —
    // never a skip, because a check that skips is worse than no check at all.
    const install = Bun.spawnSync({
      cmd: ["bun", "add", tarball],
      cwd: scratch,
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: resolve(scratch, ".cache") },
    });
    const installOutput = `${new TextDecoder().decode(install.stdout)}${new TextDecoder().decode(install.stderr)}`;
    // bun can exit 0 while reporting a failed extraction, so the output is read too.
    if (install.exitCode !== 0 || /\berror:/i.test(installOutput)) {
      console.error("Installing the packed tarball failed:");
      console.error(installOutput);
      process.exit(1);
    }

    const entry = resolve(scratch, "node_modules", "@oxyhq", "crowdsource-contracts", "dist", "index.js");
    const contracts = await import(entry);

    const failures = assertJsonSchemaSurface(contracts);
    if (failures.length > 0) {
      console.error("The packed contracts tarball has an unusable JSON-Schema surface:\n");
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }

    console.log(
      `All ${contracts.CONTRACT_JSON_SCHEMA_NAMES.length} published JSON Schema name(s) convert from the packed tarball, ` +
        "and the name list and schema registry agree.",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
