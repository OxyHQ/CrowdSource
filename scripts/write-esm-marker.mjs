#!/usr/bin/env bun
/**
 * Marks `dist/esm/` as ESM.
 *
 * The root manifest says `"type": "commonjs"`, which Node applies to every `.js`
 * beneath it — including the ESM emit. Without this file Node parses
 * `dist/esm/index.js` as CommonJS and fails on the first `import` statement.
 * One line, and the whole ESM half is inert without it.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
await writeFile(resolve(process.cwd(), "dist/esm/package.json"), '{"type":"module"}\n');
