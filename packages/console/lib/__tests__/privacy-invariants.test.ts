/**
 * No component can render a field the console must never show.
 *
 * `projections.test.ts` proves the data never arrives. This file proves nothing is
 * WRITTEN that expects it to: a screen reading `decision.reviews` or
 * `resource.data` is a component that would light up the moment a projection
 * regressed, and it is the shape a well-meaning edit takes ("the API has the
 * reviewer id, let me show who reviewed it").
 *
 * Scanning source text is a blunt instrument, so the exemptions are explicit and
 * narrow rather than the patterns being loosened: `projections.ts` names these fields
 * in order to drop them, and the tests name them in order to forbid them. If either
 * file is renamed the new path trips the scan, which is the right way for a stale
 * exemption to be noticed.
 *
 * Mutation-tested: adding `{decision.reviews[0].reviewerId}` to a screen makes this
 * fail and names the file.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..', '..');
const SCANNED_DIRECTORIES = ['app', 'components'];

/** The one module allowed to name these fields, because it exists to drop them. */
const PROJECTION_MODULE = 'lib/console-api/projections.ts';

interface SourceFile {
  path: string;
  code: string;
}

function collect(directory: string, relative: string): SourceFile[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    const relativePath = `${relative}/${entry}`;
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' ? [] : collect(full, relativePath);
    }
    if (!/\.(ts|tsx)$/.test(entry)) {
      return [];
    }
    const source = readFileSync(full, 'utf8');
    // Whole-line comments removed: these files EXPLAIN the omissions, at length, and a
    // paragraph saying "never render reporterFingerprints" must not read as rendering
    // it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    return [{ path: relativePath, code }];
  });
}

const FILES = SCANNED_DIRECTORIES.flatMap((directory) =>
  collect(join(PACKAGE_ROOT, directory), directory),
);

function offenders(pattern: RegExp): string[] {
  return FILES.filter((file) => pattern.test(file.code)).map((file) => file.path);
}

describe('no screen reads a field the console must never show', () => {
  it('scanned the screens and components', () => {
    // Vacuity floor: a traversal that found nothing would pass every assertion below
    // without reading a line of the UI.
    expect(FILES.length).toBeGreaterThan(15);
  });

  it('never names a reviewer', () => {
    // Not an id, not a handle, not a count of who sat. A console that named a juror
    // would be worse than a leak — it would be a retaliation surface.
    expect(offenders(/reviewerId|reviewerIds|agreeingReviewerIds|jurors|coReviewers/)).toEqual([]);
  });

  it('never reads an individual vote or review record', () => {
    // The aggregate figures on `decision.jury` are published by the application API and
    // by §10.7's envelope; a per-juror record has no path to this app.
    expect(offenders(/\.reviews\b|\.votes\b|\.ballots\b|reviewRecords/)).toEqual([]);
  });

  it('never names a reporter or their fingerprint', () => {
    // The salt is the application's own id and the input is its own external principal
    // id, so a tenant handed the fingerprints could de-anonymise its own reporters.
    expect(offenders(/reporterFingerprints|reporterId\b|\breporters\b/)).toEqual([]);
  });

  it('never reads a resource payload or a content snapshot', () => {
    // Metadata and digests only. A console that rendered reported content would become
    // a second, longer-lived copy of the most sensitive data in the system.
    expect(offenders(/contentSnapshot|resource\.data\b|\.snapshot\b/)).toEqual([]);
  });

  it('never reads internal queue state or cross-tenant correlation', () => {
    // Priority is a queue position a tenant could game; the pool would say which of its
    // cases went to specialists; an incident id would say its case is linked to
    // another's.
    expect(offenders(/priorityScore|reviewPool|incidentId/)).toEqual([]);
  });

  it('never reads a stored credential digest', () => {
    // `token` and `secret.value` are legitimate — in the issuing response only, which is
    // the one place either exists. A stored digest is not.
    expect(offenders(/secretHash|tokenHash|credentialHash/)).toEqual([]);
  });

  it('never reads a delivery body', () => {
    // It holds the exact signed bytes of the event.
    //
    // The negative lookahead excludes a `.body` immediately followed by a quote, which
    // is an i18n KEY (`t('state.unavailable.body')`) and not a property read. Narrowing
    // the pattern rather than exempting whole files keeps it sharp: `row.body`,
    // `delivery.body` and `event.body` are all still caught, because a property access
    // is followed by punctuation or whitespace.
    expect(offenders(/\.body\b(?!['"`])/)).toEqual([]);
  });

  it('still has the module it exempts', () => {
    // The exemption is the projection module, and it lives outside the scanned tree
    // rather than inside it with a carve-out. If it moves into `components/` or `app/`
    // this assertion is what says the arrangement changed.
    const projections = readFileSync(join(PACKAGE_ROOT, PROJECTION_MODULE), 'utf8');
    expect(projections).toContain('FORBIDDEN_FIELD_PATTERNS');
    expect(FILES.map((file) => file.path)).not.toContain(PROJECTION_MODULE);
  });
});
