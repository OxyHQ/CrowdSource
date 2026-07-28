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
      // No `icon`, `splash` image or `favicon`: CrowdSource has no brand assets
      // yet, and shipping another product's marks would be worse than Expo's
      // neutral defaults. Add them here when the real assets land.
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
        manifest: './public/manifest.json',
        meta: {
          viewport: 'width=device-width, initial-scale=1.0',
          themeColor: '#0B0B0F',
          appleMobileWebAppCapable: 'yes',
          appleMobileWebAppStatusBarStyle: 'default',
          appleMobileWebAppTitle: 'CrowdSource',
          applicationName: 'CrowdSource',
        },
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
