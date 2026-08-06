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
});
