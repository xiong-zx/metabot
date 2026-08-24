import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Exercise the current workspace sources. Package exports intentionally
    // point at dist for production, but a stale ignored dist must never let a
    // focused Worker test validate another branch's adapter contract.
    alias: {
      '@metabot/rulespack-adapter': fileURLToPath(new URL('../rulespack-adapter/src/index.ts', import.meta.url)),
      '@metabot/rulespack': fileURLToPath(new URL('../rulespack/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { isolate: true } },
  },
});
