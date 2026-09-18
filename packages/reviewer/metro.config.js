const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const exactModuleAliases = new Map([
  ['@expo/vector-icons', path.join(projectRoot, 'shims/expo-vector-icons.ts')],
]);

const config = getDefaultConfig(projectRoot);

config.projectRoot = projectRoot;

// Include monorepo root so Metro can resolve hoisted dependencies in root node_modules/
config.watchFolders = [
  monorepoRoot,
];

// Helper to create block patterns
const blockPath = (dir) => {
  const resolved = path.resolve(dir);
  return new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`);
};

config.resolver = {
  ...config.resolver,
  blockList: [
    blockPath(path.join(monorepoRoot, 'packages/backend')),
    blockPath(path.join(monorepoRoot, 'packages/contracts/src')),
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
    '@oxy.so/crowdsource-contracts': path.join(monorepoRoot, 'packages/contracts'),
  },
  // Resolve from reviewer node_modules first, then monorepo root (for hoisted deps)
  nodeModulesPaths: [
    path.join(projectRoot, 'node_modules'),
    path.join(monorepoRoot, 'node_modules'),
  ],
  // Enable symlinks for npm workspace resolution
  unstable_enableSymlinks: true,
  // Enable package.json "exports" field resolution (required by @oxy.so/bloom subpath exports)
  unstable_enablePackageExports: true,
  // Oxy's published UI still imports the `@expo/vector-icons` barrel even
  // though it only renders Ionicons and MaterialCommunityIcons. The barrel
  // eagerly registers every glyph map/font family in web and adds megabytes of
  // unused assets. This app imports icon-family subpaths directly; only the
  // exact legacy barrel request is narrowed here.
  resolveRequest: (context, moduleName, platform) => {
    return context.resolveRequest(
      context,
      exactModuleAliases.get(moduleName) ?? moduleName,
      platform,
    );
  },
  sourceExts: [...config.resolver.sourceExts, 'ts', 'tsx'],
  // Bloom's `fonts/font-urls.web.js` imports its `.woff2` files (BlomusModernus,
  // Inter, JetBrains Mono) so Metro emits them as hashed static assets under
  // `/assets/`. Metro does not include `.woff2` in default `assetExts`.
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
