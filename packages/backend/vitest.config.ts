import path from 'path';

import { defineConfig } from 'vitest/config';

const backendRoot = path.resolve(__dirname, '.');

export default defineConfig({
  root: backendRoot,
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(backendRoot, 'vitest.setup.ts')],
    // Refuses a green run unless the real PostgreSQL fixture is configured.
    globalSetup: [path.resolve(backendRoot, 'vitest.globalSetup.ts')],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    /**
     * One file at a time.
     *
     * Every integration suite runs against ONE disposable PostgreSQL database, and two of the
     * things under test are deliberately global: the outbox dispatcher claims
     * across every tenant, and so does the webhook delivery worker. Run in
     * parallel, one file's dispatcher claims another file's rows and completes
     * them — which is correct behaviour for the code and a race for the
     * assertions, showing up as a suite that fails once every several runs in a
     * different place each time.
     *
     * Per-test tenants keep the DATA apart; they cannot keep the WORKERS apart,
     * because a worker with a tenant filter would not be the worker that runs in
     * production. Serialising costs about ten seconds on the whole suite, which
     * is a good trade for a gate that means what it says.
     */
    fileParallelism: false,
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
