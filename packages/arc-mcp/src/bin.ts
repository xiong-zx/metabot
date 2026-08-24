#!/usr/bin/env node
import { createArcRuntime } from './runtime.js';
import { connectArcStdioServer } from './server.js';

async function main(): Promise<void> {
  const runtime = await createArcRuntime();
  for (const stale of runtime.store.lock.staleLocks) {
    process.stderr.write(
      `metabot-arc-mcp: reclaimed stale data lock from pid ${stale.owner.pid}; diagnostic ${stale.archivePath}\n`,
    );
  }
  let server;
  try {
    server = await connectArcStdioServer(runtime.coordinator);
    runtime.notifications?.start();
  } catch (error) {
    runtime.coordinator.dispose();
    runtime.store.close();
    throw error;
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    runtime.notifications?.dispose();
    runtime.coordinator.dispose();
    await server.close();
    runtime.store.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

main().catch((error: unknown) => {
  process.stderr.write(`metabot-arc-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
