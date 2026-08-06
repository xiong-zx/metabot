#!/usr/bin/env node
import { readCapabilityTokenFile } from './local-auth.js';
import { runLocalMcpStdioProxy } from './proxy.js';

const endpoint = process.env.METABOT_WORKER_PROXY_ENDPOINT?.trim() || requiredEnv('METABOT_WORKER_PROXY_URL');
const capability =
  process.env.METABOT_WORKER_PROXY_CAPABILITY?.trim() ||
  readCapabilityTokenFile(requiredEnv('METABOT_WORKER_PROXY_CAPABILITY_FILE'), 'Worker Runner proxy capability');
const close = await runLocalMcpStdioProxy({ endpoint, capability });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void close().finally(() => process.exit(0)));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
