import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sorted = values => [...values].sort();

/** Lock graph only: no network, installed code execution, or exception activation. */
export function toolingCensus(lock, packageNames) {
  const records = lock.packages;
  const targets = new Set(Object.keys(records).filter(key => packageNames.some(name => String(records[key][0]).startsWith(name + '@'))));
  if (targets.size !== packageNames.length) throw new Error('Unexpected target package multiplicity');
  function resolve(parent, name) {
    let prefix = parent;
    while (prefix) {
      if (records[prefix + '/' + name]) return prefix + '/' + name;
      const index = prefix.lastIndexOf('/');
      prefix = index < 0 ? '' : prefix.slice(0, index);
    }
    if (records[name]) return name;
    throw new Error('Unresolved dependency in audited lock');
  }
  const edges = [];
  for (const [key, row] of Object.entries(records)) {
    const metadata = String(row[0]).startsWith('workspace:')
      ? lock.workspaces[String(row[0]).slice(10)] : row[2];
    if (!metadata || typeof metadata !== 'object') continue;
    for (const kind of ['dependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(metadata[kind] ?? {})) edges.push({ from: key, to: resolve(key, name), kind, name, range });
    }
  }
  for (const [root, metadata] of Object.entries(lock.workspaces)) {
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
    patchedDependencies: lock.patchedDependencies ?? {},
    workspaces: sorted(Object.keys(lock.workspaces)),
    targets: sorted(targets),
    roots: sorted([...ancestry].filter(key => key.startsWith('workspace:'))),
    records: sorted([...ancestry].filter(key => !key.startsWith('workspace:'))).map(key => ({ key, record: records[key] })),
    edges: edges.filter(edge => ancestry.has(edge.to)).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0),
  };
  return { graph, sha256: digest(graph) };
}

/** The caller must retain its normal refusal when this returns false. */
export function permitsToolingException({ policy, advisory, packageName: name, lock, inputBytes, now = new Date() }) {
  if (policy.version !== 1 || policy.expires !== '2026-10-09T22:00:00Z' || now.getTime() >= Date.parse(policy.expires)) return false;
  if (!Number.isFinite(now.getTime())) return false;
  if (!policy.advisories.some(entry => entry.id === advisory && entry.package === name)) return false;
  try {
    for (const input of policy.runtimeInputs) if (!inputBytes[input.path] || digest(inputBytes[input.path]) !== input.sha256) return false;
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
    for (const source of map.sources) {
      if (typeof source !== 'string') throw new Error('Invalid source path');
      const normalized = source.replaceAll('\\', '/');
      for (const name of packageNames) if (normalized.includes('/node_modules/' + name + '/') || normalized.startsWith('node_modules/' + name + '/')) throw new Error('Tooling module present in exported bundle');
    }
    return { bundle: relative(root, path), bundleSha256: digest(bytes), sourceMap: relative(root, mapPath), sourceMapSha256: digest(mapBytes), sourceCount: map.sources.length };
  });
}
