#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ArcArtifactStore } from './artifact-store.js';
import { ArcCoordinator } from './coordinator.js';
import { ArcError } from './errors.js';
import type { ArcRunner } from './runner.js';
import { ArcRunStore } from './run-store.js';
import { connectArcStdioServer } from './server.js';

type RunnerModule = {
  createArcRunner?: () => ArcRunner | Promise<ArcRunner>;
};

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ArcError('runner_unconfigured', `${name} is required`);
  return value;
}

function assertRunner(value: unknown): asserts value is ArcRunner {
  const candidate = value as Partial<ArcRunner> | null;
  for (const method of ['start', 'pause', 'resume', 'cancel', 'collect'] as const) {
    if (!candidate || typeof candidate[method] !== 'function') {
      throw new ArcError('runner_unconfigured', `ARC runner adapter is missing ${method}()`);
    }
  }
}

async function loadRunner(modulePath: string): Promise<ArcRunner> {
  const resolved = path.resolve(modulePath);
  const module = (await import(pathToFileURL(resolved).href)) as RunnerModule;
  if (typeof module.createArcRunner !== 'function') {
    throw new ArcError('runner_unconfigured', 'ARC runner module must export createArcRunner()');
  }
  const runner = await module.createArcRunner();
  assertRunner(runner);
  return runner;
}

async function main(): Promise<void> {
  const dataDir = requireEnvironment('METABOT_ARC_DATA_DIR');
  const runnerModule = requireEnvironment('METABOT_ARC_RUNNER_MODULE');
  const runner = await loadRunner(runnerModule);
  const store = new ArcRunStore(dataDir);
  const coordinator = new ArcCoordinator(store, new ArcArtifactStore(), runner, {
    recoverInterrupted: true,
  });
  const server = await connectArcStdioServer(coordinator);

  const close = async (): Promise<void> => {
    coordinator.dispose();
    await server.close();
    store.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`metabot-arc-mcp: ${message}\n`);
  process.exitCode = 1;
});
