#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ArcArtifactStore } from './artifact-store.js';
import { ArcCoordinator } from './coordinator.js';
import { ArcError } from './errors.js';
import type { ArcRunner } from './runner.js';
import { ArcRunStore } from './run-store.js';
import { ArcProjectScope } from './scope-policy.js';
import { connectArcStdioServer } from './server.js';

type RunnerModule = {
  createArcRunner?: () => ArcRunner | Promise<ArcRunner>;
};

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ArcError('runner_unconfigured', `${name} is required`);
  return value;
}

function configuredProjectRoots(): string[] {
  const raw = process.env.METABOT_ARC_PROJECT_ROOTS?.trim();
  if (!raw) {
    throw new ArcError(
      'scope_not_configured',
      'METABOT_ARC_PROJECT_ROOTS must be a JSON array of trusted project roots',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ArcError('scope_not_configured', 'METABOT_ARC_PROJECT_ROOTS is not valid JSON', {
      cause: error,
    });
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ArcError('scope_not_configured', 'METABOT_ARC_PROJECT_ROOTS must contain only paths');
  }
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
  const artifacts = new ArcArtifactStore();
  const scope = new ArcProjectScope(artifacts, {
    allowedProjectRoots: configuredProjectRoots(),
    ...(process.env.METABOT_ARC_PROJECT_ID?.trim()
      ? { fixedProjectId: process.env.METABOT_ARC_PROJECT_ID.trim() }
      : {}),
  });
  const store = new ArcRunStore(dataDir);
  let runner: ArcRunner;
  try {
    runner = await loadRunner(runnerModule);
  } catch (error) {
    store.close();
    throw error;
  }
  const coordinator = new ArcCoordinator(store, artifacts, runner, { scope });
  for (const stale of store.lock.staleLocks) {
    process.stderr.write(
      `metabot-arc-mcp: reclaimed stale data lock from pid ${stale.owner.pid}; diagnostic ${stale.archivePath}\n`,
    );
  }
  let server;
  try {
    server = await connectArcStdioServer(coordinator);
  } catch (error) {
    coordinator.dispose();
    store.close();
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
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
