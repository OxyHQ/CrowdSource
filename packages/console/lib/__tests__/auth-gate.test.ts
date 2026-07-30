/**
 * The `(auth)` redirect is live.
 *
 * This guard is ported from the reviewer app, where the failure it catches has already
 * happened once in this repository: a bypass added for local verification
 * (`if (false && ...)`) was swept into a commit by a concurrent `git add -A`, and for a
 * while the pushed branch let every screen render with no session at all.
 *
 * Nothing else would catch it. The app compiles, lints, renders and passes every other
 * test with the redirect disabled — that is exactly what makes it dangerous. So the
 * condition itself is asserted here, as text, and the short-circuit forms that neuter
 * it are named.
 *
 * The stakes are higher in the console than in the reviewer app: one half of this app
 * is a cross-tenant staff surface. The API refuses an unauthenticated caller either
 * way, but a shell that renders without a session sends every query out anonymously and
 * puts a wall of "not running yet" notices where an operator expects data.
 *
 * If a refactor changes the shape of this condition legitimately, update the
 * expectation deliberately: that edit is the review this file exists to force.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_LAYOUT = join(__dirname, '..', '..', 'app', '_layout.tsx');
const SOURCE = readFileSync(ROOT_LAYOUT, 'utf8');

/** Whole-line `//` comments and block comments removed. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

describe('the auth gate', () => {
  it('read the root layout', () => {
    // Vacuity floor: a path that silently read an empty file would make every "does
    // not contain" assertion below pass for the wrong reason.
    expect(CODE.length).toBeGreaterThan(500);
    expect(CODE).toContain('function AuthRouter');
  });

  it('redirects an unauthenticated visitor to sign-in', () => {
    expect(CODE).toMatch(
      /if \(!isAuthenticated && !inAuthGroup\) \{\s*return <Redirect href="\/sign-in" \/>;/,
    );
  });

  it('waits for cold boot before routing on the session', () => {
    // `isAuthenticated: false` is UNDETERMINED until this resolves; routing on it
    // early bounces a returning operator to sign-in on every reload.
    expect(CODE).toMatch(/if \(!isAuthResolved\) \{\s*return null;/);
  });

  it('has no constant short-circuit disabling either redirect', () => {
    // The exact shape of the incident, plus its obvious variants.
    const shortCircuits = [
      /if \(\s*false\s*&&/,
      /if \(\s*true\s*\|\|/,
      /&&\s*false\s*\)/,
      /\|\|\s*true\s*\)/,
      /return null;\s*\/\/\s*bypass/i,
    ];
    const found = shortCircuits.filter((pattern) => pattern.test(CODE)).map(String);
    expect(found).toEqual([]);
  });
});
