import { defineConfig } from 'vitest/config';

// Unit tests only (`pnpm test`). The end-to-end suite has its own config: vitest.e2e.config.ts.
export default defineConfig({
  test: { include: ['test/unit/**/*.test.ts'], environment: 'node', restoreMocks: true },
});
