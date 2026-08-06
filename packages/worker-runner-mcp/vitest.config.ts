import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { isolate: true } },
  },
});
