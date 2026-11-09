import { defineConfig } from 'vitest/config';

// End-to-end suite (`pnpm test:e2e`): real Chrome + real bvl. Slow; files run one at a time
// because they share one browser, proxy and port (see test/e2e/harness.ts).
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    globalSetup: ['test/e2e/global-setup.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
