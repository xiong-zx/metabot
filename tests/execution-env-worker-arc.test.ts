import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { webBotFromJson } from '../src/config.js';
import { ExecutionCapabilityService, provisionExecutionKeyPairs } from '../src/services/execution-capabilities.js';
import { mintOptedInExecutionCapabilities, type DerivedExecutionPrincipal } from '../src/services/execution-principal.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function service(): ExecutionCapabilityService {
  const root = mkdtempSync(path.join(tmpdir(), 'metabot-worker-capability-'));
  roots.push(root);
  provisionExecutionKeyPairs(root);
  return new ExecutionCapabilityService(root);
}

const principal: DerivedExecutionPrincipal = { role: 'pm', botName: 'pm', chatId: 'oc-user' };

describe('Worker execution environment', () => {
  it('mints only the explicitly enabled Worker capability', () => {
    const env = mintOptedInExecutionCapabilities({ service: service(), principal, config: { workerTools: true } });
    expect(Object.keys(env)).toEqual(['METABOT_WORKER_CAPABILITY']);
  });

  it('mints nothing for disabled or Team principals', () => {
    const issuer = service();
    expect(mintOptedInExecutionCapabilities({ service: issuer, principal, config: {} })).toEqual({});
    expect(mintOptedInExecutionCapabilities({
      service: issuer,
      principal: { role: 'agent', botName: 'pm', chatId: 'team:project:agent' },
      config: { workerTools: true },
    })).toEqual({});
  });

  it('normalizes only the Worker opt-in; products use external MCP descriptors', () => {
    const bot = webBotFromJson({ name: 'worker', defaultWorkingDirectory: '/tmp', workerTools: true });
    expect(bot.workerTools).toBe(true);
    expect(bot.mcpServers).toBeUndefined();
  });
});
