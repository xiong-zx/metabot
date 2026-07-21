import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { handleWorkerRoutes } from '../src/api/routes/worker-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

function makeReq(url: string, body?: unknown): any {
  const req = new EventEmitter() as any;
  req.url = url;
  req.headers = { host: 'localhost' };
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
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

function buildCtx(workerManager: any): RouteContext {
  return {
    registry: {} as any,
    scheduler: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    asyncTaskStore: {} as any,
    intentRouter: {} as any,
    circuitBreaker: {} as any,
    budgetManager: {} as any,
    teamManager: {} as any,
    meetingService: {} as any,
    voiceIdentityStore: {} as any,
    ws: {},
    workerManager,
  };
}

async function call(workerManager: any, method: string, url: string, body?: unknown): Promise<any> {
  const res = makeRes();
  const handled = await handleWorkerRoutes(buildCtx(workerManager), makeReq(url, body), res, method, url);
  expect(handled).toBe(true);
  return res;
}

describe('handleWorkerRoutes authority', () => {
  it('requires PM/user/admin authority to dispatch workers', async () => {
    const dispatch = vi.fn(() => ({ id: 'w1', status: 'running' }));
    const workerManager = {
      listWorkers: vi.fn(() => []),
      dispatch,
      getWorker: vi.fn(),
      abortWorker: vi.fn(),
      redirectWorker: vi.fn(),
    };
    const body = {
      botName: 'pm-codex',
      pmChatId: 'oc_pm',
      workingDirectory: '/root/metabot',
      prompt: 'run focused tests',
    };

    const missingRole = await call(workerManager, 'POST', '/api/workers', body);
    expect(missingRole.statusCode).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();

    const managerRole = await call(workerManager, 'POST', '/api/workers', { ...body, actorRole: 'manager' });
    expect(managerRole.statusCode).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();

    const pmRole = await call(workerManager, 'POST', '/api/workers', { ...body, actorRole: 'pm' });
    expect(pmRole.statusCode).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      botName: 'pm-codex',
      pmChatId: 'oc_pm',
      workingDirectory: '/root/metabot',
      prompt: 'run focused tests',
    }));
  });

  it('passes worker dispatch dedupe keys through the API', async () => {
    const dispatch = vi.fn(() => ({ id: 'w1', status: 'running', dedupeKey: 'restart-resume:abc' }));
    const workerManager = {
      listWorkers: vi.fn(() => []),
      dispatch,
      getWorker: vi.fn(),
      abortWorker: vi.fn(),
      redirectWorker: vi.fn(),
    };

    const res = await call(workerManager, 'POST', '/api/workers', {
      botName: 'pm-codex',
      pmChatId: 'oc_pm',
      workingDirectory: '/root/metabot',
      prompt: 'run focused tests',
      actorRole: 'pm',
      dedupeKey: 'restart-resume:abc',
    });

    expect(res.statusCode).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'restart-resume:abc',
    }));
  });

  it('rejects unsupported output contract names at the API boundary', async () => {
    const dispatch = vi.fn(() => ({ id: 'w1', status: 'running' }));
    const workerManager = {
      listWorkers: vi.fn(() => []),
      dispatch,
      getWorker: vi.fn(),
      abortWorker: vi.fn(),
      redirectWorker: vi.fn(),
    };

    const res = await call(workerManager, 'POST', '/api/workers', {
      botName: 'pm-codex',
      pmChatId: 'oc_pm',
      workingDirectory: '/root/metabot',
      prompt: 'run focused tests',
      actorRole: 'pm',
      outputContract: {
        name: 'not_a_real_contract',
        requiredArtifact: true,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: expect.stringContaining('Invalid outputContract'),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects malformed expectedArtifacts at the API boundary', async () => {
    const dispatch = vi.fn(() => ({ id: 'w1', status: 'running' }));
    const workerManager = {
      listWorkers: vi.fn(() => []),
      dispatch,
      getWorker: vi.fn(),
      abortWorker: vi.fn(),
      redirectWorker: vi.fn(),
    };

    const res = await call(workerManager, 'POST', '/api/workers', {
      botName: 'pm-codex',
      pmChatId: 'oc_pm',
      workingDirectory: '/root/metabot',
      prompt: 'run focused tests',
      actorRole: 'pm',
      outputContract: {
        name: 'generic_results_v1',
        requiredArtifact: true,
        expectedArtifacts: ['results.json', '', 123],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: expect.stringContaining('expectedArtifacts'),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('requires PM/user/admin authority to abort and redirect workers', async () => {
    const workerManager = {
      listWorkers: vi.fn(() => []),
      dispatch: vi.fn(),
      getWorker: vi.fn(),
      abortWorker: vi.fn(() => true),
      redirectWorker: vi.fn(() => ({ id: 'w2', status: 'running' })),
    };

    const missingAbortRole = await call(workerManager, 'POST', '/api/workers/w1/abort');
    expect(missingAbortRole.statusCode).toBe(403);
    expect(workerManager.abortWorker).not.toHaveBeenCalled();

    const userAbort = await call(workerManager, 'POST', '/api/workers/w1/abort', { actorRole: 'user' });
    expect(userAbort.statusCode).toBe(200);
    expect(workerManager.abortWorker).toHaveBeenCalledWith('w1');

    const agentRedirect = await call(workerManager, 'POST', '/api/workers/w1/redirect', {
      actorRole: 'agent',
      newPrompt: 'new prompt',
    });
    expect(agentRedirect.statusCode).toBe(403);
    expect(workerManager.redirectWorker).not.toHaveBeenCalled();

    const pmRedirect = await call(workerManager, 'POST', '/api/workers/w1/redirect', {
      actorRole: 'pm',
      newPrompt: 'new prompt',
    });
    expect(pmRedirect.statusCode).toBe(202);
    expect(workerManager.redirectWorker).toHaveBeenCalledWith('w1', 'new prompt');
  });
});
