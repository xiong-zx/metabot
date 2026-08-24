import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncTaskStore } from '../src/api/async-task-store.js';
import { setPeerRequestClaims } from '../src/api/peer-auth.js';
import { PeerManager } from '../src/api/peer-manager.js';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

const PEER_SECRET = 'rulespack-peer-key-00000000000000000000000001';

function logger() {
  const value = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
  value.child.mockReturnValue(value);
  return value;
}

describe('RulesPack over scoped peer authentication', () => {
  let manager: PeerManager | undefined;
  let receiver: PeerManager | undefined;
  let taskStore: AsyncTaskStore | undefined;

  beforeEach(() => {
    vi.stubEnv('METABOT_CORE_AGENT_BUS_URL', '');
    vi.stubEnv('METABOT_CORE_URL', '');
    vi.stubEnv('METABOT_CORE_TOKEN', '');
  });

  afterEach(() => {
    manager?.destroy();
    receiver?.destroy();
    taskStore?.destroy();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('binds the envelope issuer to the signed source Bot without administrator auth', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/api/talk')) {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ taskId: body.requestId, status: 'accepted' }), { status: 202 });
      }
      return new Response(JSON.stringify({
        taskId: 'request',
        status: 'completed',
        result: { success: true, rulesPackDelivery: { status: 'consumed' } },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const peer = {
      name: 'savio',
      url: 'http://127.0.0.1:19110',
      auth: { keyId: 'peer-v1', secret: PEER_SECRET },
    };
    manager = new PeerManager([peer], [{ name: 'admin' }], logger(), { peerIdentity: 'imac' });

    await expect(manager.forwardTask(peer, {
      sourceBot: 'admin',
      botName: 'admin-savio',
      chatId: 'chat-1',
      prompt: 'hello',
      rulesPackDispatch: { issuer: 'admin' },
    })).resolves.toMatchObject({ success: true });

    const post = fetchMock.mock.calls.find(([url]) => url.endsWith('/api/talk'))!;
    const headers = post[1]?.headers as Record<string, string>;
    const body = JSON.parse(String(post[1]?.body));
    expect(headers.Authorization).toMatch(/^MetaBotPeer /);
    expect(headers.Authorization).not.toContain(PEER_SECRET);
    expect(headers['X-MetaBot-RulesPack-Issuer']).toBe('admin');
    expect(body.sourceBot).toBe('admin');
  });

  it('rejects a RulesPack issuer that differs from the signed source Bot', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const peer = {
      name: 'savio',
      url: 'http://127.0.0.1:19110',
      auth: { keyId: 'peer-v1', secret: PEER_SECRET },
    };
    manager = new PeerManager([peer], [{ name: 'admin' }], logger(), { peerIdentity: 'imac' });

    await expect(manager.forwardTask(peer, {
      sourceBot: 'admin',
      botName: 'admin-savio',
      chatId: 'chat-1',
      prompt: 'hello',
      rulesPackDispatch: { issuer: 'secretary' },
    })).rejects.toThrow('RulesPack dispatch issuer must match a configured local peer source Bot');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the exact RulesPack acknowledgement through the real async task store and status route', async () => {
    const peer = {
      name: 'savio',
      url: 'http://127.0.0.1:19110',
      auth: { keyId: 'peer-v1', secret: PEER_SECRET },
    };
    const reversePeer = {
      name: 'imac',
      url: 'http://127.0.0.1:19111',
      auth: {
        keyId: 'peer-v1',
        secret: PEER_SECRET,
        allowedSourceBots: ['admin'],
        allowedTargetBots: ['admin-savio'],
      },
    };
    manager = new PeerManager([peer], [{ name: 'admin' }], logger(), { peerIdentity: 'imac' });
    receiver = new PeerManager([reversePeer], [{ name: 'admin-savio' }], logger(), { peerIdentity: 'savio' });
    taskStore = new AsyncTaskStore();
    const executeApiTask = vi.fn(async (options: any) => {
      const envelope = options.rulesPack.dispatch.envelope;
      return {
        success: true,
        responseText: 'done',
        rulesPackDelivery: {
          status: 'consumed',
          envelopeId: envelope.envelopeId,
          replayId: envelope.replayId,
          packDigest: envelope.packDigest,
          effectivePackDigest: envelope.packDigest,
        },
      };
    });
    const ctx = {
      registry: { get: (name: string) => name === 'admin-savio' ? { bridge: { executeApiTask } } : undefined },
      scheduler: {},
      logger: logger(),
      asyncTaskStore: taskStore,
      circuitBreaker: {
        isAvailable: () => true,
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
      },
      budgetManager: { canAcceptTask: () => ({ allowed: true }), recordCost: vi.fn() },
      resolveRulesPackTransportIssuer: () => 'admin',
      ws: {},
    } as unknown as RouteContext;

    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(rawUrl));
      const rawBody = typeof init.body === 'string' ? init.body : '';
      const headers = init.headers as Record<string, string>;
      const verified = receiver!.verifyInboundPeerRequest({
        authorization: headers.Authorization,
        method: init.method ?? 'GET',
        path: url.pathname,
        host: url.host,
        origin: headers['X-MetaBot-Origin'],
        rawBody,
      });
      if (!verified.ok) return new Response(JSON.stringify({ code: verified.code }), { status: verified.status });

      const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []) as http.IncomingMessage;
      req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
      setPeerRequestClaims(req, verified.claims);
      let status = 0;
      let responseBody = '';
      const res = {
        writeHead(code: number) { status = code; return this; },
        end(body?: string) { responseBody = body ?? ''; return this; },
      } as unknown as http.ServerResponse;
      await handleTaskRoutes(ctx, req, res, init.method ?? 'GET', url.pathname);
      return new Response(responseBody, { status });
    }));

    const envelope = {
      issuer: 'admin',
      envelopeId: 'envelope-1',
      replayId: 'replay-1',
      packDigest: 'pack-digest-1',
    };
    await expect(manager.forwardTask(peer, {
      sourceBot: 'admin',
      botName: 'admin-savio',
      chatId: 'chat-1',
      prompt: 'hello',
      rulesPackDispatch: envelope,
    })).resolves.toMatchObject({
      success: true,
      rulesPackDelivery: {
        status: 'consumed',
        envelopeId: 'envelope-1',
        replayId: 'replay-1',
        packDigest: 'pack-digest-1',
      },
    });
    expect(executeApiTask).toHaveBeenCalledTimes(1);
  });
});
