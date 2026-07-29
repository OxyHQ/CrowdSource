/**
 * Identity scoping — the rules that keep one reviewer's data away from the next.
 *
 * Two failure modes are being guarded, and neither announces itself:
 *
 *  - a query that fires before the access token exists, fails 401, and — with
 *    `refetchOnMount` and `refetchOnWindowFocus` both off — stays failed for the
 *    life of the page;
 *  - an account switch that serves the previous reviewer's standing, training
 *    and history from a cache key that did not change with the account.
 *
 * The decisions are pure functions so they can be exercised exhaustively here
 * rather than only by rendering the whole app under a real Oxy session.
 */

import { reviewerQueryKeys } from '@/lib/reviewer-api/query-keys';
import {
  resolveViewer,
  shouldDropPreviousViewer,
  UNRESOLVED_VIEWER_KEY,
  type ViewerAuthState,
} from '@/lib/reviewer-api/viewer';

const RESOLVED_SIGNED_IN: ViewerAuthState = {
  isAuthResolved: true,
  isAuthenticated: true,
  userId: 'usr_a',
  canUsePrivateApi: true,
};

describe('resolveViewer', () => {
  it('withholds a key and forbids querying while cold boot is unresolved', () => {
    // `isAuthenticated: false` here means UNDETERMINED. Treating it as signed
    // out is what makes a returning reviewer load anonymous data.
    const viewer = resolveViewer({
      isAuthResolved: false,
      isAuthenticated: false,
      userId: null,
      canUsePrivateApi: false,
    });
    expect(viewer).toEqual({ key: null, canQuery: false });
  });

  it('still withholds the key when cold boot is unresolved but a user is already known', () => {
    // Resolution is the gate, not the presence of a user object.
    expect(
      resolveViewer({ ...RESOLVED_SIGNED_IN, isAuthResolved: false }),
    ).toEqual({ key: null, canQuery: false });
  });

  it('forbids querying when resolved and signed out', () => {
    expect(
      resolveViewer({
        isAuthResolved: true,
        isAuthenticated: false,
        userId: null,
        canUsePrivateApi: false,
      }),
    ).toEqual({ key: 'anonymous', canQuery: false });
  });

  it('forbids querying while an authenticated session has no token yet', () => {
    // The window this exists for: the session is committed, the bearer is not.
    // A request sent here comes back 401 and the query never retries itself.
    expect(resolveViewer({ ...RESOLVED_SIGNED_IN, canUsePrivateApi: false })).toEqual({
      key: 'user:usr_a',
      canQuery: false,
    });
  });

  it('allows querying only once resolved, authenticated and token-ready', () => {
    expect(resolveViewer(RESOLVED_SIGNED_IN)).toEqual({ key: 'user:usr_a', canQuery: true });
  });

  it('gives different accounts different keys', () => {
    const a = resolveViewer(RESOLVED_SIGNED_IN);
    const b = resolveViewer({ ...RESOLVED_SIGNED_IN, userId: 'usr_b' });
    expect(a.key).not.toEqual(b.key);
  });

  it('cannot let a user id collide with the anonymous or unresolved sentinels', () => {
    // A bare id as the key would collide if an account were ever literally named
    // `anonymous`. The `user:` prefix is what makes that impossible.
    for (const userId of ['anonymous', UNRESOLVED_VIEWER_KEY]) {
      const viewer = resolveViewer({ ...RESOLVED_SIGNED_IN, userId });
      expect(viewer.key).not.toBe('anonymous');
      expect(viewer.key).not.toBe(UNRESOLVED_VIEWER_KEY);
    }
  });

  it('treats a missing user id as not queryable even when flagged authenticated', () => {
    expect(
      resolveViewer({ ...RESOLVED_SIGNED_IN, userId: null }),
    ).toEqual({ key: 'anonymous', canQuery: false });
  });
});

describe('shouldDropPreviousViewer', () => {
  it('drops when the account changes', () => {
    expect(shouldDropPreviousViewer('user:usr_a', 'user:usr_b')).toBe(true);
  });

  it('drops when a signed-in reviewer signs out', () => {
    expect(shouldDropPreviousViewer('user:usr_a', 'anonymous')).toBe(true);
  });

  it('does not drop on the first resolution of a page load', () => {
    // Nothing from a previous account can be in memory yet; wiping here would
    // discard the cache the page just filled, on every single load.
    expect(shouldDropPreviousViewer(null, 'user:usr_a')).toBe(false);
  });

  it('does not drop while the identity is still unknown', () => {
    expect(shouldDropPreviousViewer('user:usr_a', null)).toBe(false);
  });

  it('does not drop when the identity is unchanged', () => {
    expect(shouldDropPreviousViewer('user:usr_a', 'user:usr_a')).toBe(false);
  });
});

describe('reviewerQueryKeys', () => {
  it('separates every cached resource by viewer', () => {
    const a = 'user:usr_a';
    const b = 'user:usr_b';
    for (const build of [
      reviewerQueryKeys.profile,
      reviewerQueryKeys.training,
      reviewerQueryKeys.history,
    ]) {
      expect(build(a)).not.toEqual(build(b));
      expect(build(a)).toContain(a);
    }
  });

  it('keeps every key under the namespace the identity boundary removes', () => {
    // `removeQueries({ queryKey: all })` matches by PREFIX. A key that does not
    // start with `all` would survive an account switch untouched.
    const namespace = [...reviewerQueryKeys.all];
    for (const build of [
      reviewerQueryKeys.profile,
      reviewerQueryKeys.training,
      reviewerQueryKeys.history,
    ]) {
      expect([...build('user:usr_a')].slice(0, namespace.length)).toEqual(namespace);
    }
  });

  it('does not confuse two resources belonging to the same viewer', () => {
    const viewer = 'user:usr_a';
    const keys = [
      reviewerQueryKeys.profile(viewer),
      reviewerQueryKeys.training(viewer),
      reviewerQueryKeys.history(viewer),
    ].map((key) => JSON.stringify(key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
