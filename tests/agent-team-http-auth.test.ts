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

      const deniedTalk = await fetch(`${baseUrl}/api/talk`, {
        method: 'POST',
        headers: { ...validHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ botName: 'pm-codex', chatId: 'target-chat', prompt: 'work' }),
      });
      expect(deniedTalk.status).toBe(403);
      await expect(deniedTalk.json()).resolves.toMatchObject({ code: 'AGENT_BUS_TALK_ROLE_DENIED' });

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

  it('allows a signed user session to create and inspect an async target-chat card receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-bus-talk-auth-'));
    vi.stubEnv('SESSION_STORE_DIR', dir);
    vi.stubEnv('METABOT_RATE_LIMIT_DISABLED', '1');
    vi.stubEnv('API_HOST', 'localhost');
    vi.stubEnv('METABOT_AGENT_SELF_URL', 'http://10.0.0.5:19110');
    const capabilities = new AgentTeamExecutionCapabilityService('talk-capability-test-key');
    const registry = new BotRegistry();
    let executionEnvProvider: ((scope: { botName: string; chatId: string }) => Record<string, string>) | undefined;
    const executeApiTask = vi.fn(async (options: any) => {
      options.onAccepted?.({ cardMessageId: 'card-1', deliveryState: 'running' });
      options.onUpdate?.({ status: 'complete' }, 'card-1', true);
      return { success: true, responseText: 'done', durationMs: 10 };
    });
    registry.register({
      name: 'admin', platform: 'feishu',
      bridge: {
        executeApiTask, getPersistentRegistry: vi.fn(), setAgentTeamStore: vi.fn(),
        setExecutionEnvProvider: vi.fn((provider: typeof executionEnvProvider) => { executionEnvProvider = provider; }),
      },
      sender: {}, config: {},
    } as any);
    const server = startApiServer({
      port: 0, secret: 'bridge-admin-secret', registry,
      scheduler: {
        setWebSocketHandle: () => {}, taskCount: () => 0, recurringTaskCount: () => 0,
      } as any,
      logger, agentTeamCapabilityService: capabilities,
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const listenerHost = address.address.includes(':') ? `[${address.address}]` : address.address;
    const baseUrl = `http://${listenerHost}:${address.port}`;
    expect(executionEnvProvider?.({ botName: 'admin', chatId: 'source-chat' })).toMatchObject({
      METABOT_ENGINE_BRIDGE_URL: baseUrl,
      METABOT_BOT_NAME: 'admin',
      METABOT_CHAT_ID: 'source-chat',
    });
    const capability = capabilities.issue({
      role: 'user', botName: 'admin', chatId: 'source-chat', ttlMs: 60_000,
    });
    const headers = {
      'x-metabot-team-capability': capability,
      'x-metabot-bot-name': 'admin',
      'x-metabot-chat-id': 'source-chat',
      'content-type': 'application/json',
    };

    try {
      const elevatedTarget = await fetch(`${baseUrl}/api/talk`, {
        method: 'POST', headers,
        body: JSON.stringify({ botName: 'pm', chatId: 'target-chat', prompt: 'work' }),
      });
      expect(elevatedTarget.status).toBe(403);
      await expect(elevatedTarget.json()).resolves.toMatchObject({ code: 'AGENT_BUS_TALK_ROLE_DENIED' });

      const remoteTarget = await fetch(`${baseUrl}/api/talk`, {
        method: 'POST', headers,
        body: JSON.stringify({ botName: 'peer/admin', chatId: 'target-chat', prompt: 'work' }),
      });
      expect(remoteTarget.status).toBe(403);
      await expect(remoteTarget.json()).resolves.toMatchObject({ code: 'AGENT_BUS_REMOTE_TARGET_DENIED' });

      const declaredIdentity = await fetch(`${baseUrl}/api/talk`, {
        method: 'POST', headers,
        body: JSON.stringify({
          botName: 'admin', chatId: 'target-chat', prompt: 'work', roles: ['api-admin'],
        }),
      });
      expect(declaredIdentity.status).toBe(400);
      await expect(declaredIdentity.json()).resolves.toMatchObject({
        code: 'AGENT_BUS_TALK_DECLARATION_DENIED',
      });

      const accepted = await fetch(`${baseUrl}/api/talk`, {
        method: 'POST', headers,
        body: JSON.stringify({
          botName: 'admin', chatId: 'target-chat', prompt: 'implement fix', async: false, sendCards: false,
        }),
      });
      expect(accepted.status).toBe(202);
      const receipt = await accepted.json() as any;
      expect(receipt).toMatchObject({
        status: 'accepted', targetBot: 'admin', targetChatId: 'target-chat',
        cardMessageId: 'card-1', deliveryState: 'running',
      });
      expect(receipt.taskId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );

      await vi.waitFor(() => expect(executeApiTask).toHaveBeenCalledTimes(1));
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'target-chat', userId: 'admin:source-chat', sendCards: true,
        rulesPack: { principal: expect.objectContaining({
          kind: 'scoped', source: 'agent-bus', botName: 'admin', chatId: 'target-chat',
          roles: ['agent-bus', 'user'],
        }) },
      }));

      const status = await fetch(`${baseUrl}/api/talk/${receipt.taskId}`, { headers });
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({
        taskId: receipt.taskId, botName: 'admin', chatId: 'target-chat',
        sourceBot: 'admin', sourceChatId: 'source-chat',
        targetBot: 'admin', targetChatId: 'target-chat',
        cardMessageId: 'card-1', deliveryState: 'complete',
      });

      const otherCapability = capabilities.issue({
        role: 'user', botName: 'admin', chatId: 'other-source-chat', ttlMs: 60_000,
      });
      const wrongSource = await fetch(`${baseUrl}/api/talk/${receipt.taskId}`, {
        headers: {
          ...headers,
          'x-metabot-team-capability': otherCapability,
          'x-metabot-chat-id': 'other-source-chat',
        },
      });
      expect(wrongSource.status).toBe(404);

      const localAdministrator = await fetch(`${baseUrl}/api/talk/${receipt.taskId}`, {
        headers: { authorization: 'Bearer bridge-admin-secret' },
      });
      expect(localAdministrator.status).toBe(404);

      executeApiTask.mockImplementationOnce(async (options: any) => {
        options.onAccepted?.({ deliveryState: 'error' });
        options.onUpdate?.({ status: 'error' }, 'api-card-failure', true);
        return { success: false, responseText: '', error: 'Target card creation failed' };
      });
      const cardFailure = await fetch(`${baseUrl}/api/talk`, {
        method: 'POST', headers,
        body: JSON.stringify({
          botName: 'admin', chatId: 'card-failure-chat', prompt: 'work', async: true, sendCards: true,
        }),
      });
      expect(cardFailure.status).toBe(202);
      await expect(cardFailure.json()).resolves.toMatchObject({
        targetBot: 'admin', targetChatId: 'card-failure-chat', deliveryState: 'error',
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows user capabilities to manage only schedules in their signed bot and chat scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-schedule-capability-auth-'));
    vi.stubEnv('SESSION_STORE_DIR', dir);
    vi.stubEnv('METABOT_RATE_LIMIT_DISABLED', '1');
    const capabilities = new AgentTeamExecutionCapabilityService('schedule-capability-test-key');
    const registry = new BotRegistry();
    const bridge = {
      getPersistentRegistry: vi.fn(),
      setAgentTeamStore: vi.fn(),
      setExecutionEnvProvider: vi.fn(),
    };
    registry.register({ name: 'pm-codex', platform: 'feishu', bridge, sender: {}, config: {} } as any);
    const oneTimeTasks = [
      {
        id: 'own-task', botName: 'pm-codex', chatId: 'oc_schedule', prompt: 'own prompt',
        executeAt: Date.now() + 60_000, sendCards: true, status: 'pending', createdAt: Date.now(),
      },
      {
        id: 'other-task', botName: 'pm-codex', chatId: 'oc_other', prompt: 'other prompt',
        executeAt: Date.now() + 60_000, sendCards: true, status: 'pending', createdAt: Date.now(),
      },
    ];
    const recurringTasks = [
      {
        id: 'own-recurring', botName: 'pm-codex', chatId: 'oc_schedule', prompt: 'own recurring',
        cronExpr: '0 8 * * *', timezone: 'UTC', nextExecuteAt: Date.now() + 60_000,
        sendCards: true, status: 'active', createdAt: Date.now(),
      },
      {
        id: 'other-recurring', botName: 'other-bot', chatId: 'oc_schedule', prompt: 'other recurring',
        cronExpr: '0 8 * * *', timezone: 'UTC', nextExecuteAt: Date.now() + 60_000,
        sendCards: true, status: 'active', createdAt: Date.now(),
      },
    ];
    const scheduler = {
      setWebSocketHandle: () => {},
      taskCount: () => oneTimeTasks.length,
      recurringTaskCount: () => recurringTasks.length,
      listTasks: vi.fn(() => oneTimeTasks),
      listRecurringTasks: vi.fn(() => recurringTasks),
      scheduleTask: vi.fn((input: { botName: string; chatId: string; prompt: string; delaySeconds: number }) => ({
        id: 'created-task', ...input, executeAt: Date.now() + input.delaySeconds * 1_000,
        sendCards: true, status: 'pending', createdAt: Date.now(),
      })),
      cancelTask: vi.fn(() => true),
      cancelRecurring: vi.fn(() => false),
    } as any;
    const server = startApiServer({
      port: 0,
      secret: 'bridge-admin-secret',
      registry,
      scheduler,
      logger,
      agentTeamCapabilityService: capabilities,
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const markerHeaders = {
      authorization: 'Bearer execution-capability',
      'content-type': 'application/json',
      'x-metabot-bot-name': 'pm-codex',
      'x-metabot-chat-id': 'oc_schedule',
    };
    const capability = (role: 'user' | 'agent') => capabilities.issue({
      role,
      botName: 'pm-codex',
      chatId: 'oc_schedule',
      ttlMs: 60_000,
    });
    const userHeaders = { ...markerHeaders, 'x-metabot-team-capability': capability('user') };

    try {
      const listed = await fetch(`${baseUrl}/api/schedule`, { headers: userHeaders });
      expect(listed.status).toBe(200);
      await expect(listed.json()).resolves.toMatchObject({
        tasks: [{ id: 'own-task', botName: 'pm-codex', chatId: 'oc_schedule' }],
        recurringTasks: [{ id: 'own-recurring', botName: 'pm-codex', chatId: 'oc_schedule' }],
      });

      const deniedRole = await fetch(`${baseUrl}/api/schedule`, {
        headers: { ...markerHeaders, 'x-metabot-team-capability': capability('agent') },
      });
      expect(deniedRole.status).toBe(403);

      const deniedScope = await fetch(`${baseUrl}/api/schedule`, {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({
          botName: 'pm-codex', chatId: 'oc_other', prompt: 'must not be scheduled', delaySeconds: 60,
        }),
      });
      expect(deniedScope.status).toBe(403);
      expect(scheduler.scheduleTask).not.toHaveBeenCalled();

      const created = await fetch(`${baseUrl}/api/schedule`, {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({
          botName: 'pm-codex', chatId: 'oc_schedule', prompt: 'allowed task', delaySeconds: 60,
        }),
      });
      expect(created.status).toBe(201);
      expect(scheduler.scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
        botName: 'pm-codex',
        chatId: 'oc_schedule',
      }));

      const hiddenMutation = await fetch(`${baseUrl}/api/schedule/other-task`, {
        method: 'DELETE',
        headers: userHeaders,
      });
      expect(hiddenMutation.status).toBe(404);
      expect(scheduler.cancelTask).not.toHaveBeenCalled();

      const ownMutation = await fetch(`${baseUrl}/api/schedule/own-task`, {
        method: 'DELETE',
        headers: userHeaders,
      });
      expect(ownMutation.status).toBe(200);
      expect(scheduler.cancelTask).toHaveBeenCalledWith('own-task');

      const administratorList = await fetch(`${baseUrl}/api/schedule`, {
        headers: { authorization: 'Bearer bridge-admin-secret' },
      });
      expect(administratorList.status).toBe(200);
      const administratorBody = await administratorList.json() as { tasks: Array<{ id: string }> };
      expect(administratorBody.tasks.map((task) => task.id)).toEqual(['own-task', 'other-task']);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows only a user or PM capability to coordinate its own restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-capability-auth-'));
    vi.stubEnv('SESSION_STORE_DIR', dir);
    vi.stubEnv('METABOT_RATE_LIMIT_DISABLED', '1');
    const capabilities = new AgentTeamExecutionCapabilityService('restart-capability-test-key');
    const registry = new BotRegistry();
    const bridge = {
      beginRestartQuiesce: vi.fn(),
      cancelRestartQuiesce: vi.fn(),
      getRestartTaskSnapshots: vi.fn().mockReturnValue([]),
      getPersistentRegistry: vi.fn(),
      setAgentTeamStore: vi.fn(),
      setExecutionEnvProvider: vi.fn(),
    };
    const sender = { sendTextNotice: vi.fn().mockResolvedValue(undefined) };
    registry.register({ name: 'admin', platform: 'feishu', bridge, sender, config: {} } as any);
    const server = startApiServer({
      port: 0,
      secret: 'bridge-admin-secret',
      registry,
      scheduler: {
        setWebSocketHandle: () => {},
        taskCount: () => 0,
        recurringTaskCount: () => 0,
      } as any,
      logger,
      agentTeamCapabilityService: capabilities,
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const markerHeaders = {
      authorization: 'Bearer execution-capability',
      'content-type': 'application/json',
      'x-metabot-bot-name': 'admin',
      'x-metabot-chat-id': 'oc_restart',
    };
    const capability = (role: 'user' | 'agent') => capabilities.issue({
      role,
      botName: 'admin',
      chatId: 'oc_restart',
      ttlMs: 60_000,
    });

    try {
      const deniedRole = await fetch(`${baseUrl}/api/runtime/restart/prepare`, {
        method: 'POST',
        headers: { ...markerHeaders, 'x-metabot-team-capability': capability('agent') },
        body: JSON.stringify({
          requestId: 'restart-agent-denied',
          requesterBot: 'admin',
          requesterChat: 'oc_restart',
        }),
      });
      expect(deniedRole.status).toBe(403);

      const deniedScope = await fetch(`${baseUrl}/api/runtime/restart/prepare`, {
        method: 'POST',
        headers: { ...markerHeaders, 'x-metabot-team-capability': capability('user') },
        body: JSON.stringify({
          requestId: 'restart-scope-denied',
          requesterBot: 'admin',
          requesterChat: 'oc_other',
        }),
      });
      expect(deniedScope.status).toBe(403);

      const accepted = await fetch(`${baseUrl}/api/runtime/restart/prepare`, {
        method: 'POST',
        headers: { ...markerHeaders, 'x-metabot-team-capability': capability('user') },
        body: JSON.stringify({
          requestId: 'restart-capability-accepted',
          requesterBot: 'admin',
          requesterChat: 'oc_restart',
        }),
      });
      expect(accepted.status).toBe(200);
      expect(bridge.beginRestartQuiesce).toHaveBeenCalledWith('restart-capability-accepted');

      const cancelled = await fetch(`${baseUrl}/api/runtime/restart/cancel`, {
        method: 'POST',
        headers: { ...markerHeaders, 'x-metabot-team-capability': capability('user') },
        body: JSON.stringify({ requestId: 'restart-capability-accepted' }),
      });
      expect(cancelled.status).toBe(200);
      expect(bridge.cancelRestartQuiesce).toHaveBeenCalledWith('restart-capability-accepted');
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
