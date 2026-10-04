import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { collectToolingBuildInputs } from './security-tooling-exceptions.mjs';

const original = JSON.parse(readFileSync('security-tooling-policy.json', 'utf8'));
const payload = Object.fromEntries(original.advisories.map(entry => [entry.package, [{ severity: 'high', url: 'https://github.com/advisories/' + entry.id }]]));
const frozen = process.argv.includes('--frozen');
let passed = 0, failed = 0;
function run(name, { start = '2026-10-09T21:59:59.000Z', after = start, late = after, mutate = () => {}, expected = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crowd-tooling-lifecycle-'));
  try {
    const paths = ['scripts/audit-security.mjs', 'scripts/security-tooling-exceptions.mjs', 'bun.lock', 'security-audit-exceptions.json', ...original.runtimeInputs.map(v => v.path)];
    for (const path of new Set(paths)) { mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(path, join(root, path)); }
    if (frozen) for (const name of ['audit-security', 'security-tooling-exceptions']) copyFileSync(new URL(`../docs/audits/2026-10-04-tooling-p2-remediation/records/frozen-${name}.mjs`, import.meta.url), join(root, 'scripts', name + '.mjs'));
    mkdirSync(join(root, 'packages/reviewer/app'), { recursive: true });
    writeFileSync(join(root, 'packages/reviewer/app/index.tsx'), 'export default function App() { return null; }');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
    // Own local Git index is only the application-input census fixture.
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '--', '.'], { cwd: root });
    const policy = { ...original, buildInputsSha256: collectToolingBuildInputs(root).sha256 };
    const bindingPath='docs/audits/2026-10-04-tooling-p2-remediation/records/reviewed-build-inputs.json';
    const binding=collectToolingBuildInputs(root);
    writeFileSync(join(root,bindingPath),JSON.stringify({sourceSha:policy.reviewedRuntimeSource,...binding}));
    policy.runtimeInputs=structuredClone(policy.runtimeInputs);
    policy.runtimeInputs.find(v=>v.path===bindingPath).sha256=createHash('sha256').update(readFileSync(join(root,bindingPath))).digest('hex');
    mutate(root, policy);
    writeFileSync(join(root, 'security-tooling-policy.json'), JSON.stringify(policy));
    const js = `const RealDate=Date; let current=${JSON.stringify(start)}, calls=0; globalThis.Date=class extends RealDate { constructor(...args){super(...(args.length?args:[current])); if(!args.length&&++calls>=3) current=${JSON.stringify(late)};} static now(){return new RealDate(current).getTime();} }; Bun.spawn=(args)=>{if(args.length!==3||args[1]!=='audit'||args[2]!=='--json')throw Error('Unexpected child');return {stdout:new Response(${JSON.stringify(JSON.stringify(payload))}).body,stderr:new Response('').body,exited:new Promise(resolve=>setTimeout(()=>{current=${JSON.stringify(after)};resolve(1);},10))};};await import(${JSON.stringify(join(root,'scripts/audit-security.mjs'))});`;
    const child = spawnSync(process.execPath, ['--no-env-file', '-e', js], { cwd: root, encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert.equal(child.signal, null, name + ': process must finish, not time out');
    assert.equal(child.status === 0, expected === 0, name + '\n' + child.stderr);
    passed++; console.log('PASS ' + name);
  } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
run('unchanged inputs just before fixed deadline admit', { expected: 0 });
run('deferred Bun audit crossing exact deadline refuses', { after: '2026-10-09T22:00:00.000Z' });
run('deadline crossed after predicate before acceptance refuses', { late: '2026-10-09T22:00:00.000Z' });
run('invalid clock after audit refuses', { after: 'invalid' });
run('source-only import of installed target without lock change refuses', { mutate: root => writeFileSync(join(root, 'packages/reviewer/app/index.tsx'), "import braces from 'braces'; export default braces;") });
run('new source file importing target refuses', { mutate: root => writeFileSync(join(root, 'packages/reviewer/app/new.tsx'), "import forge from 'node-forge'; export default forge;") });
run('missing source/build binding refuses', { mutate: (_root, policy) => { delete policy.buildInputsSha256; } });
run('build config change refuses', { mutate: root => writeFileSync(join(root, 'packages/reviewer/metro.config.js'), "module.exports = { transformer: { custom: true } };") });
run('foreign image source refuses even with updated record hash', { mutate: (root, policy) => {
  const path='docs/audits/2026-10-04-tooling-p2-remediation/records/arm-image-verification.json';
  const value=JSON.parse(readFileSync(join(root,path))); value.sourceSha='0'.repeat(40);
  writeFileSync(join(root,path),JSON.stringify(value));
  policy.runtimeInputs.find(v=>v.path===path).sha256=createHash('sha256').update(readFileSync(join(root,path))).digest('hex');
} });
run('ARM proof with included tooling refuses', { mutate: (root, policy) => {
  const path='docs/audits/2026-10-04-tooling-p2-remediation/records/arm-image-verification.json';
  const value=JSON.parse(readFileSync(join(root,path))); value.runtimeToolingAbsence.braces.present=true;
  writeFileSync(join(root,path),JSON.stringify(value));
  policy.runtimeInputs.find(v=>v.path===path).sha256=createHash('sha256').update(readFileSync(join(root,path))).digest('hex');
} });
run('missing export record refuses', { mutate: root => rmSync(join(root,'docs/audits/2026-10-04-tooling-p2-remediation/records/export-absence.json')) });
run('missing reviewed runtime evidence refuses', { mutate: root => rmSync(join(root, original.runtimeInputs.at(-1).path)) });
console.log(`${passed} PASS / ${failed} FAIL; all owned fixture directories removed`);
process.exitCode = failed ? 1 : 0;
