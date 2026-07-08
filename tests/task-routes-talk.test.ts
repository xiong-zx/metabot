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
      get: (name: string) => name === 'pm' ? { bridge: { executeApiTask } } : undefined,
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
      statusCommand: `metabot talk-status ${taskId}`,
      phase: 'completed',
      progress: expect.objectContaining({ kind: 'complete' }),
      message: 'Task finished. See result for the final response or error.',
      nextAction: 'Inspect result for the final response or error.',
    });
    expect(typeof status.json().elapsedMs).toBe('number');
    expect(status.json().result).toMatchObject({ success: true, responseText: 'done' });
  });

  it('running task status includes retry guidance and elapsed time', async () => {
    let resolveTask!: (value: { success: true; responseText: string }) => void;
    const executeApiTask = vi.fn(() => new Promise((resolve) => {
      resolveTask = resolve as typeof resolveTask;
    }));
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
      statusCommand: `metabot talk-status ${taskId}`,
      message:
        'Task is still running. Check statusUrl again later; long research tasks may expose more detail in their Memory Core run lifecycle.',
      nextAction: `Run metabot talk-status ${taskId} again after 2s. For AutoResearchClaw tasks, also ask for the matching Memory Core run status.`,
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
      statusCommand: 'metabot talk-status missing-task',
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
      nextAction: expect.stringContaining('metabot research runs --root /root/workspaces/r6 --project metabot-r6'),
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

  it('marks orphaned running tasks as failed after the stale timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'));
    const executeApiTask = vi.fn(() => new Promise(() => {}));
    const ctx = makeCtx(executeApiTask, new AsyncTaskStore({
      staleTaskMs: 1000,
      cleanupIntervalMs: 60_000,
    }));

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
      message: 'Task finished. See result for the final response or error.',
      result: {
        success: false,
        responseText: '',
        errorCode: 'task_expired',
      },
    });
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
