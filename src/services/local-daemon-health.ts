import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

import { ExecutionCapabilityService, resolveExecutionKeysDir } from './execution-capabilities.js';

export type LocalExecutionDaemon = 'worker';

export interface LocalDaemonProbeResult {
  daemon: LocalExecutionDaemon;
  ok: true;
  busy: boolean;
  activeCount: number;
  saturated: boolean;
}

const WORKER_ACTIVE = new Set(['queued', 'running']);
const DEFAULT_WORKER_ENDPOINT = 'http://127.0.0.1:9311/mcp';

/** Probe Worker Runner's authenticated MCP wire without importing its package. */
export async function probeLocalDaemon(
  daemon: LocalExecutionDaemon,
  options: { env?: NodeJS.ProcessEnv; busy?: boolean } = {},
): Promise<LocalDaemonProbeResult> {
  const env = runtimeEnvironment(options.env ?? process.env);
  const capability = new ExecutionCapabilityService(resolveExecutionKeysDir(env)).issueLocalLifecycleAdmin('worker');
  const endpoint = env.METABOT_WORKER_DAEMON_URL?.trim()
    || env.METABOT_WORKER_LISTEN?.trim()
    || DEFAULT_WORKER_ENDPOINT;
  const transport = new StreamableHTTPClientTransport(requireLoopbackEndpoint(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${capability}` } },
  });
  const client = new Client({ name: 'metabot-local-worker-health', version: '1.0.0' });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: 'worker_list',
      arguments: { limit: options.busy ? 100 : 1, all_scopes: true },
    });
    const workers = records(response.structuredContent);
    const activeCount = workers.filter((record) => WORKER_ACTIVE.has(record.status)).length;
    const saturated = options.busy === true && workers.length === 100;
    return { daemon, ok: true, busy: activeCount > 0 || saturated, activeCount, saturated };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function records(value: unknown): Array<Record<string, unknown> & { status: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Worker response is malformed');
  const rows = (value as Record<string, unknown>).workers;
  if (!Array.isArray(rows)) throw new Error('Worker response is malformed');
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof (row as Record<string, unknown>).status !== 'string') {
      throw new Error('Worker record is malformed');
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { ...fileEnv, ...processEnv };
}

function requireLoopbackEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Worker health endpoint must use loopback HTTP');
  }
  if (!endpoint.port || !endpoint.pathname || endpoint.pathname === '/') {
    throw new Error('Worker health endpoint must include a port and dedicated path');
  }
  return endpoint;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const busy = args[0] === '--busy';
  const daemon = args[busy ? 1 : 0];
  if (daemon !== 'worker' || args.length !== (busy ? 2 : 1)) {
    throw new Error('Usage: local-daemon-health.ts [--busy] worker');
  }
  const result = await probeLocalDaemon('worker', { busy });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (busy && result.busy) process.exitCode = 10;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main().catch((error) => {
    process.stderr.write(`local-daemon-health: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
