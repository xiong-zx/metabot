import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';

const logger = {
  child: () => logger,
  info: () => {},
} as any;

describe('AgentTeamStore', () => {
  it('stores team agents, tasks, messages, and runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const team = store.createTeam('demo', 'Demo team');
    expect(team).toMatchObject({ name: 'demo', description: 'Demo team', status: 'active' });

    const agent = store.createAgent('demo', {
      name: 'reviewer',
      role: 'review',
      engine: 'codex',
      prompt: 'Review changes',
    });
    expect(agent).toMatchObject({ teamName: 'demo', name: 'reviewer', status: 'idle', engine: 'codex' });
    expect(store.deleteAgent('demo', 'missing')).toBe(false);

    const task = store.createTask('demo', {
      subject: 'Review CLI',
      description: 'Check command shape',
      owner: 'reviewer',
    });
    expect(task).toMatchObject({ id: 1, subject: 'Review CLI', status: 'pending', owner: 'reviewer' });

    const updated = store.updateTask('demo', 1, { status: 'completed', result: 'Looks good' });
    expect(updated).toMatchObject({ status: 'completed', result: 'Looks good' });

    const message = store.sendMessage('demo', {
      fromName: 'lead',
      toName: 'reviewer',
      summary: 'review task',
      body: 'Please review task 1',
    });
    expect(message).toMatchObject({ fromName: 'lead', toName: 'reviewer', body: 'Please review task 1' });
    expect(store.listMessages('demo', 'reviewer', true)).toHaveLength(1);
    expect(store.markMessagesRead('demo', 'reviewer')).toBe(1);
    expect(store.listMessages('demo', 'reviewer', true)).toHaveLength(0);

    const run = store.createRun('demo', { agentName: 'reviewer', taskId: 1 });
    expect(run).toMatchObject({ teamName: 'demo', agentName: 'reviewer', taskId: 1, status: 'running' });
    expect(store.getRunningRun('demo', 'reviewer')).toMatchObject({ id: run.id, status: 'running' });
    expect(store.updateRun('demo', run.id, { status: 'completed', output: 'done' })).toMatchObject({ output: 'done' });
    expect(store.getRunningRun('demo', 'reviewer')).toBeUndefined();

    const status = store.status('demo');
    expect(status?.agents).toHaveLength(1);
    expect(status?.tasks).toHaveLength(1);
    expect(status?.runs).toHaveLength(1);
    expect(store.deleteAgent('demo', 'reviewer')).toBe(true);
    expect(store.listAgents('demo')).toHaveLength(0);

    store.close();
  });

  it('marks only selected message ids read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.createTeam('demo', 'Demo team');

    const first = store.sendMessage('demo', { fromName: 'lead', toName: 'reviewer', body: 'Task #1' });
    const second = store.sendMessage('demo', { fromName: 'lead', toName: 'reviewer', body: 'Task #2' });
    store.sendMessage('demo', { fromName: 'lead', toName: 'other', body: 'Other task' });

    expect(store.markMessagesReadById('demo', 'reviewer', [first.id])).toBe(1);
    expect(store.listMessages('demo', 'reviewer', true).map((message) => message.id)).toEqual([second.id]);
    expect(store.listMessages('demo', 'other', true)).toHaveLength(1);

    store.close();
  });

  it('allows lead as a normal member name for nested teams', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('demo', 'Demo team');
    expect(store.createAgent('demo', { name: 'lead', engine: 'codex' })).toMatchObject({ name: 'lead', status: 'idle' });
    store.reconcileTeams([{
      name: 'demo',
      agents: [
        { name: 'lead', role: 'lead', engine: 'codex' },
        { name: 'worker', role: 'worker', engine: 'codex' },
      ],
    }]);

    expect(store.getAgent('demo', 'lead')).toMatchObject({ name: 'lead', role: 'lead' });
    expect(store.listAgents('demo').map((agent) => agent.name)).toEqual(['lead', 'worker']);
    expect(store.status('demo')?.agents.map((agent) => agent.name)).toEqual(['lead', 'worker']);

    store.close();
  });

  it('does not stop manual teams when bots.json resident teams are removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('manual-team', 'Created by CLI', {
      displayChatIds: ['oc_manual'],
    });
    store.reconcileTeams([{
      name: 'resident-team',
      description: 'From bots.json',
      displayChatIds: ['oc_resident'],
      agents: [{ name: 'lead', engine: 'codex' }],
    }]);

    expect(store.getTeam('manual-team')).toMatchObject({ status: 'active', managedByConfig: false });
    expect(store.getTeam('resident-team')).toMatchObject({ status: 'active', managedByConfig: true });
    expect(store.listAgents('resident-team').map((agent) => agent.name)).toEqual(['lead']);

    store.reconcileTeams([]);

    expect(store.getTeam('manual-team')).toMatchObject({ status: 'active', managedByConfig: false });
    expect(store.getTeam('resident-team')).toMatchObject({ status: 'stopped', managedByConfig: true });
    expect(store.findTeamForChat('oc_manual')).toMatchObject({ name: 'manual-team' });
    expect(store.findTeamForChat('oc_resident')).toBeUndefined();
    store.close();
  });

  it('reconciles configured teams and resolves chat display bindings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.reconcileTeams([{
      name: 'metabot-dev',
      description: 'Runtime team',
      chatIds: ['team:metabot-dev:runtime-engineer'],
      displayChatIds: ['oc_chat_123'],
      agents: [
        { name: 'lead', role: 'lead', engine: 'codex' },
        { name: 'runtime-engineer', role: 'runtime', engine: 'codex', prompt: 'Own runtime' },
      ],
      tasks: [
        { id: 5, subject: 'Implement supervisor', owner: 'runtime-engineer' },
      ],
    }]);

    expect(store.getTeam('metabot-dev')).toMatchObject({
      name: 'metabot-dev',
      chatIds: ['team:metabot-dev:runtime-engineer'],
      displayChatIds: ['oc_chat_123'],
      managedByConfig: true,
    });
    expect(store.getAgent('metabot-dev', 'runtime-engineer')).toMatchObject({ role: 'runtime', engine: 'codex' });
    expect(store.getAgent('metabot-dev', 'lead')).toMatchObject({ role: 'lead', engine: 'codex' });
    expect(store.getTask('metabot-dev', 5)).toMatchObject({ subject: 'Implement supervisor', owner: 'runtime-engineer' });
    expect(store.findTeamForChat('oc_chat_123')).toMatchObject({ name: 'metabot-dev' });
    expect(store.findTeamForChat('team:metabot-dev:runtime-engineer')).toMatchObject({ name: 'metabot-dev' });
    expect(store.findTeamForChat('oc_other')).toBeUndefined();

    store.reconcileTeams([{
      name: 'metabot-dev',
      description: 'Runtime team',
      displayChatIds: ['oc_chat_456'],
      agents: [
        { name: 'lead', role: 'lead', engine: 'codex' },
      ],
    }]);

    expect(store.getAgent('metabot-dev', 'runtime-engineer')).toMatchObject({ status: 'stopped' });
    expect(store.findTeamForChat('oc_chat_123')).toBeUndefined();
    expect(store.findTeamForChat('oc_chat_456')).toMatchObject({ name: 'metabot-dev' });

    store.reconcileTeams([]);
    expect(store.getTeam('metabot-dev')).toMatchObject({ status: 'stopped' });
    expect(store.findTeamForChat('oc_chat_456')).toBeUndefined();
    store.close();
  });

  it('preserves manual teams when resident config is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('manual', 'Manual team', { displayChatIds: ['manual-chat'] });
    store.reconcileTeams([{
      name: 'resident',
      displayChatIds: ['resident-chat'],
      agents: [{ name: 'worker', engine: 'codex' }],
    }]);

    expect(store.getTeam('manual')).toMatchObject({ status: 'active', managedByConfig: false });
    expect(store.getTeam('resident')).toMatchObject({ status: 'active', managedByConfig: true });

    store.reconcileTeams([]);
    expect(store.getTeam('manual')).toMatchObject({ status: 'active' });
    expect(store.findTeamForChat('manual-chat')).toMatchObject({ name: 'manual' });
    expect(store.getTeam('resident')).toMatchObject({ status: 'stopped' });
    expect(store.findTeamForChat('resident-chat')).toBeUndefined();

    store.close();
  });

  it('bootstraps versioned templates from config and pins legacy resident teams', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.reconcileTeams([{
      name: 'research',
      description: 'Research template',
      agents: [{ name: 'planner', engine: 'codex', prompt: 'Plan v1' }],
    }]);

    expect(store.listTemplates('research')).toHaveLength(1);
    expect(store.getTemplateVersion('research')).toMatchObject({ name: 'research', version: 1 });
    expect(store.getTeam('research')).toMatchObject({
      templateName: 'research',
      templateVersion: 1,
      scopeType: 'legacy',
      instanceId: 'legacy:research',
      managedByConfig: true,
    });

    store.reconcileTeams([{
      name: 'research',
      description: 'Research template',
      agents: [{ name: 'planner', engine: 'codex', prompt: 'Plan v2' }],
    }]);

    expect(store.listTemplates('research').map((template) => template.version)).toEqual([2, 1]);
    expect(store.getTeam('research')).toMatchObject({ templateName: 'research', templateVersion: 2 });
    store.close();
  });

  it('creates chat-scoped instances pinned to a template version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.upsertTemplateFromConfig({
      name: 'research',
      description: 'Research team',
      agents: [{ name: 'planner', engine: 'codex', prompt: 'Plan v1' }],
    }, 'test');

    const projectA = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_a',
      pmBot: 'pm-codex',
    })!;

    expect(projectA.name).toContain('research@chat:');
    expect(projectA).toMatchObject({
      templateName: 'research',
      templateVersion: 1,
      scopeType: 'chat',
      scopeKey: 'oc_project_a',
      pmBot: 'pm-codex',
      displayChatIds: ['oc_project_a'],
      managedByConfig: false,
    });
    expect(store.getAgent(projectA.name, 'planner')).toMatchObject({ kind: 'template', prompt: 'Plan v1' });

    store.upsertTemplateFromConfig({
      name: 'research',
      description: 'Research team',
      agents: [{ name: 'planner', engine: 'codex', prompt: 'Plan v2' }],
    }, 'test');

    const resolvedAgain = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_a',
    })!;
    expect(resolvedAgain.name).toBe(projectA.name);
    expect(resolvedAgain.templateVersion).toBe(1);
    expect(store.getAgent(projectA.name, 'planner')).toMatchObject({ prompt: 'Plan v1' });

    const projectB = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_b',
    })!;
    expect(projectB.templateVersion).toBe(2);
    expect(store.getAgent(projectB.name, 'planner')).toMatchObject({ prompt: 'Plan v2' });
    store.close();
  });

  it('resolves instance ids and keeps chat-scoped runtime work isolated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('legacy-research', 'Legacy display team', { displayChatIds: ['oc_project_a'] });
    store.upsertTemplateFromConfig({
      name: 'research',
      agents: [{ name: 'planner', engine: 'codex' }],
    }, 'test');

    const projectA = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_a',
    })!;
    const projectB = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_b',
    })!;

    expect(projectA.instanceId).toBeTruthy();
    expect(store.getTeamByInstanceId(projectA.instanceId!)).toMatchObject({ name: projectA.name });
    expect(store.resolveTeamName(projectA.instanceId!)).toBe(projectA.name);
    expect(store.resolveTeamIdentifier(projectA.instanceId!)).toMatchObject({ name: projectA.name });
    expect(store.findTeamForChat('oc_project_a')).toMatchObject({ name: projectA.name });
    expect(store.getAgent(projectA.name, 'planner')).toMatchObject({ instanceId: projectA.instanceId });

    const taskA = store.createTask(projectA.name, { subject: 'Project A task', owner: 'planner' });
    store.createTask(projectB.name, { subject: 'Project B task', owner: 'planner' });
    const messageA = store.sendMessage(projectA.name, { toName: 'planner', body: 'A only' });
    store.sendMessage(projectB.name, { toName: 'planner', body: 'B only' });
    const runA = store.createRun(projectA.name, { agentName: 'planner', output: 'A run' });
    store.createRun(projectB.name, { agentName: 'planner', output: 'B run' });

    expect(taskA).toMatchObject({ instanceId: projectA.instanceId });
    expect(messageA).toMatchObject({ instanceId: projectA.instanceId });
    expect(runA).toMatchObject({ instanceId: projectA.instanceId });
    expect(store.listTasks(projectA.name).map((task) => task.subject)).toEqual(['Project A task']);
    expect(store.listTasks(projectB.name).map((task) => task.subject)).toEqual(['Project B task']);
    expect(store.listMessages(projectA.name, 'planner').map((message) => message.body)).toEqual(['A only']);
    expect(store.listMessages(projectB.name, 'planner').map((message) => message.body)).toEqual(['B only']);
    expect(store.listRuns(projectA.name).map((run) => run.output)).toEqual(['A run']);
    expect(store.listRuns(projectB.name).map((run) => run.output)).toEqual(['B run']);
    store.close();
  });

  it('backfills child rows when a legacy team becomes pinned to an instance id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('legacy', 'Legacy team');
    store.createAgent('legacy', { name: 'planner', actorRole: 'pm' });
    store.createTask('legacy', { subject: 'Legacy task', owner: 'planner' });
    store.sendMessage('legacy', { toName: 'planner', body: 'Legacy message' });
    const run = store.createRun('legacy', { agentName: 'planner' });

    expect(store.getAgent('legacy', 'planner')?.instanceId).toBeUndefined();
    store.upsertTeam({
      name: 'legacy',
      instanceId: 'legacy:legacy',
      scopeType: 'legacy',
      managedByConfig: true,
    });

    expect(store.getAgent('legacy', 'planner')).toMatchObject({ instanceId: 'legacy:legacy' });
    expect(store.getTask('legacy', 1)).toMatchObject({ instanceId: 'legacy:legacy' });
    expect(store.listMessages('legacy', 'planner')[0]).toMatchObject({ instanceId: 'legacy:legacy' });
    expect(store.getRun('legacy', run.id)).toMatchObject({ instanceId: 'legacy:legacy' });
    store.close();
  });

  it('pins RuleSet references when creating a scoped instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.upsertRuleSet({
      name: 'research-rules',
      scope: 'team-template',
      rules: [{ text: 'Use workflow v1.' }],
      source: 'test',
    });
    store.upsertTemplateFromConfig({
      name: 'research',
      ruleSetRefs: ['research-rules'],
      agents: [{ name: 'planner', engine: 'codex' }],
    }, 'test');

    const instance = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_a',
    })!;
    expect(instance.ruleSetRefs).toEqual([{ name: 'research-rules', version: 1 }]);

    store.upsertRuleSet({
      name: 'research-rules',
      scope: 'team-template',
      rules: [{ text: 'Use workflow v2.' }],
      source: 'test',
    });
    const resolvedAgain = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_a',
    })!;
    expect(resolvedAgain.ruleSetRefs).toEqual([{ name: 'research-rules', version: 1 }]);

    const newInstance = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_b',
    })!;
    expect(newInstance.ruleSetRefs).toEqual([{ name: 'research-rules', version: 2 }]);
    store.close();
  });

  it('pins additional project RuleSet refs passed during instance resolution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.upsertRuleSet({
      name: 'research-rules',
      scope: 'team-template',
      rules: [{ text: 'Use workflow v1.' }],
      source: 'test',
    });
    store.upsertRuleSet({
      name: 'project-alpha',
      scope: 'project',
      rules: [{ text: 'Use dataset alpha.' }],
      source: 'test',
    });
    store.upsertTemplateFromConfig({
      name: 'research',
      ruleSetRefs: ['research-rules'],
      agents: [{ name: 'planner', engine: 'codex' }],
    }, 'test');

    const instance = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_a',
      ruleSetRefs: ['project-alpha'],
    })!;
    expect(instance.ruleSetRefs).toEqual([
      { name: 'project-alpha', version: 1 },
      { name: 'research-rules', version: 1 },
    ]);

    store.upsertRuleSet({
      name: 'project-alpha',
      scope: 'project',
      rules: [{ text: 'Use dataset alpha v2.' }],
      source: 'test',
    });
    const resolvedAgain = store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_a',
      ruleSetRefs: ['project-alpha@2'],
    })!;
    expect(resolvedAgain.ruleSetRefs).toEqual([
      { name: 'project-alpha', version: 1 },
      { name: 'research-rules', version: 1 },
    ]);
    store.close();
  });

  it('pins unversioned RuleSet refs during team config updates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.upsertRuleSet({
      name: 'project-alpha',
      scope: 'project',
      rules: [{ text: 'Use dataset alpha v1.' }],
      source: 'test',
    });
    store.createTeam('runtime', 'Runtime team');

    const updated = store.updateTeamConfig('runtime', {
      ruleSetRefs: ['project-alpha'],
    })!;
    expect(updated.ruleSetRefs).toEqual([{ name: 'project-alpha', version: 1 }]);

    store.upsertRuleSet({
      name: 'project-alpha',
      scope: 'project',
      rules: [{ text: 'Use dataset alpha v2.' }],
      source: 'test',
    });
    expect(store.getTeam('runtime')?.ruleSetRefs).toEqual([{ name: 'project-alpha', version: 1 }]);
    store.close();
  });

  it('rejects scoped instances when declared RuleSet refs are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.upsertTemplateFromConfig({
      name: 'research',
      ruleSetRefs: ['missing-rules'],
      agents: [{ name: 'planner', engine: 'codex' }],
    }, 'test');

    expect(() => store.resolveTeamInstance({
      templateName: 'research',
      chatId: 'oc_project_a',
    })).toThrow(/RuleSet not found/);
    store.close();
  });

  it('exports templates, diffs versions, and stops expired temporary agents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const v1 = store.upsertTemplateFromConfig({
      name: 'research',
      description: 'v1',
      agents: [{ name: 'planner', prompt: 'Plan v1' }],
      ruleSetRefs: [{ name: 'dev-global', version: 1 }],
    }, 'test');
    const v2 = store.upsertTemplateFromConfig({
      name: 'research',
      description: 'v2',
      agents: [
        { name: 'planner', prompt: 'Plan v2' },
        { name: 'reviewer', prompt: 'Review' },
      ],
      ruleSetRefs: [{ name: 'dev-global', version: 2 }],
    }, 'test');

    expect(store.exportTemplate('research', v1.version)).toMatchObject({
      name: 'research',
      version: 1,
      body: { ruleSetRefs: [{ name: 'dev-global', version: 1 }] },
    });
    expect(store.diffTemplateVersions('research', v1.version, v2.version)).toMatchObject({
      name: 'research',
      changed: true,
      summary: {
        addedAgents: ['reviewer'],
        changedAgents: ['planner'],
        ruleSetRefsChanged: true,
        descriptionChanged: true,
      },
    });

    store.createTeam('runtime', 'Runtime team');
    store.createAgent('runtime', {
      name: 'temp',
      kind: 'temporary',
      actorRole: 'pm',
      ttlMs: 1,
    });
    const expired = store.stopExpiredTemporaryAgents(Date.now() + 10);
    expect(expired.map((agent) => agent.name)).toEqual(['temp']);
    expect(store.getAgent('runtime', 'temp')).toMatchObject({ status: 'stopped' });
    store.close();
  });

  it('enforces agent creation permissions and quotas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.createTeam('quota', 'Quota team', { quotas: { maxAgents: 2, maxTemporaryAgents: 1 } });

    store.createAgent('quota', { name: 'planner', actorRole: 'pm' });
    expect(() => store.createAgent('quota', { name: 'manager-created', actorRole: 'manager' }))
      .toThrow(/not allowed/);
    store.createAgent('quota', { name: 'temp-1', kind: 'temporary', actorRole: 'pm' });
    expect(() => store.createAgent('quota', { name: 'temp-2', kind: 'temporary', actorRole: 'pm' }))
      .toThrow(/quota exceeded/i);
    store.close();
  });

  it('enforces scoped team, queue, and active run quotas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.upsertTemplateFromConfig({ name: 'research-a', agents: [{ name: 'planner' }] }, 'test');
    store.upsertTemplateFromConfig({ name: 'research-b', agents: [{ name: 'planner' }] }, 'test');
    store.upsertTemplateFromConfig({ name: 'research-c', agents: [{ name: 'planner' }] }, 'test');
    store.resolveTeamInstance({ templateName: 'research-a', chatId: 'oc_project', quotas: { maxTeamsPerScope: 2 } });
    store.resolveTeamInstance({ templateName: 'research-b', chatId: 'oc_project', quotas: { maxTeamsPerScope: 2 } });
    expect(() => store.resolveTeamInstance({ templateName: 'research-c', chatId: 'oc_project', quotas: { maxTeamsPerScope: 2 } }))
      .toThrow(/scope quota exceeded/i);

    store.createTeam('queue-limited', 'Queue limited', { quotas: { maxQueuedTasks: 2, maxActiveRuns: 1 } });
    store.createTask('queue-limited', { subject: 'first' });
    const second = store.createTask('queue-limited', { subject: 'second' });
    expect(() => store.createTask('queue-limited', { subject: 'third' }))
      .toThrow(/queue quota exceeded/i);
    store.updateTask('queue-limited', second.id, { status: 'completed' });
    expect(store.createTask('queue-limited', { subject: 'third' })).toMatchObject({ subject: 'third' });
    expect(() => store.updateTask('queue-limited', second.id, { status: 'pending' }))
      .toThrow(/queue quota exceeded/i);

    const running = store.createRun('queue-limited', { agentName: 'planner' });
    expect(() => store.createRun('queue-limited', { agentName: 'reviewer' }))
      .toThrow(/active run quota exceeded/i);
    expect(store.createRun('queue-limited', { agentName: 'archiver', status: 'completed' })).toMatchObject({ status: 'completed' });
    store.updateRun('queue-limited', running.id, { status: 'completed' });
    expect(store.createRun('queue-limited', { agentName: 'reviewer' })).toMatchObject({ status: 'running' });
    const completedArchiver = store.listRuns('queue-limited').find((run) => run.agentName === 'archiver')!;
    expect(() => store.updateRun('queue-limited', completedArchiver.id, { status: 'running' }))
      .toThrow(/active run quota exceeded/i);

    store.createTeam('parallel-limited', 'Parallel limited', { quotas: { maxActiveRuns: 3, maxParallelRunsPerAgent: 1 } });
    store.createRun('parallel-limited', { agentName: 'planner' });
    expect(() => store.createRun('parallel-limited', { agentName: 'planner' }))
      .toThrow(/per-agent run quota exceeded/i);
    expect(store.createRun('parallel-limited', { agentName: 'reviewer' })).toMatchObject({ status: 'running' });
    const completedPlanner = store.createRun('parallel-limited', { agentName: 'planner', status: 'completed' });
    expect(() => store.updateRun('parallel-limited', completedPlanner.id, { status: 'running' }))
      .toThrow(/per-agent run quota exceeded/i);
    store.close();
  });

  it('requires PM/user/admin approval before applying template or RuleSet proposals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const ruleProposal = store.createPromotionProposal({
      kind: 'ruleset',
      requestedBy: 'research-manager',
      requestedByRole: 'manager',
      summary: 'Share code-change rule',
      body: {
        name: 'dev-global',
        scope: 'global',
        rules: [{ text: 'Update docs and MetaMemory after code changes.', overridable: false }],
      },
    });
    expect(ruleProposal).toMatchObject({
      kind: 'ruleset',
      targetName: 'dev-global',
      status: 'pending',
      requestedByRole: 'manager',
    });
    expect(store.getRuleSet('dev-global')).toBeUndefined();
    expect(() => store.decidePromotionProposal(ruleProposal.id, {
      decision: 'approved',
      actorRole: 'manager',
      decidedBy: 'research-manager',
    })).toThrow(/not allowed/);

    const approved = store.decidePromotionProposal(ruleProposal.id, {
      decision: 'approved',
      actorRole: 'pm',
      decidedBy: 'pm-codex',
      reason: 'Rule is global and stable.',
    });
    expect(approved).toMatchObject({
      status: 'approved',
      appliedVersion: 1,
      decidedBy: 'pm-codex',
    });
    expect(store.getRuleSet('dev-global')).toMatchObject({
      version: 1,
      source: `proposal:${ruleProposal.id}`,
      rules: [{ text: 'Update docs and MetaMemory after code changes.', overridable: false }],
    });

    const templateProposal = store.createPromotionProposal({
      kind: 'template',
      requestedBy: 'reviewer',
      requestedByRole: 'agent',
      body: {
        name: 'research',
        agents: [{ name: 'planner', prompt: 'Plan carefully.' }],
      },
    });
    const rejected = store.decidePromotionProposal(templateProposal.id, {
      decision: 'rejected',
      actorRole: 'user',
      decidedBy: 'human',
      reason: 'Needs more review.',
    });
    expect(rejected).toMatchObject({ status: 'rejected', decidedBy: 'human' });
    expect(store.getTemplateVersion('research')).toBeUndefined();
    expect(store.listPromotionProposals('pending')).toEqual([]);
    expect(store.listPromotionProposals('approved').map((proposal) => proposal.id)).toEqual([ruleProposal.id]);
    expect(() => store.createPromotionProposal({
      kind: 'ruleset',
      requestedBy: 'worker',
      requestedByRole: 'worker',
      body: {
        name: 'worker-proposed',
        scope: 'worker',
        rules: [{ text: 'Untrusted worker proposal.' }],
      },
    })).toThrow(/not allowed to create promotion proposals/);
    store.close();
  });

  it('builds a rules context pack with provenance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const global = store.upsertRuleSet({
      name: 'dev-global',
      scope: 'global',
      rules: [{ text: 'Update docs and MetaMemory after code changes.', overridable: false }],
      source: 'test',
    });
    const project = store.upsertRuleSet({
      name: 'project-a',
      scope: 'project',
      rules: [{ text: 'Use project dataset path /data/a.' }],
      source: 'test',
    });

    const pack = store.buildRulesContextPack({
      refs: [
        { name: project.name, version: project.version },
        { name: global.name, version: global.version },
      ],
      inlineRules: [{ text: 'Run the focused store tests.' }],
    });

    expect(pack.provenance.map((item) => item.scope)).toEqual(['global', 'project']);
    expect(pack.text).toContain('Update docs and MetaMemory after code changes. [locked]');
    expect(pack.text).toContain('Run the focused store tests.');
    store.close();
  });

  it('builds runtime rules packs from global, bot, and chat instance refs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.upsertRuleSet({
      name: 'dev-global',
      scope: 'global',
      rules: [{ text: 'Global v1' }],
      source: 'test',
    });
    store.upsertRuleSet({
      name: 'dev-global',
      scope: 'global',
      rules: [{ text: 'Global v2' }],
      source: 'test',
    });
    store.upsertRuleSet({
      name: 'bot:pm-codex',
      scope: 'bot',
      rules: [{ text: 'PM Codex bot rule' }],
      source: 'test',
    });
    const teamRules = store.upsertRuleSet({
      name: 'research-team',
      scope: 'team-instance',
      rules: [{ text: 'Project team rule' }],
      source: 'test',
    });
    store.createTeam('runtime', 'Runtime team', {
      displayChatIds: ['oc_project'],
      ruleSetRefs: [{ name: teamRules.name, version: teamRules.version }],
    });

    const pack = store.buildRuntimeRulesContextPack({
      purpose: 'bot-turn',
      botName: 'pm-codex',
      chatId: 'oc_project',
    });

    expect(pack.text).toContain('Global v2');
    expect(pack.text).not.toContain('Global v1');
    expect(pack.text).toContain('PM Codex bot rule');
    expect(pack.text).toContain('Project team rule');
    expect(pack.text).toContain('Bot turn boundary');
    expect(pack.provenance.map((item) => `${item.scope}:${item.name}@v${item.version}`)).toEqual([
      'global:dev-global@v2',
      'bot:bot:pm-codex@v1',
      'team-instance:research-team@v1',
    ]);
    store.close();
  });

  it('selects first-class agent-role and worker RuleSets for runtime packs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.upsertRuleSet({
      name: 'manager',
      scope: 'agent-role',
      rules: [{ text: 'Manager must coordinate and request PM approval.' }],
      source: 'test',
    });
    store.upsertRuleSet({
      name: 'role:reviewer',
      scope: 'agent-role',
      rules: [{ text: 'Reviewer must check tests and risks.' }],
      source: 'test',
    });
    store.upsertRuleSet({
      name: 'worker',
      scope: 'worker',
      rules: [{ text: 'All workers must return structured output.' }],
      source: 'test',
    });
    store.upsertRuleSet({
      name: 'worker:nightly',
      scope: 'worker',
      rules: [{ text: 'Nightly workers must summarize artifacts.' }],
      source: 'test',
    });
    store.upsertRuleSet({
      name: 'unrelated-worker',
      scope: 'worker',
      rules: [{ text: 'Should not be injected.' }],
      source: 'test',
    });

    const managerPack = store.buildRuntimeRulesContextPack({
      purpose: 'agent-run',
      agentName: 'manager',
      agentRole: 'team manager',
    });
    expect(managerPack.text).toContain('Manager must coordinate and request PM approval.');
    expect(managerPack.text).not.toContain('Reviewer must check tests and risks.');
    expect(managerPack.provenance.map((item) => `${item.scope}:${item.name}@v${item.version}`)).toContain('agent-role:manager@v1');

    const reviewerPack = store.buildRuntimeRulesContextPack({
      purpose: 'agent-run',
      agentName: 'qa',
      agentRole: 'reviewer',
    });
    expect(reviewerPack.text).toContain('Reviewer must check tests and risks.');

    const workerPack = store.buildRuntimeRulesContextPack({
      purpose: 'worker-dispatch',
      botName: 'pm-codex',
      workerLabel: 'nightly',
    });
    expect(workerPack.text).toContain('All workers must return structured output.');
    expect(workerPack.text).toContain('Nightly workers must summarize artifacts.');
    expect(workerPack.text).not.toContain('Should not be injected.');
    expect(workerPack.provenance.map((item) => `${item.scope}:${item.name}@v${item.version}`)).toEqual([
      'worker:worker@v1',
      'worker:worker:nightly@v1',
    ]);
    store.close();
  });
});
