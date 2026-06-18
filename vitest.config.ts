import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.{test,spec,e2e}.ts'],
    exclude: ['test/e2e-browser/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 360_000,
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
  },
});
