import path from 'path';

import { defineConfig } from 'vitest/config';

const packageRoot = path.resolve(__dirname, '.');

/**
 * The `@crowdsource.you/core/outbox` suite — the only one of the four that
 * needs a real PostgreSQL, which is why it keeps its own config and its own
 * `globalSetup`.
 */
export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: [path.resolve(packageRoot, 'src/outbox/__tests__/**/*.test.ts')],
    globalSetup: [path.resolve(packageRoot, 'vitest.globalSetup.ts')],
    // Schema setup and contention checks can take longer on a cold database.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/outbox/**/*.ts'],
      exclude: ['src/outbox/__tests__/**'],
    },
  },
});
