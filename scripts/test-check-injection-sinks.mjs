#!/usr/bin/env bun

/**
 * Mutation-tests `check-injection-sinks.mjs`.
 *
 * A guard nobody has broken on purpose is a guard nobody knows works, and this one
 * guards a claim that is otherwise unverified: that no package interprets a string
 * as markup or code. So every sink it claims to detect is PLANTED here and the
 * checker must fail AND name the file — a non-zero exit that does not say where the
 * sink is sends the next person grepping 285 files by hand.
 *
 * Four kinds of case, and the last two are the ones that make the difference
 * between a check and a ritual:
 *
 *   1. the healthy tree passes (without this, a checker broken into always failing
 *      would pass every other case here);
 *   2. each sink is caught, by name and by file;
 *   3. the two lookalikes ALREADY IN THIS TREE do not trip it — `WebViewStyle` and
 *      `evaluateConsensus`. A gate that cries wolf gets disabled by whoever hits it
 *      next, so these are regression tests against that outcome;
 *   4. both vacuity floors fire, and the comment stripper does not blind the
 *      scanner. A scan that traversed nothing reports the same clean result as a
 *      scan that found nothing, and a stripper that truncates at the `//` inside a
 *      URL would silently delete the rest of the line.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checker = resolve(dirname(fileURLToPath(import.meta.url)), "check-injection-sinks.mjs");

/**
 * A tree that must pass: one benign file per expected package, plus the two
 * lookalikes that must never be mistaken for sinks.
 */
function healthyTree() {
  return {
    "packages/contracts/src/index.ts": "export const CONTRACT = 1;\n",
    "packages/backend/src/app.ts": "export function createApp() { return {}; }\n",
    "packages/reviewer/components/ResourceView.tsx":
      "export function ResourceView({ text }: { text: string }) {\n" +
      "  return <Text selectable={false}>{text}</Text>;\n" +
      "}\n",
    "packages/sdk/src/client.ts": "export const client = {};\n",
    "packages/sdk-express/src/middleware.ts": "export const middleware = () => {};\n",
    "packages/testing/src/fixtures.ts": "export const fixture = {};\n",
  };
}

const cases = [
  {
    name: "the healthy tree passes",
    expectFailure: false,
    mutate: (tree) => tree,
  },

  // --- every sink, planted ---------------------------------------------------
  {
    name: "dangerouslySetInnerHTML is caught",
    expectFailure: true,
    mustMention: ["packages/reviewer/components/ResourceView.tsx", "dangerouslySetInnerHTML"],
    mutate: (tree) => ({
      ...tree,
      "packages/reviewer/components/ResourceView.tsx":
        "export function ResourceView({ text }: { text: string }) {\n" +
        "  return <div dangerouslySetInnerHTML={{ __html: text }} />;\n" +
        "}\n",
    }),
  },
  {
    name: "innerHTML is caught",
    expectFailure: true,
    mustMention: ["packages/reviewer/components/ResourceView.tsx", "innerHTML"],
    mutate: (tree) => ({
      ...tree,
      "packages/reviewer/components/ResourceView.tsx":
        "export function render(node: HTMLElement, text: string) {\n" +
        "  node.innerHTML = text;\n" +
        "}\n",
    }),
  },
  {
    name: "outerHTML is caught",
    expectFailure: true,
    mustMention: ["outerHTML"],
    mutate: (tree) => ({
      ...tree,
      "packages/reviewer/components/ResourceView.tsx":
        "export function swap(node: HTMLElement, text: string) { node.outerHTML = text; }\n",
    }),
  },
  {
    name: "insertAdjacentHTML is caught",
    expectFailure: true,
    mustMention: ["insertAdjacentHTML"],
    mutate: (tree) => ({
      ...tree,
      "packages/reviewer/components/ResourceView.tsx":
        "export function add(node: HTMLElement, text: string) {\n" +
        "  node.insertAdjacentHTML('beforeend', text);\n" +
        "}\n",
    }),
  },
  {
    name: "document.write is caught",
    expectFailure: true,
    mustMention: ["document.write"],
    mutate: (tree) => ({
      ...tree,
      "packages/reviewer/components/ResourceView.tsx":
        "export function emit(text: string) { document.write(text); }\n",
    }),
  },
  {
    name: "a WebView component is caught",
    expectFailure: true,
    mustMention: ["WebView"],
    mutate: (tree) => ({
      ...tree,
      "packages/reviewer/components/ResourceView.tsx":
        "import { WebView } from 'react-native-webview';\n" +
        "export const Show = ({ html }: { html: string }) => <WebView source={{ html }} />;\n",
    }),
  },
  {
    name: "eval is caught",
    expectFailure: true,
    mustMention: ["eval"],
    mutate: (tree) => ({
      ...tree,
      "packages/backend/src/app.ts": "export function run(code: string) { return eval(code); }\n",
    }),
  },
  {
    name: "new Function is caught",
    expectFailure: true,
    mustMention: ["new Function"],
    mutate: (tree) => ({
      ...tree,
      "packages/backend/src/app.ts":
        "export function compile(body: string) { return new Function(body); }\n",
    }),
  },
  {
    name: "setTimeout with a string body is caught",
    expectFailure: true,
    mustMention: ["setTimeout"],
    mutate: (tree) => ({
      ...tree,
      "packages/backend/src/app.ts": "export function later() { setTimeout('doThing()', 10); }\n",
    }),
  },

  // --- the lookalikes already in this tree ----------------------------------
  {
    /**
     * `WebViewStyle` is a react-native-web STYLE type in
     * `packages/reviewer/types/webStyles.ts`. It is not the WebView component, and
     * a scan that flags it would be disabled within a day.
     */
    name: "WebViewStyle is NOT mistaken for a WebView",
    expectFailure: false,
    mutate: (tree) => ({
      ...tree,
      "packages/reviewer/types/webStyles.ts":
        "import type { ViewStyle } from 'react-native';\n" +
        "export type WebViewStyle = Omit<ViewStyle, 'position'>;\n" +
        "export interface WebViewProps { style: WebViewStyle }\n" +
        "export const asViewStyle = (style: WebViewStyle): ViewStyle => style as ViewStyle;\n",
    }),
  },
  {
    name: "evaluateConsensus is NOT mistaken for eval",
    expectFailure: false,
    mutate: (tree) => ({
      ...tree,
      "packages/backend/src/consensus.ts":
        "export function evaluateConsensus(input: unknown) { return input; }\n" +
        "export const verdict = evaluateConsensus({});\n" +
        "export const revaluate = (x: number) => x;\n",
    }),
  },
  {
    name: "a comment ABOUT a sink is not a use of one",
    expectFailure: false,
    mutate: (tree) => ({
      ...tree,
      "packages/reviewer/components/ResourceView.tsx":
        "/**\n" +
        " * Never use dangerouslySetInnerHTML here, and never node.innerHTML either.\n" +
        " * A WebView would hand the reported site our origin. Do not eval(anything).\n" +
        " */\n" +
        "// document.write is also forbidden; so is new Function(body).\n" +
        "export const Safe = () => null;\n",
    }),
  },

  // --- the checks on the checks ---------------------------------------------
  {
    /**
     * The naive `line.replace(/\/\/.*$/, "")` truncates at the `//` inside a URL,
     * deleting the rest of the line — so a sink after a URL would go UNDETECTED.
     * For a security gate a false negative is the unacceptable direction.
     */
    name: "a sink AFTER a URL on the same line is still caught",
    expectFailure: true,
    mustMention: ["innerHTML"],
    mutate: (tree) => ({
      ...tree,
      "packages/reviewer/components/ResourceView.tsx":
        "export function go(node: HTMLElement) {\n" +
        "  const docs = 'https://example.com/a//b'; node.innerHTML = docs;\n" +
        "}\n",
    }),
  },
  {
    name: "the file-count floor fires rather than reporting a clean scan",
    expectFailure: true,
    minFiles: 999,
    mustMention: ["floor of 999", "broken traversal"],
    mutate: (tree) => tree,
  },
  {
    /**
     * The second vacuity axis. A file-count floor low enough to survive ordinary
     * churn would be cleared by a traversal that walked only one package, so a
     * package present on disk contributing nothing has to fail on its own.
     */
    name: "a package that exists but yields no files fails on its own",
    expectFailure: true,
    mustMention: ["packages/backend exists on disk but contributed no scanned files"],
    mutate: (tree) => {
      const mutated = { ...tree };
      delete mutated["packages/backend/src/app.ts"];
      mutated["packages/backend/README.md"] = "# backend\n";
      return mutated;
    },
  },
  {
    name: "the allowlist is empty, so the first entry is a visible edit",
    expectFailure: false,
    mustMention: ["0 allowlisted"],
    mutate: (tree) => tree,
  },
];

let failed = 0;

for (const testCase of cases) {
  const root = await mkdtemp(join(tmpdir(), "crowdsource-sink-"));
  try {
    const tree = testCase.mutate(healthyTree());
    for (const [path, contents] of Object.entries(tree)) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, "utf8");
    }

    const result = spawnSync(
      "bun",
      [checker, root, `--min-files=${testCase.minFiles ?? 1}`],
      { encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const didFail = result.status !== 0;

    if (didFail !== testCase.expectFailure) {
      failed += 1;
      console.error(
        `FAIL  ${testCase.name}\n      expected ${
          testCase.expectFailure ? "a failure" : "a pass"
        }, got exit ${result.status}\n${output.replace(/^/gm, "      ")}`,
      );
      continue;
    }

    const missing = (testCase.mustMention ?? []).filter((needle) => !output.includes(needle));
    if (missing.length > 0) {
      failed += 1;
      console.error(
        `FAIL  ${testCase.name}\n      exited correctly but never mentioned: ${missing.join(
          ", ",
        )}\n${output.replace(/^/gm, "      ")}`,
      );
      continue;
    }

    console.log(`ok    ${testCase.name}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} mutation cases failed.`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} mutation cases behaved as specified.`);
