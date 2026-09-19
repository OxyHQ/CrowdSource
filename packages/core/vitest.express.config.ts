import path from 'path';

import { defineConfig } from 'vitest/config';

const packageRoot = path.resolve(__dirname, '.');

/** The `@crowdsource.you/core/express` suite. See `vitest.config.ts` for why the four are separate. */
export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: [path.resolve(packageRoot, 'src/express/__tests__/**/*.test.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/express/**/*.ts'],
      exclude: ['src/express/__tests__/**'],
    },
  },
});
