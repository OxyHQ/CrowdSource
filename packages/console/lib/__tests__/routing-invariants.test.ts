/**
 * Structural checks on the route tree and the API surface.
 *
 * The reviewer app's version of this file asserts that NO route accepts an
 * identifier, because nobody may choose the case they review. The console is the
 * opposite surface by design — an application id is the handle for every screen in
 * it — so what is asserted here is different, and each assertion guards a way the
 * audience split could be broken by an ordinary-looking edit.
 *
 * Every assertion below was mutation-tested: the thing it guards was broken on
 * purpose and the test was confirmed to fail AND to name the offending file.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..', '..');
const APP_DIR = join(PACKAGE_ROOT, 'app');

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      return routeFiles(full);
    }
    return entry.endsWith('.tsx') ? [full] : [];
  });
}

/** Path relative to `app/`, so a failure names something readable. */
function relative(file: string): string {
  return file.slice(APP_DIR.length + 1);
}

describe('route tree', () => {
  const files = routeFiles(APP_DIR);

  it('scanned the route tree', () => {
    // Vacuity floor: a traversal that found nothing would pass every assertion
    // below without checking anything at all.
    expect(files.length).toBeGreaterThan(10);
  });

  it('puts every screen in exactly one of the two groups', () => {
    // The root layout is the sole authority for the group swap, and it can only be
    // that if every screen belongs to a group. A route file at the top level would
    // render on both sides of the boundary.
    const stray = files
      .map(relative)
      .filter((path) => path !== '_layout.tsx' && !path.startsWith('(auth)/') && !path.startsWith('(console)/'));
    expect(stray).toEqual([]);
  });

  it('addresses exactly three kinds of resource by id', () => {
    // A new dynamic segment is a new addressable resource, which is a decision about
    // what a URL may name — not something to arrive as a side effect of adding a
    // screen. `[caseId]` is here and `[reviewId]` never can be: there is no reviewer
    // record in this app's API surface at all.
    const params = new Set(
      files.flatMap((file) => [...relative(file).matchAll(/\[([^\]]+)\]/g)].map((match) => match[1])),
    );
    expect([...params].sort()).toEqual(['applicationId', 'caseId', 'organizationId']);
  });

  it('has no catch-all segment', () => {
    // `[...rest]` would let one screen answer for URLs nobody designed, which is how
    // a route ends up rendering with an id it never validated.
    const catchAll = files.map(relative).filter((path) => path.includes('[...'));
    expect(catchAll).toEqual([]);
  });

  it('keeps the Trust & Safety screens in their own subtree', () => {
    // Not cosmetic: `buildNavigation` gates that subtree on a staff role, and a staff
    // screen living anywhere else would be reachable from a rail entry that was never
    // gated. The API refuses either way; this keeps the two halves legible.
    const staffScreens = files
      .map(relative)
      .filter((path) => /trust-?safety/i.test(path));
    expect(staffScreens.length).toBeGreaterThan(0);
    for (const path of staffScreens) {
      expect(path.startsWith('(console)/trust-safety/')).toBe(true);
    }
  });
});

describe('the console API surface', () => {
  const client = readFileSync(
    join(PACKAGE_ROOT, 'lib', 'console-api', 'client.ts'),
    'utf8',
  );

  /**
   * The request paths, with every interpolation collapsed to `:param`.
   *
   * Normalized so a path built from a template literal compares as the ROUTE it is
   * rather than as its source text — otherwise `/v1/trust-safety/applications${query(f)}`
   * and `/v1/trust-safety/applications` read as two different endpoints and the
   * assertion below could never be written.
   */
  const paths = [...client.matchAll(/'(\/v1\/[^']*)'|`(\/v1\/[^`]*)`/g)]
    .map((match) => match[1] ?? match[2])
    .map((path) => path.replace(/\$\{[^}]*\}/g, ':param'))
    // A trailing query interpolation is not part of the route.
    .map((path) => path.replace(/:param$/, ''));

  it('found the paths to check', () => {
    expect(paths.length).toBeGreaterThan(15);
  });

  it('calls only the two routers this app is a client of', () => {
    for (const path of paths) {
      expect(
        path.startsWith('/v1/console/') || path.startsWith('/v1/trust-safety/'),
      ).toBe(true);
    }
  });

  it('reaches no cross-tenant read beyond what the staff router serves', () => {
    // §4.3's specialist queues and cross-application incidents are NOT built: `cases`
    // and `decisions` expose no cross-tenant read, and correlation belongs to a
    // privileged incident module that does not exist. A path here that asked for one
    // would be a client for an endpoint that cannot exist without a change to the one
    // boundary nothing else in the system enforces — so the staff routes this app
    // calls are enumerated rather than pattern-matched.
    const staffPaths = paths.filter((path) => path.startsWith('/v1/trust-safety/'));
    expect([...new Set(staffPaths)].sort()).toEqual([
      '/v1/trust-safety/applications',
      '/v1/trust-safety/applications/:param/standing',
      '/v1/trust-safety/deliveries/dead-letter',
      '/v1/trust-safety/metrics',
    ]);
  });

  it('reads no case or decision across tenants', () => {
    // The one thing a staff path must never be. Named explicitly because the check
    // above is an equality that a careless update could simply be widened to include.
    for (const path of paths.filter((candidate) => candidate.startsWith('/v1/trust-safety/'))) {
      expect(path).not.toMatch(/case|decision|report|review/i);
    }
  });

  it('offers no way to enumerate tenants', () => {
    // `GET /v1/console/organizations` returns the caller's own memberships. There is
    // no "all organizations" route in the API and there must be no client for one: a
    // developer surface that could enumerate tenants is a customer list.
    expect(client).not.toMatch(/\/v1\/console\/organizations\/all/);
    expect(client).not.toMatch(/\/v1\/console\/applications['"`]/);
  });

  it('encodes every id it puts in a path', () => {
    // Ids arrive from a URL an operator can edit. Every interpolation in a REQUEST PATH
    // must go through `segment()` (which encodes) or `query()` (which encodes each
    // value); a bare `${id}` is how a slash or a `?` in a parameter rewrites the
    // request. Scoped to path template literals, so the interpolations inside `query()`
    // itself — which is where the encoding happens — are not scanned as call sites.
    const pathLiterals = [...client.matchAll(/`(\/v1\/[^`]*)`/g)].map((match) => match[1]);
    expect(pathLiterals.length).toBeGreaterThan(10);
    const interpolations = pathLiterals.flatMap((literal) =>
      [...literal.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1].trim()),
    );
    expect(interpolations.length).toBeGreaterThan(10);
    const unencoded = interpolations.filter(
      (expression) => !expression.startsWith('segment(') && !expression.startsWith('query('),
    );
    expect(unencoded).toEqual([]);
  });
});
