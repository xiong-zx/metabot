#!/usr/bin/env node
import { readArcCapabilityFile } from './local-auth.js';
import { runArcStdioProxy } from './proxy.js';

const endpoint = process.env.METABOT_ARC_PROXY_ENDPOINT?.trim() || requiredEnv('METABOT_ARC_PROXY_URL');
const capability =
  process.env.METABOT_ARC_PROXY_CAPABILITY?.trim() ||
  readArcCapabilityFile(requiredEnv('METABOT_ARC_PROXY_CAPABILITY_FILE'));
const close = await runArcStdioProxy({ endpoint, capability });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void close().finally(() => process.exit(0)));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
