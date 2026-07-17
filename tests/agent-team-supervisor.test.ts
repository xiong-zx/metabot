import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { BotRegistry } from '../src/api/bot-registry.js';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';
import { AgentTeamSupervisor } from '../src/agent-teams/team-supervisor.js';

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-supervisor-'));
  return new AgentTeamStore(logger, join(dir, 'teams.db'));
}

function makeRegistry(executeApiTask: any, stopChatTask = vi.fn(), sendAgentActivityCard = vi.fn()) {
  const setSessionEngine = vi.fn();
  const setSessionModel = vi.fn();
  const setSessionId = vi.fn();
  const bridge = {
    getSessionManager: () => ({ setSessionEngine, setSessionModel, setSessionId }),
    executeApiTask,
    stopChatTask,
    sendAgentActivityCard,
  };
  const registry = new BotRegistry();
  registry.register({
    name: 'metabot',
    platform: 'feishu',
    bridge,
    sender: {},
    config: {
      name: 'metabot',
      engine: 'codex',
      claude: { defaultWorkingDirectory: process.cwd() },
    },
  } as any);
  return { registry, bridge, setSessionEngine, setSessionModel, setSessionId, stopChatTask, sendAgentActivityCard };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

describe('AgentTeamSupervisor', () => {
  it('recovers stale running runs left by a previous bridge process', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    const task = store.createTask('demo', { subject: 'Interrupted task', owner: 'worker', blockedBy: [99] });
    store.updateTask('demo', task.id, { status: 'in_progress' });
    const run = store.createRun('demo', { agentName: 'worker', taskId: task.id });
    store.setAgentStatus('demo', 'worker', 'working');

    const { registry } = makeRegistry(vi.fn());
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });
    supervisor.start();

    await waitFor(() => {
      expect(store.getRun('demo', run.id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Bridge restarted'),
      });
    });
    expect(store.getTask('demo', task.id)).toMatchObject({
      status: 'pending',
      result: expect.stringContaining(run.id),
    });
    expect(store.getAgent('demo', 'worker')).toMatchObject({ status: 'idle' });
    expect(store.listMessages('demo', 'lead', false)[0]).toMatchObject({
      fromName: 'worker',
      summary: expect.stringContaining('Recovered stale run'),
    });
    supervisor.destroy();
    store.close();
  });

  it('runs a member in an independent team chat session and reports to lead', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'kimi', role: 'Worker' });
    store.createTask('demo', { subject: 'Inspect supervisor', owner: 'worker' });
    store.sendMessage('demo', { fromName: 'lead', toName: 'worker', body: 'Please inspect task 1' });

    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => ({
      success: true,
      responseText: `done from ${chatId}`,
      sessionId: `session-${chatId}`,
    }));
    const { registry, setSessionEngine } = makeRegistry(executeApiTask);

    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });
    await supervisor.tick();

    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'team:demo:worker',
        userId: 'agent-team-supervisor',
        sendCards: false,
        lifecycleKey: expect.stringMatching(/^team:demo:worker:run-/),
      }));
    });
    expect(setSessionEngine).toHaveBeenCalledWith('team:demo:worker', 'kimi');
    expect(store.listTasks('demo')[0]).toMatchObject({ status: 'completed', result: 'done from team:demo:worker' });
    expect(store.getAgent('demo', 'worker')).toMatchObject({ sessionId: 'session-team:demo:worker' });
    expect(store.listMessages('demo', 'worker', true)).toHaveLength(0);

    await waitFor(() => {
      expect(store.listMessages('demo', 'lead', true)).toHaveLength(1);
    });

    await supervisor.tick();
    expect(executeApiTask).not.toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'team:demo:lead',
    }));

    const runs = store.listRuns('demo');
    expect(runs.some((run) => run.agentName === 'worker' && run.status === 'completed')).toBe(true);
    expect(runs.some((run) => run.agentName === 'lead')).toBe(false);
    supervisor.destroy();
    store.close();
  });

  it('uses instance-scoped chat sessions for runtime team instances', async () => {
    const store = makeStore();
    store.createTeam('research@chat:oc-a', 'Research A', {
      scopeType: 'chat',
      scopeKey: 'oc_a',
      instanceId: 'ati_chat_a',
    });
    store.createAgent('research@chat:oc-a', { name: 'worker', engine: 'kimi', role: 'Worker' });
    store.createTask('research@chat:oc-a', { subject: 'Inspect scoped session', owner: 'worker' });

    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => ({
      success: true,
      responseText: `done from ${chatId}`,
      sessionId: `session-${chatId}`,
    }));
    const { registry, setSessionEngine } = makeRegistry(executeApiTask);

    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });
    await supervisor.tick();

    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'teaminst:ati_chat_a:worker',
        userId: 'agent-team-supervisor',
        sendCards: false,
        lifecycleKey: expect.stringMatching(/^teaminst:ati_chat_a:worker:run-/),
      }));
    });
    expect(setSessionEngine).toHaveBeenCalledWith('teaminst:ati_chat_a:worker', 'kimi');
    expect(store.listTasks('research@chat:oc-a')[0]).toMatchObject({
      status: 'completed',
      result: 'done from teaminst:ati_chat_a:worker',
    });
    expect(store.getAgent('research@chat:oc-a', 'worker')).toMatchObject({
      instanceId: 'ati_chat_a',
      sessionId: 'session-teaminst:ati_chat_a:worker',
    });
    supervisor.destroy();
    store.close();
  });

  it('uses team maxParallelRunsPerAgent quota when selecting runnable work', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { quotas: { maxParallelRunsPerAgent: 1 } });
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'First task', owner: 'worker' });
    store.createTask('demo', { subject: 'Second task', owner: 'worker' });

    let resolveExecution: ((value: any) => void) | undefined;
    const executeApiTask = vi.fn(() => new Promise((resolve) => {
      resolveExecution = resolve;
    }));
    const { registry } = makeRegistry(executeApiTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();

    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledTimes(1);
    });
    expect(store.listRuns('demo').filter((run) => run.status === 'running')).toHaveLength(1);
    expect(store.listTasks('demo').map((task) => task.status)).toEqual(['in_progress', 'pending']);

    resolveExecution?.({ success: true, responseText: 'done', sessionId: 'session-worker' });
    await waitFor(() => {
      expect(store.listRuns('demo').filter((run) => run.status === 'running')).toHaveLength(0);
    });
    supervisor.destroy();
    store.close();
  });

  it('uses the configured execution bot instead of the first registered bot', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Use PM bot', owner: 'worker' });

    const managerExecute = vi.fn(async () => ({ success: true, responseText: 'manager' }));
    const pmExecute = vi.fn(async () => ({ success: true, responseText: 'research-pm' }));
    const registry = new BotRegistry();
    const makeBridge = (executeApiTask: any) => ({
      getSessionManager: () => ({ setSessionEngine: vi.fn(), setSessionId: vi.fn() }),
      executeApiTask,
      stopChatTask: vi.fn(),
      sendAgentActivityCard: vi.fn(),
    });
    registry.register({
      name: 'manager',
      platform: 'feishu',
      bridge: makeBridge(managerExecute),
      sender: {},
      config: { name: 'manager', engine: 'codex', claude: { defaultWorkingDirectory: process.cwd() } },
    } as any);
    registry.register({
      name: 'research-pm',
      platform: 'feishu',
      bridge: makeBridge(pmExecute),
      sender: {},
      config: { name: 'research-pm', engine: 'codex', claude: { defaultWorkingDirectory: process.cwd() } },
    } as any);

    const supervisor = new AgentTeamSupervisor({
      registry,
      store,
      logger,
      intervalMs: 60_000,
      executionBotName: 'research-pm',
    });
    await supervisor.tick();

    await waitFor(() => {
      expect(pmExecute).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'team:demo:worker',
        userId: 'agent-team-supervisor',
      }));
    });
    expect(managerExecute).not.toHaveBeenCalled();
    supervisor.destroy();
    store.close();
  });

  it('sends an agent activity card to display chats when a member finishes', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Notify task', owner: 'worker' });

    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: 'member report',
      sessionId: 'sid',
    }));
    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(executeApiTask, vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(sendAgentActivityCard).toHaveBeenCalledWith(
        'oc_main',
        expect.stringContaining('demo / worker'),
        expect.objectContaining({
          teamName: 'demo',
          agentName: 'worker',
          runId: expect.any(String),
          taskIds: [1],
        }),
      );
    });
    expect(sendAgentActivityCard.mock.calls[0][1]).toContain('member report');
    expect(sendAgentActivityCard.mock.calls[0][1]).not.toContain('Completed run');
    await waitFor(() => {
      expect(store.listRuns('demo').some((run) => run.agentName === 'worker' && run.status === 'completed')).toBe(true);
    });
    await supervisor.tick();
    expect(sendAgentActivityCard).toHaveBeenCalledTimes(1);
    expect(sendAgentActivityCard.mock.calls[0][1]).not.toContain('demo / lead');
    expect(sendAgentActivityCard.mock.calls[0][1]).not.toContain('demo / idle digest');
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);
    supervisor.destroy();
    store.close();
  });

  it('does not emit an idle digest when visible run activity already reports drained work', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Digest task', owner: 'worker' });

    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: 'done',
      sessionId: 'sid',
    }));
    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(executeApiTask, vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(sendAgentActivityCard.mock.calls.some((call) => call[1].includes('demo / worker'))).toBe(true);
    });
    expect(sendAgentActivityCard.mock.calls.some((call) => call[1].includes('demo / idle digest'))).toBe(false);
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);

    await supervisor.tick();
    const digestCalls = sendAgentActivityCard.mock.calls.filter((call) => call[1].includes('demo / idle digest'));
    expect(digestCalls).toHaveLength(0);

    await supervisor.tick();
    const digestCallsAfterSecondTick = sendAgentActivityCard.mock.calls.filter((call) => call[1].includes('demo / idle digest'));
    expect(digestCallsAfterSecondTick).toHaveLength(0);
    supervisor.destroy();
    store.close();
  });

  it('does not emit an idle digest while open work remains', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Blocked task', owner: 'worker', blockedBy: [1] });

    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(vi.fn(), vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    expect(sendAgentActivityCard.mock.calls.some((call) => call[1].includes('idle digest'))).toBe(false);
    supervisor.destroy();
    store.close();
  });

  it('sends lead inbox messages as activity when the team has no lead agent member', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.sendMessage('demo', {
      fromName: 'worker',
      toName: 'lead',
      summary: 'member finished',
      body: 'Worker final report',
    });

    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: '长沙当前多云，约 28°C。',
      sessionId: 'sid',
    }));
    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(executeApiTask, vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    expect(executeApiTask).not.toHaveBeenCalled();
    expect(sendAgentActivityCard).toHaveBeenCalledWith(
      'oc_main',
      expect.stringContaining('demo / lead'),
      expect.objectContaining({
        teamName: 'demo',
        agentName: 'lead',
      }),
    );
    expect(sendAgentActivityCard.mock.calls[0][1]).toContain('Worker final report');
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);
    expect(store.listRuns('demo').some((run) => run.agentName === 'lead')).toBe(false);
    supervisor.destroy();
    store.close();
  });

  it('passes per-agent model, effort, and permission overrides to member runs', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', {
      name: 'reviewer',
      engine: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      timeoutMs: 123_000,
      idleTimeoutMs: 45_000,
      allowedTools: ['Read'],
    });
    store.createTask('demo', { subject: 'Review diff', owner: 'reviewer' });

    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: 'review complete',
      sessionId: 'reviewer-session',
    }));
    const { registry, setSessionModel } = makeRegistry(executeApiTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();

    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'team:demo:reviewer',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        timeoutMs: 123_000,
        idleTimeoutMs: 45_000,
        allowedTools: ['Read'],
      }));
    });
    expect(setSessionModel).toHaveBeenCalledWith('team:demo:reviewer', 'gpt-5.5', 'codex');
    supervisor.destroy();
    store.close();
  });

  it('injects pinned RuleSet context and manager authority boundaries into agent prompts', async () => {
    const store = makeStore();
    const rules = store.upsertRuleSet({
      name: 'research-workflow',
      scope: 'team-template',
      rules: [{ text: 'Follow planner-coder-experiment-reviewer workflow.' }],
      source: 'test',
    });
    store.upsertRuleSet({
      name: 'manager',
      scope: 'agent-role',
      rules: [{ text: 'Manager role RuleSet: coordinate the team and escalate approvals.' }],
      source: 'test',
    });
    store.createTeam('demo', 'Demo', { ruleSetRefs: [{ name: rules.name, version: rules.version }] });
    store.createAgent('demo', { name: 'manager', role: 'team manager', engine: 'codex' });
    store.createTask('demo', { subject: 'Coordinate research loop', owner: 'manager' });

    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: 'coordinated',
      sessionId: 'manager-session',
    }));
    const { registry } = makeRegistry(executeApiTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();

    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        prompt: expect.stringContaining('Rules Context Pack:'),
      }));
    });
    const prompt = executeApiTask.mock.calls[0]![0].prompt;
    expect(prompt).toContain('Follow planner-coder-experiment-reviewer workflow.');
    expect(prompt).toContain('Manager role RuleSet: coordinate the team and escalate approvals.');
    expect(prompt).toContain('Rules provenance: team-template:research-workflow@v1, agent-role:manager@v1');
    expect(prompt).toContain('Manager boundary');
    expect(prompt).toContain('Do not spawn Agents or run worker_dispatch yourself.');
    supervisor.destroy();
    store.close();
  });

  it('recycles expired temporary agents and requeues their running task', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.createAgent('demo', {
      name: 'temp',
      kind: 'temporary',
      actorRole: 'pm',
      expiresAt: Date.now() - 1_000,
    });
    const task = store.createTask('demo', { subject: 'Temporary work', owner: 'temp' });
    store.updateTask('demo', task.id, { status: 'in_progress' });
    const run = store.createRun('demo', { agentName: 'temp', taskId: task.id });
    store.setAgentStatus('demo', 'temp', 'working');

    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(vi.fn(), vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();

    expect(store.getAgent('demo', 'temp')).toMatchObject({ status: 'stopped' });
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.getTask('demo', task.id)).toMatchObject({ status: 'pending' });
    expect(store.listMessages('demo', 'lead')[0]).toMatchObject({
      fromName: 'temp',
      summary: expect.stringContaining('expired'),
    });
    expect(sendAgentActivityCard).toHaveBeenCalledWith(
      'oc_main',
      expect.stringContaining('Temporary Agent TTL expired'),
      expect.objectContaining({
        teamName: 'demo',
        agentName: 'temp',
      }),
    );
    supervisor.destroy();
    store.close();
  });

  it('stops an in-flight temporary agent chat when TTL expires during a run', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', {
      name: 'temp',
      kind: 'temporary',
      actorRole: 'pm',
      expiresAt: Date.now() + 60_000,
    });
    store.createTask('demo', { subject: 'Temporary work', owner: 'temp' });

    let resolveRun!: () => void;
    let runSettled = false;
    const executeApiTask = vi.fn(async () => {
      await new Promise<void>((resolve) => { resolveRun = resolve; });
      runSettled = true;
      return { success: true, responseText: 'late success', sessionId: 'temp-session' };
    });
    const stopChatTask = vi.fn();
    const { registry } = makeRegistry(executeApiTask, stopChatTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo').filter((run) => run.status === 'running')).toHaveLength(1);
    });
    const run = store.listRuns('demo')[0]!;
    store.upsertAgent('demo', {
      name: 'temp',
      kind: 'temporary',
      expiresAt: Date.now() - 1_000,
    });

    await supervisor.tick();

    expect(stopChatTask).toHaveBeenCalledWith('team:demo:temp');
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.getTask('demo', run.taskId!)).toMatchObject({ status: 'pending' });

    resolveRun();
    await waitFor(() => {
      expect(runSettled).toBe(true);
      expect(store.getAgent('demo', 'temp')).toMatchObject({ status: 'stopped' });
    });
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    supervisor.destroy();
    store.close();
  });

  it('runs lead as a normal nested member when the team defines one', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.createAgent('demo', { name: 'lead', engine: 'codex' });
    store.sendMessage('demo', {
      fromName: 'worker',
      toName: 'lead',
      summary: 'member finished',
      body: 'Worker final report',
    });

    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => ({
      success: true,
      responseText: `lead reply from ${chatId}`,
      sessionId: 'lead-sid',
    }));
    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(executeApiTask, vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'team:demo:lead',
      }));
    });
    expect(sendAgentActivityCard).toHaveBeenCalledWith(
      'oc_main',
      expect.stringContaining('demo / lead'),
      expect.objectContaining({
        teamName: 'demo',
        agentName: 'lead',
        runId: expect.any(String),
      }),
    );
    expect(sendAgentActivityCard.mock.calls[0][1]).toContain('lead reply from team:demo:lead');
    expect(store.listRuns('demo').some((run) => run.agentName === 'lead' && run.status === 'completed')).toBe(true);
    supervisor.destroy();
    store.close();
  });

  it('uses the member lead message as the agent activity body when one was sent during the run', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Weather', owner: 'worker' });

    const executeApiTask = vi.fn(async () => {
      store.sendMessage('demo', {
        fromName: 'worker',
        toName: 'lead',
        summary: 'weather report',
        body: '北京当前多云，约 26°C。',
      });
      return {
        success: true,
        responseText: 'No files edited. Completed task and sent message #1.',
        sessionId: 'sid',
      };
    });
    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(executeApiTask, vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(sendAgentActivityCard).toHaveBeenCalledWith(
        'oc_main',
        expect.stringContaining('demo / lead'),
        expect.objectContaining({
          teamName: 'demo',
          agentName: 'lead',
          runId: expect.any(String),
          taskIds: [1],
        }),
      );
    });
    expect(sendAgentActivityCard.mock.calls[0][1]).toContain('北京当前多云，约 26°C。');
    expect(sendAgentActivityCard.mock.calls[0][1]).not.toContain('No files edited');
    expect(store.listMessages('demo', 'lead').filter((message) => message.fromName === 'worker')).toHaveLength(1);
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);
    supervisor.destroy();
    store.close();
  });

  it('persists heartbeat output while a member run is still running', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Long task', owner: 'worker' });

    let resolveRun!: () => void;
    const executeApiTask = vi.fn(async ({ onUpdate }: any) => {
      onUpdate?.({ status: 'running', userPrompt: 'p', responseText: 'hello', toolCalls: [] }, 'msg', false);
      onUpdate?.({ status: 'running', userPrompt: 'p', responseText: 'hello world', toolCalls: [] }, 'msg', false);
      await new Promise<void>((resolve) => { resolveRun = resolve; });
      return { success: true, responseText: 'final output', sessionId: 'sid' };
    });
    const { registry } = makeRegistry(executeApiTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'running', output: 'hello world' });
    });

    resolveRun();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'completed', output: 'final output' });
    });
    supervisor.destroy();
    store.close();
  });

  it('runs multiple pending tasks for the same member concurrently in isolated sessions', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'reviewer', engine: 'codex' });
    store.createTask('demo', { subject: 'Verify API routes', owner: 'reviewer' });
    store.createTask('demo', { subject: 'Verify web UI', owner: 'reviewer' });

    const pending: Array<{
      chatId: string;
      resolve: (value: { success: boolean; responseText: string; sessionId: string }) => void;
    }> = [];
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => {
      return await new Promise<{ success: boolean; responseText: string; sessionId: string }>((resolve) => {
        pending.push({
          chatId,
          resolve,
        });
      });
    });
    const { registry, setSessionId } = makeRegistry(executeApiTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledTimes(2);
    });

    const chatIds = pending.map((run) => run.chatId);
    expect(new Set(chatIds).size).toBe(2);
    expect(chatIds.every((chatId) => chatId.startsWith('team:demo:reviewer:run-'))).toBe(true);
    expect(setSessionId).not.toHaveBeenCalled();
    expect(store.listRuns('demo').filter((run) => run.agentName === 'reviewer' && run.status === 'running')).toHaveLength(2);
    expect(store.listTasks('demo').filter((task) => task.status === 'in_progress')).toHaveLength(2);
    expect(store.getAgent('demo', 'reviewer')).toMatchObject({ status: 'working' });

    pending[0]!.resolve({ success: true, responseText: 'api verified', sessionId: 'isolated-api' });
    await waitFor(() => {
      expect(store.listRuns('demo').filter((run) => run.status === 'completed')).toHaveLength(1);
    });
    expect(store.getAgent('demo', 'reviewer')).toMatchObject({ status: 'working' });

    pending[1]!.resolve({ success: true, responseText: 'ui verified', sessionId: 'isolated-ui' });
    await waitFor(() => {
      expect(store.listRuns('demo').filter((run) => run.status === 'completed')).toHaveLength(2);
      expect(store.listTasks('demo').filter((task) => task.status === 'completed')).toHaveLength(2);
      expect(store.getAgent('demo', 'reviewer')).toMatchObject({ status: 'idle' });
    });
    expect(store.getAgent('demo', 'reviewer')?.sessionId).toBeUndefined();
    supervisor.destroy();
    store.close();
  });

  it('pairs dispatch wake-up messages with their tasks instead of starting extra message lanes', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'reviewer', engine: 'codex' });
    const apiTask = store.createTask('demo', { subject: 'Verify API routes', owner: 'reviewer' });
    const uiTask = store.createTask('demo', { subject: 'Verify web UI', owner: 'reviewer' });
    store.sendMessage('demo', {
      fromName: 'lead',
      toName: 'reviewer',
      summary: `Task #${apiTask.id}: Verify API routes`,
      body: `Start task #${apiTask.id}: Verify API routes`,
    });
    store.sendMessage('demo', {
      fromName: 'lead',
      toName: 'reviewer',
      summary: `Task #${uiTask.id}: Verify web UI`,
      body: `Start task #${uiTask.id}: Verify web UI`,
    });

    const pending: Array<{
      chatId: string;
      prompt: string;
      resolve: (value: { success: boolean; responseText: string; sessionId: string }) => void;
    }> = [];
    const executeApiTask = vi.fn(async ({ chatId, prompt }: { chatId: string; prompt: string }) => {
      return await new Promise<{ success: boolean; responseText: string; sessionId: string }>((resolve) => {
        pending.push({ chatId, prompt, resolve });
      });
    });
    const { registry } = makeRegistry(executeApiTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledTimes(2);
    });

    expect(store.listMessages('demo', 'reviewer', true)).toHaveLength(0);
    expect(pending.map((run) => run.prompt).join('\n')).toContain(`#${apiTask.id}`);
    expect(pending.map((run) => run.prompt).join('\n')).toContain(`#${uiTask.id}`);

    for (const run of pending) {
      run.resolve({ success: true, responseText: 'verified', sessionId: run.chatId });
    }
    await waitFor(() => {
      expect(store.listRuns('demo').filter((run) => run.status === 'completed')).toHaveLength(2);
      expect(store.listTasks('demo').filter((task) => task.status === 'completed')).toHaveLength(2);
    });
    supervisor.destroy();
    store.close();
  });

  it('stops one same-agent parallel run without stopping its sibling lane', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'reviewer', engine: 'codex' });
    store.createTask('demo', { subject: 'Verify API routes', owner: 'reviewer' });
    store.createTask('demo', { subject: 'Verify web UI', owner: 'reviewer' });

    const pending: Array<{
      chatId: string;
      resolve: (value: { success: boolean; responseText: string; sessionId: string }) => void;
    }> = [];
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => {
      return await new Promise<{ success: boolean; responseText: string; sessionId: string }>((resolve) => {
        pending.push({ chatId, resolve });
      });
    });
    const stopChatTask = vi.fn();
    const { registry } = makeRegistry(executeApiTask, stopChatTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo').filter((run) => run.status === 'running')).toHaveLength(2);
    });
    const runs = store.listRuns('demo').filter((run) => run.status === 'running');
    const stoppedRun = runs[0]!;
    const siblingRun = runs[1]!;
    const stoppedChatId = pending.find((run) => run.chatId.endsWith(stoppedRun.id))?.chatId;
    expect(stoppedChatId).toBeTruthy();

    supervisor.stopRun('demo', stoppedRun.id);
    expect(stopChatTask).toHaveBeenCalledTimes(1);
    expect(stopChatTask).toHaveBeenCalledWith(stoppedChatId);
    expect(store.getRun('demo', stoppedRun.id)).toMatchObject({ status: 'stopped' });
    expect(store.getRun('demo', siblingRun.id)).toMatchObject({ status: 'running' });
    expect(store.getTask('demo', stoppedRun.taskId!)).toMatchObject({ status: 'pending' });
    expect(store.getTask('demo', siblingRun.taskId!)).toMatchObject({ status: 'in_progress' });
    expect(store.getAgent('demo', 'reviewer')).toMatchObject({ status: 'working' });

    pending.find((run) => run.chatId.endsWith(siblingRun.id))?.resolve({
      success: true,
      responseText: 'sibling finished',
      sessionId: 'sibling-session',
    });
    await waitFor(() => {
      expect(store.getRun('demo', siblingRun.id)).toMatchObject({ status: 'completed' });
      expect(store.getAgent('demo', 'reviewer')).toMatchObject({ status: 'idle' });
    });
    supervisor.destroy();
    store.close();
  });

  it('requeues assigned tasks when a member run fails or crashes', async () => {
    const failedStore = makeStore();
    failedStore.createTeam('demo', 'Demo');
    failedStore.createAgent('demo', { name: 'worker', engine: 'codex' });
    failedStore.createTask('demo', { subject: 'Fail task', owner: 'worker' });
    const failed = makeRegistry(vi.fn(async () => ({ success: false, responseText: 'bad output', error: 'boom' })));
    const failedSupervisor = new AgentTeamSupervisor({ registry: failed.registry, store: failedStore, logger, intervalMs: 60_000 });
    await failedSupervisor.tick();
    await waitFor(() => {
      expect(failedStore.listRuns('demo')[0]).toMatchObject({ status: 'failed', error: 'boom' });
      expect(failedStore.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('boom') });
    });
    failedSupervisor.destroy();
    failedStore.close();

    const crashedStore = makeStore();
    crashedStore.createTeam('demo', 'Demo');
    crashedStore.createAgent('demo', { name: 'worker', engine: 'codex' });
    crashedStore.createTask('demo', { subject: 'Crash task', owner: 'worker' });
    const crashed = makeRegistry(vi.fn(async () => { throw new Error('crash'); }));
    const crashedSupervisor = new AgentTeamSupervisor({ registry: crashed.registry, store: crashedStore, logger, intervalMs: 60_000 });
    await crashedSupervisor.tick();
    await waitFor(() => {
      expect(crashedStore.listRuns('demo')[0]).toMatchObject({ status: 'failed', error: 'crash' });
      expect(crashedStore.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('crash') });
    });
    crashedSupervisor.destroy();
    crashedStore.close();
  });

  it('stops in-flight runs and suppresses late executor results', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Stop task', owner: 'worker' });

    let resolveRun!: () => void;
    const executeApiTask = vi.fn(async () => {
      await new Promise<void>((resolve) => { resolveRun = resolve; });
      return { success: true, responseText: 'late success', sessionId: 'sid' };
    });
    const stopChatTask = vi.fn();
    const { registry } = makeRegistry(executeApiTask, stopChatTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'running' });
    });
    const run = store.listRuns('demo')[0];
    supervisor.stopRun('demo', run.id);
    expect(stopChatTask).toHaveBeenCalledWith('team:demo:worker');
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('Stopped run') });

    resolveRun();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.getRun('demo', run.id)?.output).not.toBe('late success');
    supervisor.destroy();
    store.close();
  });

  it('suppresses crash notice when an intentionally stopped run rejects', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Stop reject task', owner: 'worker' });

    let rejectRun!: (err: Error) => void;
    const executeApiTask = vi.fn(async () => {
      await new Promise<void>((_resolve, reject) => { rejectRun = reject; });
      return { success: true, responseText: 'unreachable', sessionId: 'sid' };
    });
    const stopChatTask = vi.fn();
    const { registry } = makeRegistry(executeApiTask, stopChatTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'running' });
    });
    const run = store.listRuns('demo')[0];
    supervisor.stopRun('demo', run.id);
    rejectRun(new Error('Task was stopped'));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);
    expect(store.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('Stopped run') });
    supervisor.destroy();
    store.close();
  });

  it('does not report a crash to lead when a stopped run aborts with an error', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Abort task', owner: 'worker' });

    let rejectRun!: (err: Error) => void;
    const executeApiTask = vi.fn(async () => {
      await new Promise<void>((_resolve, reject) => { rejectRun = reject; });
      return { success: true, responseText: 'unreachable', sessionId: 'sid' };
    });
    const { registry } = makeRegistry(executeApiTask, vi.fn());
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'running' });
    });
    const run = store.listRuns('demo')[0];
    supervisor.stopRun('demo', run.id);
    rejectRun(new Error('aborted by stop'));

    await waitFor(() => {
      expect(store.getAgent('demo', 'worker')).toMatchObject({ status: 'idle' });
    });
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('Stopped run') });
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);
    supervisor.destroy();
    store.close();
  });
});
