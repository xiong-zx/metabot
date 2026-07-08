import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
} as any;

describe('WorkerManager dispatch execution options', () => {
  let priorSessionStoreDir: string | undefined;
  let sessionStoreDir: string;
  let workdir: string;

  beforeEach(() => {
    priorSessionStoreDir = process.env.SESSION_STORE_DIR;
    sessionStoreDir = mkdtempSync(join(tmpdir(), 'metabot-worker-store-'));
    workdir = mkdtempSync(join(tmpdir(), 'metabot-worker-workdir-'));
    process.env.SESSION_STORE_DIR = sessionStoreDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (priorSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
    else process.env.SESSION_STORE_DIR = priorSessionStoreDir;
    rmSync(sessionStoreDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('passes permission and timeout overrides to executeApiTask', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'done' }));
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const registry = { get: vi.fn(() => ({ bridge })) } as any;
    const manager = new WorkerManager(registry, logger, { defaultModel: 'gpt-5.4', maxPerPm: 8 });

    manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: 'run experiment',
      model: 'gpt-5.4',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      timeoutMs: 12_345,
      idleTimeoutMs: 6_789,
    });

    await vi.waitFor(() => expect(executeApiTask).toHaveBeenCalled());
    expect(executeApiTask.mock.calls[0][0]).toMatchObject({
      prompt: 'run experiment',
      chatId: expect.stringMatching(/^worker-/),
      workingDirectory: workdir,
      model: 'gpt-5.4',
      engine: 'codex',
      lifecycleKey: expect.stringMatching(/^worker:/),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      timeoutMs: 12_345,
      idleTimeoutMs: 6_789,
    });
  });

  it('prepends worker rules context when a provider is configured', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'done' }));
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const registry = { get: vi.fn(() => ({ bridge })) } as any;
    const manager = new WorkerManager(registry, logger, { defaultModel: 'gpt-5.4', maxPerPm: 8 });
    manager.setRulesContextProvider((input) => [
      '<rules-context-pack purpose="worker-dispatch">',
      `Worker workdir: ${input.workingDirectory}`,
      '</rules-context-pack>',
    ].join('\n'));

    manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: 'run experiment',
      model: 'gpt-5.4',
    });

    await vi.waitFor(() => expect(executeApiTask).toHaveBeenCalled());
    expect(executeApiTask.mock.calls[0][0].prompt).toBe([
      '<rules-context-pack purpose="worker-dispatch">',
      `Worker workdir: ${workdir}`,
      '</rules-context-pack>',
      '',
      'run experiment',
    ].join('\n'));
  });

  it('reuses a running or recent completed worker when dedupeKey matches', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    let finishWorker: ((value: { success: boolean; responseText: string }) => void) | undefined;
    const executeApiTask = vi.fn(() => new Promise<{ success: boolean; responseText: string }>((resolve) => {
      finishWorker = resolve;
    }));
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const registry = { get: vi.fn(() => ({ bridge })) } as any;
    const manager = new WorkerManager(registry, logger, { defaultModel: 'gpt-5.4', maxPerPm: 8 });

    const first = manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: 'run experiment',
      model: 'gpt-5.4',
      dedupeKey: 'restart-resume:worker-a',
    });
    const second = manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: 'run experiment again',
      model: 'gpt-5.4',
      dedupeKey: 'restart-resume:worker-a',
    });

    expect(second.id).toBe(first.id);
    expect(executeApiTask).toHaveBeenCalledTimes(1);

    finishWorker?.({ success: true, responseText: 'done' });
    await vi.waitFor(() => expect(manager.getWorker(first.id)?.status).toBe('completed'));
    const callsAfterCompletionNotification = executeApiTask.mock.calls.length;

    const third = manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: 'run experiment after completion',
      model: 'gpt-5.4',
      dedupeKey: 'restart-resume:worker-a',
    });

    expect(third.id).toBe(first.id);
    expect(executeApiTask).toHaveBeenCalledTimes(callsAfterCompletionNotification);
  });
});
