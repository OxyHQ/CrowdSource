import path from 'path';

import { defineConfig } from 'vitest/config';

/** The `@crowdsource.you/core/testing` suite. See `vitest.config.ts` for why the four are separate. */
const packageRoot = path.resolve(__dirname, '.');

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: [path.resolve(packageRoot, 'src/testing/__tests__/**/*.test.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/testing/**/*.ts'],
      exclude: ['src/testing/__tests__/**'],
    },
  },
});
