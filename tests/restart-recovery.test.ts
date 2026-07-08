import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalSessionStoreDir = process.env.SESSION_STORE_DIR;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as any;

afterEach(() => {
  if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
  else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
  vi.resetModules();
});

describe('restart recovery', () => {
  it('updates interrupted card, notifies chat, queues continuation, and clears active task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-recovery-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const restartNotice = await import('../src/bridge/restart-notice.js');
    const recovery = await import('../src/bridge/restart-recovery.js');

    writeFileSync(
      join(dir, 'last-restart.json'),
      JSON.stringify({ restartedAt: Math.floor(Date.now() / 1000), botName: 'research-pm', chatId: 'oc_1' }),
    );
    recovery.recordActiveTask({
      botName: 'research-pm',
      chatId: 'oc_1',
      messageId: 'msg_1',
      lifecycleKey: 'chat:oc_1:m1',
      userPrompt: 'Please update config and restart service.',
      startedAt: Date.now() - 5000,
      source: 'chat',
    });

    restartNotice.loadRestartBreadcrumb();

    const updateCard = vi.fn().mockResolvedValue(true);
    const sendTextNotice = vi.fn().mockResolvedValue(undefined);
    const scheduleTask = vi.fn((input) => ({ ...input, id: 'resume-task' }));
    const registry = {
      get: vi.fn((name: string) => name === 'research-pm'
        ? { sender: { updateCard, sendTextNotice } }
        : undefined),
    };

    await recovery.recoverInterruptedTasksAfterRestart({
      registry: registry as any,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(updateCard).toHaveBeenCalledWith('msg_1', expect.objectContaining({
      status: 'complete',
      userPrompt: 'Please update config and restart service.',
      lifecycleKey: 'chat:oc_1:m1',
      lifecycleStage: 'recovering',
    }));
    expect(recovery.listActiveTaskRecords()).toEqual([]);
    expect((await import('../src/bridge/card-lifecycle-store.js')).getCardLifecycleRecord('chat:oc_1:m1')).toMatchObject({
      botName: 'research-pm',
      chatId: 'oc_1',
      messageId: 'msg_1',
      source: 'restart-recovery',
      status: 'complete',
      lifecycleStage: 'recovering',
    });
    expect(sendTextNotice).toHaveBeenCalledWith(
      'oc_1',
      'MetaBot Restart Complete',
      expect.stringContaining('Service restart completed'),
      'green',
    );
    expect(scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      botName: 'research-pm',
      chatId: 'oc_1',
      delaySeconds: 2,
      sendCards: true,
      label: 'restart-resume-oc_1',
      dedupeKey: 'restart-resume:research-pm:oc_1',
      prompt: expect.stringContaining('Do not run metabot restart or metabot update again merely to satisfy the previous interrupted request'),
    }));
  });

  it('queues recovery continuation for interrupted tasks on ordinary startup without a fresh breadcrumb', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-recovery-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const recovery = await import('../src/bridge/restart-recovery.js');
    recovery.recordActiveTask({
      botName: 'research-pm',
      chatId: 'oc_1',
      messageId: 'msg_1',
      userPrompt: 'Still running?',
      startedAt: Date.now() - 5000,
      source: 'chat',
    });

    const updateCard = vi.fn().mockResolvedValue(true);
    const sendTextNotice = vi.fn().mockResolvedValue(undefined);
    const scheduleTask = vi.fn((input) => ({ ...input, id: 'resume-task' }));
    const registry = {
      get: vi.fn((name: string) => name === 'research-pm'
        ? { sender: { updateCard, sendTextNotice } }
        : undefined),
    };

    await recovery.recoverInterruptedTasksAfterRestart({
      registry: registry as any,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(updateCard).toHaveBeenCalledWith('msg_1', expect.objectContaining({
      status: 'complete',
      userPrompt: 'Still running?',
      lifecycleStage: 'recovering',
      errorMessage: undefined,
    }));
    expect(sendTextNotice).toHaveBeenCalledWith(
      'oc_1',
      'MetaBot Restart Complete',
      expect.stringContaining('without a fresh controlled-restart breadcrumb'),
      'green',
    );
    expect(scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      botName: 'research-pm',
      chatId: 'oc_1',
      label: 'restart-resume-oc_1',
      dedupeKey: 'restart-resume:research-pm:oc_1',
      prompt: expect.stringContaining('recovery continuation'),
    }));
    expect(recovery.listActiveTaskRecords()).toEqual([]);
  });

  it('controlled chat restarts do not repeat the restart command when no task was active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-recovery-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const restartNotice = await import('../src/bridge/restart-notice.js');
    const recovery = await import('../src/bridge/restart-recovery.js');

    writeFileSync(
      join(dir, 'last-restart.json'),
      JSON.stringify({
        restartedAt: Math.floor(Date.now() / 1000),
        botName: 'research-pm',
        chatId: 'oc_1',
        source: 'chat-command',
        resume: true,
        requestId: 'restart-123',
      }),
    );

    restartNotice.loadRestartBreadcrumb();
    expect(restartNotice.shouldRemindRestart('oc_1')).toBe(true);

    const updateCard = vi.fn().mockResolvedValue(true);
    const sendTextNotice = vi.fn().mockResolvedValue(undefined);
    const scheduleTask = vi.fn();
    const registry = {
      get: vi.fn((name: string) => name === 'research-pm'
        ? { sender: { updateCard, sendTextNotice } }
        : undefined),
    };

    await recovery.recoverInterruptedTasksAfterRestart({
      registry: registry as any,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(updateCard).not.toHaveBeenCalled();
    expect(sendTextNotice).toHaveBeenCalledWith(
      'oc_1',
      'MetaBot Restart Complete',
      expect.stringContaining('No in-flight agent turn was recorded'),
      'green',
    );
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(recovery.listActiveTaskRecords()).toEqual([]);
  });

  it('controlled chat restarts resume other chats that had active turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-recovery-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const restartNotice = await import('../src/bridge/restart-notice.js');
    const recovery = await import('../src/bridge/restart-recovery.js');

    writeFileSync(
      join(dir, 'last-restart.json'),
      JSON.stringify({
        restartedAt: Math.floor(Date.now() / 1000),
        botName: 'admin',
        chatId: 'oc_restart',
        source: 'chat-command',
        resume: true,
      }),
    );
    recovery.recordActiveTask({
      botName: 'pm-codex',
      chatId: 'oc_work',
      messageId: 'msg_work',
      userPrompt: 'Continue validation after restart',
      startedAt: Date.now() - 10_000,
      source: 'chat',
    });

    restartNotice.loadRestartBreadcrumb();

    const updateCard = vi.fn().mockResolvedValue(true);
    const sendTextNotice = vi.fn().mockResolvedValue(undefined);
    const scheduleTask = vi.fn((input) => ({ ...input, id: 'resume-task' }));
    const registry = {
      get: vi.fn((name: string) => {
        if (name === 'pm-codex') return { sender: { updateCard, sendTextNotice } };
        if (name === 'admin') return { sender: { updateCard, sendTextNotice } };
        return undefined;
      }),
    };

    await recovery.recoverInterruptedTasksAfterRestart({
      registry: registry as any,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(updateCard).toHaveBeenCalledWith('msg_work', expect.objectContaining({
      status: 'complete',
      userPrompt: 'Continue validation after restart',
    }));
    expect(sendTextNotice).toHaveBeenCalledWith(
      'oc_work',
      'MetaBot Restart Complete',
      expect.stringContaining('queued a continuation'),
      'green',
    );
    expect(scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      botName: 'pm-codex',
      chatId: 'oc_work',
      label: 'restart-resume-oc_work',
      dedupeKey: 'restart-resume:pm-codex:oc_work',
      prompt: expect.stringContaining('Continue validation after restart'),
    }));
  });

  it('sends a post-restart readiness report to requester and blocker chats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-recovery-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const restartNotice = await import('../src/bridge/restart-notice.js');
    const recovery = await import('../src/bridge/restart-recovery.js');
    const restartCoordinator = await import('../src/bridge/restart-coordinator.js');

    writeFileSync(
      join(dir, 'last-restart.json'),
      JSON.stringify({
        restartedAt: Math.floor(Date.now() / 1000),
        botName: 'admin',
        chatId: 'oc_restart',
        source: 'chat-command',
        resume: true,
        requestId: 'restart-report-1',
      }),
    );
    restartCoordinator.recordServiceRestartRequest({
      requestId: 'restart-report-1',
      requesterBotName: 'admin',
      request: { chatId: 'oc_restart', userId: 'u1', reason: 'deploy fixes' },
      status: 'scheduled',
      blockers: [{ botName: 'pm-codex', chatId: 'oc_work', messageId: 'msg_work', source: 'chat' }],
      now: Date.now() - 5_000,
    });
    restartCoordinator.recordServiceRestartReadiness({
      requestId: 'restart-report-1',
      botName: 'pm-codex',
      chatId: 'oc_work',
      userId: 'u2',
      note: 'checkpoint saved',
      now: Date.now() - 4_000,
    });
    recovery.recordActiveTask({
      botName: 'pm-codex',
      chatId: 'oc_work',
      messageId: 'msg_work',
      userPrompt: 'Continue validation after restart',
      startedAt: Date.now() - 10_000,
      source: 'chat',
    });

    restartNotice.loadRestartBreadcrumb();

    const adminNotice = vi.fn().mockResolvedValue(undefined);
    const pmNotice = vi.fn().mockResolvedValue(undefined);
    const updateCard = vi.fn().mockResolvedValue(true);
    const scheduleTask = vi.fn((input) => ({ ...input, id: 'resume-task' }));
    const registry = {
      get: vi.fn((name: string) => {
        if (name === 'admin') return { sender: { updateCard, sendTextNotice: adminNotice } };
        if (name === 'pm-codex') return { sender: { updateCard, sendTextNotice: pmNotice } };
        return undefined;
      }),
    };

    await recovery.recoverInterruptedTasksAfterRestart({
      registry: registry as any,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(adminNotice).toHaveBeenCalledWith(
      'oc_restart',
      'MetaBot Restart Report',
      expect.stringContaining('ready=1/1'),
      'green',
    );
    expect(pmNotice).toHaveBeenCalledWith(
      'oc_work',
      'MetaBot Restart Recovery Report',
      expect.stringContaining('Recovery continuations queued: 1'),
      'green',
    );
    expect(restartCoordinator.getServiceRestartRequest('restart-report-1')?.reportedAt).toEqual(expect.any(Number));
  });

  it('clears expired active tasks on startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-recovery-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const recovery = await import('../src/bridge/restart-recovery.js');
    const old = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(
      join(dir, 'active-tasks.json'),
      JSON.stringify([
        {
          botName: 'research-pm',
          chatId: 'oc_1',
          messageId: 'msg_1',
          userPrompt: 'Old running task',
          startedAt: old,
          updatedAt: old,
          source: 'chat',
        },
      ]),
    );

    const registry = { get: vi.fn() };
    const scheduleTask = vi.fn();

    await recovery.recoverInterruptedTasksAfterRestart({
      registry: registry as any,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(registry.get).not.toHaveBeenCalled();
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(recovery.listActiveTaskRecords()).toEqual([]);
  });

  it('clears internal worker and agent active task records instead of resuming them as user chats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-recovery-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const restartNotice = await import('../src/bridge/restart-notice.js');
    const recovery = await import('../src/bridge/restart-recovery.js');

    writeFileSync(
      join(dir, 'last-restart.json'),
      JSON.stringify({
        restartedAt: Math.floor(Date.now() / 1000),
        botName: 'admin',
        chatId: 'oc_restart',
        source: 'chat-command',
        resume: true,
      }),
    );
    const now = Date.now();
    writeFileSync(
      join(dir, 'active-tasks.json'),
      JSON.stringify([
        {
          botName: 'pm-codex',
          chatId: 'worker-abc123',
          messageId: 'worker-msg',
          userPrompt: 'Internal worker task',
          startedAt: now - 5_000,
          updatedAt: now - 4_000,
          source: 'api',
        },
        {
          botName: 'pm-codex',
          chatId: 'team:research:reviewer',
          messageId: 'legacy-agent-msg',
          userPrompt: 'Legacy internal agent task',
          startedAt: now - 5_000,
          updatedAt: now - 4_000,
          source: 'api',
        },
        {
          botName: 'pm-codex',
          chatId: 'teaminst:ati_chat_a:reviewer',
          messageId: 'instance-agent-msg',
          userPrompt: 'Instance internal agent task',
          startedAt: now - 5_000,
          updatedAt: now - 4_000,
          source: 'api',
        },
      ]),
    );

    restartNotice.loadRestartBreadcrumb();

    const updateCard = vi.fn().mockResolvedValue(true);
    const sendTextNotice = vi.fn().mockResolvedValue(undefined);
    const scheduleTask = vi.fn();
    const registry = {
      get: vi.fn((name: string) => ({ sender: { updateCard, sendTextNotice }, name })),
    };

    await recovery.recoverInterruptedTasksAfterRestart({
      registry: registry as any,
      scheduler: { scheduleTask } as any,
      logger,
    });

    expect(updateCard).not.toHaveBeenCalled();
    expect(sendTextNotice).toHaveBeenCalledTimes(1);
    expect(sendTextNotice).toHaveBeenCalledWith(
      'oc_restart',
      'MetaBot Restart Complete',
      expect.stringContaining('No in-flight agent turn was recorded'),
      'green',
    );
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(recovery.listActiveTaskRecords()).toEqual([]);
  });
});
