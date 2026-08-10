import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ScannedFile } from '../db/driverEscapes';
import {
  CENSUS_EXCUSED_SITES,
  COLLECTION_DATA_METHODS,
  UNSCOPED_TABLE_ACCESSORS,
  censusUnscopedReaders,
  findUnscopedReaders,
  formatReaderSite,
  staleExcuses,
} from '../db/postgres/collectionReaders';
import { UNSCOPED_TABLES } from '../db/postgres/tableRegistry';

/**
 * Who reads the tables that have no tenant policy.
 *
 * The four exemption kinds say why no policy predicate is correct. NONE of them
 * says anything about readers — `tenant_attributed_not_tenant_owned` was renamed
 * out of exactly that claim, because `staff_audit_events` has no production reader
 * and the old name could not be honoured. That rename is an improvement in
 * honesty, and this file is what stops it buying itself with a safety property:
 *
 *   A table with no policy returns EVERY tenant's rows to EVERY reader.
 *
 * Nothing in the vocabulary carries that now, so the complete reader set is a fact
 * somebody must hold, and holding it in prose means true-when-written and
 * unchecked forever after.
 *
 * WHAT THIS BOUNDS, stated plainly because a gate believed to check more than it
 * does is worse than one whose edge is written down: it bounds TODAY's readers.
 * It cannot bind tomorrow's — what it does is make tomorrow's arrival fail the
 * build rather than pass unnoticed. It finds calls through the collection WRAPPER,
 * so a module reaching the driver directly is invisible here and is
 * `collectionBoundary.test.ts`'s business. And it is a census, not a judgement: it
 * says nothing about whether a reader SHOULD exist.
 *
 * No database. The question is about source, and a gate that needs Postgres to
 * answer a question about source would not run where it is cheapest to run.
 */

const backendRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(backendRoot, 'src');

/**
 * `__tests__` is excluded, and the exclusion is load-bearing rather than tidy: a
 * test reading a table is not a cross-tenant disclosure, and counting suites would
 * bury the production readers this exists to pin under fixtures. It is also what
 * makes `staff_audit_events` show its true shape — one writer, no reader — instead
 * of appearing read because an integration test reads it.
 */
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

const sources = collectSources(sourceRoot);
const sites = findUnscopedReaders(sources);
const declared = Object.fromEntries(
  Object.entries(UNSCOPED_TABLES).map(([table, reason]) => [table, reason.readers]),
);

describe('the census can see the tree at all', () => {
  /**
   * The vacuity floor. Every assertion below iterates what the scan produced, so a
   * traversal that returned nothing — or a pattern that stopped matching — would
   * satisfy all of them while measuring no code whatsoever.
   */
  it('scanned the source tree and found reader sites', () => {
    expect(sources.length).toBeGreaterThanOrEqual(15);
    expect(sites.length).toBeGreaterThanOrEqual(100);
    expect(sources.map((file) => file.path)).toContain(
      'src/modules/webhooks/delivery.service.ts',
    );
  });

  /**
   * Membership is TOTAL, the defence against the hole that hid `Decision` and
   * `Appeal`: a table absent from the accessor map is not censused, and not being
   * censused looks exactly like having no readers.
   */
  it('maps every unscoped table, and maps nothing that is not one', () => {
    expect(Object.keys(UNSCOPED_TABLE_ACCESSORS).sort()).toEqual(
      Object.keys(UNSCOPED_TABLES).sort(),
    );
  });

  /** The wrapper's whole data surface, so a method added later is not silently unwatched. */
  it('watches every method that can move a row', () => {
    expect([...COLLECTION_DATA_METHODS].sort()).toEqual([
      'countDocuments',
      'find',
      'findOne',
      'findOneAndUpdate',
      'insertOne',
      'updateOne',
    ]);
  });
});

describe('every unscoped table declares its complete reader set', () => {
  it('has no reader that is neither declared nor excused, and none declared that is gone', () => {
    const disagreements = censusUnscopedReaders(sites, declared).flatMap((result) => [
      ...result.unattributed.map(
        (reader) => `${result.table}: UNATTRIBUTED (found in source, not declared) ${reader}`,
      ),
      ...result.stale.map(
        (reader) => `${result.table}: STALE (declared, no longer in source) ${reader}`,
      ),
    ]);

    // The residual is PRINTED, not counted. A reader nobody classified is visible
    // by construction rather than only when it happens to overlap a case somebody
    // anticipated — which is the property a positive control alone cannot give.
    expect(disagreements).toEqual([]);
  });

  /**
   * An excuse for a site that no longer matches is a suppression still in force
   * over nothing — harmless today, and cover for a real site that later lands on
   * the same name.
   */
  it('carries no excuse that has stopped matching anything', () => {
    expect(staleExcuses(sites)).toEqual([]);
  });

  it('states a reason for every excused site', () => {
    expect(CENSUS_EXCUSED_SITES.length).toBeGreaterThan(0);
    for (const excused of CENSUS_EXCUSED_SITES) {
      expect(
        excused.why.trim().length,
        `${excused.table} ${excused.site} must say why it is not a reader`,
      ).toBeGreaterThanOrEqual(30);
    }
  });

  /**
   * The declared symbol half needs no separate check, and saying so beats adding a
   * redundant one: the assertion above requires declared to EQUAL found, and every
   * found site was derived from a real declaration in a real file. A declared
   * `file#symbol` that does not exist cannot survive the equality.
   */
  it('records the observation that motivated all of this', () => {
    // `staff_audit_events` is write-only in production code: one site, and it is
    // the append. An audit trail with no reader is a control that cannot be
    // exercised — recorded here so the fact is pinned rather than remembered, and
    // so that a reader arriving later shows up as a change to this file.
    expect(declared.staff_audit_events).toEqual([
      'src/modules/console/staffAudit.collection.ts#appendStaffAuditEvent',
    ]);
  });
});

describe('the census can fail', () => {
  const fixture: ScannedFile[] = [
    {
      path: 'src/modules/somewhere/new.service.ts',
      source: [
        "import { reviews } from '../review/review.collection';",
        '',
        'export async function aReaderNobodyDeclared(caseId: string) {',
        '  return reviews.find({ caseId });',
        '}',
      ].join('\n'),
    },
  ];

  /**
   * The mutation test proper: a new reader in a file nobody has classified must be
   * reported AND named. Without this, the empty residual above is indistinguishable
   * from a scanner that matches nothing.
   */
  it('reports a reader that arrived without being declared', () => {
    const found = findUnscopedReaders(fixture);
    expect(found.map((site) => formatReaderSite(site))).toEqual([
      'src/modules/somewhere/new.service.ts#aReaderNobodyDeclared',
    ]);

    const [result] = censusUnscopedReaders(found, { reviews: [] });
    expect(result.unattributed).toEqual([
      'src/modules/somewhere/new.service.ts#aReaderNobodyDeclared',
    ]);
  });

  it('reports a declared reader that no longer exists', () => {
    const [result] = censusUnscopedReaders([], {
      reviews: ['src/modules/review/gone.ts#deletedReader'],
    });
    expect(result.stale).toEqual(['src/modules/review/gone.ts#deletedReader']);
  });

  it('reports an excuse that matches nothing', () => {
    expect(
      staleExcuses([], [{ table: 'reviews', site: 'src/nowhere.ts#x', why: 'a stale excuse' }]),
    ).toEqual(['reviews: src/nowhere.ts#x']);
  });

  /**
   * Attribution, not just detection. A call inside a nested closure belongs to the
   * exported function containing it — the named thing another module can call —
   * rather than to some inner `const`, which would make the declared set churn on
   * refactors that changed nothing about who reads the table.
   */
  it('attributes a nested call to its top-level function', () => {
    const found = findUnscopedReaders([
      {
        path: 'src/modules/x/y.ts',
        source: [
          'export async function outerReader(ids: string[]) {',
          '  const inner = async () => {',
          '    return assignments.find({ ids });',
          '  };',
          '  return inner();',
          '}',
        ].join('\n'),
      },
    ]);
    expect(found.map((site) => formatReaderSite(site))).toEqual(['src/modules/x/y.ts#outerReader']);
  });

  /** A module documenting the rule is not a module breaching it. */
  it('does not mistake a comment about a read for a read', () => {
    expect(
      findUnscopedReaders([
        {
          path: 'src/modules/x/y.ts',
          source: [
            '// Never call reviews.find( from here.',
            ' * The dispatcher uses outboxEvents.findOneAndUpdate to claim.',
            'export const nothing = 1;',
          ].join('\n'),
        },
      ]),
    ).toEqual([]);
  });
});
