import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';
import { handleAgentTeamRoutes } from '../src/api/routes/agent-team-routes.js';
import { recordCardLifecycle } from '../src/bridge/card-lifecycle-store.js';
import type { RouteContext } from '../src/api/routes/types.js';

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

function makeReq(url: string, body?: unknown): any {
  const req = new EventEmitter() as any;
  req.url = url;
  req.headers = { host: 'localhost' };
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function ctx(agentTeamStore: AgentTeamStore): RouteContext {
  return {
    registry: {} as any,
    scheduler: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    asyncTaskStore: {} as any,
    intentRouter: {} as any,
    circuitBreaker: {} as any,
    budgetManager: {} as any,
    teamManager: {} as any,
    meetingService: {} as any,
    voiceIdentityStore: {} as any,
    ws: {},
    agentTeamStore,
  };
}

async function call(store: AgentTeamStore, method: string, url: string, body?: unknown): Promise<any> {
  const res = makeRes();
  const handled = await handleAgentTeamRoutes(ctx(store), makeReq(url, body), res, method, url);
  expect(handled).toBe(true);
  return res;
}

describe('handleAgentTeamRoutes', () => {
  it('parses numeric template export/diff query params from strings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-routes-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const v1 = store.upsertTemplateFromConfig({
      name: 'research',
      agents: [{ name: 'planner', prompt: 'Plan v1' }],
    }, 'test');
    const v2 = store.upsertTemplateFromConfig({
      name: 'research',
      agents: [{ name: 'planner', prompt: 'Plan v2' }],
    }, 'test');

    const exportRes = await call(store, 'GET', '/api/agent-teams/templates/research/export?version=1');
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.json()).toMatchObject({
      name: 'research',
      version: v1.version,
      body: { agents: [{ name: 'planner', prompt: 'Plan v1' }] },
    });

    const diffRes = await call(store, 'GET', `/api/agent-teams/templates/research/diff?from=${v1.version}&to=${v2.version}`);
    expect(diffRes.statusCode).toBe(200);
    expect(diffRes.json()).toMatchObject({
      name: 'research',
      changed: true,
      summary: { changedAgents: ['planner'] },
    });
    store.close();
  });

  it('accepts instance ids on team routes and isolates instance tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-routes-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.upsertTemplateFromConfig({
      name: 'research',
      agents: [{ name: 'planner', engine: 'codex' }],
    }, 'test');

    const projectA = store.resolveTeamInstance({ templateName: 'research', chatId: 'oc_project_a' })!;
    const projectB = store.resolveTeamInstance({ templateName: 'research', chatId: 'oc_project_b' })!;
    const idA = encodeURIComponent(projectA.instanceId!);
    const idB = encodeURIComponent(projectB.instanceId!);

    const createRes = await call(store, 'POST', `/api/agent-teams/${idA}/tasks`, {
      subject: 'Project A task',
      owner: 'planner',
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json()).toMatchObject({
      teamName: projectA.name,
      instanceId: projectA.instanceId,
      subject: 'Project A task',
    });

    const statusRes = await call(store, 'GET', `/api/agent-teams/${idA}`);
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toMatchObject({
      team: { name: projectA.name, instanceId: projectA.instanceId },
      tasks: [{ subject: 'Project A task' }],
    });

    const projectBTasks = await call(store, 'GET', `/api/agent-teams/${idB}/tasks`);
    expect(projectBTasks.statusCode).toBe(200);
    expect(projectBTasks.json()).toEqual({ tasks: [] });
    store.close();
  });

  it('accepts worker RuleSet scope through the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-routes-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const res = await call(store, 'POST', '/api/agent-teams/rules', {
      name: 'worker',
      scope: 'worker',
      rules: [{ text: 'Workers return structured output.' }],
      actorRole: 'pm',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'worker',
      scope: 'worker',
      rules: [{ text: 'Workers return structured output.' }],
    });
    store.close();
  });

  it('exports and diffs versioned RuleSets through the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-routes-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const v1 = store.upsertRuleSet({
      name: 'project-alpha',
      scope: 'project',
      rules: [{ text: 'Use dataset alpha.' }],
      source: 'test',
    });
    const v2 = store.upsertRuleSet({
      name: 'project-alpha',
      scope: 'project',
      rules: [{ text: 'Use dataset alpha v2.' }],
      source: 'test',
    });

    const exportRes = await call(store, 'GET', '/api/agent-teams/rules/project-alpha/export?version=1');
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.json()).toMatchObject({
      name: 'project-alpha',
      version: v1.version,
      scope: 'project',
      rules: [{ text: 'Use dataset alpha.' }],
    });

    const diffRes = await call(store, 'GET', `/api/agent-teams/rules/project-alpha/diff?from=${v1.version}&to=${v2.version}`);
    expect(diffRes.statusCode).toBe(200);
    expect(diffRes.json()).toMatchObject({
      name: 'project-alpha',
      changed: true,
      summary: { addedRules: ['1:Use dataset alpha v2.'], removedRules: ['1:Use dataset alpha.'] },
    });
    store.close();
  });

  it('pins ruleSetRefs on instance resolve and supports team config updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-routes-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.upsertRuleSet({
      name: 'project-alpha',
      scope: 'project',
      rules: [{ text: 'Use dataset alpha.' }],
      source: 'test',
    });
    store.upsertTemplateFromConfig({
      name: 'research',
      agents: [{ name: 'planner', engine: 'codex' }],
    }, 'test');

    const resolveRes = await call(store, 'POST', '/api/agent-teams/instances/resolve', {
      templateName: 'research',
      chatId: 'oc_project_a',
      ruleSetRefs: ['project-alpha'],
      actorRole: 'pm',
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json()).toMatchObject({
      ruleSetRefs: [{ name: 'project-alpha', version: 1 }],
    });

    const teamName = resolveRes.json().name;
    const configRes = await call(store, 'PATCH', `/api/agent-teams/${encodeURIComponent(teamName)}`, {
      pmBot: 'pm-codex',
      quotas: { maxTemporaryAgents: 5 },
      ruleSetRefs: ['project-alpha'],
      actorRole: 'pm',
    });
    expect(configRes.statusCode).toBe(200);
    expect(configRes.json()).toMatchObject({
      pmBot: 'pm-codex',
      quotas: { maxTemporaryAgents: 5 },
      ruleSetRefs: [{ name: 'project-alpha', version: 1 }],
    });
    store.close();
  });

  it('lists instance-scoped activity history with metadata filters', async () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-routes-'));
    process.env.SESSION_STORE_DIR = dir;
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    try {
      store.upsertTemplateFromConfig({
        name: 'research',
        agents: [{ name: 'reviewer', engine: 'codex' }],
      }, 'test');
      const projectA = store.resolveTeamInstance({ templateName: 'research', chatId: 'oc_project_a' })!;
      const projectB = store.resolveTeamInstance({ templateName: 'research', chatId: 'oc_project_b' })!;

      recordCardLifecycle({
        lifecycleKey: `teaminst:${projectA.instanceId}:reviewer:run-a`,
        botName: 'pm-codex',
        chatId: 'oc_project_a',
        source: 'agent-activity',
        teamName: projectA.name,
        instanceId: projectA.instanceId,
        agentName: 'reviewer',
        runId: 'run-a',
        taskIds: [7],
        status: 'agent_activity',
        lifecycleStage: 'closed',
        responseText: 'project a report',
        now: 2_000,
      });
      recordCardLifecycle({
        lifecycleKey: `teaminst:${projectB.instanceId}:reviewer:run-b`,
        botName: 'pm-codex',
        chatId: 'oc_project_b',
        source: 'agent-activity',
        teamName: projectB.name,
        instanceId: projectB.instanceId,
        agentName: 'reviewer',
        runId: 'run-b',
        taskIds: [8],
        status: 'agent_activity',
        lifecycleStage: 'closed',
        responseText: 'project b report',
        now: 3_000,
      });

      const res = await call(
        store,
        'GET',
        `/api/agent-teams/${encodeURIComponent(projectA.instanceId!)}/activity?agent=reviewer&taskId=7&limit=5`,
      );

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        activity: [expect.objectContaining({
          lifecycleKey: `teaminst:${projectA.instanceId}:reviewer:run-a`,
          teamName: projectA.name,
          instanceId: projectA.instanceId,
          agentName: 'reviewer',
          runId: 'run-a',
          taskIds: [7],
          responsePreview: 'project a report',
        })],
      });
    } finally {
      store.close();
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets managers propose RuleSet changes but requires PM approval to apply them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-routes-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const proposalRes = await call(store, 'POST', '/api/agent-teams/proposals', {
      kind: 'ruleset',
      requestedBy: 'manager',
      requestedByRole: 'manager',
      summary: 'Share runtime rule',
      body: {
        name: 'worker',
        scope: 'worker',
        rules: [{ text: 'Workers must report validation output.' }],
      },
    });
    expect(proposalRes.statusCode).toBe(201);
    const proposal = proposalRes.json();
    expect(proposal).toMatchObject({
      kind: 'ruleset',
      targetName: 'worker',
      status: 'pending',
      requestedByRole: 'manager',
    });
    expect(store.getRuleSet('worker')).toBeUndefined();

    const managerApprove = await call(store, 'POST', `/api/agent-teams/proposals/${proposal.id}/approve`, {
      actorRole: 'manager',
      decidedBy: 'manager',
    });
    expect(managerApprove.statusCode).toBe(403);
    expect(store.getPromotionProposal(proposal.id)).toMatchObject({ status: 'pending' });

    const pmApprove = await call(store, 'POST', `/api/agent-teams/proposals/${proposal.id}/approve`, {
      actorRole: 'pm',
      decidedBy: 'pm-codex',
      reason: 'OK for worker scope.',
    });
    expect(pmApprove.statusCode).toBe(200);
    expect(pmApprove.json()).toMatchObject({
      status: 'approved',
      appliedVersion: 1,
      decidedBy: 'pm-codex',
    });
    expect(store.getRuleSet('worker')).toMatchObject({
      scope: 'worker',
      rules: [{ text: 'Workers must report validation output.' }],
    });

    const workerProposal = await call(store, 'POST', '/api/agent-teams/proposals', {
      kind: 'ruleset',
      requestedBy: 'worker',
      requestedByRole: 'worker',
      body: {
        name: 'worker-proposed',
        scope: 'worker',
        rules: [{ text: 'Worker should not propose privileged rules.' }],
      },
    });
    expect(workerProposal.statusCode).toBe(403);

    const listRes = await call(store, 'GET', '/api/agent-teams/proposals?status=approved');
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().proposals.map((item: any) => item.id)).toEqual([proposal.id]);
    store.close();
  });

  it('does not treat missing actorRole as PM authority', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-routes-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.createTeam('secure', 'Secure team');

    const createAgentRes = await call(store, 'POST', '/api/agent-teams/secure/agents', {
      name: 'unexpected',
    });
    expect(createAgentRes.statusCode).toBe(403);

    const pmCreateAgentRes = await call(store, 'POST', '/api/agent-teams/secure/agents', {
      name: 'planner',
      actorRole: 'pm',
    });
    expect(pmCreateAgentRes.statusCode).toBe(201);

    const proposal = store.createPromotionProposal({
      kind: 'ruleset',
      requestedBy: 'manager',
      requestedByRole: 'manager',
      body: {
        name: 'secure-worker',
        scope: 'worker',
        rules: [{ text: 'Use structured output.' }],
      },
    });
    const approveWithoutRole = await call(store, 'POST', `/api/agent-teams/proposals/${proposal.id}/approve`, {
      decidedBy: 'unknown',
    });
    expect(approveWithoutRole.statusCode).toBe(403);
    expect(store.getPromotionProposal(proposal.id)).toMatchObject({ status: 'pending' });

    const templateImportWithoutRole = await call(store, 'POST', '/api/agent-teams/templates', {
      template: { name: 'unapproved-template', agents: [{ name: 'planner' }] },
    });
    expect(templateImportWithoutRole.statusCode).toBe(403);

    const ruleSetWithoutRole = await call(store, 'POST', '/api/agent-teams/rules', {
      name: 'unapproved-rule',
      scope: 'worker',
      rules: [{ text: 'Should be reviewed first.' }],
    });
    expect(ruleSetWithoutRole.statusCode).toBe(403);

    store.upsertTemplateFromConfig({ name: 'secure-template', agents: [{ name: 'planner' }] }, 'test');
    const instanceResolveWithoutRole = await call(store, 'POST', '/api/agent-teams/instances/resolve', {
      templateName: 'secure-template',
      chatId: 'oc_secure',
    });
    expect(instanceResolveWithoutRole.statusCode).toBe(403);
    store.close();
  });
});
