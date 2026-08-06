import { lstatSync, readFileSync } from 'node:fs';

import type { ArcRunner } from '@xvirobotics/arc-mcp';

import { ArcWorkerRunnerAdapter } from './adapter.js';
import { connectWorkerMcp, type ConnectedWorkerClient } from './client.js';

let connection: ConnectedWorkerClient | undefined;

export async function createArcRunner(): Promise<ArcRunner> {
  const env = process.env;
  connection ??= await connectWorkerMcp({
    endpoint: required(env, 'METABOT_ARC_WORKER_ENDPOINT'),
    capability: readCapability(required(env, 'METABOT_ARC_WORKER_CAPABILITY_FILE')),
  });
  return new ArcWorkerRunnerAdapter({
    client: connection.wire,
    engine: engine(env.METABOT_ARC_WORKER_ENGINE),
    ...(env.METABOT_ARC_WORKER_MODEL?.trim() ? { model: env.METABOT_ARC_WORKER_MODEL.trim() } : {}),
    timeoutMs: integer(env, 'METABOT_ARC_WORKER_TIMEOUT_MS', 4 * 60 * 60 * 1_000),
    idleTimeoutMs: integer(env, 'METABOT_ARC_WORKER_IDLE_TIMEOUT_MS', 30 * 60 * 1_000),
    pollIntervalMs: integer(env, 'METABOT_ARC_WORKER_POLL_MS', 5_000),
  });
}

export async function closeArcRunnerConnection(): Promise<void> {
  const current = connection;
  connection = undefined;
  await current?.close();
}

function readCapability(filePath: string): string {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ARC Worker capability must be a regular non-symlink file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('ARC Worker capability file must not grant group or other access');
  }
  const value = readFileSync(filePath, 'utf8').trim();
  if (value.length < 20 || value.length > 4_096 || value.includes('\0')) {
    throw new Error('ARC Worker capability is invalid');
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function engine(value: string | undefined): 'codex' | 'claude' | 'kimi' {
  const selected = value?.trim() || 'codex';
  if (!['codex', 'claude', 'kimi'].includes(selected)) throw new Error('METABOT_ARC_WORKER_ENGINE is invalid');
  return selected as 'codex' | 'claude' | 'kimi';
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
