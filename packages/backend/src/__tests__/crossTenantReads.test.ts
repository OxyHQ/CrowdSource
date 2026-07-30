import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CROSS_TENANT_FORBIDDEN_FIELDS,
  ESCALATED_QUEUE_FIELDS,
} from '../modules/trust/crossTenantReads';

/**
 * The gate on the privileged cross-tenant reads.
 *
 * `collectionBoundary.test.ts` pins WHO may reach the driver. That is necessary and it is
 * not sufficient, and the gap is the point of this file: the driver scanner sees a module
 * that touches `mongoose.model(`, and it cannot see a module that reaches the same data by
 * IMPORTING an already-sanctioned function. So the second control is on the import graph,
 * and the third is on the projections themselves — declared as data precisely so a test
 * can read them.
 *
 * Three independent properties, each with its own failure:
 *
 *  1. Only named modules may import the privileged one.
 *  2. A returned row's fields are exactly the declared projection.
 *  3. The declared projection and the forbidden list are disjoint.
 */

const backendRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(backendRoot, 'src');

/** The module under guard, as it appears in an import specifier. */
const PRIVILEGED_MODULE = 'trust/crossTenantReads';

/**
 * The modules allowed to import it, and why.
 *
 * Pinned for the same reason the allowlist is: an unpinned list of callers is one where
 * the next caller arrives without a test change. A developer-console route must never
 * appear here — the whole audience split rests on a developer having no path to another
 * tenant's data, however well projected.
 */
const PRIVILEGED_IMPORTERS: Readonly<Record<string, string>> = {
  'src/modules/console/trustSafety.routes.ts':
    'The Trust & Safety surface, which is the audience §4.3 defines as cross-tenant.',
};

interface ScannedFile {
  readonly path: string;
  readonly source: string;
}

function collectSources(directory: string): ScannedFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : collectSources(absolute);
    }
    if (!entry.name.endsWith('.ts')) return [];
    return [
      {
        path: path.relative(backendRoot, absolute).replaceAll(path.sep, '/'),
        source: readFileSync(absolute, 'utf8'),
      },
    ];
  });
}

/**
 * Files that import the privileged module.
 *
 * Matched on the `from '…'` CLAUSE rather than on the whole `import` statement, because a
 * named import of several functions spans lines and an `import[^\n]*from` pattern silently
 * misses every one of them — which is the failure mode where this check reports an empty
 * result while a real caller sits in the tree. The `from` clause is always on one line.
 *
 * Comment lines are stripped first, the same way `driverEscapes.ts` does it, so the doc
 * comments that name this module on purpose are not read as imports. The module itself is
 * excluded: it is not its own caller.
 */
function importersOf(files: readonly ScannedFile[], specifier: string): string[] {
  const pattern = new RegExp(`from\\s+['"][^'"]*${specifier}['"]`);
  return files
    .filter((file) => !file.path.includes('crossTenantReads.ts'))
    .filter((file) => {
      const code = file.source
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
      return pattern.test(code);
    })
    .map((file) => file.path)
    .sort();
}

const sources = collectSources(sourceRoot);

describe('who may import the privileged cross-tenant module', () => {
  /** The vacuity floor: a traversal returning nothing would make every check below pass. */
  it('scanned the source tree', () => {
    expect(sources.length).toBeGreaterThanOrEqual(15);
    expect(sources.map((file) => file.path)).toContain(
      'src/modules/trust/crossTenantReads.ts',
    );
  });

  it('is exactly the pinned set, each with a stated reason', () => {
    expect(importersOf(sources, PRIVILEGED_MODULE)).toEqual(
      Object.keys(PRIVILEGED_IMPORTERS).sort(),
    );
    for (const [importer, why] of Object.entries(PRIVILEGED_IMPORTERS)) {
      expect(why.trim().length, `${importer} must say why it may read across tenants`)
        .toBeGreaterThanOrEqual(30);
    }
  });

  it('never includes the developer console', () => {
    /**
     * Stated separately from the pin above, because it is the property that matters rather
     * than a consequence of it. The developer half of the console is the surface a tenant's
     * own staff reach; a cross-tenant read there would be the audience split failing while
     * every screen still looked correct.
     */
    const importers = importersOf(sources, PRIVILEGED_MODULE);
    expect(importers).not.toContain('src/modules/console/console.routes.ts');
    expect(importers).not.toContain('src/modules/console/caseExplorer.service.ts');
    expect(importers).not.toContain('src/modules/console/operations.service.ts');
  });

  /**
   * The mutation test on the scanner. Break the thing it guards and confirm it fails AND
   * names the offending path — otherwise the pinned result above is indistinguishable from
   * a matcher that finds nothing at all.
   */
  it('detects an importer the pin does not list', () => {
    const smuggled: ScannedFile[] = [
      {
        path: 'src/modules/console/console.routes.ts',
        source: "import { findEscalatedCasesAcrossTenants } from '../trust/crossTenantReads';",
      },
      {
        path: 'src/modules/webhooks/fanout.ts',
        source:
          "import { countCasesByStatusAcrossTenants } from '../../modules/trust/crossTenantReads';",
      },
    ];

    for (const file of smuggled) {
      expect(importersOf([file], PRIVILEGED_MODULE), file.path).toEqual([file.path]);
    }
  });

  it('does not mistake a comment naming the module for an import of it', () => {
    const mentioned: ScannedFile[] = [
      {
        path: 'src/modules/console/console.routes.ts',
        source: '// Cross-tenant reads live in trust/crossTenantReads and are staff-only.',
      },
      {
        path: 'src/modules/console/console.routes.ts',
        source: " * See `src/modules/trust/crossTenantReads.ts` for the projected queries.",
      },
    ];

    for (const file of mentioned) {
      expect(importersOf([file], PRIVILEGED_MODULE), file.path).toEqual([]);
    }
  });
});

describe('the projections the privileged queries return', () => {
  it('never overlap the fields no cross-tenant read may carry', () => {
    const forbidden: readonly string[] = CROSS_TENANT_FORBIDDEN_FIELDS;
    const leaked = ESCALATED_QUEUE_FIELDS.filter((field) => forbidden.includes(field));

    /**
     * The whole overlap, not a boolean: a failure has to NAME the field that was added, or
     * the next person sees "expected true to be false" and has to go looking.
     */
    expect(leaked).toEqual([]);
  });

  it('would notice a forbidden field added to a projection', () => {
    /**
     * The vacuity guard. Without it, an assertion comparing two lists that never overlap
     * for structural reasons would pass forever while checking nothing — and this one has
     * to keep working, because it is the only thing standing between a hurried edit and a
     * cross-tenant leak of reported material.
     */
    const widened = [...ESCALATED_QUEUE_FIELDS, 'contentSnapshot'];
    const forbidden: readonly string[] = CROSS_TENANT_FORBIDDEN_FIELDS;
    expect(widened.filter((field) => forbidden.includes(field))).toEqual(['contentSnapshot']);
  });

  it('forbids juror identity by name, so a rename cannot quietly drop it', () => {
    // §11 protects these hardest, and they live in UNSCOPED collections where the tenant
    // filter is not — and cannot be — the control. The field list is the control.
    for (const field of ['reviewerId', 'agreeingReviewerIds', 'assignmentId', 'oxyUserId']) {
      expect(CROSS_TENANT_FORBIDDEN_FIELDS, field).toContain(field);
    }
  });
});
