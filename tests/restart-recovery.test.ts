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
  process.env.SESSION_STORE_DIR = originalSessionStoreDir;
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
    }));
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
      prompt: expect.stringContaining('Do not run metabot restart or metabot update again'),
    }));
    expect(recovery.listActiveTaskRecords()).toEqual([]);
  });
});
