import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerManager } from '../src/api/peer-manager.js';

const SHARED_KEY = 'two-bridge-peer-key-0000000000000000000000001';

function logger() {
  const value = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
  value.child.mockReturnValue(value);
  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('two-Bridge peer capability topology', () => {
  let imac: PeerManager | undefined;
  let savio: PeerManager | undefined;

  beforeEach(() => {
    vi.stubEnv('METABOT_CORE_AGENT_BUS_URL', '');
    vi.stubEnv('METABOT_CORE_URL', '');
    vi.stubEnv('METABOT_CORE_TOKEN', '');
  });

  afterEach(() => {
    imac?.destroy();
    savio?.destroy();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('discovers and sends in both directions across loopback endpoints without administrator credentials', async () => {
    imac = new PeerManager(
      [{
        name: 'savio',
        url: 'http://127.0.0.1:19110',
        auth: {
          keyId: 'imac-savio-v1',
          secret: SHARED_KEY,
          allowedSourceBots: ['bot-savio', 'bridge:savio'],
          allowedTargetBots: ['bot-imac'],
        },
      }],
      [{ name: 'bot-imac' }],
      logger(),
      { peerIdentity: 'imac' },
    );
    savio = new PeerManager(
      [{
        name: 'imac',
        url: 'http://127.0.0.1:19111',
        auth: {
          keyId: 'imac-savio-v1',
          secret: SHARED_KEY,
          allowedSourceBots: ['bot-imac', 'bridge:imac'],
          allowedTargetBots: ['bot-savio'],
        },
      }],
      [{ name: 'bot-savio' }],
      logger(),
      { peerIdentity: 'savio' },
    );

    const tasks = new Map<string, { botName: string; chatId: string; result: string }>();
    const executions = new Map<string, number>();
    let droppedImacToSavioResponse = false;
    let droppedImacToSavioStatus = false;
    const seenAuthorization: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(rawUrl));
      const target = url.port === '19110' ? savio! : imac!;
      const targetName = url.port === '19110' ? 'savio' : 'imac';
      const headers = init.headers as Record<string, string> | undefined;
      const authorization = headers?.Authorization;
      if (authorization) seenAuthorization.push(authorization);
      const rawBody = typeof init.body === 'string' ? init.body : '';
      const verified = target.verifyInboundPeerRequest({
        authorization,
        method: init.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        host: url.host,
        origin: headers?.['X-MetaBot-Origin'],
        rawBody,
      });
      if (!verified.ok) return json({ error: 'Unauthorized', code: verified.code }, verified.status);

      if (url.pathname === '/api/bots') {
        return json({
          bots: [{
            name: targetName === 'savio' ? 'bot-savio' : 'bot-imac',
            platform: 'web',
            workingDirectory: '/work',
          }],
        });
      }
      if (url.pathname === '/api/skills') return json({ skills: [] });
      if (url.pathname === '/api/talk' && init.method === 'POST') {
        const body = JSON.parse(rawBody) as Record<string, string>;
        const key = `${targetName}:${body.requestId}`;
        if (!tasks.has(key)) {
          tasks.set(key, {
            botName: body.botName,
            chatId: body.chatId,
            result: `${targetName}:${body.prompt}`,
          });
          executions.set(key, (executions.get(key) ?? 0) + 1);
        }
        if (targetName === 'savio' && !droppedImacToSavioResponse) {
          droppedImacToSavioResponse = true;
          throw new Error('simulated response loss after acceptance');
        }
        return json({ taskId: body.requestId, requestId: body.requestId, status: 'accepted' }, 202);
      }
      if (url.pathname.startsWith('/api/talk/')) {
        const requestId = decodeURIComponent(url.pathname.slice('/api/talk/'.length));
        const task = tasks.get(`${targetName}:${requestId}`);
        if (!task) return json({ error: 'Task not found' }, 404);
        if (targetName === 'savio' && !droppedImacToSavioStatus) {
          droppedImacToSavioStatus = true;
          throw new Error('simulated status connection loss');
        }
        return json({
          taskId: requestId,
          requestId,
          status: 'completed',
          botName: task.botName,
          chatId: task.chatId,
          result: { success: true, responseText: task.result },
        });
      }
      return json({ error: 'Not found' }, 404);
    }));

    await Promise.all([imac.refreshAll(), savio.refreshAll()]);
    expect(imac.getPeerBots().map((bot) => bot.name)).toEqual(['bot-savio']);
    expect(savio.getPeerBots().map((bot) => bot.name)).toEqual(['bot-imac']);
    expect(imac.getPeerStatuses()[0].authMode).toBe('peer_capability');
    expect(savio.getPeerStatuses()[0].authMode).toBe('peer_capability');

    const imacToSavio = await imac.forwardTask(
      imac.findBotPeer('bot-savio')!.peer,
      { sourceBot: 'bot-imac', botName: 'bot-savio', chatId: 'chat-imac', prompt: 'from-imac' },
    ) as Record<string, unknown>;
    const savioToImac = await savio.forwardTask(
      savio.findBotPeer('bot-imac')!.peer,
      { sourceBot: 'bot-savio', botName: 'bot-imac', chatId: 'chat-savio', prompt: 'from-savio' },
    ) as Record<string, unknown>;

    expect(imacToSavio).toMatchObject({ success: true, responseText: 'savio:from-imac' });
    expect(savioToImac).toMatchObject({ success: true, responseText: 'imac:from-savio' });
    expect(typeof imacToSavio.requestId).toBe('string');
    expect(typeof savioToImac.requestId).toBe('string');
    expect(tasks.has(`savio:${String(imacToSavio.requestId)}`)).toBe(true);
    expect(tasks.has(`imac:${String(savioToImac.requestId)}`)).toBe(true);
    expect(Array.from(executions.values())).toEqual([1, 1]);
    expect(new Set(tasks.keys()).size).toBe(2);
    expect(seenAuthorization.length).toBeGreaterThanOrEqual(8);
    expect(seenAuthorization.every((value) => value.startsWith('MetaBotPeer '))).toBe(true);
    const serializedHeaders = JSON.stringify(seenAuthorization);
    expect(serializedHeaders).not.toContain(SHARED_KEY);
    expect(serializedHeaders).not.toContain('API_SECRET');
    expect(serializedHeaders).not.toContain('Bearer ');
  });
});
