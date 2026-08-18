import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleBotRoutes } from '../src/api/routes/bot-routes.js';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';
import { resolveRulesPackApiPrincipal } from '../src/extensions/rulespack-api-principal.js';
import { forwardAuthenticatedPeerTask } from '../src/extensions/rulespack-peer-dispatch.js';

function request(body: Record<string, unknown> = {}, headers: Record<string, string> = {}): http.IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as http.IncomingMessage;
  req.headers = headers;
  return req;
}

function response() {
  const output: { status: number; body?: any } = { status: 0 };
  const res = {
    writeHead: vi.fn((status: number) => {
      output.status = status;
      return res;
    }),
    end: vi.fn((body?: string) => {
      if (body) output.body = JSON.parse(body);
      return res;
    }),
  } as unknown as http.ServerResponse;
  return { res, output };
}

describe('RulesPack operator and transport routes', () => {
  it('derives scoped local principals, rejects envelope mismatch, and keeps bearer-only calls generic', () => {
    expect(
      resolveRulesPackApiPrincipal({ localAdministrator: true }, { botName: 'admin', chatId: 'chat-a' }),
    ).toMatchObject({ kind: 'scoped', botName: 'admin', chatId: 'chat-a', roles: ['api-admin'] });
    expect(
      resolveRulesPackApiPrincipal(
        { localAdministrator: false, coreBearerBotName: 'caller-bot' },
        { botName: 'admin', chatId: 'caller-selected-chat' },
      ),
    ).toEqual({ kind: 'generic', source: 'core-bearer', botName: 'caller-bot' });

    const dispatch = {
      target: {
        hostId: 'savio',
        bot: 'pm',
        roles: ['worker'],
        worker: 'worker-a',
        projectId: 'project-a',
        chatId: 'chat-a',
        taskId: 'task-a',
        tools: [],
        dataClasses: ['worker'],
        outputTypes: ['text'],
        engine: 'codex',
      },
    } as any;
    expect(
      resolveRulesPackApiPrincipal(
        { localAdministrator: false, coreBearerBotName: 'issuer' },
        {
          botName: 'pm',
          chatId: 'chat-a',
          dispatch,
          declarations: {
            projectId: 'project-a',
            workerId: 'worker-a',
            taskId: 'task-a',
            roles: ['worker'],
          },
        },
      ),
    ).toMatchObject({ kind: 'scoped', workerId: 'worker-a', taskId: 'task-a' });
    expect(() =>
      resolveRulesPackApiPrincipal(
        { localAdministrator: false, coreBearerBotName: 'issuer' },
        { botName: 'pm', chatId: 'chat-b', dispatch },
      ),
    ).toThrow(/does not match/u);
    for (const declarations of [{ projectId: 'project-b' }, { workerId: 'worker-b' }, { taskId: 'task-b' }]) {
      expect(() =>
        resolveRulesPackApiPrincipal(
          { localAdministrator: false, coreBearerBotName: 'issuer' },
          { botName: 'pm', chatId: 'chat-a', dispatch, declarations },
        ),
      ).toThrow(/identity declaration/u);
    }
    expect(() =>
      resolveRulesPackApiPrincipal(
        { localAdministrator: false, coreBearerBotName: 'caller-bot' },
        { botName: 'admin', chatId: 'chat-a', declarations: { workerId: 'caller-worker' } },
      ),
    ).toThrow(/require an authenticated exact dispatch/u);
  });

  it('automatically attaches an exact authenticated envelope for normal peer/relay forwarding', async () => {
    const envelope = { issuer: 'caller-bot', target: { hostId: 'savio', bot: 'pm', chatId: 'chat-a' } } as any;
    const operator = {
      createDispatchEnvelope: vi.fn(async () => envelope),
      recordDispatchRejected: vi.fn(),
    };
    const forwardTask = vi.fn(async (_peer, body) => ({ accepted: true, body }));
    const result = await forwardAuthenticatedPeerTask({
      registry: { get: () => ({ bridge: { getRulesPackOperator: () => operator } }) } as any,
      peerManager: { forwardTask } as any,
      peer: { name: 'savio', url: 'inbox:' },
      peerBot: { name: 'pm', engine: 'codex', rulesPackTools: ['metabot-worker'] } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    });
    expect(operator.createDispatchEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: 'metabot-host:savio',
        targetSubject: expect.objectContaining({
          hostId: 'savio',
          bot: 'pm',
          chatId: 'chat-a',
          roles: ['peer', 'pm'],
          tools: ['metabot-worker'],
        }),
      }),
    );
    expect(forwardTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rulesPackDispatch: envelope }),
    );
    expect(result).toMatchObject({ accepted: true });
  });

  it('fails closed on peer compile failure and records transport failure after envelope creation', async () => {
    const compileFailure = new Error('compile failed');
    const forwardTask = vi.fn();
    await expect(
      forwardAuthenticatedPeerTask({
        registry: {
          get: () => ({
            bridge: {
              getRulesPackOperator: () => ({
                createDispatchEnvelope: () => {
                  throw compileFailure;
                },
              }),
            },
          }),
        } as any,
        peerManager: { forwardTask } as any,
        peer: { name: 'savio', url: 'http://savio' },
        peerBot: { name: 'pm', engine: 'codex' } as any,
        principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
        body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
      }),
    ).rejects.toThrow('compile failed');
    expect(forwardTask).not.toHaveBeenCalled();

    const envelope = { issuer: 'caller-bot' } as any;
    const recordDispatchRejected = vi.fn();
    await expect(
      forwardAuthenticatedPeerTask({
        registry: {
          get: () => ({
            bridge: {
              getRulesPackOperator: () => ({
                createDispatchEnvelope: async () => envelope,
                recordDispatchRejected,
              }),
            },
          }),
        } as any,
        peerManager: {
          forwardTask: vi.fn(async () => {
            throw new Error('transport failed');
          }),
        } as any,
        peer: { name: 'savio', url: 'http://savio' },
        peerBot: { name: 'pm', engine: 'codex' } as any,
        principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
        body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
      }),
    ).rejects.toThrow('transport failed');
    expect(recordDispatchRejected).toHaveBeenCalledWith(envelope, expect.any(Error));
  });

  it.each([
    [
      'direct non-2xx',
      { name: 'savio', url: 'http://savio' },
      () => Promise.reject(new Error('peer task failed with HTTP 503')),
    ],
    [
      'relay non-2xx',
      { name: 'savio', url: 'inbox:' },
      () => Promise.reject(new Error('core inbox enqueue failed with HTTP 503')),
    ],
    ['network throw', { name: 'savio', url: 'http://savio' }, () => Promise.reject(new Error('ECONNRESET'))],
    ['explicit JSON rejection', { name: 'savio', url: 'http://savio' }, () => Promise.resolve({ accepted: false })],
    ['explicit JSON error', { name: 'savio', url: 'http://savio' }, () => Promise.resolve({ error: 'rejected' })],
  ])('records a rejected receipt for envelope-bearing %s', async (_name, peer, implementation) => {
    const envelope = { issuer: 'caller-bot' } as any;
    const recordDispatchRejected = vi.fn();
    const operator = { createDispatchEnvelope: vi.fn(async () => envelope), recordDispatchRejected };
    await expect(
      forwardAuthenticatedPeerTask({
        registry: { get: () => ({ bridge: { getRulesPackOperator: () => operator } }) } as any,
        peerManager: { forwardTask: vi.fn(implementation) } as any,
        peer: peer as any,
        peerBot: { name: 'pm', engine: 'codex' } as any,
        principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
        body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
      }),
    ).rejects.toThrow();
    expect(recordDispatchRejected).toHaveBeenCalledWith(envelope, expect.any(Error));
  });

  it.each([
    ['direct', { name: 'savio', url: 'http://savio' }],
    ['relay', { name: 'savio', url: 'inbox:' }],
  ])('does not record rejection for successful envelope-bearing %s delivery', async (_name, peer) => {
    const envelope = { issuer: 'caller-bot' } as any;
    const recordDispatchRejected = vi.fn();
    const result = await forwardAuthenticatedPeerTask({
      registry: {
        get: () => ({
          bridge: {
            getRulesPackOperator: () => ({
              createDispatchEnvelope: async () => envelope,
              recordDispatchRejected,
            }),
          },
        }),
      } as any,
      peerManager: { forwardTask: vi.fn(async () => ({ accepted: true })) } as any,
      peer: peer as any,
      peerBot: { name: 'pm', engine: 'codex' } as any,
      principal: { kind: 'generic', source: 'core-bearer', botName: 'caller-bot' },
      body: { botName: 'pm', chatId: 'chat-a', prompt: 'work' },
    });
    expect(result).toEqual({ accepted: true });
    expect(recordDispatchRejected).not.toHaveBeenCalled();
  });

  it('exposes authenticated bot-scoped status and mode controls through the operator', async () => {
    const operator = {
      status: vi.fn(() => ({ mode: 'off' })),
      setMode: vi.fn((mode: string) => ({ mode })),
      clearModeOverride: vi.fn(() => ({ mode: 'off' })),
    };
    const ctx = {
      registry: {
        get: () => ({
          config: { claude: { defaultWorkingDirectory: '/tmp' } },
          bridge: { getRulesPackOperator: () => operator },
        }),
      },
      logger: {},
      ws: {},
    } as unknown as RouteContext;

    const status = response();
    expect(await handleBotRoutes(ctx, request(), status.res, 'GET', '/api/bots/admin/rulespack/status')).toBe(true);
    expect(status.output).toEqual({ status: 200, body: { mode: 'off' } });

    const mode = response();
    expect(
      await handleBotRoutes(ctx, request({ mode: 'shadow' }), mode.res, 'PATCH', '/api/bots/admin/rulespack/mode'),
    ).toBe(true);
    expect(operator.setMode).toHaveBeenCalledWith('shadow');
    expect(mode.output).toEqual({ status: 200, body: { mode: 'shadow' } });

    const cleared = response();
    await handleBotRoutes(ctx, request({ mode: null }), cleared.res, 'PATCH', '/api/bots/admin/rulespack/mode');
    expect(operator.clearModeOverride).toHaveBeenCalledOnce();
  });

  it('rejects a dispatch whose claimed issuer is not bound by authenticated transport', async () => {
    const ctx = {
      resolveRulesPackTransportIssuer: () => 'authenticated-peer',
    } as unknown as RouteContext;
    const { res, output } = response();
    const handled = await handleTaskRoutes(
      ctx,
      request(
        { botName: 'admin', chatId: 'chat', prompt: 'work', rulesPackDispatch: {} },
        { 'x-metabot-origin': 'peer', 'x-metabot-rulespack-issuer': 'spoofed-peer' },
      ),
      res,
      'POST',
      '/api/talk',
    );
    expect(handled).toBe(true);
    expect(output).toEqual({
      status: 400,
      body: { error: 'RulesPack dispatch requires authenticated peer transport headers' },
    });
  });
});
