import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const typescript: typeof import('typescript') = createRequire(import.meta.url)('typescript');

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

const ignoredEnvironmentTemplateTrees = new Set([
  '.git',
  '.plan',
  '.worktrees',
  'dist',
  'node_modules',
]);
const environmentTemplateName = /^\.env(?:\.[a-z0-9_-]+)*\.example$/i;

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

function environmentTemplates(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredEnvironmentTemplateTrees.has(entry.name) ? [] : environmentTemplates(absolute);
    }
    if (!environmentTemplateName.test(entry.name)) return [];
    return [{ path: path.relative(repositoryRoot, absolute), source: readFileSync(absolute, 'utf8') }];
  });
}

function executableSource(source: string): string {
  const scanner = typescript.createScanner(
    typescript.ScriptTarget.Latest,
    false,
    typescript.LanguageVariant.Standard,
    source,
  );
  const tokens: string[] = [];
  for (
    let token = scanner.scan();
    token !== typescript.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    const text = scanner.getTokenText();
    tokens.push(
      token === typescript.SyntaxKind.SingleLineCommentTrivia ||
        token === typescript.SyntaxKind.MultiLineCommentTrivia
        ? text.replace(/[^\n]/g, ' ')
        : text,
    );
  }
  return tokens.join('');
}

const forbidden = [
  { name: 'mongoose import', pattern: /(?:from\s+|require\()['"]mongoose['"]/ },
  { name: 'mongodb driver import', pattern: /(?:from\s+|require\()['"]mongodb['"]/ },
  { name: 'Mongo connection environment', pattern: /\bMONGODB_URI\b/ },
  { name: 'Mongo connection string', pattern: /mongodb(?:\+srv)?:\/\// },
] as const;

function forbiddenRuntimeViolations(files: readonly SourceFile[], stripCodeComments: boolean): string[] {
  return files.flatMap((file) => {
    const inspected = stripCodeComments ? executableSource(file.source) : file.source;
    return forbidden
      .filter(({ pattern }) => pattern.test(inspected))
      .map(({ name }) => `${file.path}: ${name}`);
  });
}

describe('the backend runtime is PostgreSQL-only', () => {
  const sources = [
    { path: 'packages/backend/server.ts', source: readFileSync(path.join(backendRoot, 'server.ts'), 'utf8') },
    {
      path: 'packages/backend/drizzle.config.ts',
      source: readFileSync(path.join(backendRoot, 'drizzle.config.ts'), 'utf8'),
    },
    ...productionSources(path.join(backendRoot, 'scripts')),
    ...productionSources(path.join(backendRoot, 'src')),
  ];
  const templates = environmentTemplates(repositoryRoot);
  const deploymentFiles = [
    '.github/workflows/ci.yml',
    '.github/workflows/deploy-aws.yml',
    '.github/scripts/deploy-ecs-image.sh',
    '.github/scripts/deployment-scope.sh',
    'packages/backend/Dockerfile',
  ].map((file) => ({
    path: file,
    source: readFileSync(path.join(repositoryRoot, file), 'utf8'),
  }));

  it('scans the real boot path, environment templates and deployment wiring', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.map((file) => file.path)).toContain('packages/backend/server.ts');
    expect(sources.map((file) => file.path)).toContain('packages/backend/scripts/migrate.ts');
    expect(sources.map((file) => file.path)).toContain('packages/backend/drizzle.config.ts');
    expect(templates.length).toBeGreaterThanOrEqual(3);
    expect(templates.map((file) => file.path)).toContain('packages/backend/.env.example');
    expect(deploymentFiles).toHaveLength(5);
  });

  it('contains no Mongo driver, URI or runtime import', () => {
    expect(forbiddenRuntimeViolations(sources, true)).toEqual([]);
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

  it('documents no Mongo environment or connection string in an environment template', () => {
    expect(forbiddenRuntimeViolations(templates, false)).toEqual([]);
  });

  it('wires no Mongo secret into CI or deployment', () => {
    expect(forbiddenRuntimeViolations(deploymentFiles, false)).toEqual([]);
  });

  it('retains Mongo only in the isolated pinned-archive recovery reader', () => {
    const postgresCutover = readFileSync(
      path.join(repositoryRoot, 'scripts/crowdsource-backend-cutover.mjs'),
      'utf8',
    );

    expect(
      existsSync(path.join(repositoryRoot, 'scripts/crowdsource-backend-export-mongo.mongosh.js')),
    ).toBe(false);
    expect(postgresCutover).not.toMatch(
      /fingerprint-source|fingerprint-freeze-key|sign-freeze|verify-freeze|export-mongo|mongosh/i,
    );
    expect(
      existsSync(path.join(repositoryRoot, 'scripts/crowdsource-backend-recover-archive.mjs')),
    ).toBe(true);
    expect(
      existsSync(path.join(repositoryRoot, 'scripts/crowdsource-backend-recover-archive.mongosh.js')),
    ).toBe(true);
  });

  it('detects every forbidden runtime shape through the production scanner', () => {
    for (const rule of forbidden) {
      const mutation =
        rule.name === 'mongoose import'
          ? "import mongoose from 'mongoose';"
          : rule.name === 'mongodb driver import'
            ? "import { MongoClient } from 'mongodb';"
            : rule.name === 'Mongo connection environment'
              ? 'const url = process.env.MONGODB_URI;'
              : "const url = 'mongodb://database.invalid/app';";
      expect(
        forbiddenRuntimeViolations([{ path: 'runtime-mutation.ts', source: mutation }], true),
        rule.name,
      ).toEqual([`runtime-mutation.ts: ${rule.name}`]);
    }
  });

  it('rejects a Mongo connection reintroduced into the real backend environment template', () => {
    const mutatedTemplates = templates.map((file) =>
      file.path === 'packages/backend/.env.example'
        ? { ...file, source: `${file.source}\nMONGODB_URI=mongodb://database.invalid/crowdsource\n` }
        : file,
    );

    expect(forbiddenRuntimeViolations(mutatedTemplates, false)).toEqual([
      'packages/backend/.env.example: Mongo connection environment',
      'packages/backend/.env.example: Mongo connection string',
    ]);
  });
});
