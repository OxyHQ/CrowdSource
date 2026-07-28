import path from 'path';

import { defineConfig } from 'vitest/config';

const contractsRoot = path.resolve(__dirname, '.');

export default defineConfig({
  root: contractsRoot,
  test: {
    environment: 'node',
    include: [path.resolve(contractsRoot, 'src/__tests__/**/*.test.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
