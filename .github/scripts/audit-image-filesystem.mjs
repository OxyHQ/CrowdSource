#!/usr/bin/env bun

// Runs INSIDE the backend image, as the image's own user, from CI's image
// smoke (smoke-backend-image.sh). It holds the properties the Dockerfile
// promises and `audit-runtime-image.mjs` does not look at:
//
//   * the process runs as the expected non-root uid;
//   * every file under /app is root-owned and not writable by that uid, so a
//     compromised process cannot rewrite the code it runs (the container is
//     NOT started read-only here, or every write check would pass vacuously);
//   * no devDependency of the shipped manifests is installed unless an
//     installed package needs it at runtime;
//   * no installed package declares an install lifecycle script or a native
//     build. Every `bun install` in the Dockerfile passes `--ignore-scripts`,
//     which skips them silently, so a dependency that needs one would ship
//     broken; this makes that a named failure instead.

import { access, constants, lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const auditRoot = resolve(process.env.AUDIT_ROOT || '/app');
const expectedUid = Number(process.env.EXPECTED_UID);
const minimumEntries = Number(process.env.MINIMUM_ENTRIES || '1000');
const failures = [];

const uid = process.getuid?.();
if (!Number.isInteger(expectedUid) || expectedUid <= 0) {
  failures.push('EXPECTED_UID must name the non-root uid the image runs as.');
} else if (uid !== expectedUid) {
  failures.push(`The image runs as uid ${String(uid)}, expected ${expectedUid}.`);
}

// --- Ownership and writability -------------------------------------------
let entries = 0;
const notRootOwned = [];
const writable = [];

async function isWritable(path) {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return false;
    throw error;
  }
}

async function walk(path) {
  const stats = await lstat(path);
  entries += 1;
  const shown = relative(auditRoot, path) || '.';
  if (stats.uid !== 0) notRootOwned.push(`${shown} (uid ${stats.uid})`);
  // A symlink's own permissions are meaningless and access() follows it.
  if (!stats.isSymbolicLink() && (await isWritable(path))) writable.push(shown);
  if (stats.isDirectory()) {
    for (const name of await readdir(path)) await walk(join(path, name));
  }
}

await walk(auditRoot);
if (entries < minimumEntries) {
  failures.push(
    `Only ${entries} entries under ${auditRoot}; expected at least ${minimumEntries}. The walk did not see the application.`,
  );
}
if (notRootOwned.length > 0) {
  failures.push(
    `${notRootOwned.length} path(s) under ${auditRoot} are not root-owned: ${notRootOwned.slice(0, 20).join(', ')}`,
  );
}
if (writable.length > 0) {
  failures.push(
    `${writable.length} path(s) under ${auditRoot} are writable by uid ${String(uid)}: ${writable.slice(0, 20).join(', ')}`,
  );
}

// --- Installed packages ----------------------------------------------------
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

const installed = [];
async function collectPackages(nodeModules) {
  if (!(await exists(nodeModules))) return;
  for (const name of await readdir(nodeModules)) {
    if (name.startsWith('.')) continue;
    const path = join(nodeModules, name);
    if (name.startsWith('@')) {
      for (const scoped of await readdir(path)) await collectPackage(join(path, scoped));
    } else {
      await collectPackage(path);
    }
  }
}
async function collectPackage(path) {
  // Workspace links point back into /app/packages, read separately below.
  if ((await lstat(path)).isSymbolicLink()) return;
  const manifestPath = join(path, 'package.json');
  if (!(await exists(manifestPath))) return;
  installed.push({ path, manifest: await readJson(manifestPath) });
  await collectPackages(join(path, 'node_modules'));
}
await collectPackages(join(auditRoot, 'node_modules'));

const shippedManifests = [];
for (const path of [join(auditRoot, 'package.json')]) {
  if (await exists(path)) shippedManifests.push(await readJson(path));
}
const packagesDirectory = join(auditRoot, 'packages');
if (await exists(packagesDirectory)) {
  for (const name of await readdir(packagesDirectory)) {
    const path = join(packagesDirectory, name, 'package.json');
    if (await exists(path)) shippedManifests.push(await readJson(path));
  }
}

const runtimeDependencyNames = new Set();
for (const manifest of [...shippedManifests, ...installed.map((entry) => entry.manifest)]) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] || {})) runtimeDependencyNames.add(name);
  }
}
const installedNames = new Set(installed.map((entry) => entry.manifest.name));
const devDependencyNames = new Set(
  shippedManifests.flatMap((manifest) => Object.keys(manifest.devDependencies || {})),
);
const installedDevDependencies = [...devDependencyNames].filter((name) => installedNames.has(name));
const strayDevDependencies = installedDevDependencies
  .filter((name) => !runtimeDependencyNames.has(name))
  .sort();
if (devDependencyNames.size === 0) {
  failures.push(
    'The shipped manifests declare no devDependencies, so the dev-dependency check checked nothing.',
  );
}
if (strayDevDependencies.length > 0) {
  failures.push(
    `devDependencies installed in the runtime image: ${strayDevDependencies.join(', ')}`,
  );
}

const lifecycleScripts = ['preinstall', 'install', 'postinstall'];
const needsScripts = [];
for (const { path, manifest } of installed) {
  const declared = lifecycleScripts.filter((script) => manifest.scripts?.[script]);
  if (manifest.gypfile || (await exists(join(path, 'binding.gyp')))) declared.push('binding.gyp');
  if (declared.length > 0) {
    needsScripts.push(`${manifest.name}@${manifest.version} (${declared.join(', ')})`);
  }
}
if (installed.length < 20) {
  failures.push(
    `Only ${installed.length} installed packages found; the walk did not see node_modules.`,
  );
}
if (needsScripts.length > 0) {
  failures.push(
    `Installed packages declare install scripts that --ignore-scripts skipped: ${needsScripts.join('; ')}`,
  );
}

if (failures.length > 0) {
  console.error('Image filesystem audit failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Image filesystem audit passed as uid ${uid}: ${entries} entries under ${auditRoot}, all root-owned and read-only to the app; ` +
    `${installed.length} installed packages, none with install scripts; ` +
    `${devDependencyNames.size} devDependencies declared, ${installedDevDependencies.length} installed` +
    (installedDevDependencies.length > 0
      ? ` (each also a runtime dependency: ${installedDevDependencies.sort().join(', ')}).`
      : '.'),
);
