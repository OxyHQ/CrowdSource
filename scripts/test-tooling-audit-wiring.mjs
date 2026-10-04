import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { collectToolingBuildInputs } from './security-tooling-exceptions.mjs';
const temp = mkdtempSync(join(tmpdir(), 'crowd-audit-policy-'));
try {
  mkdirSync(join(temp, 'scripts')); mkdirSync(join(temp, 'packages/backend'), { recursive: true });
  const originalPolicy = JSON.parse(readFileSync('security-tooling-policy.json', 'utf8'));
  for (const path of ['scripts/audit-security.mjs', 'scripts/security-tooling-exceptions.mjs', 'bun.lock', 'security-audit-exceptions.json', '.github/workflows/ci.yml', ...originalPolicy.runtimeInputs.map(v => v.path)]) { mkdirSync(join(temp, path.substring(0, path.lastIndexOf('/')) || '.'), {recursive:true}); copyFileSync(path, join(temp, path)); }
  mkdirSync(join(temp, 'packages/reviewer')); writeFileSync(join(temp, 'packages/reviewer/package.json'), '{}');
  execFileSync('git', ['init', '-q'], {cwd:temp}); execFileSync('git', ['add', '--', '.'], {cwd:temp});
  const original = originalPolicy;
  const bindingPath='docs/audits/2026-10-04-tooling-p2-remediation/records/reviewed-build-inputs.json';
  const binding=collectToolingBuildInputs(temp);
  writeFileSync(join(temp,bindingPath), JSON.stringify({sourceSha:original.reviewedInputSource,runtimeSourceSha:original.reviewedRuntimeSource,...binding}));
  original.buildInputsSha256=binding.sha256;
  const equalityPath='docs/audits/2026-10-04-tooling-p2-remediation/records/runtime-input-equality.json';
  const equality=JSON.parse(readFileSync(join(temp,equalityPath))); equality.buildInputsSha256=binding.sha256; equality.changedInputs[0].currentSha256=binding.records.find(v=>v.path==='.github/workflows/ci.yml').sha256;
  writeFileSync(join(temp,equalityPath),JSON.stringify(equality));
  original.runtimeInputs.find(v=>v.path===equalityPath).sha256=(await import('node:crypto')).createHash('sha256').update(readFileSync(join(temp,equalityPath))).digest('hex');
  original.runtimeInputs.find(v=>v.path===bindingPath).sha256=(await import('node:crypto')).createHash('sha256').update(readFileSync(join(temp,bindingPath))).digest('hex');
  const payload = Object.fromEntries(original.advisories.map(entry => [entry.package, [{ severity: 'high', url: 'https://github.com/advisories/' + entry.id }]]));
  let count = 0;
  function run(label, policy, data, expected) {
    writeFileSync(join(temp, 'security-tooling-policy.json'), JSON.stringify(policy));
    const script = `Bun.spawn = (args) => { if(args.length !== 3 || args[1] !== 'audit' || args[2] !== '--json') throw Error('Unexpected subprocess'); return {stdout:new Response(${JSON.stringify(JSON.stringify(data))}).body,stderr:new Response('').body,exited:Promise.resolve(1)}; }; await import(${JSON.stringify(join(temp, 'scripts/audit-security.mjs'))});`;
    const result = spawnSync(process.execPath, ['--no-env-file', '-e', script], { cwd: temp, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert.equal(result.status, expected, label + '\n' + result.stderr); count++; console.log('PASS ' + label);
  }
  run('disabled policy retains ordinary denial', { ...original, enabled: false }, payload, 1);
  run('exact enabled policy admits only reviewed tooling', { ...original, enabled: true }, payload, 0);
  run('unknown high advisory remains denied', { ...original, enabled: true }, { ...payload, unknown: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-unreviewed' }] }, 1);
  run('wrong package for reviewed advisory remains denied', { ...original, enabled: true }, { wrong: payload.braces }, 1);
  run('graph drift refuses', { ...original, enabled: true, graphSha256: '0'.repeat(64) }, payload, 1);
  writeFileSync(join(temp, 'packages/backend/Dockerfile'), 'changed');
  run('runtime image boundary drift refuses', { ...original, enabled: true }, payload, 1);
  console.log(`${count} audit wiring controls PASS; product policy unchanged`);
} finally { rmSync(temp, { recursive: true, force: true }); }
