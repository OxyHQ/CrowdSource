const pkg = require('./package.json')

module.exports = function(_config) {

  /**
   * App version number. Should be incremented as part of a release cycle.
   */
  const VERSION = pkg.version

  /**
   * Uses built-in Expo env vars
   *
   * @see https://docs.expo.dev/build-reference/variables/#built-in-environment-variables
   */
  const PLATFORM = process.env.EAS_BUILD_PLATFORM

  const APP_ENV = process.env.EXPO_PUBLIC_ENV ?? 'development'
  const VALID_APP_ENVS = ['development', 'testflight', 'production']
  if (!VALID_APP_ENVS.includes(APP_ENV)) {
    throw new Error(
      `Invalid EXPO_PUBLIC_ENV "${APP_ENV}". Expected one of: ${VALID_APP_ENVS.join(', ')}`,
    )
  }
  const IS_DEV = APP_ENV === 'development'
  const DEV_HOST = process.env.EXPO_PUBLIC_DEV_HOST?.trim()
  if (DEV_HOST && !/^[a-zA-Z0-9.-]+$/.test(DEV_HOST)) {
    throw new Error(
      'Invalid EXPO_PUBLIC_DEV_HOST. Provide a hostname or IP without a scheme or port.',
    )
  }

  /**
   * App variant — lets a development build sit next to the production app on the
   * SAME device by giving it a distinct applicationId/bundleId + name. Build the
   * dev variant with `APP_VARIANT=development`; production is the default.
   */
  const IS_DEV_VARIANT = process.env.APP_VARIANT === 'development'
  const APP_ID = IS_DEV_VARIANT ? 'so.oxy.crowdsource.dev' : 'so.oxy.crowdsource'
  const APP_NAME = IS_DEV_VARIANT ? 'CrowdSource (Dev)' : 'CrowdSource'

  return {
    expo: {
      name: APP_NAME,
      slug: 'crowdsource',
      version: VERSION,
      orientation: 'portrait',
      scheme: 'crowdsource',
      userInterfaceStyle: 'automatic',
      newArchEnabled: true,
      experiments: {
        typedRoutes: true,
        reactCompiler: true,
      },
      // The launcher mark, opaque and full-bleed at 1024px as iOS requires (it
      // rejects an alpha channel and applies its own corner mask). Android and
      // web take the layered/round variants below instead of this one.
      icon: './assets/images/icon.png',
      ios: {
        supportsTablet: true,
        bundleIdentifier: APP_ID,
        infoPlist: {
          // Allow Linking.canOpenURL('oxycommons://') so "Sign in with Oxy" can
          // deep-link into Commons on iOS (custom schemes are hidden from
          // canOpenURL unless whitelisted here). Android is unrestricted.
          LSApplicationQueriesSchemes: ['oxycommons'],
        },
      },
      android: {
        package: APP_ID,
        // Three layers, not one flattened bitmap: the launcher masks the
        // foreground to whatever shape the device theme uses, and `monochrome`
        // is what Android 13+ themed icons tint to the wallpaper palette —
        // without it a themed launcher falls back to the unthemed icon. Sources
        // are 432px because that is exactly the xxxhdpi mipmap Expo generates,
        // so every density is a downscale and none is an upscale.
        adaptiveIcon: {
          foregroundImage: './assets/images/adaptive-icon-foreground.png',
          backgroundImage: './assets/images/adaptive-icon-background.png',
          monochromeImage: './assets/images/adaptive-icon-monochrome.png',
        },
        intentFilters: [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [
              {
                scheme: 'https',
                host: 'crowdsource.oxy.so',
              },
              {
                scheme: 'https',
                host: 'oxy.so',
              },
              IS_DEV && {
                scheme: 'http',
                host: 'localhost',
                port: '8081',
              },
              IS_DEV && DEV_HOST && {
                scheme: 'http',
                host: DEV_HOST,
                port: '8081',
              },
            ].filter(Boolean),
            category: ['BROWSABLE', 'DEFAULT'],
          },
        ],
        softwareKeyboardLayoutMode: 'pan',
      },
      web: {
        bundler: 'metro',
        output: 'single',
        // `themeColor` is the ONLY head tag the Metro web export derives from
        // this block (alongside `lang` and `description`); it appends a
        // `<meta name="theme-color">`. The `web.meta` and `web.manifest` maps
        // belong to the retired webpack pipeline and are read by nothing here,
        // so the favicon links, the PWA manifest link and the Apple web-app
        // tags are declared in `public/index.html`, which IS the shell Expo
        // serves. Keep this value equal to the pre-hydration canvas in
        // global.css and to `manifest.json`'s `theme_color`.
        themeColor: '#0B0B0F',
        // No `favicon`: `public/favicon.ico` is a real multi-resolution icon
        // from the brand export, and Expo prefers a user-defined one over
        // generating a flat 48px PNG from a source image. Because it takes that
        // path it also skips injecting the `<link rel="icon">` tag, which is
        // why `public/index.html` carries the icon links itself.
        build: {
          babel: {
            include: ['@expo/vector-icons'],
          },
        },
        // Metro configuration is handled in metro.config.js
      },
      // Build the plugins array dynamically so we can exclude certain
      // native-only plugins from web builds.
      plugins: (() => {
        const base = [
          [
            // Async routes split each route into its own lazy chunk under
            // `_expo/static/js/web/` so heavy screens are fetched on demand
            // instead of shipping in the entry bundle. Web-only: `production`
            // is the documented web-only value and is disabled on native (the
            // setting lands in `extra.router.asyncRoutes`, which
            // @expo/metro-config reads).
            'expo-router',
            {
              asyncRoutes: { web: 'production' },
            },
          ],
          [
            // Background only. The colour matches the pre-hydration canvas in
            // global.css so a cold start never flashes white.
            'expo-splash-screen',
            {
              backgroundColor: '#0B0B0F',
              dark: { backgroundColor: '#0B0B0F' },
            },
          ],
          [
            'expo-secure-store',
            {
              configureAndroidBackup: true,
              faceIDPermission: 'Allow $(PRODUCT_NAME) to access your Face ID biometric data.',
            },
          ],
          'expo-image',
          [
            'expo-build-properties',
            {
              ios: {
                deploymentTarget: '16.4',
                entitlements: {
                  'keychain-access-groups': [
                    '$(AppIdentifierPrefix)group.so.oxy.shared',
                  ],
                },
              },
              android: {
                compileSdkVersion: 36,
                targetSdkVersion: 35,
                buildToolsVersion: '36.0.0',
                enableProguardInReleaseBuilds: true,
                enableShrinkResourcesInReleaseBuilds: true,
                useLegacyPackaging: false,
              },
            },
          ],
          'expo-web-browser',
          // Android sharedUserId for cross-app authentication
          './plugins/withSharedUserId',
          // Reader side of the shared-identity native module (ships in
          // @oxyhq/services): request the signature permission + <queries>
          // so cold boot can silently read the Commons-hosted shared
          // identity (silent "Sign in with Oxy").
          '@oxyhq/services/plugins/withSharedIdentityReader',
        ]

        if (PLATFORM === 'web') {
          return base.filter((plugin) => {
            const name = Array.isArray(plugin) ? plugin[0] : plugin
            return name !== './plugins/withSharedUserId'
          })
        }

        return base
      })(),
      extra: {
        // No `eas.projectId`: no EAS project has been created for CrowdSource.
        // `eas init` writes it here.
        router: {
          origin: false,
        },
      },
      owner: 'oxyhq',
    },
  }
}
