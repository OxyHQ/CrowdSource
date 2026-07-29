import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { registeredCollectionNames, unscopedCollectionReasons } from '../db/collections';
import { DRIVER_ACCESS_ALLOWED, findDriverEscapes, type ScannedFile } from '../db/driverEscapes';
// Imported for their side effect: a collection is only registered once the
// module that declares it is loaded, and an empty registry would make every
// assertion below vacuously true.
import '../modules/audit/audit.collection';
import '../modules/cases/case.collection';
import '../modules/ingestion/report.collection';
import '../modules/outbox/outbox.collection';
import '../modules/policy/policySet.collection';
import '../modules/tenancy/tenancy.collections';

/**
 * The gate on the tenant boundary.
 *
 * Nothing in MongoDB stops a query that forgets its tenant filter, so the
 * boundary is only as strong as the rule that every query goes through
 * `src/db`. This test is what enforces that rule, and — following the lesson
 * that a check unable to fail is worse than no check — it carries its own
 * mutation test and its own vacuity floor.
 */

const backendRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(backendRoot, 'src');

function collectSources(directory: string): ScannedFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Tests are excluded deliberately: asserting on what is actually STORED,
      // straight off the driver, is exactly how the isolation tests avoid
      // proving only that the wrapper agrees with itself.
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

const sources = collectSources(sourceRoot);

describe('driver access', () => {
  /**
   * The vacuity floor. A traversal that silently returned nothing would make the
   * assertion below pass while checking no files whatsoever.
   */
  it('scanned the source tree', () => {
    expect(sources.length).toBeGreaterThanOrEqual(15);
    expect(sources.map((file) => file.path)).toContain('src/modules/ingestion/report.service.ts');
  });

  it('no module outside the access layer reaches the driver', () => {
    const escapes = findDriverEscapes(sources);

    // The full offending lines, so a failure names what to fix rather than just
    // asserting a count.
    expect(escapes.map((escape) => `${escape.path}:${escape.line} ${escape.rule} — ${escape.text}`))
      .toEqual([]);
  });

  /**
   * The mutation test. Break the thing the check guards and confirm the check
   * fails AND names the offending path — otherwise the empty result above is
   * indistinguishable from a scanner that matches nothing.
   */
  it('detects each escape it claims to detect', () => {
    const violations: ScannedFile[] = [
      { path: 'src/modules/cases/case.service.ts', source: 'const M = mongoose.model("Report");' },
      {
        path: 'src/modules/cases/case.service.ts',
        source: 'await connection.collection("reports").find({});',
      },
      { path: 'src/modules/cases/case.service.ts', source: 'const db = connection.db;' },
    ];

    for (const violation of violations) {
      const found = findDriverEscapes([violation]);
      expect(found).toHaveLength(1);
      expect(found[0].path).toBe('src/modules/cases/case.service.ts');
      expect(found[0].text).toBe(violation.source);
    }
  });

  it('does not flag the access layer it exists to protect', () => {
    for (const allowed of Object.keys(DRIVER_ACCESS_ALLOWED)) {
      const escapes = findDriverEscapes([
        { path: `${allowed}${allowed.endsWith('/') ? 'anything.ts' : ''}`, source: 'mongoose.model("X")' },
      ]);
      expect(escapes).toEqual([]);
    }
  });

  it('does not mistake a comment about the rule for a breach of it', () => {
    const escapes = findDriverEscapes([
      {
        path: 'src/modules/cases/case.service.ts',
        source: [
          '// Never call mongoose.model( here.',
          ' * The escape hatch is connection.db and it is watched.',
          'const scoped = reports.findOne(context, {});',
        ].join('\n'),
      },
    ]);

    expect(escapes).toEqual([]);
  });
});

describe('collections that are exempt from tenant scoping', () => {
  /**
   * Pinned, so adding an exemption is an edit to this list and not something
   * that happens quietly inside a module. Each entry has to justify itself in
   * source; this asserts the justification exists and that the set is what was
   * agreed.
   */
  it('is exactly the set that cannot be scoped, each with a stated reason', () => {
    const reasons = unscopedCollectionReasons();

    expect([...reasons.keys()].sort()).toEqual([
      'Application',
      'ApplicationCredential',
      'Organization',
      'OutboxEvent',
    ]);
    for (const [name, why] of reasons) {
      expect(why.trim().length, `${name} must say why it is exempt`).toBeGreaterThanOrEqual(30);
    }
  });

  /**
   * The other half of the pin. Every collection that CAN be tenant-scoped must
   * be, so a new one added as unscoped shows up as a failure in the list above
   * and a new one added as scoped shows up here.
   */
  it('registers the tenant-owned collections too', () => {
    expect(registeredCollectionNames()).toEqual(
      expect.arrayContaining(['Report', 'Case', 'CaseReport', 'PolicySet', 'AuditEvent']),
    );
  });
});
