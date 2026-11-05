import path from 'node:path';

import {
  ANDROID_PACKAGE,
  ASSET_LINKS_PATH,
  OXY_RELEASE_CERT_SHA256,
  handleWellKnown,
} from '../appAssociation.js';

/**
 * `crowdsource.oxy.so` answers the App Links verifier with JSON, not the app
 * shell, and names the package the production app is built as.
 */

const ORIGIN = 'https://crowdsource.oxy.so';

function get(pathname: string, method = 'GET'): Response | null {
  return handleWellKnown(new Request(`${ORIGIN}${pathname}`, { method }));
}

/** A well-known path: the Worker must answer it itself. */
function answer(pathname: string, method = 'GET'): Response {
  const response = get(pathname, method);
  if (!response) throw new Error(`${pathname} fell through to the assets binding`);
  return response;
}

type AppConfig = {
  expo: {
    android: {
      package: string;
      intentFilters: { autoVerify?: boolean; data: { scheme: string; host: string }[] }[];
    };
  };
};

function loadAppConfig(variant?: string): AppConfig['expo'] {
  const saved = { variant: process.env.APP_VARIANT, env: process.env.EXPO_PUBLIC_ENV };
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  process.env.EXPO_PUBLIC_ENV = 'production';
  try {
    jest.resetModules();
    const factory = require(path.join(__dirname, '..', '..', 'app.config.js')) as (
      config: unknown,
    ) => AppConfig;
    return factory({}).expo;
  } finally {
    if (saved.variant === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = saved.variant;
    if (saved.env === undefined) delete process.env.EXPO_PUBLIC_ENV;
    else process.env.EXPO_PUBLIC_ENV = saved.env;
  }
}

describe('assetlinks.json', () => {
  it('is 200 application/json naming the production package and the Oxy release key', async () => {
    const response = answer(ASSET_LINKS_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'so.oxy.crowdsource',
          sha256_cert_fingerprints: [OXY_RELEASE_CERT_SHA256],
        },
      },
    ]);
  });

  it('carries the Oxy ecosystem certificate', () => {
    expect(OXY_RELEASE_CERT_SHA256.replaceAll(':', '').toLowerCase()).toBe(
      'b8ab3746466ce4569d7a6a0ffa1eed91bc375174d503613987ca09cb33d6a58d',
    );
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = answer(ASSET_LINKS_PATH, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = answer(ASSET_LINKS_PATH, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('ends every other well-known path in a JSON 404 and leaves the rest to the assets', () => {
    const missing = answer('/.well-known/apple-app-site-association');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/json');
    expect(get('/')).toBeNull();
    expect(get('/.well-knownish')).toBeNull();
  });
});

describe('app.config.js', () => {
  it('builds the package assetlinks.json names', () => {
    expect(loadAppConfig().android.package).toBe(ANDROID_PACKAGE);
  });

  it('builds the development variant as a separate package', () => {
    expect(loadAppConfig('development').android.package).toBe(`${ANDROID_PACKAGE}.dev`);
  });

  it('auto-verifies only crowdsource.oxy.so, the host this Worker serves', () => {
    const hosts = loadAppConfig()
      .android.intentFilters.filter((filter) => filter.autoVerify)
      .flatMap((filter) => filter.data.map((entry) => `${entry.scheme}://${entry.host}`));
    expect(hosts).toEqual(['https://crowdsource.oxy.so']);
  });
});
