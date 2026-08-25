import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  AgentTeamGovernanceError,
  AgentTeamGovernanceExtension,
  createAgentTeamGovernanceHost,
  hasTeamGovernanceAuthority,
} from '../src/agent-teams/governance-extension.js';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';

const logger = {
  child: () => logger,
  info: () => {},
} as any;

const pm = { role: 'pm', id: 'pm-bot' } as const;
const manager = { role: 'manager', id: 'team-manager' } as const;

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-governance-'));
  const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
  const governance = new AgentTeamGovernanceExtension(
    createAgentTeamGovernanceHost(store),
    logger,
    join(dir, 'governance.db'),
  );
  return {
    store,
    governance,
    close: () => {
      governance.close();
      store.close();
    },
  };
}

function expectGovernanceError(operation: () => unknown, expected: { statusCode: number; code: string }): void {
  try {
    operation();
    throw new Error('Expected AgentTeamGovernanceError');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentTeamGovernanceError);
    expect(error).toMatchObject(expected);
  }
}

describe('AgentTeamGovernanceExtension authority', () => {
  it('lets managers coordinate existing Agents but denies privileged operations and audits denials', () => {
    const { governance, close } = makeHarness();

    expect(hasTeamGovernanceAuthority('manager', 'coordinate_existing_agents')).toBe(true);
    for (const role of ['admin', 'user', 'pm'] as const) {
      expect(hasTeamGovernanceAuthority(role, 'create_agent')).toBe(true);
      expect(hasTeamGovernanceAuthority(role, 'stop_run')).toBe(true);
      expect(hasTeamGovernanceAuthority(role, 'promote_rules')).toBe(true);
    }
    expect(hasTeamGovernanceAuthority('agent', 'coordinate_existing_agents')).toBe(true);
    expect(hasTeamGovernanceAuthority('worker', 'create_agent')).toBe(false);
    for (const action of [
      'create_team',
      'start_team',
      'stop_team',
      'delete_team',
      'create_agent',
      'stop_agent',
      'delete_agent',
      'stop_run',
      'dispatch_worker',
      'restart_service',
      'update_service',
      'promote_template',
      'promote_rules',
    ] as const) {
      expect(hasTeamGovernanceAuthority('manager', action)).toBe(false);
    }

    governance.authorize(manager, 'coordinate_existing_agents', { teamName: 'existing' });
    expectGovernanceError(
      () => governance.authorize(manager, 'create_agent', { teamName: 'existing', subject: 'new-agent' }),
      { statusCode: 403, code: 'AUTHORITY_DENIED' },
    );
    expectGovernanceError(() => governance.publishTemplate({ actor: manager, name: 'managed', body: {} }), {
      statusCode: 403,
      code: 'AUTHORITY_DENIED',
    });
    expectGovernanceError(() => (governance as any).authorize(undefined, 'create_agent'), {
      statusCode: 401,
      code: 'TRUSTED_PRINCIPAL_REQUIRED',
    });

    expect(governance.listAudit().map((event) => event.eventType)).toEqual([
      'authority.denied',
      'authority.denied',
      'authority.denied',
      'authority.allowed',
    ]);
    close();
  });
});

describe('AgentTeamGovernanceExtension templates and scope', () => {
  it('fails startup reconciliation when a pinned Template digest no longer matches stored content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-governance-corrupt-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    const governancePath = join(dir, 'governance.db');
    const governance = new AgentTeamGovernanceExtension(createAgentTeamGovernanceHost(store), logger, governancePath);
    governance.publishTemplate({ actor: pm, name: 'digest-check', body: { description: 'original' } });
    governance.resolveInstance({ actor: pm, templateName: 'digest-check', chatId: 'oc_digest' });
    governance.close();

    const db = new Database(governancePath);
    db.prepare("UPDATE agent_team_governance_templates SET body_json = ? WHERE name = 'digest-check'").run(
      JSON.stringify({ description: 'tampered' }),
    );
    db.close();

    const reopened = new AgentTeamGovernanceExtension(createAgentTeamGovernanceHost(store), logger, governancePath);
    expectGovernanceError(() => reopened.reconcile(), { statusCode: 500, code: 'TEMPLATE_DIGEST_MISMATCH' });
    reopened.close();
    store.close();
  });

  it('repairs a crash orphan with no governance row and cleanly recreates it on demand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-governance-orphan-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    const governancePath = join(dir, 'governance.db');
    const governance = new AgentTeamGovernanceExtension(createAgentTeamGovernanceHost(store), logger, governancePath);
    governance.publishTemplate({ actor: pm, name: 'crash-repair', body: { agents: [{ name: 'coder' }] } });
    const original = governance.resolveInstance({ actor: pm, templateName: 'crash-repair', chatId: 'oc_crash' })!;
    governance.close();

    const db = new Database(governancePath);
    db.prepare('DELETE FROM agent_team_governance_instances WHERE id = ?').run(original.id);
    db.close();

    const reopened = new AgentTeamGovernanceExtension(createAgentTeamGovernanceHost(store), logger, governancePath);
    expect(reopened.reconcile().stoppedOrphans).toEqual([original.teamName]);
    expect(store.getTeam(original.teamName)).toMatchObject({ status: 'stopped' });
    const recreated = reopened.resolveInstance({ actor: pm, templateName: 'crash-repair', chatId: 'oc_crash' })!;
    expect(recreated).toMatchObject({ id: original.id, teamName: original.teamName, status: 'active' });
    expect(store.getAgent(original.teamName, 'coder')).toBeDefined();
    reopened.close();
    store.close();
  });

  it('uses safe deterministic names and repairs stop, delete, recreate, orphan, and missing-upstream states', () => {
    const { store, governance, close } = makeHarness();
    governance.publishTemplate({
      actor: pm,
      name: 'Runtime / Team @ One',
      body: { agents: [{ name: 'lead', role: 'manager' }] },
    });
    const instance = governance.resolveInstance({
      actor: pm,
      templateName: 'Runtime / Team @ One',
      chatId: 'oc:unsafe/@chat',
    })!;
    expect(instance.teamName).toMatch(/^[a-z0-9._-]+$/);
    expect(instance.teamName).not.toMatch(/[@/:]/);

    expect(governance.stopInstance(pm, instance.id)).toMatchObject({ status: 'stopped' });
    expect(store.getTeam(instance.teamName)).toMatchObject({ status: 'stopped' });
    expectGovernanceError(() => governance.reactivateInstance(manager, instance.id), {
      statusCode: 403,
      code: 'AUTHORITY_DENIED',
    });
    expect(
      governance.resolveInstance({
        actor: pm,
        templateName: 'Runtime / Team @ One',
        chatId: 'oc:unsafe/@chat',
      }),
    ).toMatchObject({ id: instance.id, status: 'active' });

    store.deleteTeam(instance.teamName);
    expect(governance.reconcile().recreatedTeams).toEqual([instance.teamName]);
    expect(store.getAgent(instance.teamName, 'lead')).toBeDefined();

    store.createTeam('atg-legacy-compatible');
    expect(governance.reconcile().stoppedOrphans).toEqual([]);
    expect(store.getTeam('atg-legacy-compatible')).toMatchObject({ status: 'active' });

    expect(governance.deleteInstance(pm, instance.id)).toBe(true);
    expect(store.getTeam(instance.teamName)).toBeUndefined();
    const recreated = governance.resolveInstance({
      actor: pm,
      templateName: 'Runtime / Team @ One',
      chatId: 'oc:unsafe/@chat',
    })!;
    expect(recreated.id).toBe(instance.id);
    expect(recreated.teamName).toBe(instance.teamName);
    close();
  });

  it('pins template and RuleSet versions and keeps global fallback opt-in', () => {
    const { store, governance, close } = makeHarness();

    const rulesV1 = governance.publishRuleSet({
      actor: pm,
      name: 'implementation-policy',
      scope: 'team-template',
      rules: [{ id: 'r1', text: 'Keep changes focused.' }],
    });
    const templateV1 = governance.publishTemplate({
      actor: pm,
      name: 'implementation',
      body: {
        description: 'Implementation team v1',
        agents: [{ name: 'coder', engine: 'codex', model: '  gpt-5.5  ', prompt: 'Implement approved changes.' }],
        ruleSetRefs: [{ name: 'implementation-policy' }],
      },
    });

    const chat = governance.resolveInstance({
      actor: pm,
      templateName: 'implementation',
      chatId: 'oc_chat_a',
      pmBot: 'pm-codex',
    })!;
    expect(chat).toMatchObject({
      templateVersion: templateV1.version,
      templateDigest: templateV1.digest,
      scopeType: 'chat',
      scopeKey: 'oc_chat_a',
      ruleSetRefs: [{ name: 'implementation-policy', version: rulesV1.version, digest: rulesV1.digest }],
    });
    expect(store.getTeam(chat.teamName)?.displayChatIds).toEqual(['oc_chat_a']);
    expect(store.getAgent(chat.teamName, 'coder')).toMatchObject({
      status: 'idle',
      engine: 'codex',
      model: 'gpt-5.5',
    });
    expect(governance.prepareRun(chat.teamName, 'coder', 'run-1')).toEqual({
      instanceId: chat.id,
      chatId: `teaminst:${chat.id}:coder`,
      executionBot: 'pm-codex',
    });
    expect(governance.buildRulesContext(chat.id, { agentName: 'coder' })).toMatchObject({
      text: expect.stringContaining('Keep changes focused.'),
      provenance: [{ name: 'implementation-policy', version: rulesV1.version, digest: rulesV1.digest }],
    });

    const rulesV2 = governance.publishRuleSet({
      actor: pm,
      name: 'implementation-policy',
      scope: 'team-template',
      rules: [{ id: 'r1', text: 'Keep changes focused and tested.' }],
    });
    const templateV2 = governance.publishTemplate({
      actor: pm,
      name: 'implementation',
      body: {
        description: 'Implementation team v2',
        agents: [{ name: 'coder', engine: 'codex', prompt: 'Implement and test approved changes.' }],
        ruleSetRefs: [{ name: 'implementation-policy' }],
      },
    });
    expect(templateV2.version).toBe(templateV1.version + 1);
    expect(rulesV2.version).toBe(rulesV1.version + 1);
    const teamsBeforeMissingPin = store.listTeams().length;
    expectGovernanceError(
      () =>
        governance.resolveInstance({
          actor: pm,
          templateName: 'implementation',
          templateVersion: 99,
          chatId: 'oc_missing_pin',
        }),
      { statusCode: 404, code: 'TEMPLATE_NOT_FOUND' },
    );
    expect(store.listTeams()).toHaveLength(teamsBeforeMissingPin);

    const sameChat = governance.resolveInstance({
      actor: manager,
      templateName: 'implementation',
      chatId: 'oc_chat_a',
    })!;
    expect(sameChat.id).toBe(chat.id);
    expect(sameChat.templateVersion).toBe(templateV1.version);
    expect(sameChat.ruleSetRefs[0].version).toBe(rulesV1.version);
    expect(governance.buildRulesContext(sameChat.id, { agentName: 'coder' }).text).not.toContain('focused and tested');

    const otherChat = governance.resolveInstance({
      actor: pm,
      templateName: 'implementation',
      chatId: 'oc_chat_b',
    })!;
    const isolatedTask = store.createTask(chat.teamName, { subject: 'chat-a only', owner: 'coder' });
    store.sendMessage(chat.teamName, { fromName: 'lead', toName: 'coder', body: 'chat-a only' });
    store.createRun(chat.teamName, { agentName: 'coder', taskId: isolatedTask.id });
    expect(otherChat.teamName).not.toBe(chat.teamName);
    expect(store.listTasks(otherChat.teamName)).toEqual([]);
    expect(store.listMessages(otherChat.teamName)).toEqual([]);
    expect(store.listRuns(otherChat.teamName)).toEqual([]);

    const project = governance.resolveInstance({
      actor: pm,
      templateName: 'implementation',
      scopeType: 'project',
      projectId: 'project-a',
    })!;
    expect(project).toMatchObject({ templateVersion: templateV2.version, scopeType: 'project', scopeKey: 'project-a' });
    expect(project.ruleSetRefs[0].version).toBe(rulesV2.version);
    expect(
      governance.resolveInstance({
        actor: manager,
        templateName: 'implementation',
        scopeType: 'project',
        projectId: 'project-a',
      })?.id,
    ).toBe(project.id);
    expect(
      governance.findInstanceForContext({
        templateName: 'implementation',
        chatId: 'oc_chat_a',
        projectId: 'project-a',
      })?.id,
    ).toBe(chat.id);

    expectGovernanceError(
      () => governance.resolveInstance({ actor: pm, templateName: 'implementation', scopeType: 'global' }),
      { statusCode: 400, code: 'GLOBAL_SCOPE_REQUIRES_OPT_IN' },
    );
    expectGovernanceError(
      () =>
        governance.resolveInstance({
          actor: pm,
          templateName: 'implementation',
          scopeType: 'global',
          scopeKey: 'implicit-tenant',
          allowGlobal: true,
        }),
      { statusCode: 400, code: 'INVALID_GLOBAL_SCOPE_KEY' },
    );
    const global = governance.resolveInstance({
      actor: pm,
      templateName: 'implementation',
      scopeType: 'global',
      allowGlobal: true,
    })!;
    expect(governance.findInstanceForContext({ templateName: 'implementation' })).toBeUndefined();
    expect(
      governance.findInstanceForContext({
        templateName: 'implementation',
        includeGlobal: true,
      })?.id,
    ).toBe(global.id);
    close();
  });

  it('filters exact Agent and role targets and rejects ambiguous target syntax', () => {
    const { governance, close } = makeHarness();
    governance.publishRuleSet({
      actor: pm,
      name: 'targeted-policy',
      scope: 'team-instance',
      rules: [
        { id: 'all', text: 'Visible to every Agent.' },
        { id: 'coder', text: 'Coder only.', target: 'coder' },
        { id: 'review-role', text: 'Review role only.', target: 'role:review' },
        { id: 'other', text: 'Other Agent only.', target: 'agent:other' },
      ],
    });
    governance.publishTemplate({
      actor: pm,
      name: 'targeted-team',
      body: {
        agents: [
          { name: 'coder', role: 'implementation' },
          { name: 'reviewer', role: 'review' },
        ],
        ruleSetRefs: [{ name: 'targeted-policy' }],
      },
    });
    const instance = governance.resolveInstance({
      actor: pm,
      templateName: 'targeted-team',
      chatId: 'oc_targeted',
    })!;

    const coder = governance.buildRulesContext(instance.id, { agentName: 'coder', agentRole: 'implementation' });
    expect(coder.text).toContain('Visible to every Agent.');
    expect(coder.text).toContain('Coder only.');
    expect(coder.text).not.toContain('Review role only.');
    expect(coder.text).not.toContain('Other Agent only.');
    expect(coder.provenance[0]).toMatchObject({ ruleCount: 4, selectedRuleCount: 2 });

    const reviewer = governance.buildRulesContext(instance.id, { agentName: 'reviewer', agentRole: 'review' });
    expect(reviewer.text).toContain('Visible to every Agent.');
    expect(reviewer.text).toContain('Review role only.');
    expect(reviewer.text).not.toContain('Coder only.');
    expect(reviewer.provenance[0]).toMatchObject({ ruleCount: 4, selectedRuleCount: 2 });

    expectGovernanceError(
      () => governance.publishRuleSet({
        actor: pm,
        name: 'invalid-target',
        scope: 'team-instance',
        rules: [{ text: 'Must not broadcast.', target: 'agent:*' }],
      }),
      { statusCode: 400, code: 'INVALID_RULE_TARGET' },
    );
    close();
  });

  it('isolates project scopes and enforces the per-scope Team quota', () => {
    const { governance, close } = makeHarness();
    governance.publishTemplate({
      actor: pm,
      name: 'first',
      body: { quotas: { maxTeamsPerScope: 1 } },
    });
    governance.publishTemplate({
      actor: pm,
      name: 'second',
      body: { quotas: { maxTeamsPerScope: 1 } },
    });

    const first = governance.resolveInstance({
      actor: pm,
      templateName: 'first',
      scopeType: 'project',
      projectId: 'project-a',
    })!;
    expectGovernanceError(
      () =>
        governance.resolveInstance({
          actor: pm,
          templateName: 'second',
          scopeType: 'project',
          projectId: 'project-a',
        }),
      { statusCode: 409, code: 'SCOPE_TEAM_QUOTA_EXCEEDED' },
    );
    const otherProject = governance.resolveInstance({
      actor: pm,
      templateName: 'second',
      scopeType: 'project',
      projectId: 'project-b',
    })!;
    expect(otherProject.scopeKey).not.toBe(first.scopeKey);
    close();
  });
});

describe('AgentTeamGovernanceExtension quotas and TTL recycling', () => {
  it('bounds temporary Agents, stops expired leases, and reuses the stopped upstream slot', () => {
    const { store, governance, close } = makeHarness();
    governance.publishTemplate({
      actor: pm,
      name: 'temporary-agents',
      body: {
        agents: [{ name: 'resident', engine: 'codex' }],
        quotas: { maxAgents: 3, maxTemporaryAgents: 1 },
        temporaryAgentIdleMs: 500,
      },
    });
    const instance = governance.resolveInstance({
      actor: pm,
      templateName: 'temporary-agents',
      chatId: 'oc_ttl',
    })!;

    const firstLease = governance.createAgent({
      actor: pm,
      instanceId: instance.id,
      name: 'burst',
      engine: 'codex',
      kind: 'temporary',
      ttlMs: 1_000,
    });
    expect(firstLease.expiresAt).toBeGreaterThan(firstLease.createdAt);
    expectGovernanceError(
      () =>
        governance.createAgent({
          actor: pm,
          instanceId: instance.id,
          name: 'burst-two',
          kind: 'temporary',
          ttlMs: 1_000,
        }),
      { statusCode: 409, code: 'TEAM_QUOTA_EXCEEDED' },
    );

    const task = store.createTask(instance.teamName, { subject: 'temporary work', owner: 'burst' });
    store.updateTask(instance.teamName, task.id, { status: 'in_progress' });
    const run = store.createRun(instance.teamName, { agentName: 'burst', taskId: task.id });
    const recycled = governance.reapExpired(firstLease.expiresAt!);
    expect(recycled).toMatchObject([
      {
        lease: { id: firstLease.id, agentName: 'burst', recycledAt: firstLease.expiresAt },
        reason: 'ttl_expired',
        runningRuns: [{ runId: run.id, taskId: task.id }],
      },
    ]);
    expect(store.getAgent(instance.teamName, 'burst')).toMatchObject({ status: 'stopped' });
    store.updateRun(instance.teamName, run.id, { status: 'stopped' });

    const reused = governance.createAgent({
      actor: pm,
      instanceId: instance.id,
      name: 'burst',
      kind: 'temporary',
      ttlMs: 2_000,
    });
    expect(reused.id).not.toBe(firstLease.id);
    expect(store.getAgent(instance.teamName, 'burst')).toMatchObject({ status: 'idle' });
    governance.touchAgent(instance.id, 'burst', reused.createdAt + 400);
    expect(governance.reapExpired(reused.createdAt + 899)).toEqual([]);
    expect(governance.reapExpired(reused.createdAt + 900)).toMatchObject([
      { lease: { id: reused.id }, reason: 'idle_expired', runningRuns: [] },
    ]);
    expect(governance.listAudit({ instanceId: instance.id }).map((event) => event.eventType)).toContain('agent.reused');
    const reapEvents = governance
      .listAudit({ instanceId: instance.id })
      .filter((event) => event.eventType === 'agent.reaped');
    expect(reapEvents.map((event) => event.details.reason)).toEqual(['idle_expired', 'ttl_expired']);
    close();
  });

  it('exposes narrow queue and Run guards for upstream createTask/createRun hooks', () => {
    const { store, governance, close } = makeHarness();
    governance.publishTemplate({
      actor: pm,
      name: 'bounded-runs',
      body: {
        agents: [{ name: 'coder', engine: 'codex' }],
        tasks: [{ subject: 'already queued', owner: 'coder' }],
        quotas: { maxQueuedTasks: 1, maxActiveRuns: 1, maxParallelRunsPerAgent: 1 },
      },
    });
    const instance = governance.resolveInstance({
      actor: pm,
      templateName: 'bounded-runs',
      chatId: 'oc_quota',
    })!;

    expectGovernanceError(() => governance.assertCanQueueTask(instance.id), {
      statusCode: 409,
      code: 'TEAM_QUOTA_EXCEEDED',
    });
    store.createRun(instance.teamName, { agentName: 'coder', taskId: 1 });
    expectGovernanceError(() => governance.assertCanStartRun(instance.id, 'coder'), {
      statusCode: 409,
      code: 'TEAM_QUOTA_EXCEEDED',
    });
    const otherInstance = governance.resolveInstance({
      actor: pm,
      templateName: 'bounded-runs',
      chatId: 'oc_quota_other',
    })!;
    expect(() => governance.assertCanStartRun(otherInstance.id, 'coder')).not.toThrow();
    expect(governance.listAudit({ instanceId: instance.id })[0]).toMatchObject({
      eventType: 'quota.denied',
      actorRole: 'system',
    });
    close();
  });
});
