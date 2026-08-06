import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

import { ExecutionCapabilityService, resolveExecutionKeysDir } from './execution-capabilities.js';

export type LocalExecutionDaemon = 'worker' | 'arc';

export interface LocalDaemonProbeResult {
  daemon: LocalExecutionDaemon;
  ok: true;
  busy: boolean;
  activeCount: number;
  saturated: boolean;
}

const WORKER_ACTIVE = new Set(['queued', 'running']);
const ARC_ACTIVE = ['queued', 'running', 'paused'] as const;
const DEFAULT_WORKER_ENDPOINT = 'http://127.0.0.1:9311/mcp';
const DEFAULT_ARC_ENDPOINT = 'http://127.0.0.1:9312/mcp';

/**
 * Probe the authenticated daemon MCP wire. This module deliberately imports
 * neither execution package nor their stores; lifecycle state is tool data.
 */
export async function probeLocalDaemon(
  daemon: LocalExecutionDaemon,
  options: { env?: NodeJS.ProcessEnv; busy?: boolean } = {},
): Promise<LocalDaemonProbeResult> {
  const env = runtimeEnvironment(options.env ?? process.env);
  const capabilityService = new ExecutionCapabilityService(resolveExecutionKeysDir(env));
  const capability = capabilityService.issueLocalLifecycleAdmin(daemon === 'worker' ? 'worker' : 'arc');
  const endpoint = daemon === 'worker'
    ? env.METABOT_WORKER_DAEMON_URL?.trim() || env.METABOT_WORKER_LISTEN?.trim() || DEFAULT_WORKER_ENDPOINT
    : env.METABOT_ARC_DAEMON_URL?.trim() || env.METABOT_ARC_LISTEN?.trim() || DEFAULT_ARC_ENDPOINT;
  const url = requireLoopbackEndpoint(endpoint);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${capability}` } },
  });
  const client = new Client({ name: 'metabot-local-daemon-health', version: '1.0.0' });
  try {
    await client.connect(transport);
    if (daemon === 'worker') {
      const response = await client.callTool({
        name: 'worker_list',
        arguments: { limit: options.busy ? 100 : 1, all_scopes: true },
      });
      const workers = records(response.structuredContent, 'workers');
      const activeCount = workers.filter((record) => WORKER_ACTIVE.has(record.status)).length;
      const saturated = options.busy === true && workers.length === 100;
      return { daemon, ok: true, busy: activeCount > 0 || saturated, activeCount, saturated };
    }

    if (!options.busy) {
      await client.callTool({ name: 'arc_run_list', arguments: { limit: 1 } });
      return { daemon, ok: true, busy: false, activeCount: 0, saturated: false };
    }
    let activeCount = 0;
    for (const status of ARC_ACTIVE) {
      const response = await client.callTool({
        name: 'arc_run_list',
        arguments: { status, limit: 1 },
      });
      activeCount += records(response.structuredContent, 'runs').length;
    }
    return { daemon, ok: true, busy: activeCount > 0, activeCount, saturated: false };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Write the dedicated ARC-to-Worker service capability as private host state. */
export function provisionArcServiceCapability(envInput: NodeJS.ProcessEnv = process.env): string {
  const env = runtimeEnvironment(envInput);
  const stateRoot = env.METABOT_STATE_DIR?.trim() || join(homedir(), '.metabot');
  for (const directory of [
    stateRoot,
    env.METABOT_WORKER_DATA_DIR?.trim() || join(stateRoot, 'worker-runner'),
    env.METABOT_ARC_DATA_DIR?.trim() || join(stateRoot, 'arc'),
    join(stateRoot, 'arc-projects'),
  ]) {
    ensurePrivateDirectory(directory);
  }
  const keysDir = resolveExecutionKeysDir(env);
  const service = new ExecutionCapabilityService(keysDir);
  const token = service.issue({
    purpose: 'worker',
    role: 'pm',
    botName: 'arc-service',
    chatId: 'local:arc-service',
    // This is a machine service credential, not an engine-session token. Key
    // rotation revokes it; avoiding wall-clock expiry keeps long ARC runs live.
    ttlMs: 100 * 366 * 24 * 60 * 60 * 1000,
  });
  const destination = resolve(
    env.METABOT_ARC_WORKER_CAPABILITY_FILE?.trim() || join(keysDir, 'arc-service.cap'),
  );
  assertReplaceablePrivateFile(destination);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${token}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
}

function records(value: unknown, field: string): Array<Record<string, unknown> & { status: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Daemon ${field} response is malformed`);
  }
  const rows = (value as Record<string, unknown>)[field];
  if (!Array.isArray(rows)) throw new Error(`Daemon ${field} response is malformed`);
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof (row as Record<string, unknown>).status !== 'string') {
      throw new Error(`Daemon ${field} record is malformed`);
    }
    return row as Record<string, unknown> & { status: string };
  });
}

function runtimeEnvironment(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = processEnv.METABOT_HOME?.trim();
  if (!home) return { ...processEnv };
  let fileEnv: NodeJS.ProcessEnv = {};
  try {
    fileEnv = parse(readFileSync(join(home, '.env')));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
  return { ...fileEnv, ...processEnv };
}

function requireLoopbackEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Daemon health endpoint must use loopback HTTP');
  }
  if (!endpoint.port || !endpoint.pathname || endpoint.pathname === '/') {
    throw new Error('Daemon health endpoint must include a port and dedicated path');
  }
  return endpoint;
}

function assertReplaceablePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('ARC service capability path is unsafe');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('ARC service capability file must not grant group or other access');
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe daemon state directory: ${path}`);
  chmodSync(path, 0o700);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--provision-arc-service' && args.length === 1) {
    process.stdout.write(`${JSON.stringify({ ok: true, capabilityFile: provisionArcServiceCapability() })}\n`);
    return;
  }
  const busy = args[0] === '--busy';
  const daemonValue = args[busy ? 1 : 0];
  if ((daemonValue !== 'worker' && daemonValue !== 'arc') || args.length !== (busy ? 2 : 1)) {
    throw new Error('Usage: local-daemon-health.ts [--busy] <worker|arc> | --provision-arc-service');
  }
  const result = await probeLocalDaemon(daemonValue, { busy });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (busy && result.busy) process.exitCode = 10;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    process.stderr.write(`local-daemon-health: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
