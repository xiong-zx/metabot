import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';
import {
  AgentTeamGovernanceExtension,
  createAgentTeamGovernanceHost,
} from '../src/agent-teams/governance-extension.js';
import { AgentTeamExecutionCapabilityService } from '../src/agent-teams/governance-capability.js';
import { handleAgentTeamGovernanceRoutes } from '../src/api/routes/agent-team-governance-routes.js';
import { handleAgentTeamRoutes } from '../src/api/routes/agent-team-routes.js';

const logger = { child: () => logger, info: () => {} } as any;

describe('Agent Team governed HTTP routes', () => {
  it('derives actors from signed request context, rejects body role spoofing, and enforces queue quota', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-governance-routes-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    const governance = new AgentTeamGovernanceExtension(
      createAgentTeamGovernanceHost(store),
      logger,
      join(dir, 'governance.db'),
    );
    const capabilities = new AgentTeamExecutionCapabilityService('route-test-key');
    const ctx = {
      agentTeamStore: store,
      agentTeamGovernance: governance,
      resolveAgentTeamPrincipal: (req: any) =>
        capabilities.resolve({
          capability: header(req, 'x-metabot-team-capability'),
          botName: header(req, 'x-metabot-bot-name'),
          chatId: header(req, 'x-metabot-chat-id'),
          localApiSecretAuthenticated: !header(req, 'x-metabot-bot-name'),
          now: 10_000,
        }),
    } as any;

    const published = await invoke(
      handleAgentTeamGovernanceRoutes,
      ctx,
      'POST',
      '/api/agent-team-governance/templates',
      {
        name: 'bounded',
        body: { agents: [{ name: 'lead', role: 'manager' }], quotas: { maxQueuedTasks: 1 } },
      },
    );
    expect(published.status).toBe(201);
    const legacy = await invoke(handleAgentTeamRoutes, ctx, 'POST', '/api/agent-teams', {
      name: 'legacy-compatible',
      description: 'upstream route',
    });
    expect(legacy).toMatchObject({ status: 201, body: { name: 'legacy-compatible', managedByConfig: false } });
    const legacyAgent = await invoke(handleAgentTeamRoutes, ctx, 'POST', '/api/agent-teams/legacy-compatible/agents', {
      name: 'worker',
      engine: 'codex',
    });
    expect(legacyAgent).toMatchObject({ status: 201, body: { name: 'worker', engine: 'codex' } });
    const created = await invoke(handleAgentTeamGovernanceRoutes, ctx, 'POST', '/api/agent-team-governance/instances', {
      templateName: 'bounded',
      chatId: 'oc_route',
    });
    expect(created.status).toBe(201);
    const instance = created.body as { id: string; teamName: string };

    const managerToken = capabilities.issue(
      {
        role: 'manager',
        botName: 'pm-codex',
        chatId: `teaminst:${instance.id}:lead`,
        teamName: instance.teamName,
        agentName: 'lead',
        ttlMs: 5_000,
      },
      10_000,
    );
    const managerHeaders = {
      'x-metabot-team-capability': managerToken,
      'x-metabot-bot-name': 'pm-codex',
      'x-metabot-chat-id': `teaminst:${instance.id}:lead`,
    };

    const spoof = await invoke(
      handleAgentTeamGovernanceRoutes,
      ctx,
      'POST',
      '/api/agent-team-governance/templates',
      {
        name: 'spoofed',
        body: {},
        actorRole: 'admin',
        role: 'admin',
      },
      managerHeaders,
    );
    expect(spoof).toMatchObject({ status: 403, body: { code: 'AUTHORITY_DENIED' } });

    const directAgentSpoof = await invoke(
      handleAgentTeamRoutes,
      ctx,
      'POST',
      `/api/agent-teams/${instance.teamName}/agents`,
      {
        name: 'rogue',
        role: 'admin',
        actorRole: 'admin',
      },
      managerHeaders,
    );
    expect(directAgentSpoof).toMatchObject({ status: 403, body: { error: expect.stringContaining('manager') } });

    const queued = await invoke(
      handleAgentTeamRoutes,
      ctx,
      'POST',
      `/api/agent-teams/${instance.teamName}/tasks`,
      {
        subject: 'one',
        owner: 'lead',
      },
      managerHeaders,
    );
    expect(queued.status).toBe(201);
    await expect(
      invoke(
        handleAgentTeamRoutes,
        ctx,
        'POST',
        `/api/agent-teams/${instance.teamName}/tasks`,
        {
          subject: 'two',
          owner: 'lead',
        },
        managerHeaders,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'TEAM_QUOTA_EXCEEDED' });
    expect(governance.listAudit({ instanceId: instance.id })[0]).toMatchObject({
      eventType: 'quota.denied',
      actorRole: 'manager',
      actorId: expect.stringContaining('pm-codex:teaminst:'),
    });

    const missing = await invoke(
      handleAgentTeamGovernanceRoutes,
      ctx,
      'GET',
      '/api/agent-team-governance/instances',
      undefined,
      {
        'x-metabot-bot-name': 'pm-codex',
        'x-metabot-chat-id': `teaminst:${instance.id}:lead`,
      },
    );
    expect(missing).toMatchObject({ status: 401, body: { code: 'EXECUTION_CAPABILITY_REQUIRED' } });

    const expiredToken = capabilities.issue(
      {
        role: 'pm',
        botName: 'pm-codex',
        chatId: 'normal-chat',
        ttlMs: 1,
      },
      9_000,
    );
    const expired = await invoke(
      handleAgentTeamGovernanceRoutes,
      ctx,
      'GET',
      '/api/agent-team-governance/instances',
      undefined,
      {
        'x-metabot-team-capability': expiredToken,
        'x-metabot-bot-name': 'pm-codex',
        'x-metabot-chat-id': 'normal-chat',
      },
    );
    expect(expired).toMatchObject({ status: 401, body: { code: 'EXECUTION_CAPABILITY_EXPIRED' } });

    governance.close();
    store.close();
  });
});

async function invoke(
  handler: (ctx: any, req: any, res: any, method: string, url: string) => Promise<boolean>,
  ctx: any,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  req.url = url;
  req.headers = { host: 'localhost', ...headers };
  let status = 0;
  let responseBody = '';
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
    },
    end(value?: string) {
      responseBody = value ?? '';
    },
  } as any;
  await handler(ctx, req, res, method, url);
  return { status, body: responseBody ? JSON.parse(responseBody) : undefined };
}

function header(req: any, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}
