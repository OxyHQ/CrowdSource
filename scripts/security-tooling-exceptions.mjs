import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';

const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sorted = values => [...values].sort();

/** Dependency reachability plus all peer declarations; no exception activation. */
export function toolingCensus(lock, packageNames) {
  const records = lock.packages;
  const targets = new Set(Object.keys(records).filter(key => packageNames.some(name => String(records[key][0]).startsWith(name + '@'))));
  if (targets.size !== packageNames.length) throw new Error('Unexpected target package multiplicity');
  function resolve(parent, name, allowMissing = false) {
    let prefix = parent;
    while (prefix) {
      if (records[prefix + '/' + name]) return prefix + '/' + name;
      const index = prefix.lastIndexOf('/');
      prefix = index < 0 ? '' : prefix.slice(0, index);
    }
    if (records[name]) return name;
    if (allowMissing) return null;
    throw new Error('Unresolved dependency in audited lock');
  }
  const edges = [];
  // Peers are not runtime dependency edges in the pinned --omit=peer install.
  // Record every declaration and its lock resolution anyway: adding/changing a
  // peer must invalidate the review, including declarations outside ancestry.
  const peerDeclarations = [];
  function recordPeers(from, parent, metadata) {
    for (const [name, range] of Object.entries(metadata.peerDependencies ?? {})) {
      const resolvedKey = resolve(parent, name, true);
      peerDeclarations.push({ from, name, range, resolvedKey,
        resolvedRecordSha256: resolvedKey === null ? null : digest(records[resolvedKey]),
        optional: metadata.optionalPeers?.includes(name) === true || metadata.peerDependenciesMeta?.[name]?.optional === true });
    }
  }
  for (const [key, row] of Object.entries(records)) {
    const metadata = String(row[0]).startsWith('workspace:')
      ? lock.workspaces[String(row[0]).slice(10)] : row[2];
    if (!metadata || typeof metadata !== 'object') continue;
    recordPeers(key, key, metadata);
    for (const kind of ['dependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(metadata[kind] ?? {})) edges.push({ from: key, to: resolve(key, name), kind, name, range });
    }
  }
  for (const [root, metadata] of Object.entries(lock.workspaces)) {
    recordPeers('workspace:' + root, '', metadata);
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(metadata[kind] ?? {})) edges.push({ from: 'workspace:' + root, to: resolve('', name), kind, name, range });
    }
  }
  const ancestry = new Set(targets);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) if (ancestry.has(edge.to) && !ancestry.has(edge.from)) { ancestry.add(edge.from); changed = true; }
  }
  const graph = {
    peerTreatment: 'All declarations and lock resolutions are pinned; dependency reachability excludes peer edges because the reviewed backend install omits peers. Frontend materialization requires final export evidence.',
    peerDeclarations: peerDeclarations.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0),
    patchedDependencies: lock.patchedDependencies ?? {},
    workspaces: sorted(Object.keys(lock.workspaces)),
    targets: sorted(targets),
    roots: sorted([...ancestry].filter(key => key.startsWith('workspace:'))),
    records: sorted([...ancestry].filter(key => !key.startsWith('workspace:'))).map(key => ({ key, record: records[key] })),
    edges: edges.filter(edge => ancestry.has(edge.to)).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0),
  };
  return { graph, sha256: digest(graph) };
}

// These verification-only files do not generate an application/export/image.
// Everything else tracked (and non-ignored untracked) is sealed, including
// package code/config, lock, Dockerfiles, scripts and deployment workflows.
const VERIFICATION_ONLY = new Set([
  'security-tooling-policy.json', 'scripts/audit-security.mjs',
  'scripts/security-tooling-exceptions.mjs', 'scripts/test-tooling-audit-wiring.mjs',
  'scripts/test-security-tooling-exceptions.mjs',
  'scripts/test-security-tooling-exceptions-adversarial.mjs',
  'scripts/test-tooling-policy-lifecycle.mjs',
]);
export function collectToolingBuildInputs(root) {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean);
  const unique = sorted(new Set(paths.filter(path => !path.startsWith('docs/') && !VERIFICATION_ONLY.has(path))));
  if (!unique.some(path => path.startsWith('packages/reviewer/')) || !unique.some(path => path.startsWith('packages/backend/'))) throw new Error('Incomplete application/build input census');
  // The exception admits a clean source checkout, before application builds.
  // Ignored files are NOT automatically harmless: Expo loads .env and Metro
  // can import ignored source/generator/output directories. Refuse their names
  // without reading (or printing) content. Only the exact installed dependency
  // directories of tracked workspaces belong to the separate frozen-lock graph.
  const dependencyDirectories = new Set(['node_modules/', ...unique
    .filter(path => /^packages\/[^/]+\/package.json$/.test(path))
    .map(path => path.slice(0, -'package.json'.length) + 'node_modules/')]);
  const ignored = execFileSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const path of ignored) {
    if (!dependencyDirectories.has(path) || !lstatSync(join(root, path.replace(/\/$/, ''))).isDirectory()) throw new Error('Unsealed ignored build input; a clean source checkout is required');
  }
  // A tracked symlink can otherwise read an unsealed payload outside the repo,
  // even when its target is absent from both Git file censuses.
  if (unique.some(path => !lstatSync(join(root, path)).isFile())) throw new Error('Unsupported non-regular application/build input');

  const records = unique.map(path => ({ path, sha256: digest(readFileSync(join(root, path))) }));
  return { records, sha256: digest(records) };
}

const RUNTIME_EVIDENCE = 'docs/audits/2026-10-04-tooling-p2-remediation/records/';
function verifiesRuntimeBinding(policy, inputBytes, buildInputs) {
  const parsed = name => {
    const path = RUNTIME_EVIDENCE + name;
    const pinned = policy.runtimeInputs.find(input => input.path === path);
    if (!pinned || digest(inputBytes[path]) !== pinned.sha256) throw new Error('Missing or changed runtime binding');
    return JSON.parse(inputBytes[path].toString());
  };
  const inputs = parsed('reviewed-build-inputs.json');
  if (inputs.sourceSha !== policy.reviewedInputSource || inputs.runtimeSourceSha !== policy.reviewedRuntimeSource || inputs.sha256 !== policy.buildInputsSha256 || digest(inputs.records) !== inputs.sha256 || inputs.sha256 !== buildInputs.sha256) return false;
  const equality = parsed('runtime-input-equality.json');
  if (equality.source !== policy.reviewedRuntimeSource || equality.inputSourceSha !== policy.reviewedInputSource || equality.buildInputsSha256 !== inputs.sha256 || equality.packageTreeEqual !== true || equality.lockAndRootManifestEqual !== true || equality.runtimeBuilderEqual !== true || equality.changedInputs?.length !== 1 || equality.changedInputs[0].path !== '.github/workflows/ci.yml' || !inputs.records.some(record => record.path === equality.changedInputs[0].path && record.sha256 === equality.changedInputs[0].currentSha256)) return false;
  const image = parsed('arm-image-verification.json');
  const protocol = parsed('arm-consumer-image-verification.json');
  if (image.complete !== true || image.platform !== 'linux/arm64' || image.sourceSha !== policy.reviewedRuntimeSource || protocol.sourceSha !== image.sourceSha || protocol.manifestSha256 !== image.manifestSha256 || protocol.configSha256 !== image.configSha256 || protocol.dockerfileSha256 !== image.dockerfileSha256 || protocol.kind !== 'root-consumer-image-verification-v1') return false;
  if (!image.allImageLayersVerified || !image.shippingTrees?.length || image.shippingTrees.some(tree => tree.allEqual !== true)) return false;
  if (policy.advisories.some(entry => image.runtimeToolingAbsence?.[entry.package]?.present !== false)) return false;
  const exports = parsed('export-absence.json');
  if (exports.kind !== 'reviewed-export-tooling-absence-v1' || exports.inputsEqualMain !== policy.reviewedRuntimeSource || exports.exports?.length !== 2 || sorted(exports.exports.map(item => item.name)).join(',') !== 'console,reviewer') return false;
  return exports.exports.every(item => item.records.length > 0 && item.records.every(record => /^[a-f0-9]{64}$/.test(record.bundleSha256) && /^[a-f0-9]{64}$/.test(record.sourceMapSha256) && record.sourceCount > 0));
}

/** The caller must retain its normal refusal when this returns false. */
export function permitsToolingException({ policy, advisory, packageName: name, lock, inputBytes, buildInputs, now = new Date() }) {
  if (policy.version !== 1 || policy.expires !== '2026-10-09T22:00:00Z' || now.getTime() >= Date.parse(policy.expires)) return false;
  if (!Number.isFinite(now.getTime())) return false;
  if (!policy.advisories.some(entry => entry.id === advisory && entry.package === name)) return false;
  try {
    if (typeof policy.buildInputsSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(policy.buildInputsSha256) || buildInputs?.sha256 !== policy.buildInputsSha256 || digest(buildInputs.records) !== buildInputs.sha256) return false;
    for (const input of policy.runtimeInputs) if (!inputBytes[input.path] || digest(inputBytes[input.path]) !== input.sha256) return false;
    if (!verifiesRuntimeBinding(policy, inputBytes, buildInputs)) return false;
    const census = toolingCensus(lock, policy.advisories.map(entry => entry.package));
    if (census.sha256 !== policy.graphSha256) return false;
    if (census.graph.roots.some(root => !policy.allowedRoots.includes(root))) return false;
    return true;
  } catch { return false; }
}

/** Final export evidence; absence of maps or a module-bearing map refuses. */
export function inspectExportMaps(root, packageNames) {
  function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]); }
  const paths = files(root);
  const bundles = paths.filter(path => /\.(?:js|mjs)$/.test(path) && relative(root, path).replaceAll('\\', '/').includes('_expo/static/js/'));
  if (!bundles.length) throw new Error('No exported JavaScript bundles');
  return bundles.map(path => {
    const bytes = readFileSync(path);
    const mapPath = path + '.map';
    const mapBytes = readFileSync(mapPath);
    const map = JSON.parse(mapBytes);
    if (map.version !== 3 || !Array.isArray(map.sources) || !map.sources.length || map.sections) throw new Error('Unsupported or empty source map');
    // Refuse a separate base instead of treating relative sources as complete
    // paths. The accepted export must put complete paths in sources itself.
    if (map.sourceRoot !== undefined && map.sourceRoot !== '') throw new Error('Nonempty or invalid sourceRoot is unsupported');
    for (const source of map.sources) {
      if (typeof source !== 'string') throw new Error('Invalid source path');
      const normalized = source.replaceAll('\\', '/');
      for (const name of packageNames) if (normalized.includes('/node_modules/' + name + '/') || normalized.startsWith('node_modules/' + name + '/')) throw new Error('Tooling module present in exported bundle');
    }
    return { bundle: relative(root, path), bundleSha256: digest(bytes), sourceMap: relative(root, mapPath), sourceMapSha256: digest(mapBytes), sourceCount: map.sources.length };
  });
}
