#!/usr/bin/env bun

// Mutation-tests the coverage floor. It must fail on a total below the floor, on
// a report that measured nothing, and on files outside the package's own source
// inflating the total — and pass a healthy report while stating what it summed.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assertScript = resolve(dirname(fileURLToPath(import.meta.url)), 'assert-coverage.mjs');
const workingDirectory = await mkdtemp(join(tmpdir(), 'crowdsource-coverage-floor-'));
const decoder = new TextDecoder();
const failures = [];

function runAssert(args) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, assertScript, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
  };
}

async function writeReport(name, text) {
  const path = join(workingDirectory, name);
  await writeFile(path, text);
  return path;
}

async function expectVerdict(caseName, args, expectedExitCode, expectedFragment) {
  const { exitCode, output } = runAssert(args);
  if (exitCode !== expectedExitCode) {
    failures.push(`${caseName}: expected exit ${expectedExitCode}, got ${exitCode}.\n${output}`);
    return;
  }
  if (!output.includes(expectedFragment)) {
    failures.push(
      `${caseName}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`,
    );
  }
}

// Shaped on a real `bun test --coverage-reporter=lcov` record.
function record(file, { lf, lh, fnf, fnh }) {
  return `TN:\nSF:${file}\nFNF:${fnf}\nFNH:${fnh}\nDA:1,1\nLF:${lf}\nLH:${lh}\nend_of_record\n`;
}

const scope = ['--only=src/', '--except=src/__tests__/'];

// Two source files: 190/200 lines (95%), 19/20 functions (95%).
const healthy =
  record('src/a.ts', { lf: 100, lh: 100, fnf: 10, fnh: 10 }) +
  record('src/b.ts', { lf: 100, lh: 90, fnf: 10, fnh: 9 });

await expectVerdict(
  'above-floor',
  [await writeReport('healthy.info', healthy), 'packages/backend', '90', '90', ...scope],
  0,
  'packages/backend: 95.00% lines (190/200), 95.00% functions (19/20) across 2 file(s).',
);

await expectVerdict(
  'lines-below-floor',
  [await writeReport('lines.info', healthy), 'packages/backend', '96', '90', ...scope],
  1,
  'lines coverage is 95.00%, below the floor of 96%.',
);

await expectVerdict(
  'functions-below-floor',
  [await writeReport('functions.info', healthy), 'packages/backend', '90', '96', ...scope],
  1,
  'functions coverage is 95.00%, below the floor of 96%.',
);

// Fully covered test helpers and files from another package must not lift a
// total that the package's own source does not reach.
await expectVerdict(
  'out-of-scope-files-ignored',
  [
    await writeReport(
      'scoped.info',
      healthy +
        record('src/__tests__/support/helpers.ts', { lf: 1000, lh: 1000, fnf: 100, fnh: 100 }) +
        record('../contracts/src/index.ts', { lf: 1000, lh: 1000, fnf: 100, fnh: 100 }),
    ),
    'packages/backend',
    '96',
    '90',
    ...scope,
  ],
  1,
  'lines coverage is 95.00%, below the floor of 96%.',
);

await expectVerdict(
  'nothing-in-scope',
  [
    await writeReport('empty.info', record('src/__tests__/x.ts', { lf: 1, lh: 1, fnf: 1, fnh: 1 })),
    'packages/backend',
    '90',
    '90',
    ...scope,
  ],
  1,
  'names no measured source file in scope',
);

await expectVerdict(
  'missing-totals',
  [
    await writeReport('shape.info', 'TN:\nSF:src/a.ts\nDA:1,1\nend_of_record\n'),
    'packages/backend',
    '90',
    '90',
    ...scope,
  ],
  1,
  'carry no LF/LH/FNF/FNH totals',
);

await expectVerdict(
  'missing-report',
  [join(workingDirectory, 'absent.info'), 'packages/backend', '90', '90', ...scope],
  1,
  'could not read the coverage report',
);

await expectVerdict(
  'non-percentage-floor',
  [await writeReport('floor.info', healthy), 'packages/backend', '0', '90', ...scope],
  1,
  'must be a percentage in (0, 100]',
);

await rm(workingDirectory, { recursive: true, force: true });

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`);
  process.exit(1);
}
console.log('assert-coverage.mjs: every case returned its expected verdict.');
