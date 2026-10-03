import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolingCensus, permitsToolingException, inspectExportMaps } from './security-tooling-exceptions.mjs';

const lock = Bun.JSONC.parse(execFileSync('git', ['show', 'HEAD:bun.lock'], { encoding: 'utf8' }));
const policy = JSON.parse(readFileSync('docs/audits/2026-10-04-tooling-exception-candidate/policy.json', 'utf8'));
const inputBytes = Object.fromEntries(policy.runtimeInputs.map(input => [input.path, readFileSync(input.path)]));
const invocation = { policy, lock, inputBytes, now: new Date('2026-10-04T00:00:00Z'), advisory: policy.advisories[0].id, packageName: policy.advisories[0].package };
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
check('exact reviewed graph permits only each matching advisory and package', () => {
  for (const entry of policy.advisories) assert.equal(permitsToolingException({ ...invocation, advisory: entry.id, packageName: entry.package }), true);
});
check('unknown advisory refuses', () => assert.equal(permitsToolingException({ ...invocation, advisory: 'GHSA-unreviewed' }), false));
check('known advisory for another package refuses', () => assert.equal(permitsToolingException({ ...invocation, packageName: 'other' }), false));
check('absolute UTC expiry refuses at boundary', () => assert.equal(permitsToolingException({ ...invocation, now: new Date(policy.expires) }), false));
check('invalid clock refuses', () => assert.equal(permitsToolingException({ ...invocation, now: new Date('invalid') }), false));
check('extending exception expiry refuses', () => assert.equal(permitsToolingException({ ...invocation, policy: { ...policy, expires: '2026-10-10T22:00:00Z' } }), false));
for (const [name, mutate] of [
  ['target version drift', value => { value.packages.braces[0] = 'braces@3.0.4'; }],
  ['target archive integrity drift', value => { value.packages.braces[3] = 'sha512-changed'; }],
  ['parent archive integrity drift', value => { value.packages.micromatch[3] = 'sha512-changed'; }],
  ['parent dependency range drift', value => { value.packages.micromatch[2].dependencies.braces = '*'; }],
  ['nested target added', value => { value.packages['new/braces'] = structuredClone(value.packages.braces); }],
  ['backend gains target', value => { value.workspaces['packages/backend'].dependencies.braces = '3.0.3'; }],
  ['new workspace', value => { value.workspaces['packages/unknown'] = {}; }],
  ['unreviewed package patch', value => { value.patchedDependencies = { 'braces@3.0.3': 'patches/changed.patch' }; }],
]) check(name, () => { const changed = structuredClone(lock); mutate(changed); assert.equal(permitsToolingException({ ...invocation, lock: changed }), false); });
check('runtime Docker boundary drift refuses', () => assert.equal(permitsToolingException({ ...invocation, inputBytes: { ...inputBytes, 'packages/backend/Dockerfile': Buffer.from('include all workspaces') } }), false));
check('unrelated Oxy version metadata cannot widen tooling graph', () => {
  const changed = structuredClone(lock); changed.packages['@oxy.so/core'][0] = '@oxy.so/core@4.2.0';
  assert.equal(toolingCensus(changed, policy.advisories.map(entry => entry.package)).sha256, policy.graphSha256);
});
const directory = mkdtempSync(join(tmpdir(), 'crowd-tooling-map-'));
try {
  const bundle = join(directory, '_expo/static/js/web/entry.js'); mkdirSync(join(directory, '_expo/static/js/web'), { recursive: true }); writeFileSync(bundle, 'console.log("fixture");');
  check('missing export map refuses', () => assert.throws(() => inspectExportMaps(directory, ['braces'])));
  const map = { version: 3, sources: ['../../src/App.tsx'], names: [], mappings: '' };
  writeFileSync(bundle + '.map', JSON.stringify(map));
  check('owned export reports exact bundle and map hashes', () => assert.equal(inspectExportMaps(directory, ['braces']).length, 1));
  for (const name of ['braces', 'http-cache-semantics', 'node-forge']) check(`export includes ${name} refuses`, () => {
    writeFileSync(bundle + '.map', JSON.stringify({ ...map, sources: [`../../node_modules/${name}/index.js`] }));
    assert.throws(() => inspectExportMaps(directory, [name]));
  });
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log(`${checks} scoped exception controls PASS; policy remains inactive`);
