import path from 'path';

import { defineConfig } from 'vitest/config';

const packageRoot = path.resolve(__dirname, '.');

/**
 * The ROOT entry point's suite — the API client a consumer gets from
 * `@crowdsource.you/core` itself.
 *
 * One config per entry point rather than one for the package, because the four
 * suites do not have the same requirements: only `vitest.outbox.config.ts`
 * needs a real PostgreSQL, and folding them together would make every client
 * test refuse to run without a database. CI keeps a separate test-count floor
 * per suite for the same reason — a floor over the union cannot tell which half
 * collapsed.
 */
export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: [path.resolve(packageRoot, 'src/__tests__/**/*.test.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
