#!/usr/bin/env bun

// Mutation-tests the vacuity floor. The floor exists to catch a suite that ran
// nothing, so the one thing it must never do is pass on an empty or missing
// report — and that is exactly the case a floor added carelessly gets wrong.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assertScript = resolve(dirname(fileURLToPath(import.meta.url)), 'assert-test-floor.mjs');
const workingDirectory = await mkdtemp(join(tmpdir(), 'crowdsource-test-floor-'));
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

async function writeReport(name, report) {
  const path = join(workingDirectory, name);
  await writeFile(path, typeof report === 'string' ? report : JSON.stringify(report));
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

const healthy = {
  numTotalTests: 175,
  numFailedTests: 0,
  success: true,
  testResults: Array.from({ length: 11 }, () => ({})),
};

// A real run above its floor passes, and states the count it measured.
await expectVerdict(
  'above-floor',
  [await writeReport('healthy.json', healthy), 'packages/contracts', '150'],
  0,
  'packages/contracts: 175 test(s) across 11 file(s), 0 failed.',
);

// The collapse this floor exists for: a runner that found almost nothing.
await expectVerdict(
  'collapsed-suite',
  [
    await writeReport('collapsed.json', { ...healthy, numTotalTests: 2, testResults: [{}] }),
    'packages/contracts',
    '150',
  ],
  1,
  'only 2 test(s) ran, below the floor of 150',
);

// Zero tests is the shape of a wrong working directory or a broken glob.
await expectVerdict(
  'empty-suite',
  [
    await writeReport('empty.json', { ...healthy, numTotalTests: 0, testResults: [] }),
    'packages/core',
    '60',
  ],
  1,
  'only 0 test(s) ran, below the floor of 60',
);

// A report that says tests failed while the runner exited 0 must not pass.
await expectVerdict(
  'failed-tests-reported',
  [
    await writeReport('failed.json', { ...healthy, numFailedTests: 3, success: false }),
    'packages/core',
    '45',
  ],
  1,
  '3 test(s) failed but the runner exited successfully.',
);

// A missing report is a suite that never ran, not "nothing to check".
await expectVerdict(
  'missing-report',
  [join(workingDirectory, 'does-not-exist.json'), 'packages/core', '12'],
  1,
  'could not read the test report',
);

// A reporter whose format changed must fail loudly rather than silently stop counting.
await expectVerdict(
  'unrecognised-report',
  [await writeReport('shape.json', { total: 175 }), 'packages/core', '12'],
  1,
  'carries no numTotalTests/numFailedTests',
);

// `bun test` reports as JUnit XML. Shaped on a real `bun test --reporter=junit`
// run: a <testsuites> root with the totals, one <testsuite> per file (a `file`
// and no `line`), and a nested <testsuite> per describe block (with a `line`),
// which must not be counted as a file.
function junit({ tests, failures, files = 2, extraRoot = '' }) {
  const suites = Array.from(
    { length: files },
    (_, index) =>
      `  <testsuite name="src/__tests__/f${index}.test.ts" file="src/__tests__/f${index}.test.ts" tests="1" failures="0" skipped="0" time="0.01" hostname="ci">
    <testsuite name="block" file="src/__tests__/f${index}.test.ts" line="3" tests="1" failures="0" skipped="0" time="0.01" hostname="ci">
      <testcase name="case" classname="block" time="0.001" file="src/__tests__/f${index}.test.ts" line="4" assertions="1" />
    </testsuite>
  </testsuite>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="${tests}" assertions="${tests}" failures="${failures}" skipped="0" time="0.3"${extraRoot}>
${suites}
</testsuites>
`;
}

await expectVerdict(
  'junit-above-floor',
  [
    await writeReport('healthy.xml', junit({ tests: 241, failures: 0, files: 15 })),
    'packages/contracts',
    '195',
  ],
  0,
  'packages/contracts: 241 test(s) across 15 file(s), 0 failed.',
);

await expectVerdict(
  'junit-collapsed-suite',
  [
    await writeReport('collapsed.xml', junit({ tests: 3, failures: 0, files: 1 })),
    'packages/contracts',
    '195',
  ],
  1,
  'only 3 test(s) ran, below the floor of 195',
);

await expectVerdict(
  'junit-failed-tests-reported',
  [
    await writeReport('failed.xml', junit({ tests: 241, failures: 2 })),
    'packages/contracts',
    '195',
  ],
  1,
  '2 test(s) failed but the runner exited successfully.',
);

// Some JUnit writers count errors apart from failures; an error is a failure here.
await expectVerdict(
  'junit-errors-reported',
  [
    await writeReport('errors.xml', junit({ tests: 241, failures: 0, extraRoot: ' errors="1"' })),
    'packages/contracts',
    '195',
  ],
  1,
  '1 test(s) failed but the runner exited successfully.',
);

await expectVerdict(
  'junit-unrecognised-report',
  [
    await writeReport(
      'shape.xml',
      '<?xml version="1.0"?>\n<testsuites name="bun test">\n</testsuites>\n',
    ),
    'packages/contracts',
    '12',
  ],
  1,
  'tests/failures totals (JUnit)',
);

await expectVerdict(
  'junit-no-root',
  [
    await writeReport(
      'noroot.xml',
      '<?xml version="1.0"?>\n<testsuite tests="241" failures="0"/>\n',
    ),
    'packages/contracts',
    '12',
  ],
  1,
  'expected one <testsuites> root element, found 0',
);

await expectVerdict('missing-arguments', [], 1, 'usage: assert-test-floor.mjs');

if (workingDirectory.startsWith(join(tmpdir(), 'crowdsource-test-floor-'))) {
  await rm(workingDirectory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('Test floor assertion tests failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Test floor assertion tests passed.');
