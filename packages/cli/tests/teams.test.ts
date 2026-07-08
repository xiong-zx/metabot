import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.API_PORT = '9100';
  process.env.API_SECRET = 'test-secret';
  delete process.env.METABOT_URL;
  delete process.env.METABOT_TEAM_AGENT;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIG_ENV };
});

async function importFresh(): Promise<typeof import('../src/teams.js')> {
  vi.resetModules();
  return await import('../src/teams.js');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function calls(fetchMock: typeof fetch): [string, RequestInit][] {
  return (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
}

describe('metabot teams CLI ergonomics', () => {
  it('agents spawn defaults new Agents to Codex', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ name: 'worker', engine: 'codex' })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run([
      'agents',
      'spawn',
      'demo',
      'worker',
      '--role',
      'runtime',
      '--model',
      'gpt-5.5',
      '--reasoning-effort',
      'xhigh',
      '--approval-policy',
      'never',
      '--sandbox',
      'read-only',
      '--timeout-ms',
      '600000',
      '--idle-timeout-ms',
      '120000',
      '--allowed-tools',
      'Read,Grep',
      '--actor-role',
      'pm',
    ]);

    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('http://localhost:9100/api/agent-teams/demo/agents');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: 'worker',
      role: 'runtime',
      engine: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      timeoutMs: 600000,
      idleTimeoutMs: 120000,
      allowedTools: ['Read', 'Grep'],
      actorRole: 'pm',
    });
  });

  it('dispatch creates an assigned task and sends a start message', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/tasks')) return jsonResponse({ id: 42, subject: 'Fix bus', owner: 'bridge-runtime', status: 'pending' }, 201);
      if (url.endsWith('/messages')) return jsonResponse({ id: 9, toName: 'bridge-runtime', body: 'Start task #42' }, 201);
      return jsonResponse({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run([
      'dispatch',
      'metabot-core-chat',
      'bridge-runtime',
      'Fix bus',
      '--description',
      'Use relay.',
    ]);

    expect(calls(fetchMock)).toHaveLength(2);
    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/metabot-core-chat/tasks');
    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toEqual({
      subject: 'Fix bus',
      description: 'Use relay.',
      owner: 'bridge-runtime',
    });
    expect(calls(fetchMock)[1]![0]).toBe('http://localhost:9100/api/agent-teams/metabot-core-chat/messages');
    const messageBody = JSON.parse(String(calls(fetchMock)[1]![1].body));
    expect(messageBody).toMatchObject({
      toName: 'bridge-runtime',
      fromName: 'lead',
      summary: 'Task #42: Fix bus',
    });
    expect(messageBody.body).toContain('Start task #42');
    expect(stdout.mock.calls.map((c) => String(c[0])).join('')).toContain('"task"');
  });

  it('dispatch can print a concise plain summary', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/tasks')) return jsonResponse({ id: 42, subject: 'Fix bus', owner: 'bridge-runtime', status: 'pending' }, 201);
      if (url.endsWith('/messages')) return jsonResponse({ id: 9, toName: 'bridge-runtime', body: 'Start task #42' }, 201);
      return jsonResponse({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['dispatch', 'metabot-core-chat', 'bridge-runtime', 'Fix bus', '--plain']);

    const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('Dispatched task #42 to bridge-runtime: Fix bus');
    expect(printed).toContain('Message #9 sent to bridge-runtime');
    expect(printed).not.toContain('"task"');
  });

  it('next returns unread messages and open assigned tasks, then marks read with --read', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: 1, toName: 'worker', body: 'ping' }] });
      if (url.endsWith('/tasks')) {
        return jsonResponse({
          tasks: [
            { id: 2, owner: 'worker', status: 'pending', subject: 'owned' },
            { id: 3, owner: 'other', status: 'pending', subject: 'other' },
            { id: 4, owner: 'worker', status: 'completed', subject: 'done' },
          ],
        });
      }
      if (url.includes('/messages/read')) return jsonResponse({ read: 1 });
      return jsonResponse({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['next', 'demo', 'worker', '--read']);

    expect(calls(fetchMock).map(([url]) => url)).toEqual([
      'http://localhost:9100/api/agent-teams/demo/messages?to=worker&unread=1',
      'http://localhost:9100/api/agent-teams/demo/tasks',
      'http://localhost:9100/api/agent-teams/demo/messages/read?to=worker',
    ]);
    const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('"unreadMessages"');
    expect(printed).toContain('"assignedTasks"');
    expect(printed).toContain('"id": 2');
    expect(printed).not.toContain('"id": 3');
  });

  it('status, tasks list, runs list, and inbox support concise summaries', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://localhost:9100/api/agent-teams/demo') {
        return jsonResponse({
          team: { name: 'demo', status: 'active', description: 'Demo team' },
          agents: [{ name: 'worker', status: 'idle', engine: 'codex' }],
          tasks: [{ id: 1, owner: 'worker', status: 'pending', subject: 'Ship CLI' }],
          unreadMessages: 2,
          runs: [{ id: 'run-1', agentName: 'worker', status: 'completed', output: 'done' }],
        });
      }
      if (url === 'http://localhost:9100/api/agent-teams/demo/tasks') {
        return jsonResponse({ tasks: [{ id: 1, owner: 'worker', status: 'pending', subject: 'Ship CLI' }] });
      }
      if (url === 'http://localhost:9100/api/agent-teams/demo/runs') {
        return jsonResponse({ runs: [{ id: 'run-1', agentName: 'worker', status: 'completed', output: 'done' }] });
      }
      if (url === 'http://localhost:9100/api/agent-teams/demo/messages?to=worker&unread=1') {
        return jsonResponse({ messages: [{ id: 3, fromName: 'lead', toName: 'worker', body: 'please start' }] });
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['status', 'demo', '--summary']);
    await mod.run(['tasks', 'list', 'demo', '--summary']);
    await mod.run(['runs', 'list', 'demo', '--summary']);
    await mod.run(['inbox', 'demo', 'worker', '--unread', '--summary']);

    const printed = stdout.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Team: demo [active]');
    expect(printed).toContain('Tasks: 1 total, 1 open');
    expect(printed).toContain('Runs: 1 total, 0 running');
    expect(printed).toContain('Inbox: 1 messages');
    expect(printed).toContain('#3 from lead please start');
  });

  it('activity lists instance-scoped card lifecycle records with filters', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://localhost:9100/api/agent-teams/ati_demo/activity?agent=reviewer&runId=run-1&taskId=7&limit=5') {
        return jsonResponse({
          activity: [{
            lifecycleKey: 'teaminst:ati_demo:reviewer:run-1',
            chatId: 'oc_project',
            source: 'agent-activity',
            teamName: 'research@chat:oc_project',
            instanceId: 'ati_demo',
            agentName: 'reviewer',
            runId: 'run-1',
            taskIds: [7],
            status: 'agent_activity',
            lifecycleStage: 'closed',
            responsePreview: 'review complete',
            updatedAt: 1234,
          }],
        });
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run([
      'activity',
      'ati_demo',
      '--agent',
      'reviewer',
      '--run-id',
      'run-1',
      '--task-id',
      '7',
      '--limit',
      '5',
      '--summary',
    ]);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/ati_demo/activity?agent=reviewer&runId=run-1&taskId=7&limit=5');
    const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('Activity: 1 records');
    expect(printed).toContain('teaminst:ati_demo:reviewer:run-1 agent_activity/closed @reviewer run=run-1 tasks=#7');
    expect(printed).toContain('review complete');
  });

  it('tasks claim uses METABOT_TEAM_AGENT when owner is omitted', async () => {
    process.env.METABOT_TEAM_AGENT = 'worker';
    const fetchMock = vi.fn(async () => jsonResponse({ id: 5, owner: 'worker', status: 'in_progress' })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['tasks', 'claim', 'demo', '5']);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/demo/tasks/5');
    expect(calls(fetchMock)[0]![1].method).toBe('PATCH');
    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toEqual({
      status: 'in_progress',
      owner: 'worker',
    });
  });

  it('tasks done, block, and reopen map to concise task updates', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['tasks', 'done', 'demo', '7', 'implemented']);
    await mod.run(['tasks', 'block', 'demo', '8', 'waiting', 'for', 'token', '--blocked-by', '7,9']);
    await mod.run(['tasks', 'reopen', 'demo', '9']);

    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toEqual({
      status: 'completed',
      result: 'implemented',
    });
    expect(JSON.parse(String(calls(fetchMock)[1]![1].body))).toEqual({
      status: 'pending',
      blockedBy: [7, 9],
      result: 'Blocked: waiting for token',
    });
    expect(JSON.parse(String(calls(fetchMock)[2]![1].body))).toEqual({
      status: 'pending',
    });
  });

  it('templates list and import use versioned template APIs', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['templates', 'list', 'research']);
    await mod.run(['templates', 'import', '{"name":"research","agents":[{"name":"planner"}]}', '--source', 'test', '--actor-role', 'pm']);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/templates/research');
    expect(calls(fetchMock)[0]![1].method).toBe('GET');
    expect(calls(fetchMock)[1]![0]).toBe('http://localhost:9100/api/agent-teams/templates');
    expect(calls(fetchMock)[1]![1].method).toBe('POST');
    expect(JSON.parse(String(calls(fetchMock)[1]![1].body))).toEqual({
      template: { name: 'research', agents: [{ name: 'planner' }] },
      source: 'test',
      actorRole: 'pm',
    });
  });

  it('templates export and diff use versioned template APIs', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['templates', 'export', 'research', '--version', '1']);
    await mod.run(['templates', 'diff', 'research', '--from', '1', '--to', '2']);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/templates/research/export?version=1');
    expect(calls(fetchMock)[1]![0]).toBe('http://localhost:9100/api/agent-teams/templates/research/diff?from=1&to=2');
  });

  it('instances resolve defaults to chat scope and can list by template', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['instances', 'list', '--template', 'research']);
    await mod.run(['instances', 'resolve', 'research', '--chat', 'oc_project', '--pm-bot', 'pm-codex', '--actor-role', 'pm']);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/instances?template=research');
    expect(calls(fetchMock)[1]![0]).toBe('http://localhost:9100/api/agent-teams/instances/resolve');
    expect(JSON.parse(String(calls(fetchMock)[1]![1].body))).toEqual({
      templateName: 'research',
      scopeType: 'chat',
      chatId: 'oc_project',
      pmBot: 'pm-codex',
      ruleSetRefs: [],
      createIfMissing: true,
      allowGlobal: false,
      actorRole: 'pm',
    });
  });

  it('instances resolve can pin explicit RuleSet refs and config updates quotas', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['instances', 'resolve', 'research', '--chat', 'oc_project', '--rule-ref', 'project-alpha@2', '--actor-role', 'pm']);
    await mod.run([
      'config',
      'ati_demo',
      '--rule-ref',
      'project-alpha@2',
      '--pm-bot',
      'pm-codex',
      '--max-temporary-agents',
      '5',
      '--max-active-runs',
      '9',
      '--actor-role',
      'pm',
    ]);

    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toEqual({
      templateName: 'research',
      scopeType: 'chat',
      chatId: 'oc_project',
      ruleSetRefs: [{ name: 'project-alpha', version: 2 }],
      createIfMissing: true,
      allowGlobal: false,
      actorRole: 'pm',
    });
    expect(calls(fetchMock)[1]![0]).toBe('http://localhost:9100/api/agent-teams/ati_demo');
    expect(calls(fetchMock)[1]![1].method).toBe('PATCH');
    expect(JSON.parse(String(calls(fetchMock)[1]![1].body))).toEqual({
      pmBot: 'pm-codex',
      ruleSetRefs: [{ name: 'project-alpha', version: 2 }],
      quotas: {
        maxTemporaryAgents: 5,
        maxActiveRuns: 9,
      },
      actorRole: 'pm',
    });
  });

  it('rules set and context use RuleSet APIs', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['rules', 'export', 'dev-global', '--version', '1']);
    await mod.run(['rules', 'diff', 'dev-global', '--from', '1', '--to', '2']);
    await mod.run(['rules', 'import', '{"name":"worker","scope":"worker","rules":[{"text":"Emit JSON"}]}', '--source', 'test', '--actor-role', 'pm']);
    await mod.run(['rules', 'set', 'dev-global', '--scope', 'global', '--rule', 'Update docs', '--actor-role', 'pm']);
    await mod.run(['rules', 'context', '--ref', 'dev-global@1', '--rule', 'Run focused tests']);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/rules/dev-global/export?version=1');
    expect(calls(fetchMock)[1]![0]).toBe('http://localhost:9100/api/agent-teams/rules/dev-global/diff?from=1&to=2');
    expect(calls(fetchMock)[2]![0]).toBe('http://localhost:9100/api/agent-teams/rules');
    expect(JSON.parse(String(calls(fetchMock)[2]![1].body))).toEqual({
      name: 'worker',
      scope: 'worker',
      rules: [{ text: 'Emit JSON' }],
      source: 'test',
      actorRole: 'pm',
    });
    expect(calls(fetchMock)[3]![0]).toBe('http://localhost:9100/api/agent-teams/rules');
    expect(JSON.parse(String(calls(fetchMock)[3]![1].body))).toEqual({
      name: 'dev-global',
      scope: 'global',
      rules: [{ text: 'Update docs' }],
      source: 'cli',
      actorRole: 'pm',
    });
    expect(calls(fetchMock)[4]![0]).toBe('http://localhost:9100/api/agent-teams/rules/context');
    expect(JSON.parse(String(calls(fetchMock)[4]![1].body))).toEqual({
      refs: [{ name: 'dev-global', version: 1 }],
      inlineRules: [{ text: 'Run focused tests' }],
    });
  });

  it('proposal commands use the controlled promotion APIs', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['proposals', 'list', '--status', 'pending']);
    await mod.run([
      'proposals',
      'create',
      'ruleset',
      '{"name":"worker","scope":"worker","rules":[{"text":"Report validation"}]}',
      '--summary',
      'worker rule',
      '--by',
      'manager',
      '--role',
      'manager',
    ]);
    await mod.run(['proposals', 'approve', 'proposal-1', '--by', 'pm-codex', '--actor-role', 'pm', '--reason', 'approved']);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/proposals?status=pending');
    expect(calls(fetchMock)[0]![1].method).toBe('GET');
    expect(calls(fetchMock)[1]![0]).toBe('http://localhost:9100/api/agent-teams/proposals');
    expect(JSON.parse(String(calls(fetchMock)[1]![1].body))).toEqual({
      kind: 'ruleset',
      body: {
        name: 'worker',
        scope: 'worker',
        rules: [{ text: 'Report validation' }],
      },
      summary: 'worker rule',
      requestedBy: 'manager',
      requestedByRole: 'manager',
    });
    expect(calls(fetchMock)[2]![0]).toBe('http://localhost:9100/api/agent-teams/proposals/proposal-1/approve');
    expect(JSON.parse(String(calls(fetchMock)[2]![1].body))).toEqual({
      actorRole: 'pm',
      decidedBy: 'pm-codex',
      reason: 'approved',
    });
  });

  it('does not default CLI privileged actor role to PM', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['agents', 'spawn', 'demo', 'worker']);
    await mod.run(['proposals', 'approve', 'proposal-1', '--by', 'pm-codex']);

    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toMatchObject({
      name: 'worker',
      engine: 'codex',
    });
    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).not.toHaveProperty('actorRole');
    expect(JSON.parse(String(calls(fetchMock)[1]![1].body))).toEqual({
      decidedBy: 'pm-codex',
    });
  });
});
