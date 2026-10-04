import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolingCensus, inspectExportMaps } from './security-tooling-exceptions.mjs';

const lock = Bun.JSONC.parse(execFileSync('git', ['show', 'HEAD:bun.lock'], { encoding: 'utf8' }));
const targets = ['braces', 'http-cache-semantics', 'node-forge'];
const baseline = toolingCensus(lock, targets);
let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`); }
}
check('adding a workspace peer changes the census', () => {
  const changed = structuredClone(lock);
  changed.workspaces['packages/backend'].peerDependencies = { ...changed.workspaces['packages/backend'].peerDependencies, braces: '3.0.3' };
  assert.notEqual(toolingCensus(changed, targets).sha256, baseline.sha256);
});
check('adding a package peer changes the census', () => {
  const changed = structuredClone(lock);
  changed.packages.express[2].peerDependencies = { ...changed.packages.express[2].peerDependencies, braces: '3.0.3' };
  assert.notEqual(toolingCensus(changed, targets).sha256, baseline.sha256);
});
const directory = mkdtempSync(join(tmpdir(), 'crowd-map-root-'));
try {
  const bundle = join(directory, '_expo/static/js/web/entry.js');
  mkdirSync(join(directory, '_expo/static/js/web'), { recursive: true });
  writeFileSync(bundle, 'console.log("owned fixture");');
  const map = { version: 3, sources: ['index.js'], names: [], mappings: '' };
  for (const sourceRoot of ['../../node_modules/braces/', '..\\..\\node_modules\\node-forge\\', 42]) {
    check(`sourceRoot ${JSON.stringify(sourceRoot)} refuses`, () => {
      writeFileSync(bundle + '.map', JSON.stringify({ ...map, sourceRoot }));
      assert.throws(() => inspectExportMaps(directory, targets));
    });
  }
  check('explicit empty sourceRoot remains valid', () => {
    writeFileSync(bundle + '.map', JSON.stringify({ ...map, sourceRoot: '' }));
    assert.equal(inspectExportMaps(directory, targets).length, 1);
  });
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log(`${passed} PASS / ${failed} FAIL; owned fixture removed`);
process.exitCode = failed ? 1 : 0;
