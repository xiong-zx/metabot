import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type * as http from 'node:http';

import {
  isAgentTeamCapabilityTalkRoute,
  matchesAgentBusTalkSource,
  mayDelegateAgentBusTalk,
} from '../src/agent-teams/talk-capability.js';
import type { AgentTeamExecutionPrincipal } from '../src/agent-teams/governance-capability.js';
import { AsyncTaskStore } from '../src/api/async-task-store.js';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';

function principal(role: AgentTeamExecutionPrincipal['role']): AgentTeamExecutionPrincipal {
  return {
    role,
    id: 'admin:source-chat',
    botName: 'admin',
    chatId: 'source-chat',
    source: 'execution-capability',
  };
}

describe('Agent Bus talk capability policy', () => {
  it('accepts only the canonical async talk and task-receipt routes', () => {
    const taskId = '11111111-1111-4111-8111-111111111111';
    expect(isAgentTeamCapabilityTalkRoute('POST', '/api/talk')).toBe(true);
    expect(isAgentTeamCapabilityTalkRoute('GET', `/api/talk/${taskId}`)).toBe(true);
    expect(isAgentTeamCapabilityTalkRoute('GET', `/api/talk/${taskId}?detail=1`)).toBe(true);
    expect(isAgentTeamCapabilityTalkRoute('GET', '/api/talk/task-1')).toBe(false);
    expect(isAgentTeamCapabilityTalkRoute('POST', '/api/tasks')).toBe(false);
    expect(isAgentTeamCapabilityTalkRoute('GET', '/api/talk')).toBe(false);
    expect(isAgentTeamCapabilityTalkRoute('DELETE', '/api/talk/task-1')).toBe(false);
  });

  it('allows only user-facing roles to delegate a new task', () => {
    for (const role of ['admin', 'pm', 'user'] as const) {
      expect(mayDelegateAgentBusTalk(principal(role), 'admin'), role).toBe(true);
    }
    for (const role of ['manager', 'agent', 'worker'] as const) {
      expect(mayDelegateAgentBusTalk(principal(role), 'admin'), role).toBe(false);
    }
    expect(mayDelegateAgentBusTalk(principal('user'), 'pm')).toBe(false);
  });

  it('binds status reads to the exact signed source bot and chat', () => {
    const source = principal('admin');
    expect(matchesAgentBusTalkSource(source, {
      sourceBotName: 'admin', sourceChatId: 'source-chat',
    })).toBe(true);
    expect(matchesAgentBusTalkSource(source, {
      sourceBotName: 'admin', sourceChatId: 'another-chat',
    })).toBe(false);
    expect(matchesAgentBusTalkSource(source, {})).toBe(false);
  });

  it('uses full UUID task ids, rejects collisions, and hides delegated tasks without a talk principal', async () => {
    const store = new AsyncTaskStore();
    try {
      const task = store.create({
        botName: 'admin', chatId: 'target-chat', prompt: 'work',
        sourceBotName: 'admin', sourceChatId: 'source-chat',
      });
      expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      store.create({ id: 'fixed-id', botName: 'admin', chatId: 'target-chat', prompt: 'first' });
      expect(() => store.create({
        id: 'fixed-id', botName: 'admin', chatId: 'target-chat', prompt: 'collision',
      })).toThrow(/already exists/u);

      let statusCode = 0;
      let responseBody: unknown;
      const response = {
        writeHead(code: number) { statusCode = code; },
        end(value: string) { responseBody = JSON.parse(value); },
      } as unknown as http.ServerResponse;
      await handleTaskRoutes(
        { asyncTaskStore: store } as any,
        { headers: { authorization: 'Bearer generic-core' } } as http.IncomingMessage,
        response,
        'GET',
        `/api/talk/${task.id}`,
      );
      expect(statusCode).toBe(404);
      expect(responseBody).toEqual({ error: 'Task not found' });

      const ordinaryTask = store.create({
        id: '22222222-2222-4222-8222-222222222222',
        botName: 'other-bot', chatId: 'other-chat', prompt: 'private',
      });
      statusCode = 0;
      responseBody = undefined;
      await handleTaskRoutes(
        {
          asyncTaskStore: store,
          resolveAgentTeamCapabilityPrincipal: () => principal('user'),
        } as any,
        { headers: {} } as http.IncomingMessage,
        response,
        'GET',
        `/api/talk/${ordinaryTask.id}`,
      );
      expect(statusCode).toBe(404);
      expect(responseBody).toEqual({ error: 'Task not found' });
    } finally {
      store.destroy();
    }
  });

  it('does not fall back to a same-named peer when the signed local Bot is missing', async () => {
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {};
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify({
        botName: 'admin', chatId: 'target-chat', prompt: 'work',
      })));
      req.emit('end');
    });
    let statusCode = 0;
    let responseBody: unknown;
    const res = {
      writeHead(code: number) { statusCode = code; },
      end(value: string) { responseBody = JSON.parse(value); },
    } as unknown as http.ServerResponse;
    const findBotPeer = vi.fn(() => ({ peer: { name: 'remote' }, bot: { name: 'admin' } }));
    const store = new AsyncTaskStore();
    try {
      await handleTaskRoutes({
        registry: { get: () => undefined },
        scheduler: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        peerManager: { findBotPeer },
        asyncTaskStore: store,
        circuitBreaker: {},
        budgetManager: {},
        ws: {},
        resolveAgentTeamCapabilityPrincipal: () => principal('user'),
      } as any, req, res, 'POST', '/api/talk');
      expect(statusCode).toBe(404);
      expect(responseBody).toMatchObject({ code: 'AGENT_BUS_LOCAL_TARGET_NOT_FOUND' });
      expect(findBotPeer).not.toHaveBeenCalled();
    } finally {
      store.destroy();
    }
  });

  it('persists pending delivery when card creation exceeds the receipt timeout', async () => {
    vi.useFakeTimers();
    const store = new AsyncTaskStore();
    const executeApiTask = vi.fn((options: any) => new Promise((resolve) => {
      setTimeout(() => {
        options.onAccepted?.({ cardMessageId: 'card-slow', deliveryState: 'running' });
        options.onUpdate?.({ status: 'complete' }, 'card-slow', true);
        resolve({ success: true, responseText: 'done', durationMs: 6_000 });
      }, 6_000);
    }));
    const req = Readable.from([Buffer.from(JSON.stringify({
      botName: 'admin', chatId: 'target-chat', prompt: 'slow card',
    }))]) as unknown as http.IncomingMessage;
    req.headers = {};
    let statusCode = 0;
    let responseBody: any;
    const res = {
      writeHead(code: number) { statusCode = code; },
      end(value: string) { responseBody = JSON.parse(value); },
    } as unknown as http.ServerResponse;
    try {
      const responsePromise = handleTaskRoutes({
        registry: { get: () => ({ bridge: { executeApiTask } }) },
        scheduler: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        asyncTaskStore: store,
        circuitBreaker: {
          isAvailable: () => true, recordSuccess: vi.fn(), recordFailure: vi.fn(),
        },
        budgetManager: { canAcceptTask: () => ({ allowed: true }), recordCost: vi.fn() },
        ws: {},
        resolveAgentTeamCapabilityPrincipal: () => principal('user'),
      } as any, req, res, 'POST', '/api/talk');
      await vi.advanceTimersByTimeAsync(5_000);
      await responsePromise;
      expect(statusCode).toBe(202);
      expect(responseBody).toMatchObject({ deliveryState: 'pending' });
      expect(store.get(responseBody.taskId)).toMatchObject({
        status: 'running', deliveryState: 'pending',
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      expect(store.get(responseBody.taskId)).toMatchObject({
        status: 'completed', cardMessageId: 'card-slow', deliveryState: 'complete',
      });
    } finally {
      store.destroy();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label: 'successful',
      cardStatus: 'complete',
      result: { success: true, responseText: 'done', durationMs: 25 },
      terminalStatus: 'completed',
      terminalDelivery: 'complete',
    },
    {
      label: 'failed',
      cardStatus: 'error',
      result: { success: false, responseText: '', error: 'failed', durationMs: 25 },
      terminalStatus: 'failed',
      terminalDelivery: 'error',
    },
  ])('keeps a consistent running receipt while $label final cleanup is paused', async ({
    cardStatus,
    result,
    terminalStatus,
    terminalDelivery,
  }) => {
    const store = new AsyncTaskStore();
    let finishTask!: (value: typeof result) => void;
    const finalResult = new Promise<typeof result>((resolve) => { finishTask = resolve; });
    const executeApiTask = vi.fn((options: any) => {
      options.onAccepted?.({ cardMessageId: 'card-final', deliveryState: 'running' });
      options.onUpdate?.({ status: cardStatus }, 'card-final', true);
      return finalResult;
    });
    const ctx = {
      registry: { get: () => ({ bridge: { executeApiTask } }) },
      scheduler: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      asyncTaskStore: store,
      circuitBreaker: {
        isAvailable: () => true, recordSuccess: vi.fn(), recordFailure: vi.fn(),
      },
      budgetManager: { canAcceptTask: () => ({ allowed: true }), recordCost: vi.fn() },
      ws: {},
      resolveAgentTeamCapabilityPrincipal: () => principal('user'),
    } as any;
    const req = Readable.from([Buffer.from(JSON.stringify({
      botName: 'admin', chatId: 'target-chat', prompt: 'final cleanup',
    }))]) as unknown as http.IncomingMessage;
    req.headers = {};
    let statusCode = 0;
    let responseBody: any;
    const res = {
      writeHead(code: number) { statusCode = code; },
      end(value: string) { responseBody = JSON.parse(value); },
    } as unknown as http.ServerResponse;
    try {
      await handleTaskRoutes(ctx, req, res, 'POST', '/api/talk');
      expect(statusCode).toBe(202);
      expect(responseBody).toMatchObject({
        deliveryState: 'running', cardMessageId: 'card-final',
      });

      statusCode = 0;
      responseBody = undefined;
      await handleTaskRoutes(
        ctx,
        { headers: {} } as http.IncomingMessage,
        res,
        'GET',
        `/api/talk/${store.list()[0]?.id}`,
      );
      expect(statusCode).toBe(200);
      expect(responseBody).toMatchObject({
        status: 'running', deliveryState: 'running', cardMessageId: 'card-final',
        sourceBot: 'admin', sourceChatId: 'source-chat',
        targetBot: 'admin', targetChatId: 'target-chat',
      });
      expect(responseBody).not.toHaveProperty('completedAt');
      expect(responseBody).not.toHaveProperty('result');

      finishTask(result);
      await vi.waitFor(() => {
        expect(store.list()[0]).toMatchObject({
          status: terminalStatus,
          deliveryState: terminalDelivery,
          cardMessageId: 'card-final',
          result,
        });
      });
    } finally {
      store.destroy();
    }
  });
});
