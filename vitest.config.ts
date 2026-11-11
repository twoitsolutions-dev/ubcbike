import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'tests/api/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
