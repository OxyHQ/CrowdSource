import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The gate on the tenant-scoped repository layer.
 *
 * `TenantScopedHandle` makes passing the pool to a scoped repository a COMPILE
 * error — that is the mechanism, and `tsc` enforces it at every call site with no
 * help from this file. What `tsc` cannot enforce is that a repository somebody
 * ADDS next month declares the branded type at all: a new file taking a bare
 * `PgHandle` compiles perfectly and is silently unscoped, and its reads return
 * zero rows rather than raising. That is the hole this closes.
 *
 * Two rules, and they are different claims:
 *
 *  1. Every file under `repositories/scoped/` takes `TenantScopedHandle` and never
 *     a bare `PgHandle`.
 *  2. The brand and the assertion that mints it exist ONLY in `withTenant.ts`. A
 *     cast elsewhere would defeat rule 1 while satisfying it textually.
 *
 * The directory is read from the FILESYSTEM, never from a list. A hard-coded file
 * set would pass every edit-mutation while being blind to the case that matters —
 * a new file — which is the `Decision`/`Appeal` defect in its natural habitat.
 */

const backendRoot = path.resolve(__dirname, '..', '..');
const scopedDirectory = path.join(backendRoot, 'src', 'db', 'postgres', 'repositories', 'scoped');
const withTenantPath = path.join(backendRoot, 'src', 'db', 'postgres', 'withTenant.ts');

interface ScopedFile {
  readonly name: string;
  readonly source: string;
}

function readScopedRepositories(): ScopedFile[] {
  return readdirSync(scopedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      name: entry.name,
      source: readFileSync(path.join(scopedDirectory, entry.name), 'utf8'),
    }));
}

/** Blanks comment bodies, so a file DESCRIBING the rule does not breach it. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block: string) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/** A parameter annotated with the bare, unbranded handle. */
export function bareHandleParameters(source: string): string[] {
  return [...withoutComments(source).matchAll(/(\w+)\s*:\s*PgHandle\b/g)].map((match) => match[0]);
}

const scopedFiles = readScopedRepositories();

describe('every tenant-scoped repository takes the branded handle', () => {
  /**
   * The vacuity floor. An empty directory — or a filter that stopped matching —
   * would satisfy every assertion below while checking no repositories at all.
   */
  it('found the scoped repository files', () => {
    expect(scopedFiles.length).toBeGreaterThanOrEqual(1);
    expect(scopedFiles.map((file) => file.name)).toContain('cases.ts');
  });

  it('declares TenantScopedHandle and never a bare PgHandle', () => {
    const offenders = scopedFiles.flatMap((file) => [
      ...(file.source.includes('TenantScopedHandle')
        ? []
        : [`${file.name}: does not mention TenantScopedHandle at all`]),
      ...bareHandleParameters(file.source).map(
        (parameter) => `${file.name}: takes a bare handle — '${parameter}'`,
      ),
    ]);

    // Named, so a failure says which file and which parameter rather than a count.
    expect(offenders).toEqual([]);
  });

  /**
   * Rule 2. A cast outside the owning module would satisfy rule 1 textually while
   * handing a scoped repository an unscoped handle — the brand's only real escape
   * hatch, so it is confined by name.
   */
  it('mints the brand only in withTenant.ts', () => {
    const withTenantSource = readFileSync(withTenantPath, 'utf8');
    expect(withTenantSource).toContain('tenantScopedBrand');

    const elsewhere = scopedFiles.filter((file) =>
      /tenantScopedBrand|as unknown as TenantScopedHandle/.test(withoutComments(file.source)),
    );

    expect(elsewhere.map((file) => file.name)).toEqual([]);
  });
});

describe('the gate can fail', () => {
  /**
   * The mutation that matters is a NEW FILE, not an edit.
   *
   * Editing an existing repository proves only that the scan reads files it
   * already knows about — and a scan accidentally pinned to a hard-coded list
   * passes that mutation while being blind to the failure actually being defended
   * against, which is somebody ADDING a repository without the branded type.
   *
   * The predicate is exercised directly here rather than by writing a file into
   * the tree, so the check needs no `git add -f` and cannot leave a probe behind.
   * The companion mutation — a real file dropped into the directory, staged so it
   * is visible, gate confirmed red, file removed — is run by hand and recorded in
   * the pull request, because a test that writes into its own source tree is a
   * worse thing to own than a documented manual step.
   */
  it('detects a bare handle in a file it has never seen', () => {
    const newcomer = [
      "import type { PgHandle } from '../../withTenant';",
      'export async function readSomething(db: PgHandle, id: string) {',
      '  return await db.select().from(cases).where(eq(cases.caseId, id));',
      '}',
    ].join('\n');

    expect(bareHandleParameters(newcomer)).toEqual(['db: PgHandle']);
    expect(newcomer.includes('TenantScopedHandle')).toBe(false);
  });

  /** And does not flag the correct shape, so the rule discriminates. */
  it('passes a correctly branded newcomer', () => {
    const correct = [
      "import type { TenantScopedHandle } from '../../withTenant';",
      'export async function readSomething(db: TenantScopedHandle, id: string) {',
      '  return await db.select().from(cases).where(eq(cases.caseId, id));',
      '}',
    ].join('\n');

    expect(bareHandleParameters(correct)).toEqual([]);
    expect(correct.includes('TenantScopedHandle')).toBe(true);
  });

  /** A file explaining the rule in prose is not a file breaking it. */
  it('does not mistake a comment about PgHandle for a parameter', () => {
    const commented = [
      '// An unscoped repository would take db: PgHandle here.',
      '/* Never write db: PgHandle in this directory. */',
      "import type { TenantScopedHandle } from '../../withTenant';",
      'export async function ok(db: TenantScopedHandle) { return db; }',
    ].join('\n');

    expect(bareHandleParameters(commented)).toEqual([]);
  });
});
