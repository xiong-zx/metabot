import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIG_ENV = { ...process.env };
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TASK_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  process.env.METABOT_CORE_TOKEN = 'mt_test_tok';
  process.env.METABOT_CORE_URL = 'https://example.test/core';
  process.env.HOME = '/tmp/metabot-cli-test-home-does-not-exist';
  delete process.env.METABOT_ENGINE_BRIDGE_URL;
  delete process.env.METABOT_AGENT_SELF_URL;
  delete process.env.METABOT_TEAM_CAPABILITY;
  delete process.env.METABOT_BOT_NAME;
  delete process.env.METABOT_CHAT_ID;
  delete process.env.METABOT_CHAT;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIG_ENV };
});

async function importFresh(): Promise<typeof import('../src/agents.js')> {
  vi.resetModules();
  return await import('../src/agents.js');
}

describe('metabot agents talk', () => {
  it('routes registry peers through the core inbox relay instead of direct /api/talk', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://example.test/core/api/agents') {
        return new Response(JSON.stringify({
          agents: [
            { botName: 'alice', url: 'http://alice:9100', visible: true, lastSeenAt: 'now' },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://example.test/core/api/inbox/worker') {
        return new Response(JSON.stringify({ message: { id: 'msg_1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected', url, init }), { status: 500 });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['talk', 'alice/worker', 'chat1', 'hello']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const relayCall = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1]!;
    expect(relayCall[0]).toBe('https://example.test/core/api/inbox/worker');
    expect(relayCall[1].method).toBe('POST');
    expect(JSON.parse(String(relayCall[1].body))).toEqual({ chatId: 'chat1', content: 'hello' });
    expect(
      (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.some(
        ([url]) => url === 'http://alice:9100/api/talk',
      ),
    ).toBe(false);
    expect(stdout.mock.calls.map((c) => String(c[0])).join('')).toContain('(relay)');
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('id=msg_1');
  });

  it('refuses a protected target because CLI-only relay cannot compile an exact envelope', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://example.test/core/api/agents') {
        return new Response(JSON.stringify({
          agents: [
            { botName: 'alice', url: 'http://alice:9100', visible: true, lastSeenAt: 'now' },
            {
              botName: 'worker', url: 'http://alice:9100', visible: true, lastSeenAt: 'now',
              rulesPackStatus: { state: 'inherited', required: true, mode: 'enforce' },
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unexpected', url }), { status: 500 });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const mod = await importFresh();
    await expect(mod.run(['talk', 'alice/worker', 'chat1', 'hello']))
      .rejects.toThrow('requires a sender-compiled RulesPack envelope');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the signed resident Bridge for a protected same-host target and returns a card receipt', async () => {
    process.env.METABOT_ENGINE_BRIDGE_URL = 'http://127.0.0.1:9100';
    process.env.METABOT_AGENT_SELF_URL = 'http://10.0.0.5:9100';
    process.env.METABOT_TEAM_CAPABILITY = 'signed-engine-capability';
    process.env.METABOT_BOT_NAME = 'admin';
    process.env.METABOT_CHAT_ID = 'source-chat';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:9100/api/talk') {
        return new Response(JSON.stringify({
          taskId: TASK_ID, requestId: TASK_ID, status: 'accepted',
          targetBot: 'admin', targetChatId: 'target-chat',
          cardMessageId: 'card-1', deliveryState: 'running',
          message: 'Task accepted for async execution',
        }), { status: 202, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unexpected', url }), { status: 500 });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['talk', 'admin', 'target-chat', 'implement fix', '--async', '--cards']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const bridgeCall = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(bridgeCall[0]).toBe('http://127.0.0.1:9100/api/talk');
    expect(bridgeCall[1]).toMatchObject({ method: 'POST' });
    expect(bridgeCall[1].headers).toMatchObject({
      Authorization: 'Bearer execution-capability',
      'x-metabot-team-capability': 'signed-engine-capability',
      'x-metabot-bot-name': 'admin',
      'x-metabot-chat-id': 'source-chat',
    });
    expect(JSON.parse(String(bridgeCall[1].body))).toEqual({
      botName: 'admin', chatId: 'target-chat', prompt: 'implement fix', async: true, sendCards: true,
    });
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('card-1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/inbox/'))).toBe(false);
  });

  it('uses the injected loopback Bridge over real HTTP even when the registry advertisement is private', async () => {
    const requests: Array<{
      method?: string;
      url?: string;
      headers: typeof import('node:http').IncomingHttpHeaders;
      body: unknown;
    }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({
          method: req.method, url: req.url, headers: req.headers,
          body: raw ? JSON.parse(raw) : undefined,
        });
        if (req.url === '/core/api/agents') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ agents: [{
            botName: 'admin', url: 'http://10.0.0.5:19110', visible: true, lastSeenAt: 'now',
          }] }));
          return;
        }
        if (req.method === 'POST' && req.url === '/api/talk') {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            taskId: TASK_ID, requestId: TASK_ID, status: 'accepted',
            targetBot: 'admin', targetChatId: 'target-chat',
            cardMessageId: 'card-real', deliveryState: 'running',
            message: 'Task accepted for async execution',
          }));
          return;
        }
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unexpected route' }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.METABOT_CORE_URL = `${baseUrl}/core`;
    process.env.METABOT_ENGINE_BRIDGE_URL = baseUrl;
    process.env.METABOT_AGENT_SELF_URL = 'http://10.0.0.5:19110';
    process.env.METABOT_TEAM_CAPABILITY = 'signed-engine-capability';
    process.env.METABOT_BOT_NAME = 'admin';
    process.env.METABOT_CHAT_ID = 'source-chat';
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const mod = await importFresh();
      await mod.run(['talk', 'admin', 'target-chat', 'real HTTP']);

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: 'POST', url: '/api/talk',
        body: { botName: 'admin', chatId: 'target-chat', prompt: 'real HTTP', async: true, sendCards: true },
      });
      expect(requests[0]?.headers).toMatchObject({
        'x-metabot-team-capability': 'signed-engine-capability',
        'x-metabot-bot-name': 'admin',
        'x-metabot-chat-id': 'source-chat',
      });
      expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('card-real');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never falls back to Core inbox from a signed engine session', async () => {
    process.env.METABOT_ENGINE_BRIDGE_URL = 'http://127.0.0.1:9100';
    process.env.METABOT_TEAM_CAPABILITY = 'signed-engine-capability';
    process.env.METABOT_BOT_NAME = 'admin';
    process.env.METABOT_CHAT_ID = 'source-chat';
    const targets = ['pm', 'peer/admin'];

    for (const target of targets) {
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ error: 'unexpected', url }), { status: 500 });
      }) as unknown as typeof fetch;
      vi.stubGlobal('fetch', fetchMock);
      const mod = await importFresh();
      await expect(mod.run(['talk', target, 'target-chat', 'hello']))
        .rejects.toThrow('may delegate only the same Bot through its resident Bridge');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/inbox/'))).toBe(false);
    }
  });

  it('rejects a mismatched or malformed resident Bridge receipt', async () => {
    process.env.METABOT_ENGINE_BRIDGE_URL = 'http://127.0.0.1:9100';
    process.env.METABOT_TEAM_CAPABILITY = 'signed-engine-capability';
    process.env.METABOT_BOT_NAME = 'admin';
    process.env.METABOT_CHAT_ID = 'source-chat';
    const valid = {
      taskId: TASK_ID, requestId: TASK_ID, status: 'accepted',
      targetBot: 'admin', targetChatId: 'target-chat',
      cardMessageId: 'card-1', deliveryState: 'running',
      message: 'Task accepted for async execution',
    };
    const invalidReceipts = [
      { ...valid, taskId: 'task-1', requestId: 'task-1' },
      { ...valid, taskId: 7, requestId: 7 },
      { ...valid, requestId: OTHER_TASK_ID },
      { ...valid, targetBot: 'pm' },
      { ...valid, deliveryState: undefined },
      { ...valid, deliveryState: 'running', cardMessageId: undefined },
      { ...valid, deliveryState: 'pending', cardMessageId: 7 },
      { ...valid, deliveryState: 'pending', cardMessageId: 'card-1' },
      { ...valid, message: '' },
      { ...valid, extra: true },
    ];

    for (const invalid of invalidReceipts) {
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify(invalid), {
          status: 202, headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;
      vi.stubGlobal('fetch', fetchMock);
      const mod = await importFresh();
      await expect(mod.run(['talk', 'admin', 'target-chat', 'hello']))
        .rejects.toThrow('invalid Agent Bus talk receipt');
    }
  });

  it('fails closed when an engine routing context is partial or non-loopback', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://example.test/core/api/agents') {
        return new Response(JSON.stringify({ agents: [
          { botName: 'admin', url: 'http://localhost:9100', visible: true, lastSeenAt: 'now' },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unexpected', url }), { status: 500 });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    process.env.METABOT_TEAM_CAPABILITY = 'signed-engine-capability';

    const mod = await importFresh();
    await expect(mod.run(['talk', 'admin', 'target-chat', 'hello']))
      .rejects.toThrow('incomplete signed engine-session routing context');

    process.env.METABOT_ENGINE_BRIDGE_URL = 'https://remote.example.test';
    process.env.METABOT_BOT_NAME = 'admin';
    process.env.METABOT_CHAT_ID = 'source-chat';
    await expect(mod.run(['talk', 'admin', 'target-chat', 'hello']))
      .rejects.toThrow('must be loopback HTTP');
  });

  it('reads a delegated task receipt only through the signed resident session', async () => {
    process.env.METABOT_ENGINE_BRIDGE_URL = 'http://127.0.0.1:9100';
    process.env.METABOT_TEAM_CAPABILITY = 'signed-engine-capability';
    process.env.METABOT_BOT_NAME = 'admin';
    process.env.METABOT_CHAT_ID = 'source-chat';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`http://127.0.0.1:9100/api/talk/${TASK_ID}`);
      expect(init?.headers).toMatchObject({
        'x-metabot-team-capability': 'signed-engine-capability',
        'x-metabot-bot-name': 'admin',
        'x-metabot-chat-id': 'source-chat',
      });
      return new Response(JSON.stringify({
        taskId: TASK_ID, status: 'running', botName: 'admin', chatId: 'target-chat',
        sourceBot: 'admin', sourceChatId: 'source-chat',
        targetBot: 'admin', targetChatId: 'target-chat',
        cardMessageId: 'card-1', deliveryState: 'running', createdAt: '2026-08-24T12:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['talk-status', TASK_ID]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('card-1');
  });

  it('accepts internally consistent terminal talk-status receipts', async () => {
    process.env.METABOT_ENGINE_BRIDGE_URL = 'http://127.0.0.1:9100';
    process.env.METABOT_TEAM_CAPABILITY = 'signed-engine-capability';
    process.env.METABOT_BOT_NAME = 'admin';
    process.env.METABOT_CHAT_ID = 'source-chat';
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const base = {
      taskId: TASK_ID, botName: 'admin', chatId: 'target-chat',
      sourceBot: 'admin', sourceChatId: 'source-chat',
      targetBot: 'admin', targetChatId: 'target-chat',
      createdAt: '2026-08-24T12:00:00.000Z', completedAt: '2026-08-24T12:01:00.000Z',
    };
    const receipts = [
      {
        ...base, status: 'completed', cardMessageId: 'card-1', deliveryState: 'complete',
        result: { success: true, responseText: 'done', durationMs: 10, costUsd: 0 },
      },
      {
        ...base, status: 'failed', deliveryState: 'error',
        result: { success: false, responseText: '', error: 'failed' },
      },
    ];

    for (const receipt of receipts) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(receipt), {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
      vi.stubGlobal('fetch', fetchMock);
      const mod = await importFresh();
      await expect(mod.run(['talk-status', TASK_ID])).resolves.toBeUndefined();
    }
  });

  it('rejects malformed task IDs and inconsistent talk-status receipts', async () => {
    process.env.METABOT_ENGINE_BRIDGE_URL = 'http://127.0.0.1:9100';
    process.env.METABOT_TEAM_CAPABILITY = 'signed-engine-capability';
    process.env.METABOT_BOT_NAME = 'admin';
    process.env.METABOT_CHAT_ID = 'source-chat';
    const base = {
      taskId: TASK_ID, status: 'running', botName: 'admin', chatId: 'target-chat',
      sourceBot: 'admin', sourceChatId: 'source-chat',
      targetBot: 'admin', targetChatId: 'target-chat',
      cardMessageId: 'card-1', deliveryState: 'running', createdAt: '2026-08-24T12:00:00.000Z',
    };
    const invalidReceipts = [
      { ...base, taskId: OTHER_TASK_ID },
      { ...base, taskId: 7 },
      { ...base, botName: 'pm' },
      { ...base, chatId: '' },
      { ...base, sourceBot: 'pm' },
      { ...base, sourceChatId: 'other-source-chat' },
      { ...base, targetBot: 'pm' },
      { ...base, targetChatId: 'other-chat' },
      { ...base, cardMessageId: undefined },
      { ...base, status: 'completed', deliveryState: 'pending', completedAt: '2026-08-24T12:01:00.000Z', result: { success: true } },
      { ...base, status: 'completed', deliveryState: 'complete', completedAt: undefined, result: { success: true } },
      { ...base, status: 'failed', deliveryState: 'error', completedAt: '2026-08-24T12:01:00.000Z', result: { success: true } },
      { ...base, status: 'completed', deliveryState: 'complete', completedAt: '2026-08-24T11:59:00.000Z', result: { success: true, responseText: 'done' } },
      { ...base, status: 'completed', deliveryState: 'complete', completedAt: '2026-08-24T12:01:00.000Z', result: { success: true, responseText: 'done', error: 'contradiction' } },
      { ...base, status: 'failed', deliveryState: 'error', completedAt: '2026-08-24T12:01:00.000Z', result: { success: false, responseText: '', error: 7 } },
      { ...base, status: 'failed', deliveryState: 'error', completedAt: '2026-08-24T12:01:00.000Z', result: { success: false, responseText: '', error: 'failed', costUsd: -1 } },
      { ...base, status: 'failed', deliveryState: 'error', completedAt: '2026-08-24T12:01:00.000Z', result: { success: false, responseText: '', error: 'failed', extra: true } },
      { ...base, extra: true },
      { ...base, createdAt: 'not-a-date' },
    ];

    let fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    let mod = await importFresh();
    await expect(mod.run(['talk-status', 'task-1'])).rejects.toThrow('invalid taskId');
    expect(fetchMock).not.toHaveBeenCalled();

    for (const invalid of invalidReceipts) {
      fetchMock = vi.fn(async () => new Response(JSON.stringify(invalid), {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
      vi.stubGlobal('fetch', fetchMock);
      mod = await importFresh();
      await expect(mod.run(['talk-status', TASK_ID]))
        .rejects.toThrow('invalid Agent Bus talk-status receipt');
    }
  });
});
