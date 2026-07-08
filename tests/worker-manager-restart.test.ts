import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

describe('WorkerManager restart recovery', () => {
  it('can mark a running worker completed from an external lifecycle owner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-worker-external-complete-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const stopChatTask = vi.fn();
    const executeApiTask = vi.fn(() => new Promise(() => {}));
    const manager = new WorkerManager(
      { get: vi.fn(() => ({ bridge: { executeApiTask, stopChatTask } })) } as any,
      logger,
      { defaultModel: 'gpt-5.4', maxPerPm: 5 },
    );

    const worker = manager.dispatch({
      botName: 'pm-codex',
      pmChatId: 'oc_pm',
      workerChatId: 'worker-external',
      workingDirectory: dir,
      prompt: 'write artifact',
    } as any);
    const completed = manager.completeWorkerFromExternal(worker.id, {
      resultSummary: 'Memory Core finalized artifact',
    });

    expect(completed).toBe(true);
    expect(stopChatTask).toHaveBeenCalledWith(worker.workerChatId);
    expect(manager.getWorker(worker.id)).toMatchObject({
      status: 'completed',
      resultSummary: 'Memory Core finalized artifact',
    });
  });

  it('restarts workers that were running when the bridge process restarted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-worker-restart-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    fs.writeFileSync(path.join(dir, 'workers.json'), JSON.stringify([
      {
        id: 'worker-1',
        botName: 'pm-codex',
        pmChatId: 'oc_pm',
        workerChatId: 'worker-worker-1',
        workingDirectory: dir,
        prompt: 'continue worker task',
        label: 'validation',
        model: 'gpt-5.4',
        engine: 'codex',
        status: 'running',
        startTime: Date.now() - 60_000,
      },
    ]));

    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => ({
      success: true,
      responseText: chatId.startsWith('worker-') ? 'worker done' : 'pm notified',
      costUsd: 0.01,
    }));
    const registry = {
      get: vi.fn(() => ({ bridge: { executeApiTask, stopChatTask: vi.fn() } })),
    };

    const manager = new WorkerManager(registry as any, logger, {
      defaultModel: 'gpt-5.4',
      maxPerPm: 5,
    });

    await vi.waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'worker-worker-1',
        prompt: 'continue worker task',
        lifecycleKey: 'worker:worker-1',
      }));
    });
    await vi.waitFor(() => {
      expect(manager.getWorker('worker-1')).toMatchObject({
        status: 'completed',
        resultSummary: 'worker done',
      });
    });
    await vi.waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'oc_pm',
        lifecycleKey: 'worker-notify:worker-1',
      }));
    });
  });

  it('marks a restart-stale worker failed if its bot no longer exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-worker-restart-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    fs.writeFileSync(path.join(dir, 'workers.json'), JSON.stringify([
      {
        id: 'worker-missing',
        botName: 'missing-bot',
        pmChatId: 'oc_pm',
        workerChatId: 'worker-missing',
        workingDirectory: dir,
        prompt: 'continue worker task',
        model: 'gpt-5.4',
        engine: 'codex',
        status: 'running',
        startTime: Date.now() - 60_000,
      },
    ]));

    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const manager = new WorkerManager(
      { get: vi.fn(() => undefined) } as any,
      logger,
      { defaultModel: 'gpt-5.4', maxPerPm: 5 },
    );

    await vi.waitFor(() => {
      expect(manager.getWorker('worker-missing')).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('bot not found'),
      });
    });
  });
});
