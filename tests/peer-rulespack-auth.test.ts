import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncTaskStore } from '../src/api/async-task-store.js';
import { getPeerRequestClaims, setPeerRequestClaims } from '../src/api/peer-auth.js';
import { PeerManager } from '../src/api/peer-manager.js';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';
import { forwardAuthenticatedPeerTask } from '../src/extensions/rulespack-peer-dispatch.js';

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

  it('signs a separate RulesPack issuer and explicit local source Bot without administrator auth', async () => {
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
      auth: { keyId: 'peer-v1', secret: PEER_SECRET, sourceBot: 'admin' },
    };
    manager = new PeerManager([peer], [{ name: 'admin' }], logger(), { peerIdentity: 'imac' });

    await expect(manager.forwardTask(peer, {
      sourceBot: 'admin',
      botName: 'admin-savio',
      chatId: 'chat-1',
      prompt: 'hello',
      rulesPackDispatch: { issuer: 'metabot-core-admin' },
    })).resolves.toMatchObject({ success: true });

    const post = fetchMock.mock.calls.find(([url]) => url.endsWith('/api/talk'))!;
    const headers = post[1]?.headers as Record<string, string>;
    const body = JSON.parse(String(post[1]?.body));
    expect(headers.Authorization).toMatch(/^MetaBotPeer /);
    expect(headers.Authorization).not.toContain(PEER_SECRET);
    expect(headers['X-MetaBot-RulesPack-Issuer']).toBe('metabot-core-admin');
    expect(body.sourceBot).toBe('admin');
  });

  it('rejects a source Bot that differs from the explicit local dispatcher', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const peer = {
      name: 'savio',
      url: 'http://127.0.0.1:19110',
      auth: { keyId: 'peer-v1', secret: PEER_SECRET, sourceBot: 'admin' },
    };
    manager = new PeerManager([peer], [{ name: 'admin' }], logger(), { peerIdentity: 'imac' });

    await expect(manager.forwardTask(peer, {
      sourceBot: 'secretary',
      botName: 'admin-savio',
      chatId: 'chat-1',
      prompt: 'hello',
      rulesPackDispatch: { issuer: 'metabot-core-admin' },
    })).rejects.toThrow('RulesPack peer dispatch source Bot must match auth.sourceBot');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the exact RulesPack acknowledgement through the real async task store and status route', async () => {
    const peer = {
      name: 'savio',
      url: 'http://127.0.0.1:19110',
      auth: { keyId: 'peer-v1', secret: PEER_SECRET, sourceBot: 'admin' },
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
      resolveRulesPackTransportIssuer: (req: http.IncomingMessage) => getPeerRequestClaims(req)?.rulesPackIssuer,
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
      issuer: 'metabot-core-admin',
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

  it('uses different explicit local dispatchers with one shared issuer in both directions', async () => {
    const imacPeer = {
      name: 'savio',
      url: 'http://127.0.0.1:19110',
      auth: {
        keyId: 'peer-v1',
        secret: PEER_SECRET,
        sourceBot: 'admin',
        allowedSourceBots: ['pm-savio'],
        allowedTargetBots: ['admin'],
      },
    };
    const savioPeer = {
      name: 'imac',
      url: 'http://127.0.0.1:19111',
      auth: {
        keyId: 'peer-v1',
        secret: PEER_SECRET,
        sourceBot: 'pm-savio',
        allowedSourceBots: ['admin'],
        allowedTargetBots: ['pm-savio'],
      },
    };
    manager = new PeerManager(
      [imacPeer],
      [{ name: 'admin' }, { name: 'secretary' }],
      logger(),
      { peerIdentity: 'imac' },
    );
    receiver = new PeerManager(
      [savioPeer],
      [{ name: 'pm-savio' }, { name: 'research-savio' }, { name: 'review-savio' }],
      logger(),
      { peerIdentity: 'savio' },
    );

    const verifiedClaims: Array<{ iss: string; sourceBot: string; rulesPackIssuer?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(rawUrl));
      const target = url.port === '19110' ? receiver! : manager!;
      const headers = init.headers as Record<string, string>;
      const rawBody = typeof init.body === 'string' ? init.body : '';
      const verified = target.verifyInboundPeerRequest({
        authorization: headers.Authorization,
        method: init.method ?? 'GET',
        path: url.pathname,
        host: url.host,
        origin: headers['X-MetaBot-Origin'],
        rawBody,
      });
      if (!verified.ok) return new Response(JSON.stringify({ code: verified.code }), { status: verified.status });
      verifiedClaims.push({
        iss: verified.claims.iss,
        sourceBot: verified.claims.sourceBot,
        ...(verified.claims.rulesPackIssuer ? { rulesPackIssuer: verified.claims.rulesPackIssuer } : {}),
      });
      const body = JSON.parse(rawBody) as { rulesPackDispatch: Record<string, string> };
      const envelope = body.rulesPackDispatch;
      return new Response(JSON.stringify({
        success: true,
        rulesPackDelivery: {
          status: 'consumed',
          envelopeId: envelope.envelopeId,
          replayId: envelope.replayId,
          packDigest: envelope.packDigest,
        },
      }), { status: 200 });
    }));

    const operator = (id: string, createDispatchEnvelope: ReturnType<typeof vi.fn>) => ({
      name: id,
      platform: 'web',
      config: { rulesPack: { dispatch: { issuer: 'metabot-core-admin' } } },
      bridge: {
        getRulesPackOperator: () => ({ createDispatchEnvelope, recordDispatchRejected: vi.fn() }),
      },
    });
    const createEnvelope = (prefix: string) => vi.fn(async (input: any) => ({
      issuer: 'metabot-core-admin',
      audience: input.audience,
      target: input.targetSubject,
      envelopeId: `${prefix}-envelope`,
      replayId: `${prefix}-replay`,
      packDigest: `${prefix}-digest`,
    }));
    const imacCreate = createEnvelope('imac');
    const savioCreate = createEnvelope('savio');
    const wrongImacCreate = createEnvelope('wrong-imac');
    const wrongSavioCreate = createEnvelope('wrong-savio');
    const admin = operator('admin', imacCreate);
    const secretary = operator('secretary', wrongImacCreate);
    const pmSavio = operator('pm-savio', savioCreate);
    const researchSavio = operator('research-savio', wrongSavioCreate);

    const principal = (botName: string) => ({
      kind: 'scoped' as const,
      source: 'local-admin' as const,
      botName,
      chatId: 'chat-live-shape',
      roles: ['api-admin'],
    });
    const peerBot = (name: string, hostId: string) => ({
      name,
      engine: 'codex' as const,
      rulesPackStatus: {
        state: 'inherited' as const,
        required: true,
        mode: 'enforce' as const,
        defaultProjectId: null,
      },
      rulesPackIdentity: { hostId, audience: `metabot-host:${hostId}` },
    });

    await expect(forwardAuthenticatedPeerTask({
      registry: {
        get: (name: string) => name === 'admin' ? admin : name === 'secretary' ? secretary : undefined,
        listRegistered: () => [secretary, admin],
      } as any,
      peerManager: manager,
      peer: imacPeer,
      peerBot: peerBot('pm-savio', 'savio') as any,
      principal: principal('pm-savio'),
      body: { botName: 'pm-savio', chatId: 'chat-live-shape', prompt: 'imac-to-savio' },
    })).resolves.toMatchObject({ success: true });

    await expect(forwardAuthenticatedPeerTask({
      registry: {
        get: (name: string) => name === 'pm-savio' ? pmSavio : name === 'research-savio' ? researchSavio : undefined,
        listRegistered: () => [researchSavio, pmSavio],
      } as any,
      peerManager: receiver,
      peer: savioPeer,
      peerBot: peerBot('admin', 'imac') as any,
      principal: principal('admin'),
      body: { botName: 'admin', chatId: 'chat-live-shape', prompt: 'savio-to-imac' },
    })).resolves.toMatchObject({ success: true });

    expect(imacCreate).toHaveBeenCalledOnce();
    expect(savioCreate).toHaveBeenCalledOnce();
    expect(wrongImacCreate).not.toHaveBeenCalled();
    expect(wrongSavioCreate).not.toHaveBeenCalled();
    expect(verifiedClaims).toEqual([
      { iss: 'imac', sourceBot: 'admin', rulesPackIssuer: 'metabot-core-admin' },
      { iss: 'savio', sourceBot: 'pm-savio', rulesPackIssuer: 'metabot-core-admin' },
    ]);
  });
});
