const pkg = require('./package.json')

/**
 * Expo config for the console — WEB ONLY.
 *
 * The reviewer app's config is the reference, and what is missing here is the
 * point: no `ios`/`android` block, no `plugins` that touch a native project, no
 * launcher icon set, no `eas.json`. The console is a static web export served
 * from Cloudflare Pages and there is no native build to configure. Adding an
 * iOS/Android target later is a deliberate decision with its own signing and
 * shared-keychain consequences, not something a config file should imply is
 * already true.
 */
module.exports = function (_config) {
  const APP_ENV = process.env.EXPO_PUBLIC_ENV ?? 'development'
  const VALID_APP_ENVS = ['development', 'production']
  if (!VALID_APP_ENVS.includes(APP_ENV)) {
    throw new Error(
      `Invalid EXPO_PUBLIC_ENV "${APP_ENV}". Expected one of: ${VALID_APP_ENVS.join(', ')}`,
    )
  }

  return {
    expo: {
      name: 'CrowdSource Console',
      slug: 'crowdsource-console',
      version: pkg.version,
      scheme: 'crowdsource-console',
      userInterfaceStyle: 'automatic',
      newArchEnabled: true,
      experiments: {
        typedRoutes: true,
        reactCompiler: true,
      },
      web: {
        bundler: 'metro',
        // A single-page export. Cloudflare Pages serves `public/_redirects`
        // (`/* /index.html 200`), so a deep link like
        // `/applications/<id>/webhooks` is answered by the shell and routed
        // client-side. A static multi-page export would have to pre-render
        // routes whose ids are only known at runtime.
        output: 'single',
        // The ONLY head tag the Metro web export derives from this block (with
        // `lang` and `description`): it appends `<meta name="theme-color">`.
        // Everything else about the document head lives in `public/index.html`,
        // which IS the shell Expo serves. Keep this equal to the pre-hydration
        // canvas in global.css.
        themeColor: '#0B0B0F',
        build: {
          babel: {
            include: ['@expo/vector-icons'],
          },
        },
      },
      plugins: [
        [
          // Async routes split each screen into its own lazy chunk under
          // `_expo/static/js/web/`, so the case explorer's table code is not in
          // the entry bundle a developer who only came to rotate a webhook
          // secret downloads. `production` is the documented web-only value.
          'expo-router',
          {
            asyncRoutes: { web: 'production' },
          },
        ],
      ],
      extra: {
        router: {
          origin: false,
        },
      },
      owner: 'oxyhq',
    },
  }
}
