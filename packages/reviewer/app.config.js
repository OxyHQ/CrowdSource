const pkg = require('./package.json');

/**
 * CrowdSource's registered Oxy client id: the ApplicationCredential publicKey
 * (`oxy_dk_…`), public by construction. The binary's Oxy Updates manifest URL is
 * baked from it, so it is the same id the production build signs in with
 * (`EXPO_PUBLIC_OXY_CLIENT_ID` in eas.json's `production` env) and the one
 * `.github/workflows/publish-update.yml` publishes under.
 */
const OXY_CLIENT_ID = 'oxy_dk_609770191a2478cda9dd190a338b1f7a827375634a589cb8';

module.exports = (_config) => {
  /**
   * App version, MAJOR.MINOR.PATCH. The store build number is derived from it
   * (@oxy.so/app-preset: 1.2.3 → 1002003) and it is the OTA compatibility
   * boundary (withOxyUpdates, runtime policy `appVersion`): bump it for any
   * native change, and the next push to main releases a new Android binary
   * (`.github/workflows/android-release.yml`). A JS-only change keeps it and
   * ships as an OTA update.
   */
  const VERSION = pkg.version;

  const APP_ENV = process.env.EXPO_PUBLIC_ENV ?? 'development';
  const VALID_APP_ENVS = ['development', 'testflight', 'production'];
  if (!VALID_APP_ENVS.includes(APP_ENV)) {
    throw new Error(
      `Invalid EXPO_PUBLIC_ENV "${APP_ENV}". Expected one of: ${VALID_APP_ENVS.join(', ')}`,
    );
  }
  const IS_DEV = APP_ENV === 'development';
  const DEV_HOST = process.env.EXPO_PUBLIC_DEV_HOST?.trim();
  if (DEV_HOST && !/^[a-zA-Z0-9.-]+$/.test(DEV_HOST)) {
    throw new Error(
      'Invalid EXPO_PUBLIC_DEV_HOST. Provide a hostname or IP without a scheme or port.',
    );
  }

  /**
   * App variant — lets a development build sit next to the production app on the
   * SAME device by giving it a distinct applicationId/bundleId + name. Build the
   * dev variant with `APP_VARIANT=development`; production is the default.
   */
  const IS_DEV_VARIANT = process.env.APP_VARIANT === 'development';
  const APP_ID = IS_DEV_VARIANT ? 'so.oxy.crowdsource.dev' : 'so.oxy.crowdsource';
  const APP_NAME = IS_DEV_VARIANT ? 'CrowdSource (Dev)' : 'CrowdSource';

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
        // App Links for the one host this app owns: `crowdsource.oxy.so` serves
        // `/.well-known/assetlinks.json` (`worker/appAssociation.js`) naming
        // this package and the Oxy release key. Never add a host whose site
        // does not serve that document: on Android 11 and older one host
        // failing verification fails the whole filter.
        intentFilters: [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [
              {
                scheme: 'https',
                host: 'crowdsource.oxy.so',
              },
              IS_DEV && {
                scheme: 'http',
                host: 'localhost',
                port: '8081',
              },
              IS_DEV &&
                DEV_HOST && {
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
      plugins: [
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
                'keychain-access-groups': ['$(AppIdentifierPrefix)group.so.oxy.shared'],
              },
            },
            android: {
              // compileSdk / targetSdk / build tools come from the Expo SDK
              // template (SDK 58: 37 / 36 / 37.0.0). SDK 58's Expo modules
              // require compileSdk 37; a pinned 36 fails the release build
              // in :expo:checkReleaseAarMetadata.
              enableProguardInReleaseBuilds: true,
              enableShrinkResourcesInReleaseBuilds: true,
              useLegacyPackaging: false,
              // Expo SDK 58+: no Fresco GIF/WebP decoders. Nothing here draws through
              // react-native's own Image — Bloom and @oxy.so/services use expo-image.
              gifEnabled: false,
              webpEnabled: false,
            },
          },
        ],
        'expo-web-browser',
        // CrowdSource runs on its own Android UID. It shares the Oxy identity
        // and the device session with Commons and Accounts over
        // signature-protected IPC: this declares and requests
        // so.oxy.permission.IDENTITY and DEVICE_SESSION and adds the
        // <queries> for their providers.
        '@oxy.so/services/plugins/withOxySharedPermissions',
        // OTA updates from Oxy Updates (oxy-api), verified against the ecosystem
        // code-signing certificate; also derives the store build number from
        // `version`. Published by `.github/workflows/publish-update.yml`.
        ['@oxy.so/app-preset/plugin/withOxyUpdates', { clientId: OXY_CLIENT_ID }],
      ],
      extra: {
        // No `eas.projectId`: no EAS project has been created for CrowdSource.
        // `eas init` writes it here.
        router: {
          origin: false,
        },
      },
      owner: 'oxyhq',
    },
  };
};
