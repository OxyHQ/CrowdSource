#!/usr/bin/env bun

// Enforces a suite's AGGREGATE line and function coverage from an lcov report.
//
// `bun test` has a `coverageThreshold`, but it is checked per FILE: one file at
// 0% functions fails a run whose total is 99%, and a threshold low enough to let
// every file through gates nothing. vitest's thresholds, which this replaces for
// the backend, were totals over the package's source. So the totals are summed
// here, over the files the package owns — `--only` keeps the sources, `--except`
// drops the tests and their support code — and compared against the floor.
//
// Bun reports no branch or statement metric, so only lines and functions are
// enforced. Like any floor, these are MINIMUMS measured on the complete suite:
// raise them as coverage grows, and never lower one to make a run pass.

import { readFile } from 'node:fs/promises';

const positional = [];
const only = [];
const except = [];
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--only=')) only.push(argument.slice('--only='.length));
  else if (argument.startsWith('--except=')) except.push(argument.slice('--except='.length));
  else positional.push(argument);
}

const [reportPath, label, linesArgument, functionsArgument] = positional;
if (!reportPath || !label || !linesArgument || !functionsArgument || positional.length !== 4) {
  console.error(
    '::error::usage: assert-coverage.mjs <lcov.info> <label> <minimum-lines-%> <minimum-functions-%> [--only=<path-prefix>]... [--except=<path-prefix>]...',
  );
  process.exit(1);
}

const minimum = { lines: Number(linesArgument), functions: Number(functionsArgument) };
for (const [metric, value] of Object.entries(minimum)) {
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    console.error(
      `::error::${label}: the minimum ${metric} coverage must be a percentage in (0, 100], got ${metric === 'lines' ? linesArgument : functionsArgument}.`,
    );
    process.exit(1);
  }
}

let source;
try {
  source = await readFile(reportPath, 'utf8');
} catch (error) {
  // No report is the shape of a run that never measured anything.
  console.error(
    `::error::${label}: could not read the coverage report at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const totals = { lines: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } };
let files = 0;
const malformed = [];
for (const record of source.split(/^end_of_record$/m)) {
  const file = /^SF:(.*)$/m.exec(record)?.[1];
  if (file === undefined) continue;
  if (only.length > 0 && !only.some((prefix) => file.startsWith(prefix))) continue;
  if (except.some((prefix) => file.startsWith(prefix))) continue;
  const field = (name) => {
    const value = new RegExp(`^${name}:(\\d+)$`, 'm').exec(record)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const counts = { LF: field('LF'), LH: field('LH'), FNF: field('FNF'), FNH: field('FNH') };
  if (Object.values(counts).some((value) => value === undefined)) {
    malformed.push(file);
    continue;
  }
  files += 1;
  totals.lines.found += counts.LF;
  totals.lines.hit += counts.LH;
  totals.functions.found += counts.FNF;
  totals.functions.hit += counts.FNH;
}

if (malformed.length > 0) {
  console.error(
    `::error::${label}: ${malformed.length} file record(s) carry no LF/LH/FNF/FNH totals (${malformed.slice(0, 3).join(', ')}), so the run cannot be verified. The reporter's format may have changed.`,
  );
  process.exit(1);
}
if (files === 0 || totals.lines.found === 0 || totals.functions.found === 0) {
  // An empty report is not 100% covered; it is a run that measured nothing.
  console.error(
    `::error::${label}: the coverage report names no measured source file in scope, so there is nothing to compare against the floor.`,
  );
  process.exit(1);
}

const percent = ({ found, hit }) => (hit / found) * 100;
const measured = { lines: percent(totals.lines), functions: percent(totals.functions) };
console.log(
  `${label}: ${measured.lines.toFixed(2)}% lines (${totals.lines.hit}/${totals.lines.found}), ${measured.functions.toFixed(2)}% functions (${totals.functions.hit}/${totals.functions.found}) across ${files} file(s).`,
);

const problems = [];
for (const metric of ['lines', 'functions']) {
  if (measured[metric] < minimum[metric]) {
    problems.push(
      `${metric} coverage is ${measured[metric].toFixed(2)}%, below the floor of ${minimum[metric]}%.`,
    );
  }
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${label}: ${problem}`);
  process.exit(1);
}
