/**
 * The session belongs to the SDK, and the console belongs to whoever is signed in
 * right now.
 *
 * These are structural checks, deliberately, because the failures they guard against
 * do not show up in a unit test of any single unit. A slow cold boot, an account
 * switch and a hand-rolled `Authorization` header all look perfectly fine in
 * isolation; what makes them bugs is where they sit in the app.
 *
 * Ported from the reviewer app, with one addition that matters more here: an account
 * switch in this console can move between a developer account and a staff account, so
 * a cache entry that survives the switch is a cross-tenant table on a screen whose
 * session holds no role for it.
 *
 * Each assertion below was mutation-tested: the thing it guards was broken on purpose
 * and the test was confirmed to fail AND to name the offending file.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..', '..');
const SCANNED_DIRECTORIES = ['app', 'components', 'lib', 'hooks', 'utils'];

interface SourceFile {
  /** Path relative to the package root, so a failure names something readable. */
  path: string;
  /** `source` with documentation removed — see {@link stripComments}. */
  code: string;
}

/**
 * Drops block comments and whole-line `//` comments.
 *
 * The rules below are about what the app DOES, and the files that follow them are also
 * the files that explain them: a doc comment saying "never build an Authorization
 * header" must not read as one. Only comments occupying a whole line are removed, so
 * nothing inside a string literal (a URL's `//`, say) is touched — a trailing comment
 * after real code still counts as code, which errs towards a false alarm rather than
 * towards missing a violation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

function collect(directory: string, relative: string): SourceFile[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    const relativePath = `${relative}/${entry}`;
    if (statSync(full).isDirectory()) {
      // Tests describe the forbidden patterns in order to forbid them.
      return entry === '__tests__' ? [] : collect(full, relativePath);
    }
    if (!/\.(ts|tsx)$/.test(entry)) {
      return [];
    }
    return [{ path: relativePath, code: stripComments(readFileSync(full, 'utf8')) }];
  });
}

const FILES = SCANNED_DIRECTORIES.flatMap((directory) =>
  collect(join(PACKAGE_ROOT, directory), directory),
);

/**
 * The one file allowed to name credentials.
 *
 * `lib/logger/sanitize.ts` enumerates `Authorization`, bearer tokens and the rest
 * precisely in order to REDACT them before anything is logged. Exempting it by path
 * rather than loosening the patterns keeps the check sharp everywhere else; if it is
 * ever renamed the new path trips the scan, which is the right way for a stale
 * exemption to be noticed.
 */
const REDACTION_MODULE = 'lib/logger/sanitize.ts';

function offenders(pattern: RegExp): string[] {
  return FILES.filter((file) => file.path !== REDACTION_MODULE && pattern.test(file.code)).map(
    (file) => file.path,
  );
}

describe('the app owns no part of the session', () => {
  it('scanned the app source', () => {
    // Vacuity floor: a traversal that found nothing would pass every assertion below
    // without reading a line of the app.
    expect(FILES.length).toBeGreaterThan(30);
  });

  it('still has the one file it exempts', () => {
    // An exemption that outlives its subject is how an allowlist quietly becomes a
    // hole.
    expect(FILES.map((file) => file.path)).toContain(REDACTION_MODULE);
  });

  it('never builds an Authorization header', () => {
    // The linked client carries the bearer and re-mints it from the device secret. An
    // app-local header is a second, silently diverging authority.
    expect(offenders(/Authorization|Bearer\s/i)).toEqual([]);
  });

  it('never reads, writes or plants a session token', () => {
    expect(offenders(/setTokens|getTokenBySession|accessToken|refreshToken|deviceSecret/)).toEqual(
      [],
    );
  });

  it('has no OAuth or SSO callback route of its own', () => {
    // Cross-domain restore is the SDK's, end to end. An app-local callback is how two
    // implementations of it start to disagree.
    expect(offenders(/sso-callback|consumeSsoReturn|oauth\/callback|code_verifier/)).toEqual([]);
  });

  it('mounts exactly one OxyProvider', () => {
    const mounts = FILES.filter((file) => /<OxyProvider\b/.test(file.code)).map(
      (file) => file.path,
    );
    expect(mounts).toEqual(['components/providers/AppProviders.tsx']);
  });

  it('mounts no second toast outlet', () => {
    // Bloom's toast stack must be mounted exactly once — every mount subscribes to the
    // same store, so a second outlet shows every toast twice. `OxyProvider` already
    // mounts one.
    expect(offenders(/<ToastOutlet\b/)).toEqual([]);
  });
});

describe('the root layout is the only authority for the group swap', () => {
  it('is the only route file that crosses the (auth) boundary', () => {
    // A child that redirects on the same signal can commit first on a cold load, and
    // the app lands on a blank route.
    const navigators = FILES.filter(
      (file) =>
        file.path.startsWith('app/') &&
        file.path !== 'app/_layout.tsx' &&
        /['"`]\/sign-in['"`]|\(auth\)/.test(file.code),
    ).map((file) => file.path);
    expect(navigators).toEqual([]);
  });
});

describe('every console query is scoped to the signed-in account', () => {
  const source = stripComments(
    readFileSync(join(PACKAGE_ROOT, 'lib', 'console-api', 'queries.ts'), 'utf8'),
  );

  /** The options object of each `useQuery` call, as text. */
  const queryCalls = [...source.matchAll(/useQuery</g)].map((match) => {
    const start = match.index ?? 0;
    const end = source.indexOf('\n  });', start);
    return source.slice(start, end === -1 ? source.length : end);
  });

  it('found the query calls to check', () => {
    // Vacuity floor: a regex that matched nothing would report a perfectly scoped
    // module that does not exist.
    expect(queryCalls.length).toBeGreaterThanOrEqual(10);
  });

  it('keys each one on the viewer', () => {
    // Cold boot is slow, and until it resolves `isAuthenticated: false` means
    // UNDETERMINED. A key that does not change when the session lands fetches once
    // while anonymous and stays that way. The same key is what stops one account
    // seeing the previous one's tenants — or its cross-tenant trust table — after a
    // switch.
    const unscoped = queryCalls.filter(
      (call) => !/queryKey: consoleQueryKeys\.\w+\(key/.test(call),
    );
    expect(unscoped).toEqual([]);
  });

  it('gates each one on a usable access token', () => {
    // `isAuthenticated` can be true a moment before the bearer is ready, and a request
    // sent in that window comes back 401.
    const ungated = queryCalls.filter((call) => !/enabled: canQuery/.test(call));
    expect(ungated).toEqual([]);
  });
});
