import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('rejects unsupported explicit output contracts before starting a worker', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'done' }));
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const registry = { get: vi.fn(() => ({ bridge })) } as any;
    const manager = new WorkerManager(registry, logger, { defaultModel: 'gpt-5.4', maxPerPm: 8 });

    expect(() => manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: 'run experiment',
      model: 'gpt-5.4',
      outputContract: {
        name: 'not_a_real_contract',
        requiredArtifact: true,
      } as any,
    } as any)).toThrow(/Invalid outputContract\.name/);

    expect(executeApiTask).not.toHaveBeenCalled();
    expect(manager.listWorkers('pm-chat')).toEqual([]);
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
  it('raises too-short timeouts for durable research workers', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'done' }));
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const registry = { get: vi.fn(() => ({ bridge })) } as any;
    const manager = new WorkerManager(registry, logger, { defaultModel: 'gpt-5.4', maxPerPm: 8 });

    const record = manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: '# AutoResearchClaw Run\nValidate a minimal artifact.',
      label: 'autoresearchclaw-smoke',
      model: 'gpt-5.5',
      timeoutMs: 120_000,
      idleTimeoutMs: 60_000,
    });

    await vi.waitFor(() => expect(executeApiTask).toHaveBeenCalled());
    expect(record.timeoutMs).toBe(300_000);
    expect(record.idleTimeoutMs).toBe(120_000);
    expect(executeApiTask.mock.calls[0][0]).toMatchObject({
      timeoutMs: 300_000,
      idleTimeoutMs: 120_000,
    });
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
  it('recovers a failed worker when a completed authoritative artifact exists', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    writeFileSync(join(workdir, 'results.json'), JSON.stringify({
      contract_version: '1.0',
      status: 'complete',
      summary: 'durable result was written before the stream failed',
    }));
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => (
      chatId.startsWith('worker-')
        ? {
            success: false,
            responseText: 'I wrote the JSON and then the stream failed.',
            error: 'stream disconnected before completion: Transport error: network error: error decoding response body',
          }
        : { success: true, responseText: 'notified' }
    ));
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const registry = { get: vi.fn(() => ({ bridge })) } as any;
    const manager = new WorkerManager(registry, logger, { defaultModel: 'gpt-5.4', maxPerPm: 8 });

    const record = manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: 'research worker: write results.json',
      model: 'gpt-5.4',
    });

    await vi.waitFor(() => {
      expect(manager.getWorker(record.id)?.status).toBe('completed');
    });
    const finalRecord = manager.getWorker(record.id)!;
    expect(finalRecord.timeoutMs).toBeUndefined();
    expect(finalRecord.idleTimeoutMs).toBeUndefined();
    expect(finalRecord.executionStatus).toBe('transport_error');
    expect(finalRecord.artifactStatus).toBe('valid_complete');
    expect(finalRecord.artifactPath).toBe(join(workdir, 'results.json'));
    expect(finalRecord.error).toBeUndefined();
    expect(finalRecord.terminalError).toContain('stream disconnected');
    expect(finalRecord.resultSummary).toContain('Recovered: valid completed artifact');
  });

  it('recovers a timed-out worker from a completed AutoResearchClaw artifact', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const artifactDir = join(workdir, '.metabot-memory', 'autoresearchclaw');
    const artifactPath = join(artifactDir, 'run-smoke-output.json');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactPath, JSON.stringify({
      contract_version: 'autoresearchclaw.output.v2',
      project_id: 'metabot-smoke',
      run_id: 'run-smoke',
      status: 'completed',
      summary: 'AutoResearchClaw artifact was completed before timeout.',
    }));
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => (
      chatId.startsWith('worker-')
        ? {
            success: false,
            responseText: 'The progress file is now marked completed.',
            error: 'Task timed out (2 minutes limit)',
          }
        : { success: true, responseText: 'notified' }
    ));
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const registry = { get: vi.fn(() => ({ bridge })) } as any;
    const manager = new WorkerManager(registry, logger, { defaultModel: 'gpt-5.4', maxPerPm: 8 });

    const record = manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: '# AutoResearchClaw Run\nWrite the contract artifact.',
      model: 'gpt-5.5',
    });

    await vi.waitFor(() => {
      expect(manager.getWorker(record.id)?.status).toBe('completed');
    });
    const finalRecord = manager.getWorker(record.id)!;
    expect(finalRecord.executionStatus).toBe('timed_out');
    expect(finalRecord.artifactStatus).toBe('valid_complete');
    expect(finalRecord.artifactPath).toBe(artifactPath);
    expect(finalRecord.terminalError).toContain('2 minutes');
  });
});
