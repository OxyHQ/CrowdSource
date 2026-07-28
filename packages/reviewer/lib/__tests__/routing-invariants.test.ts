/**
 * "Nobody chooses the case they review" (PLAN §4.1, Appendix F), as a structural
 * check on the route tree.
 *
 * A shareable case link cannot exist if no route accepts a case or assignment
 * identifier, so that is what this asserts — against the files on disk, not
 * against anyone's memory of them. Expo Router derives its URLs from this
 * directory, so a `[caseId].tsx` appearing here IS a shareable link, whatever
 * the screen inside it does.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = join(__dirname, '..', '..', 'app');

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      return routeFiles(full);
    }
    return entry.endsWith('.tsx') ? [full] : [];
  });
}

describe('route tree', () => {
  const files = routeFiles(APP_DIR);

  it('scanned the route tree', () => {
    // Vacuity floor: a traversal that found nothing would pass every assertion
    // below without checking anything at all.
    expect(files.length).toBeGreaterThan(5);
  });

  it('has no dynamic segment anywhere', () => {
    // Expo Router's dynamic segments are `[param]` and `[...rest]`. None of the
    // reviewer's surfaces is addressed by an id: the assignment is held in
    // memory for the session and the route that renders it takes no parameters.
    const dynamic = files.filter((file) => /\[[^\]]+\]/.test(file));
    expect(dynamic).toEqual([]);
  });

  it('has no screen that reads a route parameter', () => {
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('useLocalSearchParams') || source.includes('useGlobalSearchParams');
    });
    expect(offenders).toEqual([]);
  });
});

describe('reviewer API surface', () => {
  const client = readFileSync(join(__dirname, '..', 'reviewer-api', 'client.ts'), 'utf8');

  it('offers no way to list or search cases', () => {
    // If a case list existed, a screen could render it and the invariant would
    // be one component away from being broken.
    expect(client).not.toMatch(/\/v1\/reviewer\/cases/);
    expect(client).not.toMatch(/search/i);
    expect(client).not.toMatch(/\bqueue\b/i);
  });

  it('reaches an assignment only through the endpoints §10.3 defines', () => {
    const paths = [...client.matchAll(/'(\/v1\/[^'`]*)'|`(\/v1\/[^'`]*)`/g)].map(
      (match) => match[1] ?? match[2],
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith('/v1/reviewer/')).toBe(true);
    }
  });
});
