import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentTeamGovernanceExtension, createAgentTeamGovernanceHost } from '../src/agent-teams/governance-extension.js';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';
import { webBotFromJson } from '../src/config.js';
import { stripBridgeLocalAdminCredentials } from '../src/engines/execution-env.js';
import {
  ExecutionCapabilityService,
  provisionExecutionKeyPairs,
} from '../src/services/execution-capabilities.js';
import {
  deriveExecutionPrincipal,
  mintOptedInExecutionCapabilities,
} from '../src/services/execution-principal.js';

const logger = {
  child: () => logger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'metabot-execution-env-'));
  chmodSync(dir, 0o700);
  const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
  const governance = new AgentTeamGovernanceExtension(
    createAgentTeamGovernanceHost(store),
    logger,
    join(dir, 'governance.db'),
  );
  store.createTeam('legacy');
  store.createAgent('legacy', { name: 'lead', role: 'manager' });
  store.createAgent('legacy', { name: 'coder', role: 'implementation' });
  const keysDir = join(dir, 'keys');
  provisionExecutionKeyPairs(keysDir);
  const service = new ExecutionCapabilityService(keysDir);
  cleanups.push(() => {
    governance.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, governance, service };
}

describe('worker/ARC execution environment', () => {
  it('uses one trusted principal derivation and denies all Team chats', () => {
    const { store, governance, service } = fixture();
    const principals = [
      deriveExecutionPrincipal(governance, store, 'pm-codex', 'team:legacy:lead'),
      deriveExecutionPrincipal(governance, store, 'pm-codex', 'team:legacy:coder'),
      deriveExecutionPrincipal(governance, store, 'pm-codex', 'teaminst:missing:lead'),
      deriveExecutionPrincipal(governance, store, 'pm-codex', 'teaminst:missing:coder'),
    ];
    expect(principals.map((principal) => principal.role)).toEqual(['manager', 'agent', 'manager', 'agent']);
    for (const principal of principals) {
      expect(mintOptedInExecutionCapabilities({
        service,
        principal,
        config: { workerTools: true, arcTools: true },
      })).toEqual({});
    }
  });

  it('mints only explicitly opted-in purposes for derived pm/user sessions', () => {
    const { store, governance, service } = fixture();
    const pm = deriveExecutionPrincipal(governance, store, 'pm-codex', 'chat-pm');
    const user = deriveExecutionPrincipal(governance, store, 'research', 'chat-user');
    expect(pm.role).toBe('pm');
    expect(user.role).toBe('user');

    const pmEnv = mintOptedInExecutionCapabilities({
      service,
      principal: pm,
      config: { workerTools: true, arcTools: true },
      now: 10_000,
    });
    expect(Object.keys(pmEnv).sort()).toEqual(['METABOT_ARC_CAPABILITY', 'METABOT_WORKER_CAPABILITY']);
    expect(service.verify(pmEnv.METABOT_WORKER_CAPABILITY, {
      purpose: 'worker', botName: 'pm-codex', chatId: 'chat-pm', now: 10_001,
    })).toMatchObject({ role: 'pm' });
    expect(service.verify(pmEnv.METABOT_ARC_CAPABILITY, {
      purpose: 'arc', botName: 'pm-codex', chatId: 'chat-pm', now: 10_001,
    })).toMatchObject({ role: 'pm' });

    expect(mintOptedInExecutionCapabilities({
      service,
      principal: user,
      config: { workerTools: true, arcTools: false },
    })).toHaveProperty('METABOT_WORKER_CAPABILITY');
    expect(mintOptedInExecutionCapabilities({
      service,
      principal: user,
      config: {},
    })).toEqual({});
  });

  it('re-mints fresh values for later persistent-executor turns and preserves admin stripping', () => {
    const { store, governance, service } = fixture();
    const principal = deriveExecutionPrincipal(governance, store, 'pm-codex', 'chat-pm');
    const first = mintOptedInExecutionCapabilities({
      service, principal, config: { workerTools: true, arcTools: true }, ttlMs: 60_000, now: 1_000,
    });
    const later = mintOptedInExecutionCapabilities({
      service, principal, config: { workerTools: true, arcTools: true }, ttlMs: 60_000, now: 2_000,
    });
    expect(later.METABOT_WORKER_CAPABILITY).not.toBe(first.METABOT_WORKER_CAPABILITY);
    expect(later.METABOT_ARC_CAPABILITY).not.toBe(first.METABOT_ARC_CAPABILITY);

    const stripped = stripBridgeLocalAdminCredentials({
      ...later,
      API_SECRET: 'admin-one',
      METABOT_API_SECRET: 'admin-two',
      METABOT_AUTH: 'admin-three',
    });
    expect(stripped).toMatchObject(later);
    expect(stripped).not.toHaveProperty('API_SECRET');
    expect(stripped).not.toHaveProperty('METABOT_API_SECRET');
    expect(stripped).not.toHaveProperty('METABOT_AUTH');
  });

  it('parses workerTools/arcTools as explicit per-bot security opt-ins', () => {
    const enabled = webBotFromJson({
      name: 'enabled',
      defaultWorkingDirectory: '/tmp',
      workerTools: true,
      arcTools: false,
    });
    const defaultOff = webBotFromJson({ name: 'default-off', defaultWorkingDirectory: '/tmp' });
    expect(enabled).toMatchObject({ workerTools: true, arcTools: false });
    expect(defaultOff.workerTools).toBeUndefined();
    expect(defaultOff.arcTools).toBeUndefined();
  });
});
