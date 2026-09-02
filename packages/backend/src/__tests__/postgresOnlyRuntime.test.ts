import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Prevents the completed runtime cut from quietly becoming dual-database again.
 * Historical migration prose may explain MongoDB; executable source, package
 * dependencies and deployment configuration may not connect to it.
 */
const backendRoot = path.resolve(__dirname, '..', '..');
const repositoryRoot = path.resolve(backendRoot, '..', '..');

interface SourceFile {
  readonly path: string;
  readonly source: string;
}

function productionSources(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionSources(absolute);
    }
    if (!entry.name.endsWith('.ts')) return [];
    return [{ path: path.relative(repositoryRoot, absolute), source: readFileSync(absolute, 'utf8') }];
  });
}

function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

const forbidden = [
  { name: 'mongoose import', pattern: /(?:from\s+|require\()['"]mongoose['"]/ },
  { name: 'mongodb driver import', pattern: /(?:from\s+|require\()['"]mongodb['"]/ },
  { name: 'Mongo connection environment', pattern: /\bMONGODB_URI\b/ },
  { name: 'Mongo connection string', pattern: /mongodb(?:\+srv)?:\/\// },
] as const;

describe('the backend runtime is PostgreSQL-only', () => {
  const sources = [
    { path: 'packages/backend/server.ts', source: readFileSync(path.join(backendRoot, 'server.ts'), 'utf8') },
    ...productionSources(path.join(backendRoot, 'src')),
  ];

  it('scans the real boot path and a non-vacuous production tree', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.map((file) => file.path)).toContain('packages/backend/server.ts');
  });

  it('contains no Mongo driver, URI or runtime import', () => {
    const violations = sources.flatMap((file) => {
      const code = executableSource(file.source);
      return forbidden
        .filter(({ pattern }) => pattern.test(code))
        .map(({ name }) => `${file.path}: ${name}`);
    });
    expect(violations).toEqual([]);
  });

  it('declares no Mongo production or test dependency', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(backendRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    expect(Object.keys(dependencies).filter((name) => /mongoose|mongodb/i.test(name))).toEqual([]);
  });

  it('wires no Mongo secret into CI or deployment', () => {
    const deploymentFiles = [
      '.github/workflows/ci.yml',
      '.github/workflows/deploy-aws.yml',
      '.github/scripts/deployment-scope.sh',
    ];
    const violations = deploymentFiles.filter((file) =>
      /MONGODB_URI|mongodb(?:\+srv)?:\/\//i.test(
        readFileSync(path.join(repositoryRoot, file), 'utf8'),
      ),
    );
    expect(violations).toEqual([]);
  });

  it('detects every forbidden runtime shape', () => {
    for (const rule of forbidden) {
      const mutation =
        rule.name === 'mongoose import'
          ? "import mongoose from 'mongoose';"
          : rule.name === 'mongodb driver import'
            ? "import { MongoClient } from 'mongodb';"
            : rule.name === 'Mongo connection environment'
              ? 'const url = process.env.MONGODB_URI;'
              : "const url = 'mongodb://database.invalid/app';";
      expect(rule.pattern.test(mutation), rule.name).toBe(true);
    }
  });
});
