#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWorkerRunnerRuntime } from './runtime.js';

const runtime = createWorkerRunnerRuntime();
for (const stale of runtime.store.lock.staleLocks) {
  process.stderr.write(
    `metabot-worker-runner-mcp: reclaimed stale data lock from pid ${stale.owner.pid}; diagnostic ${stale.archivePath}\n`,
  );
}
await runtime.service.start();
await runtime.server.connect(new StdioServerTransport());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void runtime.server.close().finally(() => {
      runtime.service.dispose();
      runtime.store.close();
      process.exit(0);
    });
  });
}
