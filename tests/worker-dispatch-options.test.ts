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
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      timeoutMs: 12_345,
      idleTimeoutMs: 6_789,
    });
  });
});
