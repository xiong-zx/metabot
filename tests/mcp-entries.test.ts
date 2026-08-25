import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildExecutionMcpEntries } from '../src/engines/mcp-entries.js';

const runtimeRoot = '/opt/metabot';
const capabilityFiles = {
  worker: '/opt/metabot/data/mcp-capabilities/bot-chat-worker.token',
};
const capabilities = {
  METABOT_WORKER_CAPABILITY: 'worker-token',
  METABOT_CHAT_ID: 'oc-user',
};
const endpoints = {
  METABOT_WORKER_DAEMON_URL: 'http://127.0.0.1:9311/mcp',
};

describe('buildExecutionMcpEntries', () => {
  it('stays a pure data module with no IO, package, or Bridge imports', () => {
    const source = readFileSync(new URL('../src/engines/mcp-entries.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"];?$/gm)].map((match) => match[1]);
    expect(imports).toEqual(['node:path']);
    expect(source).not.toContain('@xvirobotics');
    expect(source).not.toContain('../bridge');
    expect(source).not.toContain('node:fs');
  });

  it('requires already-minted capability authority and absolute materialized files', () => {
    expect(buildExecutionMcpEntries({
      executionEnv: { METABOT_CHAT_ID: 'oc-user' },
      bridgeEnv: endpoints,
      runtimeRoot,
      capabilityFiles,
    })).toEqual([]);
    expect(buildExecutionMcpEntries({
      executionEnv: capabilities,
      bridgeEnv: endpoints,
      runtimeRoot,
      capabilityFiles: { worker: 'relative.token' },
    })).toEqual([]);
  });

  it.each(['team:project:lead', 'teaminst:project:agent'])(
    'denies Team chat %s even if capability variables are accidentally present',
    (chatId) => {
      expect(buildExecutionMcpEntries({
        executionEnv: { ...capabilities, METABOT_CHAT_ID: chatId },
        bridgeEnv: endpoints,
        runtimeRoot,
        capabilityFiles,
      })).toEqual([]);
    },
  );

  it('fails closed per purpose for missing, remote, authenticated, or HTTPS endpoints', () => {
    for (const endpoint of [
      undefined,
      'http://10.0.0.2:9311/mcp',
      'http://token@127.0.0.1:9311/mcp',
      'https://127.0.0.1:9311/mcp',
      'not-a-url',
    ]) {
      expect(buildExecutionMcpEntries({
        executionEnv: capabilities,
        bridgeEnv: {
          ...(endpoint ? { METABOT_WORKER_DAEMON_URL: endpoint } : {}),
        },
        runtimeRoot,
        capabilityFiles,
      })).toEqual([]);
    }
  });

  it('builds only the retained Worker Runner proxy entry', () => {
    expect(buildExecutionMcpEntries({
      executionEnv: capabilities,
      bridgeEnv: endpoints,
      runtimeRoot,
      capabilityFiles,
    })).toEqual([
      {
        name: 'metabot-worker',
        command: process.execPath,
        args: [path.join(runtimeRoot, 'packages/worker-runner-mcp/dist/proxy-cli.js')],
        env: {
          METABOT_WORKER_PROXY_URL: 'http://127.0.0.1:9311/mcp',
          METABOT_WORKER_PROXY_CAPABILITY_FILE: capabilityFiles.worker,
        },
        codexToolsApprovalMode: 'approve',
      },
    ]);
  });
});
