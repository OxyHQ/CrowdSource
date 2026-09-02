#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') return [];
      return sourceFiles(path);
    }
    return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

export function appPostgresOnlyViolations(root = repositoryRoot) {
  const packageRoot = resolve(root, 'packages/app');
  const packageJsonPath = resolve(packageRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const violations = [];

  if (statSync(packageRoot).isDirectory()) {
    for (const path of sourceFiles(packageRoot)) {
      const source = readFileSync(path, 'utf8');
      const executableReference =
        /(?:from\s+|import\s*\(|require\s*\()\s*['"][^'"]*(?:mongoose|mongodb)[^'"]*['"]/i;
      if (executableReference.test(source)) {
        violations.push(`${relative(root, path)} imports a MongoDB runtime`);
      }
    }
  }

  const dependencyGroups = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  for (const group of dependencyGroups) {
    const dependencies = packageJson[group] ?? {};
    for (const name of Object.keys(dependencies)) {
      if (/mongoose|mongodb/i.test(name)) {
        violations.push(`packages/app/package.json ${group}.${name}`);
      }
    }
  }

  for (const subpath of Object.keys(packageJson.exports ?? {})) {
    if (/mongoose|mongodb/i.test(subpath)) {
      violations.push(`packages/app/package.json exports.${subpath}`);
    }
  }

  const removedDirectory = resolve(packageRoot, 'src/mongoose');
  try {
    if (statSync(removedDirectory).isDirectory()) {
      violations.push('packages/app/src/mongoose still exists');
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }

  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] === undefined ? repositoryRoot : resolve(process.argv[2]);
  const violations = appPostgresOnlyViolations(root);
  if (violations.length > 0) {
    process.stderr.write(`The application package is not PostgreSQL-only:\n${violations.map((entry) => `  - ${entry}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('The application package has no MongoDB runtime, dependency or export.\n');
}
