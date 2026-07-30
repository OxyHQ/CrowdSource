#!/usr/bin/env bun

/**
 * Mutation-tests `assertJsonSchemaSurface`.
 *
 * Against synthetic modules rather than real tarballs, deliberately: packing and
 * installing eight times to test the assertions would make this slow enough that
 * somebody removes it, and the packing half is not the part that can be subtly
 * wrong. The CLI half is a handful of lines of I/O; the judgement is all here.
 *
 * Each failing case requires the reported failure to NAME the offender, because
 * "the JSON-Schema surface is unusable" without a name sends the next person
 * reading three structures by hand.
 */

import { assertJsonSchemaSurface } from "./check-published-json-schemas.mjs";

/** Enough names to clear the floor, all converting, both structures agreeing. */
function healthyModule() {
  const names = Array.from({ length: 15 }, (_, index) => `schema-${index + 1}`);
  const schemas = Object.fromEntries(names.map((name) => [name, { marker: name }]));
  return {
    CONTRACT_JSON_SCHEMA_NAMES: names,
    CONTRACT_SCHEMAS: schemas,
    crowdSourceJsonSchema: (name) => {
      if (!(name in schemas)) throw new Error(`unknown schema ${name}`);
      return { $schema: "https://json-schema.org/draft/2020-12/schema", title: name };
    },
  };
}

const cases = [
  { name: "a sound surface passes", expectFailure: false, mutate: (m) => m },
  {
    name: "a name with no registered schema is caught",
    expectFailure: true,
    mustMention: "schema-99",
    mutate: (m) => ({ ...m, CONTRACT_JSON_SCHEMA_NAMES: [...m.CONTRACT_JSON_SCHEMA_NAMES, "schema-99"] }),
  },
  {
    name: "a registered schema that is never published is caught",
    expectFailure: true,
    mustMention: "secret-schema",
    mutate: (m) => ({ ...m, CONTRACT_SCHEMAS: { ...m.CONTRACT_SCHEMAS, "secret-schema": {} } }),
  },
  {
    name: "a lazily-throwing conversion is caught and named",
    expectFailure: true,
    mustMention: "schema-7",
    // The real defect: an unconvertible schema. Surfaces at neither build nor
    // pack time, only when an integrator asks for that specific name.
    mutate: (m) => ({
      ...m,
      crowdSourceJsonSchema: (name) => {
        if (name === "schema-7") throw new Error("Zod cannot convert this shape");
        return m.crowdSourceJsonSchema(name);
      },
    }),
  },
  {
    name: "a conversion returning an empty document is caught",
    expectFailure: true,
    mustMention: "schema-3",
    mutate: (m) => ({
      ...m,
      crowdSourceJsonSchema: (name) => (name === "schema-3" ? {} : m.crowdSourceJsonSchema(name)),
    }),
  },
  {
    name: "a duplicate published name is caught",
    expectFailure: true,
    mustMention: "duplicate",
    mutate: (m) => ({
      ...m,
      CONTRACT_JSON_SCHEMA_NAMES: [...m.CONTRACT_JSON_SCHEMA_NAMES, m.CONTRACT_JSON_SCHEMA_NAMES[0]],
    }),
  },
  {
    name: "an empty name list trips the floor instead of passing vacuously",
    expectFailure: true,
    mustMention: "floor",
    mutate: (m) => ({ ...m, CONTRACT_JSON_SCHEMA_NAMES: [], CONTRACT_SCHEMAS: {} }),
  },
  {
    name: "a missing export is reported rather than crashing the check",
    expectFailure: true,
    mustMention: "crowdSourceJsonSchema",
    mutate: (m) => ({ ...m, crowdSourceJsonSchema: undefined }),
  },
  {
    name: "adding a name to BOTH structures passes with no count to update",
    expectFailure: false,
    // The point of having no count literal: a legitimate addition needs no edit
    // to this check. If a literal crept back in, this case would start failing.
    mutate: (m) => ({
      ...m,
      CONTRACT_JSON_SCHEMA_NAMES: [...m.CONTRACT_JSON_SCHEMA_NAMES, "appeal"],
      CONTRACT_SCHEMAS: { ...m.CONTRACT_SCHEMAS, appeal: { marker: "appeal" } },
      crowdSourceJsonSchema: (name) => (name === "appeal" ? { title: "appeal" } : m.crowdSourceJsonSchema(name)),
    }),
  },
];

let failed = 0;

for (const testCase of cases) {
  const failures = assertJsonSchemaSurface(testCase.mutate(healthyModule()));
  const didFail = failures.length > 0;
  const output = failures.join("\n");

  if (didFail !== testCase.expectFailure) {
    failed += 1;
    console.error(
      `FAIL  ${testCase.name}\n      expected ${testCase.expectFailure ? "a failure" : "a pass"}, got ${failures.length} failure(s)\n${output}`,
    );
    continue;
  }
  if (testCase.mustMention !== undefined && !output.includes(testCase.mustMention)) {
    failed += 1;
    console.error(`FAIL  ${testCase.name}\n      failed as expected but never mentioned "${testCase.mustMention}"\n${output}`);
    continue;
  }
  console.log(`PASS  ${testCase.name}`);
}

if (failed > 0) {
  console.error(`\n${failed} mutation case(s) failed: assertJsonSchemaSurface is not a working guard.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} mutation cases behaved correctly.`);
