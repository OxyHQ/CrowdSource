#!/usr/bin/env bun

import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appPostgresOnlyViolations } from './assert-app-postgres-only.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = mkdtempSync(resolve(tmpdir(), 'crowdsource-app-postgres-gate-'));

try {
  mkdirSync(resolve(fixture, 'packages'), { recursive: true });
  cpSync(resolve(repositoryRoot, 'packages/app'), resolve(fixture, 'packages/app'), {
    recursive: true,
    filter: (source) => !source.includes('/dist') && !source.includes('/node_modules'),
  });

  const control = appPostgresOnlyViolations(fixture);
  if (control.length !== 0) {
    throw new Error(`Positive control is not clean: ${control.join(', ')}`);
  }

  writeFileSync(
    resolve(fixture, 'packages/app/src/reintroduced.ts'),
    "import mongoose from 'mongoose';\nvoid mongoose;\n",
  );
  const importMutation = appPostgresOnlyViolations(fixture);
  if (!importMutation.some((entry) => entry.includes('reintroduced.ts imports'))) {
    throw new Error('The gate did not catch a reintroduced runtime import.');
  }

  writeFileSync(
    resolve(fixture, 'packages/app/vitest.globalSetup.ts'),
    "import { MongoMemoryReplSet } from 'mongodb-memory-server';\nvoid MongoMemoryReplSet;\n",
  );
  const harnessMutation = appPostgresOnlyViolations(fixture);
  if (!harnessMutation.some((entry) => entry.includes('vitest.globalSetup.ts imports'))) {
    throw new Error('The gate did not catch a reintroduced MongoDB test harness.');
  }

  const packagePath = resolve(fixture, 'packages/app/package.json');
  const packageJson = JSON.parse(await Bun.file(packagePath).text());
  packageJson.peerDependencies = { ...(packageJson.peerDependencies ?? {}), mongoose: '^9.0.0' };
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const dependencyMutation = appPostgresOnlyViolations(fixture);
  if (!dependencyMutation.some((entry) => entry.includes('peerDependencies.mongoose'))) {
    throw new Error('The gate did not catch a reintroduced dependency.');
  }

  process.stdout.write('The PostgreSQL-only app gate catches runtime, harness and dependency mutations.\n');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
