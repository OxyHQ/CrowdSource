/**
 * Android App Links for `https://crowdsource.oxy.so/...`: the reviewer app's
 * `autoVerify` intent filter (`app.config.js`) verifies only when this host
 * serves `/.well-known/assetlinks.json` naming the app's package and signing
 * certificate.
 *
 * It is served HERE, by the `crowdsource-frontend` Worker, because
 * `crowdsource.oxy.so` is this Worker and nothing else (`wrangler.toml`). Without
 * it the assets binding's single-page-application fallback answers the path with
 * `index.html` and 200, which Android rejects, so every link opened in the
 * browser. Every other `/.well-known/` path ends in a JSON 404 too, so a missing
 * document never masquerades as the app shell. `worker/__tests__/appAssociation.test.ts`
 * pins the package below to `app.config.js`.
 *
 * No `apple-app-site-association`: the iOS app declares no associated domains.
 */

/** `android.package` of the production app (`app.config.js`). */
export const ANDROID_PACKAGE = 'so.oxy.crowdsource';

/**
 * The Oxy ecosystem release key (`CN=Oxy, OU=Oxy Ecosystem`). Every Oxy app is
 * signed with it (oxy `android-release.yml` refuses any other), and Play App
 * Signing uses it as the app signing key, so it is the only certificate an
 * installed CrowdSource carries.
 */
export const OXY_RELEASE_CERT_SHA256 =
  'B8:AB:37:46:46:6C:E4:56:9D:7A:6A:0F:FA:1E:ED:91:BC:37:51:74:D5:03:61:39:87:CA:09:CB:33:D6:A5:8D';

export const ASSET_LINKS_PATH = '/.well-known/assetlinks.json';

/** Verifiers re-fetch on their own schedule; an hour keeps a key rotation quick. */
const CACHE_CONTROL = 'public, max-age=3600';

export const ASSET_LINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: ANDROID_PACKAGE,
      sha256_cert_fingerprints: [OXY_RELEASE_CERT_SHA256],
    },
  },
];

function json(body, status, cacheControl, method) {
  return new Response(method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * The response for a `/.well-known/` request, or `null` for any other path,
 * which the caller hands to the assets binding as before.
 */
export function handleWellKnown(request) {
  const { pathname } = new URL(request.url);
  if (pathname !== '/.well-known' && !pathname.startsWith('/.well-known/')) return null;

  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    const response = json({ error: 'Method not allowed' }, 405, 'no-store', method);
    response.headers.set('Allow', 'GET, HEAD');
    return response;
  }
  if (pathname === ASSET_LINKS_PATH) {
    return json(ASSET_LINKS, 200, CACHE_CONTROL, method);
  }
  return json({ error: 'Not found' }, 404, 'no-store', method);
}
