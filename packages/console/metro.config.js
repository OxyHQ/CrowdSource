const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const exactModuleAliases = new Map([
  ['@expo/vector-icons', path.join(projectRoot, 'shims/expo-vector-icons.ts')],
  ['@oxyhq/bloom', path.join(projectRoot, 'shims/oxy-bloom.ts')],
]);
const bloomFontDataShim = path.join(projectRoot, 'shims/bloom-font-data.web.ts');

const config = getDefaultConfig(projectRoot);

config.projectRoot = projectRoot;

// Include the monorepo root so Metro resolves hoisted dependencies.
config.watchFolders = [monorepoRoot];

const blockPath = (dir) => {
  const resolved = path.resolve(dir);
  return new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`);
};

config.resolver = {
  ...config.resolver,
  blockList: [
    blockPath(path.join(monorepoRoot, 'packages/backend')),
    blockPath(path.join(monorepoRoot, 'packages/contracts/src')),
    blockPath(path.join(monorepoRoot, 'packages/reviewer')),
    blockPath(path.join(monorepoRoot, 'docs')),
    /\.expo\/.*/,
    /\.expo-shared\/.*/,
    /\.metro\/.*/,
    /\.cache\/.*/,
    /node_modules\/\.cache\/.*/,
    /\.tsbuildinfo$/,
    /.*\.expo\/types\/.*/,
    /__tests__\/.*/,
    /\.test\.(js|ts|tsx|jsx)$/,
    /\.spec\.(js|ts|tsx|jsx)$/,
    /\.md$/,
    /README/,
  ],
  extraNodeModules: {
    '@oxyhq/crowdsource-contracts': path.join(monorepoRoot, 'packages/contracts'),
  },
  nodeModulesPaths: [
    path.join(projectRoot, 'node_modules'),
    path.join(monorepoRoot, 'node_modules'),
  ],
  unstable_enableSymlinks: true,
  // Required by @oxyhq/bloom's subpath exports.
  unstable_enablePackageExports: true,
  // Oxy's published UI still imports the `@expo/vector-icons` barrel even
  // though it only renders Ionicons and MaterialCommunityIcons. The barrel
  // eagerly registers every glyph map and font family, adding megabytes of
  // unused assets to a web bundle. Only the exact legacy barrel request is
  // narrowed; this app imports icon-family subpaths directly.
  resolveRequest: (context, moduleName, platform) => {
    // Bloom publishes its web fonts as base64 strings in `font-data.web.js`.
    // Those bytes in the entry graph inflate every initial download even though
    // the browser already has a cacheable font pipeline; `public/fonts/*` plus
    // the one-year immutable rule in `public/_headers` is that pipeline. The
    // override is limited to Bloom's own relative import so no unrelated module
    // can resolve to the shim.
    const isBloomFontDataRequest =
      platform === 'web' &&
      (moduleName === './font-data.web' || moduleName === './font-data.web.js') &&
      /[\\/]@oxyhq[\\/]bloom[\\/].*[\\/]fonts[\\/]apply-font-faces\.web\.(?:js|ts)$/.test(
        context.originModulePath ?? '',
      );

    return context.resolveRequest(
      context,
      isBloomFontDataRequest ? bloomFontDataShim : exactModuleAliases.get(moduleName) ?? moduleName,
      platform,
    );
  },
  sourceExts: [...config.resolver.sourceExts, 'ts', 'tsx'],
  // Bloom's `apply-font-faces.web.js` imports `.woff2` at module level, and
  // Metro does not include that extension in `assetExts` by default.
  assetExts: [...config.resolver.assetExts.filter((ext) => ext !== 'svg'), 'wasm', 'woff2', 'woff'],
};

config.transformer = {
  ...config.transformer,
  minifierConfig: {
    ...config.transformer?.minifierConfig,
    keep_classnames: false,
    keep_fnames: false,
    mangle: {
      keep_classnames: false,
      keep_fnames: false,
    },
    output: {
      ascii_only: true,
      quote_style: 3,
      wrap_iife: true,
    },
    sourceMap: {
      includeSources: false,
    },
    toplevel: false,
    compress: {
      arguments: true,
      dead_code: true,
      drop_console: false,
      drop_debugger: true,
      ecma: 2020,
      evaluate: true,
      inline: 1,
      passes: 3,
      reduce_funcs: true,
      reduce_vars: true,
      unsafe: false,
      unsafe_comps: false,
      unsafe_math: false,
    },
  },
};

module.exports = withNativeWind(config, {
  inlineRem: 16,
  inlineVariables: false,
});
