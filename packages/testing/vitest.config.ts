import path from 'path';

import { defineConfig } from 'vitest/config';

const packageRoot = path.resolve(__dirname, '.');

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: [path.resolve(packageRoot, 'src/__tests__/**/*.test.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
