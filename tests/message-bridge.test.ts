import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MessageBridge,
  isStaleSessionError,
  normalizePromptForEngine,
  extractSpontaneousSnippet,
  formatSpontaneousCardBody,
  resolvePersistentExecutorEnvDefault,
  setServiceRestartSpawnForTest,
} from '../src/bridge/message-bridge.js';
import { CodexCommandController } from '../src/bridge/codex-command-controller.js';
import { DEFAULT_CODEX_GOAL_MAX_ITERATIONS } from '../src/engines/index.js';
import { classifyBurstSource } from '../src/engines/claude/persistent-executor.js';
import type { BotConfigBase } from '../src/config.js';
import type { CardState } from '../src/types.js';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';
import { recordActiveTask } from '../src/bridge/restart-recovery.js';
import {
  getServiceRestartRequest,
  listServiceRestartRequests,
  recordServiceRestartReadiness,
  recordServiceRestartRequest,
} from '../src/bridge/restart-coordinator.js';

afterEach(() => {
  vi.useRealTimers();
  setServiceRestartSpawnForTest();
});

const mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => mockLogger,
} as any;

function makeConfig(): BotConfigBase {
  return {
    name: 'test-bot',
    engine: 'claude',
    claude: {
      defaultWorkingDirectory: '/tmp',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp/metabot-test-outputs',
      downloadsDir: '/tmp/metabot-test-downloads',
      backend: 'pty',
    },
    persistentExecutor: { enabled: true },
  };
}

function makeCodexConfig(): BotConfigBase {
  return {
    ...makeConfig(),
    engine: 'codex',
    codex: {
      model: 'gpt-5.5-codex',
    },
  } as BotConfigBase;
}

function makeSender() {
  const sent: Array<{ chatId: string; state: CardState }> = [];
  const updated: Array<{ messageId: string; state: CardState }> = [];
  const sender = {
    sent,
    updated,
    async sendCard(chatId: string, state: CardState) {
      sent.push({ chatId, state });
      return `msg-${sent.length}`;
    },
    async updateCard(messageId: string, state: CardState) {
      updated.push({ messageId, state });
      return true;
    },
    async sendQuestionCard(chatId: string, state: CardState) {
      sent.push({ chatId, state });
      return `qmsg-${sent.length}`;
    },
    async updateQuestionCard(messageId: string, state: CardState) {
      updated.push({ messageId, state });
      return true;
    },
    async sendTextNotice() {},
    async sendText() {},
    async sendImageFile() { return true; },
    async sendLocalFile() { return true; },
    async downloadImage() { return false; },
    async downloadFile() { return false; },
  };
  return sender;
}

describe('isStaleSessionError', () => {
  it('matches the GitHub issue error text', () => {
    expect(
      isStaleSessionError('Error: No conversation found with session ID: d0cfbde2-1357-4da0-acd6-ee36d1da056c'),
    ).toBe(true);
  });

  it('matches other stale session variants', () => {
    expect(isStaleSessionError('invalid session provided')).toBe(true);
    expect(isStaleSessionError('Conversation not found')).toBe(true);
  });

  it('matches Codex stale thread resume errors', () => {
    expect(
      isStaleSessionError('Error: Codex exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id ea0dd6d2-7418-4545-8427-63cc8aed81f2'),
    ).toBe(true);
  });

  it('matches conversation corruption errors (duplicate tool_result)', () => {
    expect(
      isStaleSessionError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.148.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_01TPsHXcmpuz5cAY97fM5vXv"}}'),
    ).toBe(true);
    expect(
      isStaleSessionError('each tool_use must have a single result'),
    ).toBe(true);
    expect(
      isStaleSessionError('Found multiple tool_result blocks with id: toolu_abc'),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isStaleSessionError('Task timed out (24 hour limit)')).toBe(false);
    expect(isStaleSessionError('permission denied')).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });
});

describe('normalizePromptForEngine', () => {
  it('converts slash skill invocations to Codex explicit skill syntax', () => {
    expect(normalizePromptForEngine('/metaskill ios app', 'codex')).toBe('$metaskill ios app');
    expect(normalizePromptForEngine('/skill-name', 'codex')).toBe('$skill-name');
  });

  it('leaves Codex bridge-managed slash commands untouched', () => {
    expect(normalizePromptForEngine('/goal ship it', 'codex')).toBe('/goal ship it');
    expect(normalizePromptForEngine('/background run tests', 'codex')).toBe('/background run tests');
    expect(normalizePromptForEngine('/bg run tests', 'codex')).toBe('/bg run tests');
  });

  it('leaves non-Codex and non-skill prompts unchanged', () => {
    expect(normalizePromptForEngine('/metaskill ios app', 'claude')).toBe('/metaskill ios app');
    expect(normalizePromptForEngine('/metaskill ios app', 'kimi')).toBe('/metaskill ios app');
    expect(normalizePromptForEngine('hello /metaskill', 'codex')).toBe('hello /metaskill');
    expect(normalizePromptForEngine('/bad/path', 'codex')).toBe('/bad/path');
  });
});

describe('MessageBridge between-turn questions', () => {
  it('handles Codex /goal in the bridge instead of sending it to Codex', async () => {
    const sender = makeSender() as any;
    const notices: Array<{ title: string; content: string; color?: string }> = [];
    sender.sendTextNotice = async (_chatId: string, title: string, content: string, color?: string) => {
      notices.push({ title, content, color });
    };
    const bridge = new MessageBridge(makeCodexConfig(), mockLogger, sender as any);

    await bridge.handleMessage({
      messageId: 'm1',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: '/goal ship Codex support',
    });

    expect(notices.at(-1)?.title).toContain('Goal Set');
    expect(notices.at(-1)?.content).toContain('ship Codex support');
    expect(bridge.getSessionManager().getSession('chat-1').activeGoal).toBe('ship Codex support');
  });

  it('starts the first Codex goal turn after setting a goal', async () => {
    vi.useFakeTimers();
    const sender = makeSender() as any;
    const notices: Array<{ title: string; content: string; color?: string }> = [];
    sender.sendTextNotice = async (_chatId: string, title: string, content: string, color?: string) => {
      notices.push({ title, content, color });
    };
    const session: any = {
      sessionId: undefined,
      workingDirectory: '/tmp',
      lastUsed: Date.now(),
      cumulativeTokens: 0,
      cumulativeCostUsd: 0,
      cumulativeDurationMs: 0,
    };
    const executeQuery = vi.fn(async () => {});
    const controller = new CodexCommandController({
      config: makeCodexConfig(),
      logger: mockLogger,
      sender,
      sessionManager: {
        getSession: () => session,
        setGoal: (_chatId: string, condition: string | undefined) => {
          session.activeGoal = condition;
          session.goalIterations = condition ? 0 : undefined;
          session.goalMaxIterations = condition ? DEFAULT_CODEX_GOAL_MAX_ITERATIONS : undefined;
        },
      } as any,
      outputsManager: {} as any,
      outputHandler: {} as any,
      audit: {} as any,
      runOneTurn: vi.fn() as any,
      executeQuery,
      hasRunningTask: () => false,
      hasQueuedMessages: () => false,
    });

    const handled = await controller.tryHandleBridgeCommand({
      messageId: 'm1',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: '/goal ship Codex support',
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(handled).toBe(true);
    expect(notices.at(-1)?.content).toContain(`reaches ${DEFAULT_CODEX_GOAL_MAX_ITERATIONS} iterations`);
    expect(executeQuery).toHaveBeenCalledOnce();
    expect(executeQuery.mock.calls[0][0]).toMatchObject({
      chatId: 'chat-1',
      text: 'Start working toward the active goal: ship Codex support',
    });
  });

  it('handles Codex /background list without starting a model turn', async () => {
    const sender = makeSender() as any;
    const notices: Array<{ title: string; content: string; color?: string }> = [];
    sender.sendTextNotice = async (_chatId: string, title: string, content: string, color?: string) => {
      notices.push({ title, content, color });
    };
    const bridge = new MessageBridge(makeCodexConfig(), mockLogger, sender as any);

    await bridge.handleMessage({
      messageId: 'm1',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: '/background list',
    });

    expect(notices.at(-1)?.title).toContain('Background');
    expect(notices.at(-1)?.content).toContain('No Codex background tasks');
    expect(sender.sent).toHaveLength(0);
  });

  it('treats a bare reset message as /reset instead of queueing it', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    const handledTexts: string[] = [];
    bridge.commandHandler = {
      handle: async (msg: { text: string }) => {
        handledTexts.push(msg.text);
        return true;
      },
    };

    await bridge.handleMessage({
      messageId: 'm1',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: 'reset',
    });

    expect(handledTexts).toEqual(['/reset']);
  });

  it('maps a bare service restart message to /restart service instead of queueing it', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    const handledTexts: string[] = [];
    bridge.commandHandler = {
      handle: async (msg: { text: string }) => {
        handledTexts.push(msg.text);
        return true;
      },
    };

    await bridge.handleMessage({
      messageId: 'm1',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: '重启服务',
    });

    expect(handledTexts).toEqual(['/restart service']);
  });

  it('maps a bare session restart message to /restart session instead of queueing it', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    const handledTexts: string[] = [];
    bridge.commandHandler = {
      handle: async (msg: { text: string }) => {
        handledTexts.push(msg.text);
        return true;
      },
    };

    await bridge.handleMessage({
      messageId: 'm1',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: '重启会话',
    });

    expect(handledTexts).toEqual(['/restart session']);
  });

  it('notifies active blocker chats and reuses a blocked controlled restart request', async () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-controlled-restart-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordActiveTask({
        botName: 'pm-codex',
        chatId: 'oc_busy',
        messageId: 'msg_busy',
        lifecycleKey: 'task:pm-codex:oc_busy:msg_busy',
        userPrompt: 'continue implementation and validation',
        startedAt: 1_000,
        source: 'chat',
      });

      const sender = makeSender() as any;
      const notices: Array<{ chatId: string; title: string; content: string; color?: string }> = [];
      sender.sendTextNotice = async (chatId: string, title: string, content: string, color?: string) => {
        notices.push({ chatId, title, content, color });
      };
      const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;

      const first = await bridge.scheduleControlledServiceRestart({
        chatId: 'oc_requester',
        userId: 'u1',
        reason: 'deploy tested fixes',
      });
      const second = await bridge.scheduleControlledServiceRestart({
        chatId: 'oc_requester',
        userId: 'u1',
        reason: 'deploy tested fixes',
      });

      expect(first).toMatchObject({
        scheduled: false,
        blockedBy: [expect.objectContaining({ botName: 'pm-codex', chatId: 'oc_busy' })],
      });
      expect(second.requestId).toBe(first.requestId);
      expect(listServiceRestartRequests()).toHaveLength(1);
      expect(getServiceRestartRequest(first.requestId)?.reason).toBe('deploy tested fixes');
      expect(notices[0]).toMatchObject({
        chatId: 'oc_busy',
        title: 'MetaBot Restart Requested',
        color: 'orange',
      });
      expect(notices[0]?.content).toContain(`Request ID: \`${first.requestId}\``);
      expect(notices[0]?.content).toContain(`/restart ready ${first.requestId}`);
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out blocked controlled restart requests without forcing a restart', async () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-controlled-restart-timeout-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordActiveTask({
        botName: 'pm-codex',
        chatId: 'oc_busy',
        messageId: 'msg_busy',
        lifecycleKey: 'task:pm-codex:oc_busy:msg_busy',
        userPrompt: 'long running validation',
        startedAt: Date.now() - 30_000,
        source: 'chat',
      });
      recordServiceRestartRequest({
        requestId: 'restart-expired',
        requesterBotName: 'test-bot',
        request: { chatId: 'oc_requester', userId: 'u1', reason: 'deploy tested fixes' },
        status: 'blocked',
        blockers: [{ botName: 'pm-codex', chatId: 'oc_busy' }],
        timeoutMs: 1,
        now: Date.now() - 5_000,
      });

      const sender = makeSender() as any;
      const notices: Array<{ chatId: string; title: string; content: string; color?: string }> = [];
      sender.sendTextNotice = async (chatId: string, title: string, content: string, color?: string) => {
        notices.push({ chatId, title, content, color });
      };
      const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;

      const result = await bridge.scheduleControlledServiceRestart({
        chatId: 'oc_requester',
        userId: 'u1',
        reason: 'deploy tested fixes',
      });

      expect(result).toMatchObject({
        scheduled: false,
        requestId: 'restart-expired',
        blockedBy: [expect.objectContaining({ botName: 'pm-codex', chatId: 'oc_busy' })],
      });
      expect(result.message).toContain('timed out');
      expect(getServiceRestartRequest('restart-expired')?.status).toBe('timed_out');
      expect(notices).toEqual([]);
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schedules the same controlled restart request after blocker readiness is acknowledged', async () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-controlled-restart-ready-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordActiveTask({
        botName: 'pm-codex',
        chatId: 'oc_busy',
        messageId: 'msg_busy',
        lifecycleKey: 'task:pm-codex:oc_busy:msg_busy',
        userPrompt: 'finish validation',
        startedAt: 1_000,
        source: 'chat',
      });

      const spawned: Array<{ command: string; args: string[]; options: any }> = [];
      const unref = vi.fn();
      setServiceRestartSpawnForTest(((command: string, args: string[], options: any) => {
        spawned.push({ command, args, options });
        return { unref } as any;
      }) as any);

      const sender = makeSender() as any;
      sender.sendTextNotice = async () => {};
      const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;

      const blocked = await bridge.scheduleControlledServiceRestart({
        chatId: 'oc_requester',
        userId: 'u1',
        reason: 'deploy tested fixes',
      });
      recordServiceRestartReadiness({
        requestId: blocked.requestId,
        botName: 'pm-codex',
        chatId: 'oc_busy',
        userId: 'u2',
        now: Date.now(),
      });
      const scheduled = await bridge.scheduleControlledServiceRestart({
        chatId: 'oc_requester',
        userId: 'u1',
        reason: 'deploy tested fixes',
      });

      expect(scheduled).toMatchObject({
        scheduled: true,
        requestId: blocked.requestId,
      });
      expect(getServiceRestartRequest(blocked.requestId)?.status).toBe('scheduled');
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toMatchObject({
        command: '/bin/sh',
        args: ['-lc', expect.stringContaining('pm2 restart metabot')],
      });
      expect(spawned[0].options.env.METABOT_RESTART_REQUEST_ID).toBe(blocked.requestId);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setServiceRestartSpawnForTest();
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('advances multi-question cards and resolves only after the last answer', async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    const resolved: Array<{ toolUseId: string; answers: Record<string, string> }> = [];
    bridge.persistentRegistry = {
      peek: () => ({
        resolveQuestion: (toolUseId: string, answers: Record<string, string>) => {
          resolved.push({ toolUseId, answers });
        },
      }),
    };

    await bridge.handleBetweenTurnQuestion('chat-1', {
      toolUseId: 'toolu_multi',
      questions: [
        {
          question: 'Pick a color',
          header: 'Color',
          options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }],
          multiSelect: false,
        },
        {
          question: 'Why?',
          header: 'Reason',
          options: [],
          multiSelect: false,
        },
      ],
    });

    expect(sender.sent[0].state.userPrompt).toBe('Question (1/2)');
    expect(sender.sent[0].state.pendingQuestion?.questions[0].question).toBe('Pick a color');

    await bridge.handleMessage({
      messageId: 'm1',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: '1',
    });

    expect(resolved).toEqual([]);
    expect(sender.updated.at(-1)?.state.userPrompt).toBe('Question (2/2)');
    expect(sender.updated.at(-1)?.state.responseText).toBe('> **Reply:** Red');
    expect(sender.updated.at(-1)?.state.pendingQuestion?.questions[0].question).toBe('Why?');

    await bridge.handleMessage({
      messageId: 'm2',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: 'Because it is visible',
    });

    expect(resolved).toEqual([
      {
        toolUseId: 'toolu_multi',
        answers: {
          'Pick a color': 'Red',
          'Why?': 'Because it is visible',
        },
      },
    ]);
    expect(sender.updated.at(-1)?.state.status).toBe('complete');
    expect(sender.updated.at(-1)?.state.responseText).toBe('> **Reply:** Red, Because it is visible');
  });
});

describe('MessageBridge auto-remind gating', () => {
  it('does not schedule auto-remind when the PM chat has no running worker', () => {
    const sender = makeSender();
    const bridge = new MessageBridge({ ...makeConfig(), pmPrompt: true } as BotConfigBase, mockLogger, sender as any);
    const scheduler = {
      scheduleTask: vi.fn(() => ({ id: 'rem-1' })),
      cancelTask: vi.fn(),
      listTasks: vi.fn(() => []),
    };
    bridge.setScheduler(scheduler as any);
    bridge.setWorkerManager({
      listWorkers: vi.fn(() => [
        { status: 'completed' },
        { status: 'failed' },
      ]),
    } as any);

    bridge.scheduleAutoRemind('chat-1');

    expect(scheduler.scheduleTask).not.toHaveBeenCalled();
  });

  it('schedules auto-remind only while a dispatched worker is running', () => {
    const sender = makeSender();
    const bridge = new MessageBridge({ ...makeConfig(), pmPrompt: true } as BotConfigBase, mockLogger, sender as any);
    const scheduler = {
      scheduleTask: vi.fn(() => ({ id: 'rem-1' })),
      cancelTask: vi.fn(),
      listTasks: vi.fn(() => []),
    };
    bridge.setScheduler(scheduler as any);
    bridge.setWorkerManager({
      listWorkers: vi.fn(() => [
        { status: 'completed' },
        { status: 'running' },
      ]),
    } as any);

    bridge.scheduleAutoRemind('chat-1');

    expect(scheduler.scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      botName: 'test-bot',
      chatId: 'chat-1',
      delaySeconds: 3600,
      sendCards: true,
      label: 'auto-remind-chat-1',
    }));
  });
});

describe('MessageBridge runtime rules context', () => {
  it('prepends runtime rules context to API task execution prompts', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge({ ...makeCodexConfig(), persistentExecutor: { enabled: false } } as BotConfigBase, mockLogger, sender as any);
    const dir = mkdtempSync(join(tmpdir(), 'metabot-message-bridge-rules-'));
    const store = new AgentTeamStore(mockLogger, join(dir, 'teams.db'));
    try {
      store.upsertRuleSet({
        name: 'dev-global',
        scope: 'global',
        rules: [{ text: 'Always update docs and MetaMemory when code changes.' }],
        source: 'test',
      });
      bridge.setAgentTeamStore(store);

      let executionPrompt = '';
      (bridge as any).executorForEngine = () => ({
        startExecution: vi.fn((input: any) => {
          executionPrompt = input.prompt;
          return {
            stream: (async function* () {})(),
            finish: vi.fn(),
            sendAnswer: vi.fn(),
            resolveQuestion: vi.fn(),
          };
        }),
      });

      await bridge.executeApiTask({
        chatId: 'chat-1',
        userId: 'u1',
        prompt: 'Implement feature',
        sendCards: false,
        engine: 'codex',
      });

      expect(executionPrompt).toContain('<rules-context-pack purpose="bot-turn">');
      expect(executionPrompt).toContain('Always update docs and MetaMemory when code changes.');
      expect(executionPrompt).toContain('Bot turn boundary');
      expect(executionPrompt.endsWith('Implement feature')).toBe(true);
    } finally {
      store.close();
      bridge.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MessageBridge card lifecycle', () => {
  it('persists cardless API lifecycle records by lifecycleKey', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-message-bridge-lifecycle-'));
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const sender = makeSender();
    const bridge = new MessageBridge({ ...makeCodexConfig(), persistentExecutor: { enabled: false } } as BotConfigBase, mockLogger, sender as any);
    (bridge as any).executorForEngine = () => ({
      startExecution: vi.fn(() => ({
        stream: (async function* () {})(),
        finish: vi.fn(),
        sendAnswer: vi.fn(),
        resolveQuestion: vi.fn(),
      })),
    });

    try {
      await bridge.executeApiTask({
        chatId: 'worker-abc',
        userId: 'worker-manager',
        prompt: 'Run worker task',
        sendCards: false,
        engine: 'codex',
        lifecycleKey: 'worker:abc',
      });

      const store = await import('../src/bridge/card-lifecycle-store.js');
      expect(store.getCardLifecycleRecord('worker:abc')).toMatchObject({
        botName: 'test-bot',
        chatId: 'worker-abc',
        messageId: 'worker:abc',
        source: 'api',
        status: 'error',
        lifecycleStage: 'blocked',
        userPrompt: 'Run worker task',
      });
    } finally {
      bridge.destroy();
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues API task execution when the initial card send fails', async () => {
    const sender = makeSender();
    sender.sendCard = vi.fn(async () => {
      throw new Error('Feishu 400');
    });
    const bridge = new MessageBridge({ ...makeCodexConfig(), persistentExecutor: { enabled: false } } as BotConfigBase, mockLogger, sender as any);
    const startExecution = vi.fn(() => ({
      stream: (async function* () {})(),
      finish: vi.fn(),
      sendAnswer: vi.fn(),
      resolveQuestion: vi.fn(),
    }));
    const updates: Array<{ state: CardState; messageId: string; final: boolean }> = [];
    (bridge as any).executorForEngine = () => ({ startExecution });

    try {
      const result = await bridge.executeApiTask({
        chatId: 'private-synthetic-chat',
        userId: 'u1',
        prompt: 'Run with a synthetic chat id',
        sendCards: true,
        engine: 'codex',
        onUpdate: (state, messageId, final) => updates.push({ state, messageId, final }),
      });

      expect(startExecution).toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(updates[0]).toMatchObject({
        final: false,
        state: { lifecycleStage: 'received', status: 'thinking' },
      });
      expect(updates[0].messageId).toMatch(/^api:private-synthetic-chat:\d+$/);
      expect(updates.at(-1)?.final).toBe(true);
      expect(sender.updated).toHaveLength(0);
    } finally {
      bridge.destroy();
    }
  });

  it('emits received and terminal lifecycle states for cardless API tasks', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge({ ...makeCodexConfig(), persistentExecutor: { enabled: false } } as BotConfigBase, mockLogger, sender as any);
    const states: Array<{ state: CardState; final: boolean }> = [];
    (bridge as any).executorForEngine = () => ({
      startExecution: vi.fn(() => ({
        stream: (async function* () {})(),
        finish: vi.fn(),
        sendAnswer: vi.fn(),
        resolveQuestion: vi.fn(),
      })),
    });

    try {
      const result = await bridge.executeApiTask({
        chatId: 'chat-lifecycle',
        userId: 'u1',
        prompt: 'Run a cardless task',
        sendCards: false,
        engine: 'codex',
        lifecycleKey: 'worker:task-123',
        onUpdate: (state, _messageId, final) => states.push({ state, final }),
      });

      expect(result.success).toBe(false);
      expect(states[0]).toMatchObject({
        final: false,
        state: { lifecycleStage: 'received', lifecycleKey: 'worker:task-123', status: 'thinking' },
      });
      expect(states.at(-1)).toMatchObject({
        final: true,
        state: { lifecycleStage: 'blocked', lifecycleKey: 'worker:task-123', status: 'error' },
      });
      expect(states.every(({ state }) => state.lifecycleKey === 'worker:task-123')).toBe(true);
      expect(sender.sent).toHaveLength(0);
      expect(sender.updated).toHaveLength(0);
    } finally {
      bridge.destroy();
    }
  });

  it('generates a lifecycle key for cardless API tasks when none is supplied', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge({ ...makeCodexConfig(), persistentExecutor: { enabled: false } } as BotConfigBase, mockLogger, sender as any);
    const updates: Array<{ state: CardState; messageId: string; final: boolean }> = [];
    (bridge as any).executorForEngine = () => ({
      startExecution: vi.fn(() => ({
        stream: (async function* () {})(),
        finish: vi.fn(),
        sendAnswer: vi.fn(),
        resolveQuestion: vi.fn(),
      })),
    });

    try {
      await bridge.executeApiTask({
        chatId: 'chat-generated-key',
        userId: 'u1',
        prompt: 'Run a cardless task',
        sendCards: false,
        engine: 'codex',
        onUpdate: (state, messageId, final) => updates.push({ state, messageId, final }),
      });

      const key = updates[0]?.state.lifecycleKey;
      expect(key).toMatch(/^api:chat-generated-key:\d+$/);
      expect(updates.every((update) => update.state.lifecycleKey === key)).toBe(true);
      expect(updates.every((update) => update.messageId === key)).toBe(true);
      expect(updates.at(-1)?.final).toBe(true);
    } finally {
      bridge.destroy();
    }
  });

  it('generates a closed lifecycle key for spontaneous activity cards', async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    const bridge = new MessageBridge(makeCodexConfig(), mockLogger, sender as any) as any;

    try {
      bridge.handleSpontaneousMessage('chat-spontaneous', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Background result ready.' }] },
      });
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].state.lifecycleStage).toBe('closed');
      expect(sender.sent[0].state.lifecycleKey).toMatch(/^spontaneous:chat-spontaneous:\d+$/);
    } finally {
      bridge.destroy();
    }
  });

  it('generates and persists lifecycle keys for direct agent activity cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-activity-lifecycle-'));
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const sender = makeSender();
    const bridge = new MessageBridge(makeCodexConfig(), mockLogger, sender as any);

    try {
      await bridge.sendAgentActivityCard('chat-agent-activity', 'Agent report ready.', {
        teamName: 'research@chat:oc_a',
        instanceId: 'ati_chat_a',
        agentName: 'reviewer',
        runId: 'run-1',
        taskIds: [7],
      });

      expect(sender.sent).toHaveLength(1);
      const state = sender.sent[0].state;
      expect(state.lifecycleStage).toBe('closed');
      expect(state.lifecycleKey).toMatch(/^agent-activity:chat-agent-activity:\d+$/);

      const store = await import('../src/bridge/card-lifecycle-store.js');
      expect(store.getCardLifecycleRecord(state.lifecycleKey!)).toMatchObject({
        botName: 'test-bot',
        chatId: 'chat-agent-activity',
        messageId: 'msg-1',
        source: 'agent-activity',
        teamName: 'research@chat:oc_a',
        instanceId: 'ati_chat_a',
        agentName: 'reviewer',
        runId: 'run-1',
        taskIds: [7],
        status: 'agent_activity',
        lifecycleStage: 'closed',
      });
    } finally {
      bridge.destroy();
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MessageBridge chatId cleanup (memory leak guard)', () => {
  it('sweepStaleChatIdEntries evicts only entries older than the TTL', () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    const now = Date.now();
    const TTL = 24 * 60 * 60 * 1000;

    bridge.recentQuestionCard.set('stale', { cardMessageId: 'old', at: now - TTL - 1000 });
    bridge.recentQuestionCard.set('fresh', { cardMessageId: 'new', at: now });

    bridge.sweepStaleChatIdEntries();

    expect(bridge.recentQuestionCard.has('stale')).toBe(false);
    expect(bridge.recentQuestionCard.has('fresh')).toBe(true);

    bridge.destroy();
  });

  it('destroy() clears all per-chat bookkeeping and the cleanup timer', () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;

    bridge.recentQuestionCard.set('chat-1', { cardMessageId: 'm', at: Date.now() });
    bridge.exitPlanCardsShown.add('chat-1');
    bridge.spontaneousSubscribed.add('chat-1');
    bridge.messageQueues.set('chat-1', []);
    const clearedTimers: Array<ReturnType<typeof setTimeout>> = [];
    const bufTimer = setTimeout(() => {}, 60_000);
    bridge.spontaneousBuffers.set('chat-1', { teamState: { agents: [], tasks: [] }, snippets: [], timer: bufTimer });
    const qTimer = setTimeout(() => {}, 60_000);
    bridge.pendingBetweenTurnQuestions.set('chat-1', {
      toolUseId: 't', questions: [], cardMessageId: 'm', currentQuestionIndex: 0,
      collectedAnswers: {}, timeoutId: qTimer,
    });

    expect(bridge.chatIdCleanupTimer).toBeDefined();

    bridge.destroy();

    expect(bridge.recentQuestionCard.size).toBe(0);
    expect(bridge.exitPlanCardsShown.size).toBe(0);
    expect(bridge.spontaneousSubscribed.size).toBe(0);
    expect(bridge.spontaneousBuffers.size).toBe(0);
    expect(bridge.pendingBetweenTurnQuestions.size).toBe(0);
    expect(bridge.messageQueues.size).toBe(0);
    expect(bridge.chatIdCleanupTimer).toBeUndefined();

    clearTimeout(bufTimer);
    clearTimeout(qTimer);
    void clearedTimers;
  });
});

/**
 * Spontaneous-card helpers — extracted so the snippet generator and card
 * title are unit-testable without booting a real MessageBridge.
 *
 * The history these tests guard against: an earlier version included a
 * `msg.type === 'result'` branch in the snippet generator, which produced
 * a `🤖 ...` snippet on top of the assistant text snippet for the same
 * underlying agent reply — flooding the card with duplicates. And the
 * card title used to say "Background activity from your agent team /
 * long-running task", which made users think the agent was *still*
 * running when in fact the card is emitted at the END of a quiet burst.
 */
describe('extractSpontaneousSnippet', () => {
  it('returns assistant text as snippet', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '  Weather is sunny  ' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBe('Weather is sunny');
  });

  // Tool-use blocks used to render as `🔧 <ToolName>` lines in the
  // spontaneous card. That's the exact intermediate noise we hid from the
  // main card in PR #268 — surfacing it between turns would just put it
  // right back. extractSpontaneousSnippet now drops tool_use blocks
  // entirely; only text snippets (the agent's actual conclusion) survive.
  it('returns null for tool_use-only assistant messages (intermediate noise dropped)', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });

  it('returns text and ignores adjacent tool_use blocks', () => {
    const msg = {
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', name: 'Bash' },
      ] },
    };
    expect(extractSpontaneousSnippet(msg)).toBe('hello');
  });

  it('returns null when only tool_use blocks are present (text-less burst)', () => {
    const msg = {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Bash' },
      ] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });

  it('truncates very long text at the snippet cap with an ellipsis marker', () => {
    // The cap is 4000 (raised from 400, which cut off ordinary multi-paragraph
    // replies mid-sentence — see "经常显示不全" bug). Snippets above the cap
    // are still tagged with an ellipsis so the reader knows truncation happened.
    const long = 'x'.repeat(8000);
    const out = extractSpontaneousSnippet({
      type: 'assistant',
      message: { content: [{ type: 'text', text: long }] },
    });
    expect(out).toHaveLength(4001); // 4000 + the trailing ellipsis char
    expect(out!.endsWith('…')).toBe(true);
  });

  it('does not touch text shorter than the snippet cap (no ellipsis appended)', () => {
    const ordinary = 'A two-paragraph reply.\n\nWith another paragraph that is well under 4 KB.';
    const out = extractSpontaneousSnippet({
      type: 'assistant',
      message: { content: [{ type: 'text', text: ordinary }] },
    });
    expect(out).toBe(ordinary);
    expect(out!.endsWith('…')).toBe(false);
  });

  // Regression for Bug B (duplicate snippets): result-type messages MUST be
  // ignored. SDK's `result.result` is a verbatim echo of the last assistant
  // text block — including it produced two snippets for the same content.
  it('returns null for result-type messages (regression: no duplicate result snippet)', () => {
    expect(extractSpontaneousSnippet({ type: 'result', result: 'Weather is sunny' })).toBeNull();
    expect(extractSpontaneousSnippet({ type: 'result', result: 'anything' })).toBeNull();
  });

  it('returns null for user/system/other message types', () => {
    expect(extractSpontaneousSnippet({ type: 'user', message: { content: [] } })).toBeNull();
    expect(extractSpontaneousSnippet({ type: 'system' })).toBeNull();
    expect(extractSpontaneousSnippet(null)).toBeNull();
    expect(extractSpontaneousSnippet({})).toBeNull();
  });

  it('returns null for assistant messages with no usable text content', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'thinking', text: 'silent' }, { type: 'image' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });

  it('skips empty text blocks', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   ' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });
});

describe('formatSpontaneousCardBody', () => {
  // The card body renders ALL snippets (chronological), separated by a
  // horizontal rule. Earlier behavior was "show only the latest + a
  // (N coalesced) footer" — that turned out to drop most of the useful
  // content (the "经常显示不全" bug) because Agent Team pings, /loop
  // iterations, and cron tasks each emit their own snippet and the user
  // needs to see all of them. Total length is capped at
  // SPONTANEOUS_BODY_MAX_CHARS; overflow drops the oldest snippets and
  // prepends a one-line summary of how many were omitted.
  //
  // The body never carries a header caption when nothing was dropped —
  // the card itself is sent with the `agent_activity` status, which
  // renders a blue "Agent activity" title at the top. Don't re-add a
  // body header without confirming the card-status signal is no longer
  // sufficient.
  it('renders the single snippet verbatim with no header caption', () => {
    const body = formatSpontaneousCardBody(['Weather is sunny']);
    expect(body).toBe('Weather is sunny');
  });

  it('renders ALL snippets chronologically with a horizontal-rule separator', () => {
    const body = formatSpontaneousCardBody([
      'Looking at the PR comments…',
      'Found 3 things to address.',
      'Pushed commit abc1234 to the branch.',
    ]);
    // All three must appear, in order.
    const idxA = body.indexOf('Looking at the PR comments');
    const idxB = body.indexOf('Found 3 things to address');
    const idxC = body.indexOf('Pushed commit abc1234');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
    // Snippets are separated by `---` rules (two between three snippets).
    expect((body.match(/^---$/gm) ?? []).length).toBe(2);
    // No body-level "between turns" / "long-running" caption, and no
    // "N events coalesced; showing latest" footer (that's the old behavior).
    expect(body).not.toMatch(/coalesced/i);
    expect(body).not.toMatch(/between turns/i);
    expect(body).not.toMatch(/long-running/i);
    expect(body).not.toMatch(/showing latest/i);
  });

  it('drops the oldest snippets and prepends an "omitted" notice when total exceeds the body budget', () => {
    // Each snippet ~3500 chars; 5 of them = ~17500 chars total → over the
    // 12000 budget. We should keep the most recent N that fit, drop the rest.
    const big = (label: string) => label + ' ' + 'x'.repeat(3500);
    const snippets = ['old1', 'old2', 'old3', 'old4', 'newest'].map(big);
    const body = formatSpontaneousCardBody(snippets);
    // newest MUST be present (most relevant).
    expect(body).toContain('newest');
    // At least the oldest one MUST be omitted, with an "omitted" notice.
    expect(body).toMatch(/^_\(\d+ earlier events? omitted; \d+ shown\)_/);
    expect(body).not.toContain('old1');
  });

  it('returns an empty string when the snippets array is empty', () => {
    expect(formatSpontaneousCardBody([])).toBe('');
  });
});

/**
 * Burst-source classifier — distinguishes SDK-initiated continuation turns
 * (the agent waking up to summarise a `run_in_background` Bash return) from
 * everything else that arrives between user turns (Agent Team pings, /goal
 * Stop-hook user messages, system status events).
 *
 * The classification matters for UX:
 *   - continuation → render as a fresh streaming card (looks like a user
 *     turn) so the user reads the burst as "the agent continued its work"
 *   - spontaneous  → coalesce into the "Agent activity between turns" card
 *     so multiple ambient pings don't spam the chat
 *
 * The signal we key on is the SDK's `origin.kind === 'task-notification'`
 * field on the FIRST message of a between-turn burst. Don't relax the
 * classifier to also fire on assistant text alone — both buckets see
 * assistant messages after the burst opens; only the OPENING message
 * carries the origin marker.
 */
describe('classifyBurstSource', () => {
  it('returns continuation for a user message with task-notification origin', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'background task finished' },
      origin: { kind: 'task-notification' },
    };
    expect(classifyBurstSource(msg)).toBe('continuation');
  });

  it('returns spontaneous for a user message with no origin (e.g. /goal Stop hook synthesis)', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'Goal evaluator says: continue' },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for a user message with peer origin (Agent Team SendMessage)', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'hi from agent' },
      origin: { kind: 'peer', from: 'researcher' },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for human-origin user message (manual injection, defensive)', () => {
    // Shouldn't happen in the consumeLoop path (humans go through nextTurn),
    // but the classifier must be conservative — anything not explicitly a
    // task-notification falls back to the coalesced bucket.
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'hello' },
      origin: { kind: 'human' },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for assistant text (e.g. Agent Team burst opening with assistant)', () => {
    // origin is on USER messages, not assistant. An assistant-led burst is
    // either a continuation already in progress (handled by activeTurn) or
    // an Agent Team ping (spontaneous).
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'doing the thing' }] },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for system task_notification system message (the SDK status event itself)', () => {
    // The SDKTaskNotificationMessage (type:'system' subtype:'task_notification')
    // is the SETTLE event, NOT the wake-up. The wake-up is the follow-up
    // user-role message with origin.kind === 'task-notification'. Keep this
    // routed to spontaneous so the status doesn't accidentally open a card
    // by itself.
    const msg = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      summary: 'done',
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('handles malformed input defensively (null / missing fields → spontaneous)', () => {
    expect(classifyBurstSource(null)).toBe('spontaneous');
    expect(classifyBurstSource(undefined)).toBe('spontaneous');
    expect(classifyBurstSource({})).toBe('spontaneous');
    expect(classifyBurstSource({ type: 'user' })).toBe('spontaneous');
    expect(classifyBurstSource({ type: 'user', origin: {} })).toBe('spontaneous');
    expect(classifyBurstSource({ type: 'user', origin: { kind: 'unknown-future' } })).toBe('spontaneous');
  });

  it('requires BOTH type==="user" AND origin.kind to fire continuation (not type alone)', () => {
    // Defensive: don't open a continuation just because origin happens to be
    // present on a non-user message — origin lives on user/result types per
    // the SDK type defs, and assistants/system never carry task-notification.
    expect(classifyBurstSource({
      type: 'assistant',
      origin: { kind: 'task-notification' },
    })).toBe('spontaneous');
    expect(classifyBurstSource({
      type: 'result',
      origin: { kind: 'task-notification' },
    })).toBe('spontaneous');
  });
});

/**
 * The persistent executor pool is the load-bearing piece behind background
 * tasks, Agent Teams continuity, and `/goal` multi-turn auto-drive. As of
 * 2026-05-13 it's the DEFAULT — installs that haven't set the env var still
 * get the right behaviour. Opt out with METABOT_PERSISTENT_EXECUTOR=false (or
 * '0').
 *
 * Don't flip the default back to off without a real reason: the card UI now
 * advertises background tasks, and silently disabling them would surprise
 * users who installed-and-went.
 */
describe('resolvePersistentExecutorEnvDefault', () => {
  it('returns true when env var is undefined (the new default)', () => {
    expect(resolvePersistentExecutorEnvDefault(undefined)).toBe(true);
  });

  it('returns true for empty string (env var present but unset value)', () => {
    expect(resolvePersistentExecutorEnvDefault('')).toBe(true);
  });

  it('returns true for explicit on values (back-compat with old opt-in syntax)', () => {
    expect(resolvePersistentExecutorEnvDefault('true')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('1')).toBe(true);
  });

  it('returns false for explicit opt-out values', () => {
    expect(resolvePersistentExecutorEnvDefault('false')).toBe(false);
    expect(resolvePersistentExecutorEnvDefault('0')).toBe(false);
  });

  it('returns true for unrecognised values (do not silently disable a load-bearing feature on a typo)', () => {
    // Anything that isn't an explicit opt-out should keep persistent on.
    // Better to leave a typo-set var on than to silently drop background
    // tasks; the symptom of "off" is much worse (silent breakage) than the
    // symptom of "on" (slightly more memory).
    expect(resolvePersistentExecutorEnvDefault('off')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('no')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('disabled')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('truee')).toBe(true);
  });
});
