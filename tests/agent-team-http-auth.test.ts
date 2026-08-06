import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTeamExecutionCapabilityService } from '../src/agent-teams/governance-capability.js';
import {
  AgentTeamGovernanceExtension,
  createAgentTeamGovernanceHost,
} from '../src/agent-teams/governance-extension.js';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';
import { BotRegistry } from '../src/api/bot-registry.js';
import { startApiServer } from '../src/api/http-server.js';

const logger = {
  child: () => logger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

afterEach(() => vi.unstubAllEnvs());

describe('Agent Team HTTP capability gate', () => {
  it('accepts a signed engine capability without the local secret and cannot bypass invalid credentials with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-http-auth-'));
    vi.stubEnv('SESSION_STORE_DIR', dir);
    vi.stubEnv('METABOT_RATE_LIMIT_DISABLED', '1');
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.createTeam('governed-scope');
    const governance = new AgentTeamGovernanceExtension(
      createAgentTeamGovernanceHost(store),
      logger,
      join(dir, 'governance.db'),
    );
    const capabilities = new AgentTeamExecutionCapabilityService('http-auth-test-key');
    const server = startApiServer({
      port: 0,
      secret: 'bridge-admin-secret',
      registry: new BotRegistry(),
      scheduler: {
        setWebSocketHandle: () => {},
        taskCount: () => 0,
        recurringTaskCount: () => 0,
      } as any,
      logger,
      agentTeamStore: store,
      agentTeamGovernance: governance,
      agentTeamCapabilityService: capabilities,
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const url = `http://127.0.0.1:${address.port}/api/agent-teams/governed-scope`;
    const markerHeaders = {
      'x-metabot-bot-name': 'pm-codex',
      'x-metabot-chat-id': 'teaminst:one:lead',
    };
    const capability = capabilities.issue({
      role: 'manager',
      botName: 'pm-codex',
      chatId: 'teaminst:one:lead',
      teamName: 'governed-scope',
      agentName: 'lead',
      ttlMs: 60_000,
    });

    try {
      const accepted = await fetch(url, {
        headers: { ...markerHeaders, 'x-metabot-team-capability': capability },
      });
      expect(accepted.status).toBe(200);

      const missing = await fetch(url, {
        headers: { ...markerHeaders, authorization: 'Bearer bridge-admin-secret' },
      });
      expect(missing.status).toBe(401);
      await expect(missing.json()).resolves.toMatchObject({ code: 'EXECUTION_CAPABILITY_REQUIRED' });

      const invalid = await fetch(url, {
        headers: {
          ...markerHeaders,
          authorization: 'Bearer bridge-admin-secret',
          'x-metabot-team-capability': `${capability}tampered`,
        },
      });
      expect(invalid.status).toBe(401);
      await expect(invalid.json()).resolves.toMatchObject({ code: 'INVALID_EXECUTION_CAPABILITY' });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      governance.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows only the exact scoped Bridge read allowlist and fails closed for invalid or broader access', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-http-read-auth-'));
    vi.stubEnv('SESSION_STORE_DIR', dir);
    vi.stubEnv('METABOT_RATE_LIMIT_DISABLED', '1');
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    const governance = new AgentTeamGovernanceExtension(
      createAgentTeamGovernanceHost(store),
      logger,
      join(dir, 'governance.db'),
    );
    const capabilities = new AgentTeamExecutionCapabilityService('http-read-auth-test-key');
    const server = startApiServer({
      port: 0,
      secret: 'bridge-admin-secret',
      registry: new BotRegistry(),
      scheduler: {
        setWebSocketHandle: () => {},
        taskCount: () => 0,
        recurringTaskCount: () => 0,
      } as any,
      logger,
      agentTeamStore: store,
      agentTeamGovernance: governance,
      agentTeamCapabilityService: capabilities,
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const markerHeaders = {
      'x-metabot-bot-name': 'pm-codex',
      'x-metabot-chat-id': 'teaminst:one:reader',
    };
    const issue = (overrides: { botName?: string; chatId?: string; ttlMs?: number } = {}, now?: number) =>
      capabilities.issue({
        role: 'agent',
        botName: overrides.botName ?? 'pm-codex',
        chatId: overrides.chatId ?? 'teaminst:one:reader',
        teamName: 'governed-scope',
        agentName: 'reader',
        ttlMs: overrides.ttlMs ?? 60_000,
      }, now);
    const capability = issue();
    const validHeaders = { ...markerHeaders, 'x-metabot-team-capability': capability };

    try {
      for (const path of ['/api/bots', '/api/peers', '/api/stats', '/api/metrics']) {
        const response = await fetch(`${baseUrl}${path}`, { headers: validHeaders });
        expect(response.status, path).toBe(200);
      }

      const rejectedCredentials = [
        {
          path: '/api/bots',
          headers: { ...markerHeaders, 'x-metabot-team-capability': `${capability}tampered` },
          code: 'INVALID_EXECUTION_CAPABILITY',
        },
        {
          path: '/api/peers',
          headers: {
            ...markerHeaders,
            'x-metabot-team-capability': issue({ ttlMs: 1 }, Date.now() - 1_000),
          },
          code: 'EXECUTION_CAPABILITY_EXPIRED',
        },
        {
          path: '/api/stats',
          headers: { ...markerHeaders, 'x-metabot-team-capability': issue({ botName: 'different-bot' }) },
          code: 'CAPABILITY_SCOPE_MISMATCH',
        },
        {
          path: '/api/metrics',
          headers: markerHeaders,
          code: 'EXECUTION_CAPABILITY_REQUIRED',
        },
      ];
      for (const testCase of rejectedCredentials) {
        const response = await fetch(`${baseUrl}${testCase.path}`, {
          headers: { ...testCase.headers, authorization: 'Bearer bridge-admin-secret' },
        });
        expect(response.status, testCase.path).toBe(401);
        await expect(response.json()).resolves.toMatchObject({ code: testCase.code });
      }

      const forbiddenRoutes: Array<[string, string]> = [
        ['GET', '/api/bots/pm-codex'],
        ['GET', '/api/bots/pm-codex/profile'],
        ['GET', '/api/status'],
        ['GET', '/api/schedule'],
        ['POST', '/api/talk'],
        ['POST', '/api/tasks'],
        ['POST', '/api/peers'],
        ['POST', '/api/bots'],
        ['POST', '/api/restart'],
        ['POST', '/api/update'],
        ['POST', '/api/workers/dispatch'],
      ];
      for (const [method, path] of forbiddenRoutes) {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { ...validHeaders, authorization: 'Bearer bridge-admin-secret' },
        });
        expect(response.status, `${method} ${path}`).toBe(401);
      }

      const promotion = await fetch(`${baseUrl}/api/agent-team-governance/templates`, {
        method: 'POST',
        headers: { ...validHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'denied', body: { agents: [] } }),
      });
      expect(promotion.status).toBe(403);
      await expect(promotion.json()).resolves.toMatchObject({ code: 'AUTHORITY_DENIED' });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      governance.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
