#!/usr/bin/env bun

/**
 * No package renders or evaluates anything.
 *
 * CrowdSource shows a jury the exact hostile material a report is about. A
 * harassment report quotes the harassment; a phishing report quotes the link. So
 * the contracts deliberately apply NO lexical filter to text — a blocklist would
 * reject the evidence and protect nothing — and the whole safety argument rests on
 * a structural claim instead:
 *
 *   the contract has no field whose value is ever interpreted as markup, a
 *   template, a component or a URL to be fetched, so there is nothing for a
 *   hostile string to be interpreted AS.
 *
 * That claim is about the RENDERERS, not about the schemas, and nothing else in
 * this repository checks it. One `dangerouslySetInnerHTML` added to a reviewer
 * screen turns every stored report into stored XSS against the one population that
 * cannot refuse to look at it, and it would pass tsc, lint, every unit test and
 * every schema assertion. There is no diagnostic: the app renders, the test suite
 * is green, and the material displays exactly as intended — because displaying it
 * IS the exploit.
 *
 * `docs/architecture/threat-model.md` §3 names this control and lists this scan as
 * the only thing that would notice it being lost. This is that scan.
 *
 * ## Two false positives are handled deliberately
 *
 * A gate that cries wolf gets disabled by whoever hits it next, so the two
 * lookalikes already in this tree are excluded by construction rather than by an
 * allowlist entry:
 *
 *   - `WebViewStyle` in `packages/reviewer/types/webStyles.ts` is a
 *     react-native-web STYLE type, not the `WebView` component. The word boundary
 *     in `\bWebView\b` is what separates them.
 *   - `evaluateConsensus` in the consensus module is not `eval`. `\beval\s*\(`
 *     requires the call, so it does not match.
 *
 * Both are asserted in `test-check-injection-sinks.mjs`. If either ever starts
 * tripping this scan, fix the pattern — do not add an allowlist entry, because the
 * allowlist is for real sinks that are genuinely safe, and neither of these is a
 * sink at all.
 *
 * ## Two vacuity floors, because a scan that finds nothing looks identical to a
 * scan that traversed nothing
 *
 * `--min-files` fails when fewer files were read than a broken traversal would
 * plausibly leave, and the package-coverage floor fails when a package that exists
 * on disk contributed zero files. One axis is not enough: a traversal that walked
 * only `packages/contracts` would clear a file count set low enough to survive
 * ordinary churn.
 *
 * Run against another tree with `bun scripts/check-injection-sinks.mjs <root>`,
 * which is how the mutation test drives it.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sinks. Each entry is one way a string becomes behaviour.
 *
 * `what` is written to be readable in a CI log by somebody who has never seen
 * this file, because that is the only context it will ever be read in.
 */
const SINKS = [
  {
    what: "React HTML injection (dangerouslySetInnerHTML)",
    pattern: /\bdangerouslySetInnerHTML\b/,
  },
  {
    what: "DOM HTML sink (innerHTML / outerHTML)",
    pattern: /\.(inner|outer)HTML\b/,
  },
  {
    what: "DOM HTML sink (insertAdjacentHTML)",
    pattern: /\binsertAdjacentHTML\s*\(/,
  },
  {
    /**
     * `write(?:ln)?`, not `writeln?` — the latter parses as `writel` plus an
     * optional `n`, so it requires the literal "writel" and never matches
     * `document.write(`. The mutation test caught exactly that, which is the
     * argument for having one.
     */
    what: "DOM HTML sink (document.write)",
    pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/,
  },
  {
    /**
     * A WebView renders attacker-controlled HTML and script with the app's own
     * origin and cookie jar. It is the single most dangerous component that could
     * appear on a reviewer screen, and `\b` on both sides is what keeps
     * `WebViewStyle` and `WebViewProps` out.
     */
    what: "WebView component (renders arbitrary HTML with the app's origin)",
    pattern: /\bWebView\b/,
  },
  {
    what: "code evaluation (eval)",
    pattern: /\beval\s*\(/,
  },
  {
    what: "code evaluation (new Function)",
    pattern: /\bnew\s+Function\s*\(/,
  },
  {
    /**
     * `setTimeout("…")` with a string body is `eval` with a delay. Only a string
     * literal as the FIRST argument is a sink; a function is the normal use, so
     * the pattern requires the quote.
     */
    what: "code evaluation (setTimeout/setInterval with a string body)",
    pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
  },
];

/**
 * Real sinks that are genuinely safe, each with the reason.
 *
 * EMPTY, and the test pins it empty — so the first entry is a visible edit to a
 * test rather than a quiet line in a config file. An entry here means "this is a
 * sink and we accept it", which is a decision that should be argued for in a
 * review, not discovered later.
 */
export const INJECTION_SINK_ALLOWED = Object.freeze({});

/** Directories that are never source. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  ".expo",
  ".next",
  "coverage",
  "android",
  "ios",
]);

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Packages that must each contribute at least one scanned file.
 *
 * The second vacuity axis. A package absent from disk is skipped rather than
 * failed, so this does not break the day a package is added or removed — but a
 * package that EXISTS and yields nothing means the walk is broken.
 */
const EXPECTED_PACKAGES = ["contracts", "backend", "reviewer", "sdk", "sdk-express", "testing"];

const DEFAULT_MIN_FILES = 200;

const positional = [];
let minFiles = DEFAULT_MIN_FILES;
for (const argument of process.argv.slice(2)) {
  const match = /^--min-files=(\d+)$/.exec(argument);
  if (match) {
    minFiles = Number(match[1]);
    continue;
  }
  positional.push(argument);
}

const repositoryRoot =
  positional[0] === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
    : resolve(positional[0]);

/**
 * Removes comments so a doc comment ABOUT a sink is not read as a use of one.
 *
 * Quote-aware on purpose. The naive `line.replace(/\/\/.*$/, "")` truncates at the
 * `//` inside `"https://…"`, which silently deletes the rest of the line — and a
 * sink after a URL on the same line would then go UNDETECTED. For a security gate
 * a false negative is the unacceptable direction, so string state is tracked.
 * `test-check-injection-sinks.mjs` plants a sink after a URL to prove it.
 */
function stripComments(source) {
  const output = [];
  let inBlockComment = false;
  let quote = null;

  for (const line of source.split("\n")) {
    let kept = "";
    let index = 0;

    while (index < line.length) {
      const character = line[index];
      const next = line[index + 1];

      if (inBlockComment) {
        if (character === "*" && next === "/") {
          inBlockComment = false;
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }

      if (quote !== null) {
        kept += character;
        if (character === "\\") {
          kept += next ?? "";
          index += 2;
          continue;
        }
        if (character === quote) quote = null;
        index += 1;
        continue;
      }

      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        kept += character;
        index += 1;
        continue;
      }
      if (character === "/" && next === "/") break;
      if (character === "/" && next === "*") {
        inBlockComment = true;
        index += 2;
        continue;
      }

      kept += character;
      index += 1;
    }

    output.push(kept);
    // A template literal spans lines; a single-quoted string does not.
    if (quote === '"' || quote === "'") quote = null;
  }

  return output;
}

function isAllowed(path) {
  return Object.keys(INJECTION_SINK_ALLOWED).some((allowed) => path.startsWith(allowed));
}

async function collectSourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await collectSourceFiles(join(directory, entry.name))));
      continue;
    }
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

const packagesRoot = resolve(repositoryRoot, "packages");
const files = await collectSourceFiles(packagesRoot);

const findings = [];
const perPackage = new Map();

for (const absolute of files) {
  const path = relative(repositoryRoot, absolute).replaceAll("\\", "/");
  const packageName = path.split("/")[1];
  perPackage.set(packageName, (perPackage.get(packageName) ?? 0) + 1);

  if (isAllowed(path)) continue;

  const source = await readFile(absolute, "utf8");
  stripComments(source).forEach((code, index) => {
    for (const { what, pattern } of SINKS) {
      if (pattern.test(code)) {
        findings.push({
          path,
          line: index + 1,
          what,
          // The FULL line, never a capture group: a truncated match hides why.
          text: code.trim(),
        });
      }
    }
  });
}

const failures = [];

for (const finding of findings) {
  failures.push(
    `${finding.path}:${finding.line} — ${finding.what}\n      ${finding.text}`,
  );
}

if (files.length < minFiles) {
  failures.push(
    `only ${files.length} source files were scanned, below the floor of ${minFiles}. ` +
      "A scan that traverses nothing reports the same clean result as a scan that finds " +
      "nothing, so this is treated as a broken traversal rather than a pass.",
  );
}

for (const name of EXPECTED_PACKAGES) {
  const exists = await stat(join(packagesRoot, name))
    .then(() => true)
    .catch(() => false);
  if (!exists) continue;
  if ((perPackage.get(name) ?? 0) === 0) {
    failures.push(
      `packages/${name} exists on disk but contributed no scanned files — the walk is broken.`,
    );
  }
}

if (failures.length > 0) {
  console.error("Injection-sink scan failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nCrowdSource renders hostile material to a jury by design. Nothing in the contract " +
      "is ever interpreted as markup or code, and that is the whole reason a lexical filter " +
      "on report text is unnecessary. A sink breaks that argument: see " +
      "docs/architecture/threat-model.md §3.",
  );
  process.exit(1);
}

const coverage = EXPECTED_PACKAGES.filter((name) => (perPackage.get(name) ?? 0) > 0).length;
const allowed = Object.keys(INJECTION_SINK_ALLOWED).length;
console.log(
  `No injection or evaluation sink in ${files.length} source files across ${coverage} packages ` +
    `(floor ${minFiles}); ${SINKS.length} sink patterns checked; ${allowed} allowlisted.`,
);
