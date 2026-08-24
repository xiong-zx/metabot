import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncTaskStore } from '../src/api/async-task-store.js';
import { setPeerRequestClaims, sha256Base64Url, type PeerCapabilityClaims } from '../src/api/peer-auth.js';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

function makeReq(body?: Record<string, unknown>) {
  const req = new EventEmitter() as any;
  req.headers = { 'x-metabot-origin': 'peer' };
  req.destroy = vi.fn();
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status; },
    end(body: string) { this.body = body; },
    json() { return JSON.parse(this.body); },
  } as any;
}

function claims(body: Record<string, unknown>): PeerCapabilityClaims {
  return {
    v: 1,
    iss: 'imac',
    aud: 'savio',
    kid: 'key-1',
    host: '127.0.0.1:19110',
    method: 'POST',
    path: '/api/talk',
    sourceBot: String(body.sourceBot),
    targetBot: String(body.botName),
    chatId: String(body.chatId),
    taskId: String(body.requestId),
    bodySha256: sha256Base64Url(JSON.stringify(body)),
    iat: 1_800_000_000,
    exp: 1_800_000_030,
    nonce: 'nonce-000000000000000001',
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      assertion();
      return;
    } catch (current) {
      error = current;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw error;
}

describe('peer task idempotency and status scope', () => {
  const stores: AsyncTaskStore[] = [];

  afterEach(() => {
    for (const store of stores) store.destroy();
    stores.length = 0;
  });

  it('executes one request ID once and returns the same terminal record to the same peer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executeApiTask = vi.fn(async () => {
      await gate;
      return { success: true, responseText: 'done', durationMs: 5 };
    });
    const store = new AsyncTaskStore();
    stores.push(store);
    const ctx = {
      registry: { get: (name: string) => name === 'bot-savio' ? { bridge: { executeApiTask } } : undefined },
      scheduler: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      asyncTaskStore: store,
      circuitBreaker: {
        isAvailable: vi.fn(() => true),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
      },
      budgetManager: { canAcceptTask: vi.fn(() => ({ allowed: true })), recordCost: vi.fn() },
      ws: {},
    } as unknown as RouteContext;
    const body = {
      botName: 'bot-savio',
      chatId: 'chat-1',
      prompt: 'hello',
      sourceBot: 'bot-imac',
      requestId: 'request-1',
      async: true,
    };

    const firstReq = makeReq(body);
    setPeerRequestClaims(firstReq, claims(body));
    const firstRes = makeRes();
    await handleTaskRoutes(ctx, firstReq, firstRes, 'POST', '/api/talk');
    expect(firstRes.statusCode).toBe(202);
    expect(firstRes.json()).toMatchObject({ taskId: 'request-1', requestId: 'request-1' });

    const retryReq = makeReq(body);
    setPeerRequestClaims(retryReq, claims(body));
    const retryRes = makeRes();
    await handleTaskRoutes(ctx, retryReq, retryRes, 'POST', '/api/talk');
    expect(retryRes.statusCode).toBe(202);
    expect(retryRes.json()).toMatchObject({
      taskId: 'request-1',
      requestId: 'request-1',
      deduplicated: true,
    });
    expect(executeApiTask).toHaveBeenCalledTimes(1);

    const changedOptionsBody = { ...body, sendCards: false };
    const changedOptionsReq = makeReq(changedOptionsBody);
    setPeerRequestClaims(changedOptionsReq, claims(changedOptionsBody));
    const changedOptionsRes = makeRes();
    await handleTaskRoutes(ctx, changedOptionsReq, changedOptionsRes, 'POST', '/api/talk');
    expect(changedOptionsRes.statusCode).toBe(409);
    expect(changedOptionsRes.json()).toMatchObject({ code: 'peer_request_conflict' });
    expect(executeApiTask).toHaveBeenCalledTimes(1);

    const conflictingBody = { ...body, prompt: 'different' };
    const conflictReq = makeReq(conflictingBody);
    setPeerRequestClaims(conflictReq, claims(conflictingBody));
    const conflictRes = makeRes();
    await handleTaskRoutes(ctx, conflictReq, conflictRes, 'POST', '/api/talk');
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json()).toMatchObject({ code: 'peer_request_conflict' });

    release();
    await eventually(() => expect(store.get('request-1')?.status).toBe('completed'));

    const statusReq = makeReq();
    setPeerRequestClaims(statusReq, {
      ...claims(body),
      method: 'GET',
      path: '/api/talk/request-1',
      bodySha256: sha256Base64Url(''),
      nonce: 'nonce-000000000000000002',
    });
    const statusRes = makeRes();
    await handleTaskRoutes(ctx, statusReq, statusRes, 'GET', '/api/talk/request-1');
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toMatchObject({
      taskId: 'request-1',
      status: 'completed',
      botName: 'bot-savio',
      chatId: 'chat-1',
      result: { success: true, responseText: 'done' },
    });

    const otherPeerReq = makeReq();
    setPeerRequestClaims(otherPeerReq, {
      ...claims(body),
      iss: 'other-peer',
      method: 'GET',
      path: '/api/talk/request-1',
      bodySha256: sha256Base64Url(''),
      nonce: 'nonce-000000000000000003',
    });
    const otherPeerRes = makeRes();
    await handleTaskRoutes(ctx, otherPeerReq, otherPeerRes, 'GET', '/api/talk/request-1');
    expect(otherPeerRes.statusCode).toBe(403);
    expect(otherPeerRes.json()).toMatchObject({ code: 'peer_task_scope_mismatch' });

    store.create({ id: 'local-task', botName: 'bot-savio', chatId: 'chat-1', prompt: 'local' });
    const localTaskReq = makeReq();
    setPeerRequestClaims(localTaskReq, {
      ...claims(body),
      method: 'GET',
      path: '/api/talk/local-task',
      taskId: 'local-task',
      bodySha256: sha256Base64Url(''),
      nonce: 'nonce-000000000000000004',
    });
    const localTaskRes = makeRes();
    await handleTaskRoutes(ctx, localTaskReq, localTaskRes, 'GET', '/api/talk/local-task');
    expect(localTaskRes.statusCode).toBe(403);
  });
});
