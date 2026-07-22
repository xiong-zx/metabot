import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncTaskStore } from '../src/api/async-task-store.js';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
} as any;

const stores: AsyncTaskStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.destroy();
  vi.clearAllMocks();
});

function makeReq(body: unknown): any {
  const req = new EventEmitter() as any;
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body: string) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function makeCtx(executeApiTask: any, asyncTaskStore = new AsyncTaskStore()): RouteContext {
  stores.push(asyncTaskStore);
  return {
    registry: {
      get: (name: string) => (name === 'pm' ? { bridge: { executeApiTask } } : undefined),
      list: () => [],
    } as any,
    scheduler: {} as any,
    logger,
    peerManager: undefined,
    asyncTaskStore,
    intentRouter: {} as any,
    circuitBreaker: {
      isAvailable: vi.fn(() => true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as any,
    budgetManager: {
      canAcceptTask: vi.fn(() => ({ allowed: true })),
      recordCost: vi.fn(),
    } as any,
    teamManager: {} as any,
    meetingService: {} as any,
    voiceIdentityStore: {} as any,
    ws: {},
  };
}

async function call(ctx: RouteContext, method: string, url: string, body: unknown = {}) {
  const res = makeRes();
  const handled = await handleTaskRoutes(ctx, makeReq(body), res, method, url);
  expect(handled).toBe(true);
  return res;
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function largeResponseText(label: string): string {
  return `${label}:${'x'.repeat(300 * 1024)}`;
}

function expectShellCommandArgs(command: string, expectedArgs: string[], markerFiles: string[] = []): void {
  const argsFile = path.join(os.tmpdir(), `metabot-command-args-${process.pid}-${Math.random()}`);
  const result = spawnSync(
    'sh',
    [
      '-c',
      `
metabot() {
  : > "$ARGS_FILE"
  for arg do
    printf '%s\\n' "$arg" >> "$ARGS_FILE"
  done
}
${command}
`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ARGS_FILE: argsFile },
    },
  );
  try {
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n')).toEqual(expectedArgs);
    for (const markerFile of markerFiles) {
      expect(fs.existsSync(markerFile)).toBe(false);
    }
  } finally {
    fs.rmSync(argsFile, { force: true });
  }
}

async function completedMemoryStatusForResult(result: unknown) {
  const executeApiTask = vi.fn(() => new Promise(() => {}));
  const ctx = makeCtx(executeApiTask);
  const res = await call(ctx, 'POST', '/api/talk?async=true', {
    botName: 'pm',
    chatId: 'private-test',
    prompt:
      'projectId=mem-terminal-adversarial projectRoot=/root/workspaces/mem-terminal-adversarial domain=memory-core. Use natural language Memory Core operations only. Create one finding, search, and generate a context pack.',
    sendCards: false,
  });
  const taskId = res.json().taskId;
  const task = ctx.asyncTaskStore.get(taskId)!;
  ctx.asyncTaskStore.update(taskId, {
    status: 'completed',
    completedAt: task.createdAt + 10,
    result,
  });
  return call(ctx, 'GET', `/api/talk/${taskId}`);
}

describe('/api/talk async UX', () => {
  it('accepts query async mode and exposes task status', async () => {
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'done', durationMs: 12 }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt: 'hello',
      sendCards: false,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      message: 'Task accepted for async execution',
      phase: expect.stringMatching(/^(accepted|running)$/),
      progress: expect.objectContaining({ kind: 'indeterminate', retryAfterMs: 2000 }),
      retryAfterMs: 2000,
      statusCommand: expect.stringMatching(/^metabot talk-status /),
      nextAction: expect.stringContaining('metabot talk-status'),
    });
    expect(['accepted', 'running']).toContain(res.json().status);

    const taskId = res.json().taskId;
    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      taskId,
      statusUrl: `/api/talk/${taskId}`,
      statusCommand: `metabot talk-status ${shellQuoteArg(taskId)}`,
      phase: 'completed',
      progress: expect.objectContaining({ kind: 'complete' }),
      message: 'Task finished. See result for the final response or error.',
      nextAction: 'Inspect result for the final response or error.',
    });
    expect(status.json()).not.toHaveProperty('finalPhase');
    expect(typeof status.json().elapsedMs).toBe('number');
    expect(status.json().result).toMatchObject({ success: true, responseText: 'done' });
  });

  it('preserves full production-flat async task results with generic 300KB responseText', async () => {
    const responseText = largeResponseText('generic-large-terminal');
    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText,
      costUsd: 0.02,
      durationMs: 321,
    }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt: 'hello',
      sendCards: false,
    });
    const taskId = res.json().taskId;

    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.statusCode).toBe(200);
    expect(status.json().result).toEqual({
      success: true,
      responseText,
      costUsd: 0.02,
      durationMs: 321,
    });
    expect(status.json().result.responseText).toHaveLength(responseText.length);
    expect(status.json().result.responseText).not.toContain('[Truncated: string budget exceeded]');
  });

  it('running task status includes retry guidance and elapsed time', async () => {
    let resolveTask!: (value: { success: true; responseText: string }) => void;
    const executeApiTask = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveTask = resolve as typeof resolveTask;
        }),
    );
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt: 'hello',
      sendCards: false,
    });

    const taskId = res.json().taskId;
    expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('running');

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      taskId,
      status: 'running',
      phase: 'running',
      progress: expect.objectContaining({ kind: 'indeterminate', retryAfterMs: 2000 }),
      retryAfterMs: 2000,
      statusUrl: `/api/talk/${taskId}`,
      statusCommand: `metabot talk-status ${shellQuoteArg(taskId)}`,
      message:
        'Task is still running. Check statusUrl again later; long research tasks may expose more detail in their Memory Core run lifecycle.',
      nextAction: `Run metabot talk-status ${shellQuoteArg(
        taskId,
      )} again after 2s. For AutoResearchClaw tasks, also ask for the matching Memory Core run status.`,
    });
    expect(typeof status.json().elapsedMs).toBe('number');

    resolveTask({ success: true, responseText: 'done' });
    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
    });
  });

  it('returns structured guidance when an async task id is unavailable', async () => {
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'unused' }));
    const ctx = makeCtx(executeApiTask);

    const status = await call(ctx, 'GET', '/api/talk/missing-task');

    expect(status.statusCode).toBe(404);
    expect(status.json()).toMatchObject({
      taskId: 'missing-task',
      status: 'not_found',
      phase: 'not_found',
      progress: { kind: 'unavailable' },
      statusUrl: '/api/talk/missing-task',
      statusCommand: `metabot talk-status ${shellQuoteArg('missing-task')}`,
      error: 'Task not found or no longer retained',
      message: expect.stringContaining('expired after retention'),
      nextAction: expect.stringContaining('metabot talk --wait-ms'),
    });
  });

  it('adds AutoResearchClaw preflight to async bot-bus accepted responses', async () => {
    const executeApiTask = vi.fn(() => new Promise(() => {}));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'Checklist: runId=...、domain=...; Start AutoResearchClaw research loop. projectId=metabot-r6 runId=run-r6-001、domain=metabot. projectRoot=/root/workspaces/r6',
      sendCards: false,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      phase: 'autoresearchclaw_accepted',
      runId: 'run-r6-001',
      progress: expect.objectContaining({
        kind: 'phased',
        currentPhase: 'worker_dispatch',
        projectId: 'metabot-r6',
        runId: 'run-r6-001',
        projectRoot: '/root/workspaces/r6',
        domain: 'metabot',
      }),
      preflight: {
        projectId: 'metabot-r6',
        runId: 'run-r6-001',
        projectRoot: '/root/workspaces/r6',
        domain: 'metabot',
        stages: expect.arrayContaining([
          expect.objectContaining({ phase: 'context_pack' }),
          expect.objectContaining({ phase: 'worker_dispatch' }),
          expect.objectContaining({ phase: 'output_contract' }),
          expect.objectContaining({ phase: 'ingest_review' }),
        ]),
        outputContract: expect.arrayContaining(['contract_version', 'hypotheses', 'tool_trace']),
      },
    });

    const taskId = res.json().taskId;
    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.json()).toMatchObject({
      status: 'running',
      phase: 'autoresearchclaw_running',
      runId: 'run-r6-001',
      progress: expect.objectContaining({
        kind: 'phased',
        currentPhase: 'worker_dispatch',
        projectId: 'metabot-r6',
        runId: 'run-r6-001',
        projectRoot: '/root/workspaces/r6',
        domain: 'metabot',
      }),
      preflight: expect.objectContaining({
        projectId: 'metabot-r6',
        runId: 'run-r6-001',
        domain: 'metabot',
      }),
      nextAction: expect.stringContaining(
        `metabot research runs --root ${shellQuoteArg('/root/workspaces/r6')} --project ${shellQuoteArg('metabot-r6')}`,
      ),
    });
  });

  it('quotes prompt-derived Memory Core command arguments for copy-paste shell safety', async () => {
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-shell-safe-'));
    const rootMarker = path.join(markerDir, 'root-injected');
    const rootTickMarker = path.join(markerDir, 'root-backtick-injected');
    const projectMarker = path.join(markerDir, 'project-injected');
    const projectTickMarker = path.join(markerDir, 'project-backtick-injected');
    const runMarker = path.join(markerDir, 'run-injected');
    const projectRoot = `/tmp/research root/quoted "dir" $(touch\${IFS}${rootMarker}) \`touch\${IFS}${rootTickMarker}\` '&`;
    const projectId = `project $(touch\${IFS}${projectMarker}) \`touch\${IFS}${projectTickMarker}\` '& id`;
    const runId = `run "quoted" $(touch\${IFS}${runMarker})`;
    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: 'artifact ingested',
      durationMs: 24,
    }));
    const ctx = makeCtx(executeApiTask);

    try {
      const res = await call(ctx, 'POST', '/api/talk?async=true', {
        botName: 'pm',
        chatId: 'private-test',
        prompt: `Start AutoResearchClaw research loop. projectId="${projectId}" runId="${runId.replace(
          /"/g,
          '\\"',
        )}" projectRoot="${projectRoot.replace(/"/g, '\\"')}" domain="memory core"`,
        sendCards: false,
      });

      expect(res.json()).toMatchObject({
        progress: expect.objectContaining({
          projectId,
          runId,
          projectRoot,
          domain: 'memory core',
        }),
        nextAction: expect.stringContaining(
          `metabot research runs --root ${shellQuoteArg(projectRoot)} --project ${shellQuoteArg(projectId)}`,
        ),
      });
      const runningCommand = String(res.json().nextAction).slice(
        String(res.json().nextAction).indexOf('metabot research runs'),
      );
      expectShellCommandArgs(
        runningCommand.replace(/\.$/, ''),
        ['research', 'runs', '--root', projectRoot, '--project', projectId],
        [rootMarker, rootTickMarker, projectMarker, projectTickMarker, runMarker],
      );

      const taskId = res.json().taskId;
      await eventually(() => {
        expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
      });

      const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
      const terminalNextAction = String(status.json().nextAction);
      expect(terminalNextAction).toContain(`locate run ${shellQuoteArg(runId)}`);
      const terminalCommand = terminalNextAction
        .slice(terminalNextAction.indexOf('metabot research runs'))
        .split(';')[0];
      expectShellCommandArgs(
        terminalCommand,
        ['research', 'runs', '--root', projectRoot, '--project', projectId],
        [rootMarker, rootTickMarker, projectMarker, projectTickMarker, runMarker],
      );
    } finally {
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  });

  it('quotes unavailable task ids so statusCommand cannot execute shell metacharacters', async () => {
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-task-id-safe-'));
    const subMarker = path.join(markerDir, 'substitution-injected');
    const tickMarker = path.join(markerDir, 'backtick-injected');
    const dangerousTaskId = `missing$(touch\${IFS}${subMarker})\`touch\${IFS}${tickMarker}\`'&x`;
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'unused' }));
    const ctx = makeCtx(executeApiTask);

    try {
      const status = await call(ctx, 'GET', `/api/talk/${dangerousTaskId}`);

      expect(status.statusCode).toBe(404);
      const actualTaskId = status.json().taskId;
      expect(actualTaskId).toContain('missing$(');
      expect(actualTaskId).toContain('%7BIFS%7D');
      expect(status.json()).toMatchObject({
        taskId: actualTaskId,
        statusCommand: `metabot talk-status ${shellQuoteArg(actualTaskId)}`,
      });
      expectShellCommandArgs(status.json().statusCommand, ['talk-status', actualTaskId], [subMarker, tickMarker]);
    } finally {
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  });

  it('preserves AutoResearchClaw lifecycle context after async completion', async () => {
    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: 'artifact ingested',
      durationMs: 24,
    }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'Start AutoResearchClaw research loop. projectId=terminal-pass runId=run-terminal-pass projectRoot=/root/workspaces/terminal-pass domain=memory-core',
      sendCards: false,
    });
    const taskId = res.json().taskId;

    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.json()).toMatchObject({
      status: 'completed',
      phase: 'autoresearchclaw_completed',
      runId: 'run-terminal-pass',
      finalPhase: 'completed',
      progress: {
        kind: 'phased',
        currentPhase: 'completed',
        finalPhase: 'completed',
        projectId: 'terminal-pass',
        runId: 'run-terminal-pass',
        projectRoot: '/root/workspaces/terminal-pass',
        domain: 'memory-core',
        stages: expect.arrayContaining([
          expect.objectContaining({ phase: 'context_pack' }),
          expect.objectContaining({ phase: 'ingest_review' }),
        ]),
        ingestReviewPhase: expect.objectContaining({
          phase: 'ingest_review',
          status: 'memory_core_system_of_record_required',
          systemOfRecord: 'memory_core',
        }),
        memoryCoreSystemOfRecord: expect.objectContaining({
          status: 'inspect_required',
          runId: 'run-terminal-pass',
          projectId: 'terminal-pass',
        }),
        finalization: {
          status: 'async_task_completed',
          systemOfRecord: 'memory_core',
        },
        nextAction: expect.stringContaining(
          `metabot research runs --root ${shellQuoteArg('/root/workspaces/terminal-pass')} --project ${shellQuoteArg(
            'terminal-pass',
          )}`,
        ),
      },
      message: expect.stringContaining('Memory Core remains the system of record'),
      nextAction: expect.stringContaining(
        `metabot research runs --root ${shellQuoteArg('/root/workspaces/terminal-pass')} --project ${shellQuoteArg(
          'terminal-pass',
        )}`,
      ),
      result: expect.objectContaining({ success: true, responseText: 'artifact ingested' }),
    });
  });

  it('preserves AutoResearchClaw lifecycle context after async failure', async () => {
    const executeApiTask = vi.fn(async () => ({
      success: false,
      responseText: '',
      error: 'ingest rejected',
      errorCode: 'contract_invalid',
    }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'Start AutoResearchClaw research loop. projectId=terminal-fail runId=run-terminal-fail projectRoot=/root/workspaces/terminal-fail domain=memory-core',
      sendCards: false,
    });
    const taskId = res.json().taskId;

    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('failed');
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.json()).toMatchObject({
      status: 'failed',
      phase: 'autoresearchclaw_failed',
      runId: 'run-terminal-fail',
      finalPhase: 'failed',
      progress: expect.objectContaining({
        kind: 'phased',
        currentPhase: 'failed',
        finalPhase: 'failed',
        projectId: 'terminal-fail',
        runId: 'run-terminal-fail',
        ingestReviewPhase: expect.objectContaining({
          phase: 'ingest_review',
          status: 'not_asserted_async_failed',
          systemOfRecord: 'memory_core',
        }),
        memoryCoreSystemOfRecord: expect.objectContaining({
          status: 'inspect_required',
          runId: 'run-terminal-fail',
          projectId: 'terminal-fail',
        }),
        error: {
          status: 'async_task_failed',
          code: 'contract_invalid',
          message: 'ingest rejected',
        },
        nextAction: expect.stringContaining(
          `metabot research runs --root ${shellQuoteArg('/root/workspaces/terminal-fail')} --project ${shellQuoteArg(
            'terminal-fail',
          )}`,
        ),
      }),
      message: expect.stringContaining('Memory Core run lifecycle'),
      nextAction: expect.stringContaining(
        `metabot research runs --root ${shellQuoteArg('/root/workspaces/terminal-fail')} --project ${shellQuoteArg(
          'terminal-fail',
        )}`,
      ),
      result: expect.objectContaining({
        success: false,
        error: 'ingest rejected',
        errorCode: 'contract_invalid',
      }),
    });
  });

  it('adds phased Memory Core status to natural-language memory operations', async () => {
    const executeApiTask = vi.fn(() => new Promise(() => {}));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'r11 Memory UX smoke for projectId=metabot-r11 projectRoot=/root/workspaces/projects/r11 domain=metabot-r11. Use natural language Memory Core operations only. Create one finding and one decision, request promotion approval, search, and generate a context pack.',
      sendCards: false,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      phase: 'memory_operation_accepted',
      progress: expect.objectContaining({
        kind: 'phased',
        currentPhase: 'scope_parse',
        projectId: 'metabot-r11',
        projectRoot: '/root/workspaces/projects/r11',
        domain: 'metabot-r11',
        timeoutBoundaryMs: 150_000,
      }),
      preflight: expect.objectContaining({
        kind: 'memory_core',
        projectId: 'metabot-r11',
        stages: expect.arrayContaining([
          expect.objectContaining({ phase: 'memory_write' }),
          expect.objectContaining({ phase: 'pending_review' }),
          expect.objectContaining({ phase: 'search_context_pack' }),
          expect.objectContaining({ phase: 'timeout_boundary' }),
        ]),
      }),
      nextAction: expect.stringContaining('metabot research events/search/context-pack'),
    });

    const taskId = res.json().taskId;
    const task = ctx.asyncTaskStore.get(taskId)!;
    ctx.asyncTaskStore.update(taskId, {
      status: 'running',
      createdAt: task.createdAt - 135_000,
    });

    const overdue = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(overdue.json()).toMatchObject({
      status: 'running',
      phase: 'memory_operation_running',
      progress: expect.objectContaining({
        kind: 'phased',
        currentPhase: 'expected_completion_overdue',
        elapsedMs: expect.any(Number),
      }),
      message: expect.stringContaining('expected completion window'),
      nextAction: expect.stringContaining('partial Memory Core evidence'),
    });

    ctx.asyncTaskStore.update(taskId, {
      status: 'running',
      createdAt: task.createdAt - 159_000,
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.json()).toMatchObject({
      status: 'running',
      phase: 'memory_operation_running',
      progress: expect.objectContaining({
        kind: 'phased',
        currentPhase: 'timeout_boundary',
        elapsedMs: expect.any(Number),
      }),
      message: expect.stringContaining('timeout boundary'),
      nextAction: expect.stringContaining('partial Memory Core evidence'),
    });
  });

  it('preserves phased Memory Core context and structured evidence after async completion', async () => {
    const responseText = [
      'Memory operation complete.',
      '```json',
      JSON.stringify(
        {
          result: {
            writes: {
              events: [{ id: 'mem_evt_beta' }, { id: 'mem_evt_alpha' }, { id: 'mem_evt_alpha' }],
              memoryUnits: [{ id: 'mem_unit_beta' }, { id: 'mem_unit_alpha' }, { id: 'mem_unit_alpha' }],
              promotionRequest: { id: 'prom_req_terminal', status: 'pending_review' },
              candidateIds: ['cand_terminal', 'cand_terminal'],
              contextPack: { id: 'ctx_terminal_1' },
              finalizationPhase: 'candidate_review_pending',
            },
          },
        },
        null,
        2,
      ),
      '```',
    ].join('\n');
    const executeApiTask = vi.fn(async () => ({ success: true, responseText, durationMs: 24 }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'projectId=mem-terminal-pass projectRoot=/root/workspaces/mem-terminal-pass domain=memory-core. Use natural language Memory Core operations only. Create one finding and one decision, request promotion approval, search, and generate a context pack.',
      sendCards: false,
    });
    const taskId = res.json().taskId;

    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.json()).toMatchObject({
      status: 'completed',
      phase: 'memory_operation_completed',
      finalPhase: 'completed',
      memoryCoreEvidence: {
        eventIds: ['mem_evt_alpha', 'mem_evt_beta'],
        memoryUnitIds: ['mem_unit_alpha', 'mem_unit_beta'],
        promotionIds: ['prom_req_terminal'],
        candidateIds: ['cand_terminal'],
        contextPackIds: ['ctx_terminal_1'],
      },
      progress: {
        kind: 'phased',
        currentPhase: 'completed',
        finalPhase: 'completed',
        projectId: 'mem-terminal-pass',
        projectRoot: '/root/workspaces/mem-terminal-pass',
        domain: 'memory-core',
        operation: 'write_search_context_pack',
        expectedCompletionMs: 120_000,
        timeoutBoundaryMs: 150_000,
        evidence: {
          eventIds: ['mem_evt_alpha', 'mem_evt_beta'],
          memoryUnitIds: ['mem_unit_alpha', 'mem_unit_beta'],
          promotionIds: ['prom_req_terminal'],
          candidateIds: ['cand_terminal'],
          contextPackIds: ['ctx_terminal_1'],
        },
        finalization: {
          status: 'memory_operation_completed',
          reviewState: 'pending_review',
          evidenceState: 'structured_evidence_extracted',
          overdueState: 'within_expected_window',
          partialEvidence: false,
        },
        nextAction: expect.stringContaining(
          `metabot research events/search/context-pack --root ${shellQuoteArg('/root/workspaces/mem-terminal-pass')} --project ${shellQuoteArg(
            'mem-terminal-pass',
          )}`,
        ),
      },
      message: expect.stringContaining('Pending review evidence was detected'),
      nextAction: expect.stringContaining('This task completed.'),
      result: expect.objectContaining({ success: true, responseText }),
    });
  });

  it('preserves full production-flat Memory Core result with adversarial 300KB responseText', async () => {
    const responseText = JSON.stringify({
      event_ids: ['mem_evt_large_response'],
      padding: largeResponseText('memory-large-terminal'),
    });
    const executeApiTask = vi.fn(async () => ({ success: true, responseText, durationMs: 77 }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'projectId=mem-terminal-large projectRoot=/root/workspaces/mem-terminal-large domain=memory-core. Use natural language Memory Core operations only. Create one finding, search, and generate a context pack.',
      sendCards: false,
    });
    const taskId = res.json().taskId;

    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'completed',
      phase: 'memory_operation_completed',
      progress: {
        finalization: {
          evidenceState: 'no_structured_evidence_truncated',
          reviewState: 'not_pending_review',
        },
      },
      result: {
        success: true,
        responseText,
        durationMs: 77,
      },
    });
    expect(status.json().result.responseText).toHaveLength(responseText.length);
    expect(status.json().result.responseText).not.toContain('[Truncated: string budget exceeded]');
    expect(status.json()).not.toHaveProperty('memoryCoreEvidence');
  });

  it('preserves phased Memory Core context and partial evidence after async failure', async () => {
    const responseText = JSON.stringify({
      partial: {
        event_ids: ['mem_evt_fail_b', 'mem_evt_fail_a', 'mem_evt_fail_a'],
        memory_unit_ids: ['mem_unit_fail'],
        promotionIds: ['prom_req_fail'],
        context_pack_id: 'ctx_fail',
      },
    });
    const executeApiTask = vi.fn(async () => ({
      success: false,
      responseText,
      error: 'memory core failed',
      errorCode: 'memory_core_failed',
    }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'projectId=mem-terminal-fail projectRoot=/root/workspaces/mem-terminal-fail domain=memory-core. Use natural language Memory Core operations only. Create one finding, request promotion approval, then search and build a context pack.',
      sendCards: false,
    });
    const taskId = res.json().taskId;

    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('failed');
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.json()).toMatchObject({
      status: 'failed',
      phase: 'memory_operation_failed',
      finalPhase: 'failed',
      memoryCoreEvidence: {
        eventIds: ['mem_evt_fail_a', 'mem_evt_fail_b'],
        memoryUnitIds: ['mem_unit_fail'],
        promotionIds: ['prom_req_fail'],
        contextPackIds: ['ctx_fail'],
      },
      progress: {
        kind: 'phased',
        currentPhase: 'failed',
        finalPhase: 'failed',
        projectId: 'mem-terminal-fail',
        operation: 'write_search_context_pack',
        evidence: {
          eventIds: ['mem_evt_fail_a', 'mem_evt_fail_b'],
          memoryUnitIds: ['mem_unit_fail'],
          promotionIds: ['prom_req_fail'],
          contextPackIds: ['ctx_fail'],
        },
        finalization: {
          status: 'memory_operation_failed',
          reviewState: 'not_pending_review',
          evidenceState: 'structured_evidence_extracted',
          overdueState: 'within_expected_window',
          partialEvidence: false,
        },
        error: {
          status: 'memory_operation_failed',
          code: 'memory_core_failed',
          message: 'memory core failed',
        },
      },
      message: expect.stringContaining('Memory Core operation failed'),
      nextAction: expect.stringContaining('This task failed.'),
      result: expect.objectContaining({
        success: false,
        responseText,
        error: 'memory core failed',
        errorCode: 'memory_core_failed',
      }),
    });
  });

  it('does not infer pending review from ids when terminal evidence explicitly says approved/finalized', async () => {
    const responseText = JSON.stringify({
      result: {
        writes: {
          promotionRequest: { id: 'prom_req_approved', status: 'approved' },
          candidateIds: ['cand_approved'],
          contextPack: { id: 'ctx_approved' },
        },
        reviewStatus: 'approved',
        finalizationPhase: 'finalized',
      },
    });
    const executeApiTask = vi.fn(async () => ({ success: true, responseText, durationMs: 9 }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'projectId=mem-terminal-approved projectRoot=/root/workspaces/mem-terminal-approved domain=memory-core. Use natural language Memory Core operations only. Create one finding, explicitly approve the promotion, and return a final context pack.',
      sendCards: false,
    });
    const taskId = res.json().taskId;

    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.json()).toMatchObject({
      status: 'completed',
      phase: 'memory_operation_completed',
      finalPhase: 'completed',
      memoryCoreEvidence: {
        promotionIds: ['prom_req_approved'],
        candidateIds: ['cand_approved'],
        contextPackIds: ['ctx_approved'],
      },
      progress: {
        kind: 'phased',
        currentPhase: 'completed',
        finalPhase: 'completed',
        finalization: {
          status: 'memory_operation_completed',
          reviewState: 'not_pending_review',
          evidenceState: 'structured_evidence_extracted',
          overdueState: 'within_expected_window',
          partialEvidence: false,
        },
      },
      message: 'Memory Core operation completed. Structured Memory Core evidence was extracted into status fields.',
      nextAction: expect.not.stringContaining('Review the pending candidate or promotion request'),
      result: expect.objectContaining({ success: true, responseText }),
    });
  });

  it('preserves timeout-boundary context when a Memory Core task completes late', async () => {
    const executeApiTask = vi.fn(() => new Promise(() => {}));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'projectId=mem-terminal-overdue projectRoot=/root/workspaces/mem-terminal-overdue domain=memory-core. Use natural language Memory Core operations only. Create one finding, search, and generate a context pack.',
      sendCards: false,
    });
    const taskId = res.json().taskId;
    const task = ctx.asyncTaskStore.get(taskId)!;
    ctx.asyncTaskStore.update(taskId, {
      status: 'completed',
      createdAt: task.createdAt - 160_000,
      completedAt: task.createdAt,
      result: {
        success: true,
        responseText: '{"event_ids":["mem_evt_overdue"],"context_pack_id":"ctx_overdue"}',
      },
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.json()).toMatchObject({
      status: 'completed',
      phase: 'memory_operation_completed',
      finalPhase: 'completed',
      progress: {
        kind: 'phased',
        currentPhase: 'completed',
        finalPhase: 'completed',
        elapsedMs: 160_000,
        finalization: {
          status: 'memory_operation_completed',
          reviewState: 'not_pending_review',
          evidenceState: 'structured_evidence_extracted',
          overdueState: 'timeout_boundary_exceeded',
          partialEvidence: true,
        },
      },
      message: expect.stringContaining('after the timeout boundary'),
      nextAction: expect.stringContaining('completed after the timeout boundary'),
      memoryCoreEvidence: {
        eventIds: ['mem_evt_overdue'],
        contextPackIds: ['ctx_overdue'],
      },
    });
  });

  it('reports when no structured Memory Core evidence can be derived from the terminal result', async () => {
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'done', durationMs: 5 }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt:
        'projectId=mem-terminal-opaque projectRoot=/root/workspaces/mem-terminal-opaque domain=memory-core. Use natural language Memory Core operations only. Create one finding and one decision, then search and generate a context pack.',
      sendCards: false,
    });
    const taskId = res.json().taskId;

    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
    });

    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
    expect(status.json()).toMatchObject({
      status: 'completed',
      phase: 'memory_operation_completed',
      finalPhase: 'completed',
      progress: {
        kind: 'phased',
        finalization: {
          status: 'memory_operation_completed',
          reviewState: 'not_pending_review',
          evidenceState: 'no_structured_evidence',
          overdueState: 'within_expected_window',
          partialEvidence: false,
        },
      },
      message: expect.stringContaining('No structured Memory Core evidence could be derived'),
      nextAction: expect.stringContaining(
        'recover event ids, memory unit ids, promotion/candidate ids, and context pack ids',
      ),
      result: expect.objectContaining({ success: true, responseText: 'done' }),
    });
    expect(status.json()).not.toHaveProperty('memoryCoreEvidence');
    expect(status.json().progress).not.toHaveProperty('evidence');
  });

  it('returns degraded Memory Core guidance for cyclic terminal evidence without throwing', async () => {
    const cyclic: any = { eventIds: ['mem_evt_cycle'] };
    cyclic.result = cyclic;
    const result = { success: true, responseText: '' };
    Object.defineProperty(result, 'memoryCoreEvidence', {
      enumerable: false,
      value: cyclic,
    });

    const status = await completedMemoryStatusForResult(result);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'completed',
      phase: 'memory_operation_completed',
      memoryCoreEvidence: {
        eventIds: ['mem_evt_cycle'],
      },
      progress: {
        finalization: {
          evidenceState: 'structured_evidence_truncated',
          reviewState: 'not_pending_review',
        },
        evidence: {
          eventIds: ['mem_evt_cycle'],
        },
      },
      nextAction: expect.stringContaining('Bounded terminal extraction was truncated'),
      result: { success: true, responseText: '' },
    });
  });

  it('returns no-structured truncated guidance for very deep terminal evidence without throwing', async () => {
    const deep: any = {};
    let cursor = deep;
    for (let index = 0; index < 20_000; index += 1) {
      cursor.result = {};
      cursor = cursor.result;
    }
    cursor.eventIds = ['mem_evt_too_deep'];
    const result = { success: true, responseText: '' };
    Object.defineProperty(result, 'memoryCoreEvidence', {
      enumerable: false,
      value: deep,
    });

    const status = await completedMemoryStatusForResult(result);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'completed',
      phase: 'memory_operation_completed',
      progress: {
        finalization: {
          evidenceState: 'no_structured_evidence_truncated',
          reviewState: 'not_pending_review',
        },
      },
      message: expect.stringContaining('bounded extraction truncated'),
      nextAction: expect.stringContaining('Bounded terminal extraction was truncated'),
    });
    expect(status.json()).not.toHaveProperty('memoryCoreEvidence');
  });

  it('does not mark repeated shared evidence references as truncated', async () => {
    const shared = { events: [{ id: 'mem_evt_shared' }] };
    const evidence = { writes: shared, partial: shared };
    const result = { success: true, responseText: '' };
    Object.defineProperty(result, 'memoryCoreEvidence', {
      enumerable: false,
      value: evidence,
    });

    const status = await completedMemoryStatusForResult(result);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      memoryCoreEvidence: {
        eventIds: ['mem_evt_shared'],
      },
      progress: {
        finalization: {
          evidenceState: 'structured_evidence_extracted',
          reviewState: 'not_pending_review',
        },
      },
      result: { success: true, responseText: '' },
    });
    expect(status.json().nextAction).not.toContain('Bounded terminal extraction was truncated');
  });

  it('does not mark unrelated non-envelope payload fields as truncated evidence', async () => {
    const responseText = '';
    const terminalResult = {
      success: true,
      responseText,
      result: {
        eventIds: ['mem_evt_flat'],
        unrelatedLog: largeResponseText('not-memory-evidence'),
      },
      durationMs: 14,
    };

    const status = await completedMemoryStatusForResult(terminalResult);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      memoryCoreEvidence: {
        eventIds: ['mem_evt_flat'],
      },
      progress: {
        finalization: {
          evidenceState: 'structured_evidence_extracted',
          reviewState: 'not_pending_review',
        },
      },
      result: terminalResult,
    });
    expect(status.json().nextAction).not.toContain('Bounded terminal extraction was truncated');
  });

  it('degrades Memory Core evidence extraction instead of propagating throwing getters', async () => {
    const result = { success: true, responseText: '' };
    Object.defineProperty(result, 'memoryCoreEvidence', {
      enumerable: false,
      get() {
        throw new Error('getter failed');
      },
    });

    const status = await completedMemoryStatusForResult(result);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      progress: {
        finalization: {
          evidenceState: 'no_structured_evidence_truncated',
          reviewState: 'not_pending_review',
        },
      },
      result: { success: true, responseText: '' },
    });
    expect(status.json()).not.toHaveProperty('memoryCoreEvidence');
    expect(status.json().nextAction).toContain('Bounded terminal extraction was truncated');
  });

  it('deterministically truncates wide evidence arrays at the item budget without throwing', async () => {
    const eventIds = Array.from({ length: 1_200 }, (_, index) => `mem_evt_${String(index).padStart(4, '0')}`);

    const status = await completedMemoryStatusForResult({
      success: true,
      responseText: JSON.stringify({ result: { eventIds } }),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().memoryCoreEvidence.eventIds).toHaveLength(1_000);
    expect(status.json().memoryCoreEvidence.eventIds[0]).toBe('mem_evt_0000');
    expect(status.json().memoryCoreEvidence.eventIds[999]).toBe('mem_evt_0999');
    expect(status.json().memoryCoreEvidence.eventIds).not.toContain('mem_evt_1199');
    expect(status.json().progress.finalization.evidenceState).toBe('structured_evidence_truncated');
    expect(status.json().nextAction).toContain('Bounded terminal extraction was truncated');
  });

  it('does not mark approved, rejected, or completed promotions as pending review', async () => {
    for (const promotionStatus of ['approved', 'rejected', 'completed']) {
      const status = await completedMemoryStatusForResult({
        success: true,
        responseText: JSON.stringify({
          result: {
            writes: {
              promotionRequest: { id: `prom_req_${promotionStatus}`, status: promotionStatus },
              candidate: { id: `cand_${promotionStatus}`, status: promotionStatus },
            },
            reviewStatus: promotionStatus,
            finalizationPhase: promotionStatus,
          },
        }),
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().progress.finalization.reviewState).toBe('not_pending_review');
      expect(status.json().message).not.toContain('Pending review evidence was detected');
      expect(status.json().nextAction).not.toContain('Review the pending candidate or promotion request');
    }
  });

  it('excludes unrelated meta.unitId while collecting whitelisted Memory Core containers', async () => {
    const status = await completedMemoryStatusForResult({
      success: true,
      result: {
        meta: {
          unitId: 'mem_unit_unrelated',
        },
        writes: {
          events: [{ id: 'mem_evt_real' }],
        },
      },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().memoryCoreEvidence).toEqual({
      eventIds: ['mem_evt_real'],
    });
    expect(status.json().memoryCoreEvidence.memoryUnitIds).toBeUndefined();
  });

  it('ignores malformed fenced JSON and still returns actionable Memory Core inspect guidance', async () => {
    const status = await completedMemoryStatusForResult({
      success: true,
      responseText: '```json\n{"result":\n```',
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      progress: {
        finalization: {
          evidenceState: 'no_structured_evidence',
          reviewState: 'not_pending_review',
        },
      },
      message: expect.stringContaining('No structured Memory Core evidence could be derived'),
      nextAction: expect.stringContaining('metabot research events/search/context-pack'),
    });
    expect(status.json()).not.toHaveProperty('memoryCoreEvidence');
  });

  it('extracts the live e474eb45 responseText Memory Core payload shape with sorted dedupe', async () => {
    const status = await completedMemoryStatusForResult({
      success: true,
      responseText: JSON.stringify({
        events: {
          finding: { eventId: 'mem_evt_finding', memoryUnitId: 'mem_unit_finding' },
          decision: { eventId: 'mem_evt_decision', memoryUnitId: 'mem_unit_decision' },
        },
        promotionRequest: {
          id: 'prom_req_live',
          status: 'approved',
          eventStatus: 'completed',
        },
        search: {
          returned: [
            { eventId: 'mem_evt_search_b', memoryUnitId: 'mem_unit_search_b' },
            { eventId: 'mem_evt_search_a', memoryUnitId: 'mem_unit_search_a' },
            { eventId: 'mem_evt_search_a', memoryUnitId: 'mem_unit_search_a' },
          ],
        },
        contextPack: {
          id: 'ctx_live',
          includedEventIds: ['mem_evt_finding', 'mem_evt_context_only'],
        },
      }),
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      memoryCoreEvidence: {
        eventIds: [
          'mem_evt_context_only',
          'mem_evt_decision',
          'mem_evt_finding',
          'mem_evt_search_a',
          'mem_evt_search_b',
        ],
        memoryUnitIds: ['mem_unit_decision', 'mem_unit_finding', 'mem_unit_search_a', 'mem_unit_search_b'],
        promotionIds: ['prom_req_live'],
        contextPackIds: ['ctx_live'],
      },
      progress: {
        finalization: {
          evidenceState: 'structured_evidence_extracted',
          reviewState: 'not_pending_review',
        },
      },
    });
  });

  it('quotes Memory Core terminal inspect commands for shell-safe project and root values', async () => {
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-memory-shell-safe-'));
    const rootMarker = path.join(markerDir, 'root-injected');
    const rootTickMarker = path.join(markerDir, 'root-backtick-injected');
    const projectMarker = path.join(markerDir, 'project-injected');
    const projectTickMarker = path.join(markerDir, 'project-backtick-injected');
    const projectRoot = `/tmp/memory root/quoted "dir" $(touch\${IFS}${rootMarker}) \`touch\${IFS}${rootTickMarker}\` '&`;
    const projectId = `memory $(touch\${IFS}${projectMarker}) \`touch\${IFS}${projectTickMarker}\` '& project`;
    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: '{"event_ids":["mem_evt_safe"]}',
      durationMs: 7,
    }));
    const ctx = makeCtx(executeApiTask);

    try {
      const res = await call(ctx, 'POST', '/api/talk?async=true', {
        botName: 'pm',
        chatId: 'private-test',
        prompt: `projectId="${projectId.replace(/"/g, '\\"')}" projectRoot="${projectRoot.replace(
          /"/g,
          '\\"',
        )}" domain="memory core". Use natural language Memory Core operations only. Create one finding, search, and generate a context pack.`,
        sendCards: false,
      });
      const taskId = res.json().taskId;

      await eventually(() => {
        expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('completed');
      });

      const status = await call(ctx, 'GET', `/api/talk/${taskId}`);
      expect(status.json()).toMatchObject({
        progress: expect.objectContaining({
          projectId,
          projectRoot,
          domain: 'memory core',
        }),
        nextAction: expect.stringContaining(
          `metabot research events/search/context-pack --root ${shellQuoteArg(projectRoot)} --project ${shellQuoteArg(
            projectId,
          )}`,
        ),
      });
      const command = String(status.json().nextAction)
        .slice(String(status.json().nextAction).indexOf('metabot research events/search/context-pack'))
        .split('. ')[0];
      expectShellCommandArgs(
        command,
        ['research', 'events/search/context-pack', '--root', projectRoot, '--project', projectId],
        [rootMarker, rootTickMarker, projectMarker, projectTickMarker],
      );
    } finally {
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  });

  it('marks orphaned running tasks as failed after the stale timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'));
    const executeApiTask = vi.fn(() => new Promise(() => {}));
    const ctx = makeCtx(
      executeApiTask,
      new AsyncTaskStore({
        staleTaskMs: 1000,
        cleanupIntervalMs: 60_000,
      }),
    );

    const res = await call(ctx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt: 'hello',
      sendCards: false,
    });
    const taskId = res.json().taskId;

    await eventually(() => {
      expect(ctx.asyncTaskStore.get(taskId)?.status).toBe('running');
    });

    vi.setSystemTime(new Date('2026-07-07T00:00:01.001Z'));
    const status = await call(ctx, 'GET', `/api/talk/${taskId}`);

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      taskId,
      status: 'failed',
      phase: 'failed',
      progress: expect.objectContaining({ kind: 'complete' }),
      message: 'Task finished. See result for the final response or error.',
      result: {
        success: false,
        responseText: '',
        errorCode: 'task_expired',
      },
    });
    expect(status.json()).not.toHaveProperty('finalPhase');
    expect(status.json().elapsedMs).toBe(1001);
  });

  it('restores persisted running tasks as restart-interrupted instead of missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-async-task-store-'));
    try {
      const storageFile = path.join(dir, 'async-tasks.json');
      const first = new AsyncTaskStore({ storageFile, cleanupIntervalMs: 60_000 });
      stores.push(first);
      const task = first.create({ botName: 'pm', chatId: 'private-test', prompt: 'long task' });
      first.update(task.id, { status: 'running' });

      const second = new AsyncTaskStore({ storageFile, cleanupIntervalMs: 60_000 });
      stores.push(second);
      expect(second.get(task.id)).toMatchObject({
        id: task.id,
        status: 'failed',
        result: {
          success: false,
          responseText: '',
          errorCode: 'task_interrupted_by_restart',
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waitMs returns the final result when the task finishes quickly', async () => {
    const executeApiTask = vi.fn(async () => ({ success: true, responseText: 'fast', durationMs: 5 }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk?waitMs=1000', {
      botName: 'pm',
      chatId: 'private-test',
      prompt: 'hello',
      sendCards: false,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'completed',
      success: true,
      responseText: 'fast',
    });
  });

  it('waitMs and async terminal status both preserve 300KB responseText', async () => {
    const responseText = largeResponseText('wait-parity');
    const waitCtx = makeCtx(vi.fn(async () => ({ success: true, responseText, durationMs: 5 })));
    const waitRes = await call(waitCtx, 'POST', '/api/talk?waitMs=1000', {
      botName: 'pm',
      chatId: 'private-test',
      prompt: 'hello',
      sendCards: false,
    });

    const asyncCtx = makeCtx(vi.fn(async () => ({ success: true, responseText, durationMs: 5 })));
    const asyncRes = await call(asyncCtx, 'POST', '/api/talk?async=true', {
      botName: 'pm',
      chatId: 'private-test',
      prompt: 'hello',
      sendCards: false,
    });
    const taskId = asyncRes.json().taskId;
    await eventually(() => {
      expect(asyncCtx.asyncTaskStore.get(taskId)?.status).toBe('completed');
    });
    const status = await call(asyncCtx, 'GET', `/api/talk/${taskId}`);

    expect(waitRes.statusCode).toBe(200);
    expect(waitRes.json().responseText).toBe(responseText);
    expect(status.statusCode).toBe(200);
    expect(status.json().result.responseText).toBe(responseText);
  });

  it('maps chat-busy talk failures to 409 with retry metadata', async () => {
    const executeApiTask = vi.fn(async () => ({
      success: false,
      responseText: '',
      error: 'Chat is busy with another task',
      errorCode: 'chat_busy',
      retryAfterMs: 5000,
      busy: {
        chatId: 'private-test',
        startedAt: '2026-07-07T00:00:00.000Z',
        durationMs: 1234,
        hasVisibleCard: false,
      },
    }));
    const ctx = makeCtx(executeApiTask);

    const res = await call(ctx, 'POST', '/api/talk', {
      botName: 'pm',
      chatId: 'private-test',
      prompt: 'hello',
      sendCards: false,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      success: false,
      errorCode: 'chat_busy',
      retryAfterMs: 5000,
      busy: { chatId: 'private-test' },
    });
  });
});
