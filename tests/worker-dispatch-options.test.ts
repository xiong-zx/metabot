import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
} as any;

function autoResearchOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_version: 'autoresearchclaw.output.v2',
    project_id: 'metabot-smoke',
    run_id: 'run-smoke',
    status: 'completed',
    summary: 'AutoResearchClaw artifact completed.',
    hypotheses: [],
    experiments: [],
    findings: [],
    negative_results: [],
    decisions: [],
    artifacts: [],
    open_questions: [],
    memory_event_candidates: [],
    recommended_followups: [],
    tool_trace: [{ tool: 'vitest', summary: 'Validated worker artifact contract', status: 'completed' }],
    ...overrides,
  };
}

function persistedWorker(sessionStoreDir: string, workerId: string): any {
  const records = JSON.parse(readFileSync(join(sessionStoreDir, 'workers.json'), 'utf-8'));
  return records.find((record: any) => record.id === workerId);
}

function quickStatusFields(record: any): Record<string, unknown> {
  return {
    status: record.status,
    executionStatus: record.executionStatus,
    outputContract: record.outputContract
      ? {
          name: record.outputContract.name,
          requiredArtifact: record.outputContract.requiredArtifact,
          expectedArtifacts: record.outputContract.expectedArtifacts,
        }
      : undefined,
    artifactStatus: record.artifactStatus,
    contractStatus: record.contractStatus,
    deliveryStatus: record.deliveryStatus,
    recoveryStatus: record.recoveryStatus,
    artifactPath: record.artifactPath,
    artifactError: record.artifactError,
    detailRoute: record.detailRoute,
    finalPayloadRef: record.finalPayloadRef,
    finalTranscriptRef: record.finalTranscriptRef,
  };
}

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

    expect(() =>
      manager.dispatch({
        botName: 'research-pm',
        pmChatId: 'pm-chat',
        workingDirectory: workdir,
        prompt: 'run experiment',
        model: 'gpt-5.4',
        outputContract: {
          name: 'not_a_real_contract',
          requiredArtifact: true,
        } as any,
      } as any),
    ).toThrow(/Invalid outputContract\.name/);

    expect(executeApiTask).not.toHaveBeenCalled();
    expect(manager.listWorkers('pm-chat')).toEqual([]);
  });

  it('prepends worker rules context when a provider is configured', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'done' }));
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const registry = { get: vi.fn(() => ({ bridge })) } as any;
    const manager = new WorkerManager(registry, logger, { defaultModel: 'gpt-5.4', maxPerPm: 8 });
    manager.setRulesContextProvider((input) =>
      [
        '<rules-context-pack purpose="worker-dispatch">',
        `Worker workdir: ${input.workingDirectory}`,
        '</rules-context-pack>',
      ].join('\n'),
    );

    manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: 'run experiment',
      model: 'gpt-5.4',
    });

    await vi.waitFor(() => expect(executeApiTask).toHaveBeenCalled());
    expect(executeApiTask.mock.calls[0][0].prompt).toBe(
      [
        '<rules-context-pack purpose="worker-dispatch">',
        `Worker workdir: ${workdir}`,
        '</rules-context-pack>',
        '',
        'run experiment',
      ].join('\n'),
    );
  });

  it('reuses a running or recent completed worker when dedupeKey matches', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    let finishWorker: ((value: { success: boolean; responseText: string }) => void) | undefined;
    const executeApiTask = vi.fn(
      () =>
        new Promise<{ success: boolean; responseText: string }>((resolve) => {
          finishWorker = resolve;
        }),
    );
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

  it('recovers a failed worker when a completed authoritative artifact exists', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    writeFileSync(
      join(workdir, 'results.json'),
      JSON.stringify({
        contract_version: '1.0',
        status: 'complete',
        summary: 'durable result was written before the stream failed',
      }),
    );
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) =>
      chatId.startsWith('worker-')
        ? {
            success: false,
            responseText: 'I wrote the JSON and then the stream failed.',
            error:
              'stream disconnected before completion: Transport error: network error: error decoding response body',
          }
        : { success: true, responseText: 'notified' },
    );
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
    writeFileSync(
      artifactPath,
      JSON.stringify(
        autoResearchOutput({
          summary: 'AutoResearchClaw artifact was completed before timeout.',
        }),
      ),
    );
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) =>
      chatId.startsWith('worker-')
        ? {
            success: false,
            responseText: 'The progress file is now marked completed.',
            error: 'Task timed out (2 minutes limit)',
          }
        : { success: true, responseText: 'notified' },
    );
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

  it('externally completes an AutoResearchClaw worker with valid terminal artifact metadata', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const artifactDir = join(workdir, '.metabot-memory', 'autoresearchclaw');
    const artifactPath = join(artifactDir, 'run-smoke-output.json');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(autoResearchOutput()));
    const executeApiTask = vi.fn(() => new Promise(() => {}));
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

    await vi.waitFor(() => expect(executeApiTask).toHaveBeenCalled());
    expect(
      manager.completeWorkerFromExternal(record.id, {
        resultSummary: 'Memory Core finalized artifact',
      }),
    ).toBe(true);

    const expected = {
      status: 'completed',
      executionStatus: 'completed',
      outputContract: { name: 'autoresearchclaw_output_v2', requiredArtifact: true },
      artifactStatus: 'valid_complete',
      contractStatus: 'satisfied',
      deliveryStatus: 'full',
      recoveryStatus: 'none',
      artifactPath,
      artifactError: undefined,
      detailRoute: `/api/workers/${record.id}`,
      finalPayloadRef: `file://${artifactPath}`,
      finalTranscriptRef: `worker-chat:${record.workerChatId}`,
    };
    expect(quickStatusFields(manager.getWorker(record.id)!)).toMatchObject(expected);
    expect(quickStatusFields(persistedWorker(sessionStoreDir, record.id))).toMatchObject(expected);
    expect(bridge.stopChatTask).toHaveBeenCalledWith(record.workerChatId);
  });

  it('externally completed AutoResearchClaw workers do not satisfy missing or invalid artifacts', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const manager = new WorkerManager(
      {
        get: vi.fn(() => ({
          bridge: {
            executeApiTask: vi.fn(() => new Promise(() => {})),
            stopChatTask: vi.fn(),
          },
        })),
      } as any,
      logger,
      { defaultModel: 'gpt-5.4', maxPerPm: 8 },
    );

    const missing = manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: '# AutoResearchClaw Run\nNo artifact exists yet.',
      model: 'gpt-5.5',
    });
    expect(manager.completeWorkerFromExternal(missing.id, { resultSummary: 'Memory Core finalized without artifact' })).toBe(
      true,
    );
    expect(quickStatusFields(manager.getWorker(missing.id)!)).toMatchObject({
      status: 'completed',
      executionStatus: 'completed',
      artifactStatus: 'missing',
      contractStatus: 'violated',
      deliveryStatus: 'chat_only',
      recoveryStatus: 'none',
      artifactPath: undefined,
      artifactError: undefined,
    });
    expect(quickStatusFields(persistedWorker(sessionStoreDir, missing.id))).toMatchObject(
      quickStatusFields(manager.getWorker(missing.id)!),
    );

    const invalidDir = mkdtempSync(join(tmpdir(), 'metabot-worker-invalid-external-'));
    try {
      const artifactDir = join(invalidDir, '.metabot-memory', 'autoresearchclaw');
      const artifactPath = join(artifactDir, 'run-smoke-output.json');
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        artifactPath,
        JSON.stringify(
          autoResearchOutput({
            memory_event_candidates: [{ type: 'finding' }],
          }),
        ),
      );
      const invalid = manager.dispatch({
        botName: 'research-pm',
        pmChatId: 'pm-chat',
        workingDirectory: invalidDir,
        prompt: '# AutoResearchClaw Run\nArtifact is malformed.',
        model: 'gpt-5.5',
      });

      expect(manager.completeWorkerFromExternal(invalid.id, { resultSummary: 'Memory Core rejected artifact' })).toBe(
        true,
      );
      expect(quickStatusFields(manager.getWorker(invalid.id)!)).toMatchObject({
        status: 'completed',
        executionStatus: 'completed',
        artifactStatus: 'invalid',
        contractStatus: 'violated',
        deliveryStatus: 'file_only',
        recoveryStatus: 'none',
        artifactPath,
        artifactError: {
          code: 'invalid_autoresearchclaw_field',
          message: expect.stringContaining('memory_event_candidates[0].summary'),
          path: artifactPath,
        },
      });
      expect(quickStatusFields(persistedWorker(sessionStoreDir, invalid.id))).toMatchObject(
        quickStatusFields(manager.getWorker(invalid.id)!),
      );
    } finally {
      rmSync(invalidDir, { recursive: true, force: true });
    }
  });

  it('preserves external terminal metadata when the worker executor resolves later', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const artifactDir = join(workdir, '.metabot-memory', 'autoresearchclaw');
    const artifactPath = join(artifactDir, 'run-smoke-output.json');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(autoResearchOutput()));
    let finishWorker: ((value: { success: boolean; responseText: string; costUsd: number }) => void) | undefined;
    const executeApiTask = vi.fn(({ chatId }: { chatId: string }) =>
      chatId.startsWith('worker-')
        ? new Promise<{ success: boolean; responseText: string; costUsd: number }>((resolve) => {
            finishWorker = resolve;
          })
        : Promise.resolve({ success: true, responseText: 'notified' }),
    );
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
    await vi.waitFor(() => expect(finishWorker).toBeDefined());
    expect(
      manager.completeWorkerFromExternal(record.id, {
        resultSummary: 'Memory Core finalized artifact before executor returned',
      }),
    ).toBe(true);
    const externallyCompleted = manager.getWorker(record.id)!;
    const externalEndTime = externallyCompleted.endTime;
    const externalDurationMs = externallyCompleted.durationMs;

    finishWorker?.({
      success: true,
      responseText: 'late executor callback should not replace Memory Core summary',
      costUsd: 0.25,
    });
    await vi.waitFor(() =>
      expect(executeApiTask).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'pm-chat',
          lifecycleKey: `worker-notify:${record.id}`,
        }),
      ),
    );

    const finalRecord = manager.getWorker(record.id)!;
    expect(finalRecord).toMatchObject({
      status: 'completed',
      executionStatus: 'completed',
      artifactStatus: 'valid_complete',
      contractStatus: 'satisfied',
      artifactPath,
      costUsd: 0.25,
      resultSummary: 'Memory Core finalized artifact before executor returned',
    });
    expect(finalRecord.endTime).toBe(externalEndTime);
    expect(finalRecord.durationMs).toBe(externalDurationMs);
    expect(quickStatusFields(persistedWorker(sessionStoreDir, record.id))).toMatchObject(
      quickStatusFields(finalRecord),
    );
  });

  it('classifies malformed AutoResearchClaw artifacts as invalid before contract satisfaction', async () => {
    const { backfillWorkerRecords } = await import('../src/workers/worker-manager.js');
    const malformedCases: Array<{
      name: string;
      output: Record<string, unknown>;
      code: string;
      message: string;
    }> = [
      {
        name: 'controlled candidate type',
        output: autoResearchOutput({
          memory_event_candidates: [{ type: 'approval_granted', summary: 'Controlled type' }],
        }),
        code: 'autoresearchclaw_candidate_type_not_allowed',
        message: 'controlled memory event type',
      },
      {
        name: 'candidate supersedes',
        output: autoResearchOutput({
          memory_event_candidates: [{ type: 'finding', summary: 'Supersede directly', supersedes: 'mem_evt_old' }],
        }),
        code: 'autoresearchclaw_candidate_supersedes_not_allowed',
        message: 'supersedes cannot be set',
      },
      {
        name: 'missing candidate summary',
        output: autoResearchOutput({
          memory_event_candidates: [{ type: 'finding' }],
        }),
        code: 'invalid_autoresearchclaw_field',
        message: 'memory_event_candidates[0].summary',
      },
      {
        name: 'candidate is not an object',
        output: autoResearchOutput({
          memory_event_candidates: ['not-an-object'],
        }),
        code: 'invalid_autoresearchclaw_field',
        message: 'memory_event_candidates[0] must be an object',
      },
      {
        name: 'memory_event_candidates is not an array',
        output: autoResearchOutput({
          memory_event_candidates: { type: 'finding', summary: 'Not an array' },
        }),
        code: 'invalid_autoresearchclaw_field',
        message: 'memory_event_candidates must be an array',
      },
      {
        name: 'unknown legacy-ish alias',
        output: autoResearchOutput({
          memory_event_candidates: [{ type: 'finding', summary: 'Unknown alias', evidenceIds: ['mem_evt_prior'] }],
        }),
        code: 'autoresearchclaw_unknown_field',
        message: 'memory_event_candidates[0].evidenceIds is not allowed',
      },
      {
        name: 'out-of-root candidate evidence path',
        output: autoResearchOutput({
          memory_event_candidates: [{ type: 'finding', summary: 'Bad path', subject: { file_paths: ['/etc/passwd'] } }],
        }),
        code: 'autoresearchclaw_path_outside_project_root',
        message: 'memory_event_candidates[0].subject.file_paths[0] escapes project root',
      },
    ];

    for (const item of malformedCases) {
      const caseDir = mkdtempSync(join(tmpdir(), 'metabot-worker-autoresearch-invalid-'));
      try {
        const artifactDir = join(caseDir, '.metabot-memory', 'autoresearchclaw');
        const artifactPath = join(artifactDir, 'run-smoke-output.json');
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(artifactPath, JSON.stringify(item.output));

        const result = backfillWorkerRecords([
          {
            id: `worker-${item.name.replace(/\W+/g, '-')}`,
            botName: 'research-pm',
            pmChatId: 'pm-chat',
            workerChatId: 'worker-chat',
            workingDirectory: caseDir,
            prompt: '# AutoResearchClaw Run',
            model: 'gpt-5.4',
            engine: 'codex',
            outputContract: { name: 'autoresearchclaw_output_v2', requiredArtifact: true },
            status: 'completed',
            startTime: Date.now() - 1000,
            endTime: Date.now(),
          } as any,
        ]);

        expect(result.updatedRecords[0]).toMatchObject({
          status: 'completed',
          artifactStatus: 'invalid',
          contractStatus: 'violated',
          recoveryStatus: 'none',
          artifactPath,
          artifactError: {
            code: item.code,
            message: expect.stringContaining(item.message),
            path: artifactPath,
          },
        });
        expect(result.updatedRecords[0]!.deliveryStatus).not.toBe('full');
      } finally {
        rmSync(caseDir, { recursive: true, force: true });
      }
    }

    const controlDir = mkdtempSync(join(tmpdir(), 'metabot-worker-autoresearch-valid-'));
    try {
      const artifactDir = join(controlDir, '.metabot-memory', 'autoresearchclaw');
      const artifactPath = join(artifactDir, 'run-smoke-output.json');
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        artifactPath,
        JSON.stringify(
          autoResearchOutput({
            memory_event_candidates: [
              {
                type: 'finding',
                summary: 'Valid canonical candidate',
                outcome: 'worked',
                subject: { file_paths: ['results/valid.json'] },
              },
            ],
          }),
        ),
      );

      const result = backfillWorkerRecords([
        {
          id: 'worker-valid-control',
          botName: 'research-pm',
          pmChatId: 'pm-chat',
          workerChatId: 'worker-chat',
          workingDirectory: controlDir,
          prompt: '# AutoResearchClaw Run',
          model: 'gpt-5.4',
          engine: 'codex',
          outputContract: { name: 'autoresearchclaw_output_v2', requiredArtifact: true },
          status: 'completed',
          startTime: Date.now() - 1000,
          endTime: Date.now(),
        } as any,
      ]);

      expect(result.updatedRecords[0]).toMatchObject({
        artifactStatus: 'valid_complete',
        contractStatus: 'satisfied',
        deliveryStatus: 'full',
        artifactPath,
      });
      expect(result.updatedRecords[0]!.artifactError).toBeUndefined();
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }

    const failedArtifactDir = mkdtempSync(join(tmpdir(), 'metabot-worker-autoresearch-failed-status-'));
    try {
      const artifactDir = join(failedArtifactDir, '.metabot-memory', 'autoresearchclaw');
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        join(artifactDir, 'run-smoke-output.json'),
        JSON.stringify(
          autoResearchOutput({
            status: 'failed',
            summary: 'Worker produced a valid failed-run artifact.',
          }),
        ),
      );

      const result = backfillWorkerRecords([
        {
          id: 'worker-valid-failed-artifact',
          botName: 'research-pm',
          pmChatId: 'pm-chat',
          workerChatId: 'worker-chat',
          workingDirectory: failedArtifactDir,
          prompt: '# AutoResearchClaw Run',
          model: 'gpt-5.4',
          engine: 'codex',
          outputContract: { name: 'autoresearchclaw_output_v2', requiredArtifact: true },
          status: 'failed',
          error: 'worker reported failure',
          startTime: Date.now() - 1000,
          endTime: Date.now(),
        } as any,
      ]);

      expect(result.updatedRecords[0]).toMatchObject({
        status: 'failed',
        error: 'worker reported failure',
        artifactStatus: 'valid_partial',
        contractStatus: 'satisfied',
        recoveryStatus: 'none',
      });
    } finally {
      rmSync(failedArtifactDir, { recursive: true, force: true });
    }
  });

  it('sanitizes malformed AutoResearchClaw JSON errors without leaking artifact fragments', async () => {
    const { backfillWorkerRecords } = await import('../src/workers/worker-manager.js');
    const artifactDir = join(workdir, '.metabot-memory', 'autoresearchclaw');
    const artifactPath = join(artifactDir, 'run-smoke-output.json');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactPath, '{"api_key":"sk-SECRET-abcdef123456","x":}');

    const result = backfillWorkerRecords([
      {
        id: 'worker-malformed-json-secret',
        botName: 'research-pm',
        pmChatId: 'pm-chat',
        workerChatId: 'worker-chat',
        workingDirectory: workdir,
        prompt: '# AutoResearchClaw Run',
        model: 'gpt-5.4',
        engine: 'codex',
        outputContract: { name: 'autoresearchclaw_output_v2', requiredArtifact: true },
        status: 'completed',
        startTime: Date.now() - 1000,
        endTime: Date.now(),
      } as any,
    ]);

    const record = result.updatedRecords[0]!;
    expect(record).toMatchObject({
      status: 'completed',
      artifactStatus: 'invalid',
      contractStatus: 'violated',
      recoveryStatus: 'none',
      deliveryStatus: 'file_only',
      artifactPath,
      artifactError: {
        code: 'invalid_json_artifact',
        path: artifactPath,
      },
    });
    expect(record.artifactError!.message).toMatch(/^Artifact is not valid JSON/);
    const surfacedError = JSON.stringify(record.artifactError);
    expect(surfacedError).not.toContain('sk-');
    expect(surfacedError).not.toContain('SECRET');
    expect(surfacedError).not.toContain('abcdef123456');
    expect(surfacedError).not.toContain('api_key');
  });

  it('accepts valid AutoResearchClaw legacy aliases and emits structured deprecation detail', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const artifactDir = join(workdir, '.metabot-memory', 'autoresearchclaw');
    const artifactPath = join(artifactDir, 'run-smoke-output.json');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      artifactPath,
      JSON.stringify(
        autoResearchOutput({
          memory_event_candidates: [
            {
              candidate_type: 'finding',
              summary: 'Legacy aliases still normalize',
              evidence_ids: ['mem_evt_prior'],
              evidence_paths: ['results/legacy.json'],
            },
          ],
        }),
      ),
    );
    logger.warn.mockClear();
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) =>
      chatId.startsWith('worker-')
        ? { success: true, responseText: 'Completed with legacy-compatible artifact.' }
        : { success: true, responseText: 'notified' },
    );
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
    expect(finalRecord.artifactStatus).toBe('valid_complete');
    expect(finalRecord.contractStatus).toBe('satisfied');
    expect(finalRecord.artifactError).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: record.id,
        projectId: 'metabot-smoke',
        runId: 'run-smoke',
        candidateIndex: 0,
        aliasNames: ['candidate_type', 'evidence_ids', 'evidence_paths'],
      }),
      expect.stringContaining('deprecated memory_event_candidates aliases'),
    );
  });

  it('does not recover a failed worker from a contract-invalid AutoResearchClaw artifact', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const artifactDir = join(workdir, '.metabot-memory', 'autoresearchclaw');
    const artifactPath = join(artifactDir, 'run-smoke-output.json');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      artifactPath,
      JSON.stringify(
        autoResearchOutput({
          memory_event_candidates: [{ type: 'finding' }],
        }),
      ),
    );
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) =>
      chatId.startsWith('worker-')
        ? {
            success: false,
            responseText: 'Artifact exists but is malformed.',
            error: 'Task timed out (2 minutes limit)',
          }
        : { success: true, responseText: 'notified' },
    );
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
      expect(manager.getWorker(record.id)?.status).toBe('failed');
    });
    const finalRecord = manager.getWorker(record.id)!;
    expect(finalRecord.status).toBe('failed');
    expect(finalRecord.executionStatus).toBe('timed_out');
    expect(finalRecord.artifactStatus).toBe('invalid');
    expect(finalRecord.contractStatus).toBe('violated');
    expect(finalRecord.recoveryStatus).toBe('none');
    expect(finalRecord.error).toContain('2 minutes');
    expect(finalRecord.terminalError).toBeUndefined();
    expect(finalRecord.artifactError).toMatchObject({
      code: 'invalid_autoresearchclaw_field',
      message: expect.stringContaining('memory_event_candidates[0].summary'),
      path: artifactPath,
    });
  });

  it('marks a completed research worker missing results.json as contract violated', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) =>
      chatId.startsWith('worker-')
        ? { success: true, responseText: 'Completed without durable output.' }
        : { success: true, responseText: 'notified' },
    );
    const bridge = { executeApiTask, stopChatTask: vi.fn() };
    const registry = { get: vi.fn(() => ({ bridge })) } as any;
    const manager = new WorkerManager(registry, logger, { defaultModel: 'gpt-5.4', maxPerPm: 8 });

    const record = manager.dispatch({
      botName: 'research-pm',
      pmChatId: 'pm-chat',
      workingDirectory: workdir,
      prompt: 'research worker: summarize findings',
      model: 'gpt-5.4',
    });

    await vi.waitFor(() => {
      expect(manager.getWorker(record.id)?.status).toBe('completed');
    });
    const finalRecord = manager.getWorker(record.id)!;
    expect(finalRecord.outputContract).toMatchObject({ name: 'generic_results_v1', requiredArtifact: true });
    expect(finalRecord.artifactStatus).toBe('missing');
    expect(finalRecord.contractStatus).toBe('violated');
    expect(finalRecord.recoveryStatus).toBe('none');
  });

  it('accepts a valid generic results.json artifact and stores full detail refs', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    const resultsPath = join(workdir, 'results.json');
    writeFileSync(
      resultsPath,
      JSON.stringify({
        task: 'Summarize benchmark deltas',
        metrics: { accuracy: 0.91, latency_ms: 12 },
        notes: 'Model B improved accuracy without violating the latency budget.',
      }),
    );
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) =>
      chatId.startsWith('worker-')
        ? { success: true, responseText: 'Completed with durable output.'.repeat(40) }
        : { success: true, responseText: 'notified' },
    );
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
    expect(finalRecord.artifactStatus).toBe('valid_complete');
    expect(finalRecord.contractStatus).toBe('satisfied');
    expect(finalRecord.artifactPath).toBe(resultsPath);
    expect(finalRecord.finalPayloadRef).toBe(`file://${resultsPath}`);
    expect(finalRecord.finalTranscriptRef).toBe(`worker-chat:${finalRecord.workerChatId}`);
    expect(finalRecord.detailRoute).toBe(`/api/workers/${finalRecord.id}`);
  });

  it('marks an invalid generic results.json artifact as contract violated', async () => {
    const { WorkerManager } = await import('../src/workers/worker-manager.js');
    writeFileSync(
      join(workdir, 'results.json'),
      JSON.stringify({
        task: 'Summarize benchmark deltas',
        metrics: ['not-an-object'],
        notes: '',
      }),
    );
    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) =>
      chatId.startsWith('worker-')
        ? { success: true, responseText: 'Completed with malformed output.' }
        : { success: true, responseText: 'notified' },
    );
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
    expect(finalRecord.artifactStatus).toBe('invalid');
    expect(finalRecord.contractStatus).toBe('violated');
    expect(finalRecord.finalPayloadRef).toBe(`file://${join(workdir, 'results.json')}`);
  });
});
