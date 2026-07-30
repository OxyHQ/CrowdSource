/**
 * The identity rule, exercised without rendering the app.
 *
 * Both behaviours below look like nothing when they are wrong. An unresolved cold boot
 * treated as "signed out" fetches once against an anonymous client and caches the
 * failure; an account switch treated as "not a change" leaves the previous account's
 * tenants — or its cross-tenant trust table — in memory for the next person.
 */

import { UNRESOLVED_VIEWER_KEY, resolveViewer, shouldDropPreviousViewer } from '../viewer';

describe('resolveViewer', () => {
  it('reports an unresolved cold boot as unknown, not as signed out', () => {
    // `null` is what makes every query hold a key that is disabled rather than a key
    // that caches an anonymous failure.
    expect(
      resolveViewer({
        isAuthResolved: false,
        isAuthenticated: false,
        userId: null,
        canUsePrivateApi: false,
      }),
    ).toEqual({ key: null, canQuery: false });
  });

  it('reports a resolved anonymous session under its own sentinel', () => {
    expect(
      resolveViewer({
        isAuthResolved: true,
        isAuthenticated: false,
        userId: null,
        canUsePrivateApi: false,
      }),
    ).toEqual({ key: 'anonymous', canQuery: false });
  });

  it('prefixes a real identity so it can never collide with the sentinel', () => {
    expect(
      resolveViewer({
        isAuthResolved: true,
        isAuthenticated: true,
        userId: 'anonymous',
        canUsePrivateApi: true,
      }),
    ).toEqual({ key: 'user:anonymous', canQuery: true });
  });

  it('refuses to query while the bearer is not ready', () => {
    // `isAuthenticated` can be true a moment before the access token is, and a request
    // sent in that window comes back 401.
    expect(
      resolveViewer({
        isAuthResolved: true,
        isAuthenticated: true,
        userId: 'oxy_1',
        canUsePrivateApi: false,
      }),
    ).toEqual({ key: 'user:oxy_1', canQuery: false });
  });

  it('has a sentinel key for the unresolved state that is not a real key', () => {
    expect(UNRESOLVED_VIEWER_KEY).not.toBe('anonymous');
    expect(UNRESOLVED_VIEWER_KEY.startsWith('user:')).toBe(false);
  });
});

describe('shouldDropPreviousViewer', () => {
  it('treats an unresolved boot as no change', () => {
    // Otherwise every page load would wipe the cache it had just filled.
    expect(shouldDropPreviousViewer(null, 'user:oxy_1')).toBe(false);
    expect(shouldDropPreviousViewer('user:oxy_1', null)).toBe(false);
  });

  it('drops on a real switch', () => {
    expect(shouldDropPreviousViewer('user:oxy_1', 'user:oxy_2')).toBe(true);
    expect(shouldDropPreviousViewer('user:oxy_1', 'anonymous')).toBe(true);
  });

  it('does not drop when the identity is unchanged', () => {
    expect(shouldDropPreviousViewer('user:oxy_1', 'user:oxy_1')).toBe(false);
  });
});
