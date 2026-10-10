// Minimal ESLint: only the rules Biome has no equivalent for. Formatting and
// every other lint rule live in the root `biome.json` (`bun run lint` runs both).
//
// eslint-plugin-expo's env-var rules catch `process.env.EXPO_PUBLIC_*` reads that
// Metro silently fails to inline — a destructured or dynamically keyed read is
// `undefined` in the bundle and nothing errors at build time.
const { defineConfig } = require('eslint/config');
const tsParser = require('@typescript-eslint/parser');
const expo = require('eslint-plugin-expo');

module.exports = defineConfig([
  { ignores: ['dist/*', '.expo/*'] },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { expo },
    rules: {
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',
      'expo/use-dom-exports': 'error',
    },
  },
]);
