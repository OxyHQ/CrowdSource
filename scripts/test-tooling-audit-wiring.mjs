import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const temp = mkdtempSync(join(tmpdir(), 'crowd-audit-policy-'));
try {
  mkdirSync(join(temp, 'scripts')); mkdirSync(join(temp, 'packages/backend'), { recursive: true });
  for (const path of ['scripts/audit-security.mjs', 'scripts/security-tooling-exceptions.mjs', 'bun.lock', 'security-audit-exceptions.json', 'packages/backend/Dockerfile']) copyFileSync(path, join(temp, path));
  const original = JSON.parse(readFileSync('security-tooling-policy.json', 'utf8'));
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
