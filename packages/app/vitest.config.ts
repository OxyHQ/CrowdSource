import path from 'path';

import { defineConfig } from 'vitest/config';

const packageRoot = path.resolve(__dirname, '.');

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: [path.resolve(packageRoot, 'src/__tests__/**/*.test.ts')],
    globalSetup: [path.resolve(packageRoot, 'vitest.globalSetup.ts')],
    // Schema setup and contention checks can take longer on a cold database.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
