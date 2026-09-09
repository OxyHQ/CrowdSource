#!/usr/bin/env bun

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// The static hosting contract for a Cloudflare WORKER serving `[assets]`.
//
// Two of the three assertions below are about the same thing from opposite
// sides: the export must carry the cache rules the live smoke checks for, and it
// must NOT carry a Worker entry point. A `_worker.js` in the assets directory is
// the trap this file exists to catch — Pages Advanced Mode loaded it, a Worker
// does not, so leaving one there makes it inert AND publishes the script as a
// public asset. `main` in `wrangler.toml` is where a Worker script belongs.
const outputDirectory = resolve(
  process.argv[2] || "packages/reviewer/dist",
);
const failures = [];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const indexPath = resolve(outputDirectory, "index.html");
if (!(await exists(indexPath))) {
  failures.push("index.html is missing");
}

const headersPath = resolve(outputDirectory, "_headers");
if (!(await exists(headersPath))) {
  failures.push("_headers is missing");
} else {
  const headers = await readFile(headersPath, "utf8");
  for (const route of ["/_expo/static/*", "/fonts/*"]) {
    const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const immutableRule = new RegExp(
      `^${escapedRoute}\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+Cache-Control:\\s*public,\\s*max-age=31536000,\\s*immutable\\s*$`,
      "im",
    );
    if (!immutableRule.test(headers)) {
      failures.push(
        `_headers has no one-year immutable cache rule for ${route}`,
      );
    }
  }
}

for (const workerEntryPoint of ["_worker.js", "_worker.js.map", "_routes.json"]) {
  if (await exists(resolve(outputDirectory, workerEntryPoint))) {
    failures.push(
      `${workerEntryPoint} must not be published; this deployment serves static assets only, and a Worker entry point inside the assets directory is never executed — it is uploaded as a public file`,
    );
  }
}

// `not_found_handling = "single-page-application"` in wrangler.toml is what
// answers a deep link now. A `_redirects` left behind would be a second,
// silently-diverging copy of that rule.
if (await exists(resolve(outputDirectory, "_redirects"))) {
  failures.push(
    "_redirects must not be published; the SPA fallback is not_found_handling in wrangler.toml",
  );
}

if (failures.length > 0) {
  console.error(`Frontend static output validation failed for ${outputDirectory}:\n`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Frontend static output contains immutable asset headers and no Worker entry point: ${outputDirectory}`,
);
