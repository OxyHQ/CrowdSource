import path from 'path';

import { defineConfig } from 'vitest/config';

const backendRoot = path.resolve(__dirname, '.');

export default defineConfig({
  root: backendRoot,
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(backendRoot, 'vitest.setup.ts')],
    include: [path.resolve(backendRoot, 'src/__tests__/**/*.test.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
      thresholds: {
        // Measured on the complete suite. Keep these values explicit: CI must
        // reject a regression instead of silently rewriting the baseline.
        statements: 97,
        branches: 92,
        functions: 96,
        lines: 98,
      },
    },
  },
  resolve: {
    alias: {
      '@oxyhq/crowdsource-contracts': path.resolve(__dirname, '../contracts/src'),
    },
  },
});
