import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@xvirobotics/arc-mcp': path.resolve(packageRoot, '../arc-mcp/src/index.ts'),
      '@xvirobotics/worker-runner-mcp': path.resolve(packageRoot, '../worker-runner-mcp/src/index.ts'),
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
