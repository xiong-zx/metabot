import { describe, it, expect, afterEach, vi } from 'vitest';
import { PeerManager } from '../src/api/peer-manager.js';

function createLogger() {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
  logger.child.mockReturnValue(logger);
  return logger;
}

const REGISTRY_ENV_KEYS = [
  'METABOT_CORE_AGENT_BUS_URL',
  'METABOT_CORE_TOKEN',
  'METABOT_AGENT_SELF_URL',
  'METABOT_AGENT_TALK_SECRET',
] as const;

function clearRegistryEnv() {
  for (const k of REGISTRY_ENV_KEYS) delete process.env[k];
}

describe('PeerManager', () => {
  let manager: PeerManager;

  afterEach(() => {
    if (manager) manager.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearRegistryEnv();
  });

  it('initializes with empty peer bots', () => {
    manager = new PeerManager([], createLogger());
    expect(manager.getPeerBots()).toEqual([]);
    expect(manager.getPeerStatuses()).toEqual([]);
  });

  it('refreshPeer caches bots from a healthy peer', async () => {
    const mockBots = {
      bots: [
        { name: 'bot-a', platform: 'feishu', workingDirectory: '/work/a' },
        { name: 'bot-b', description: 'B bot', platform: 'telegram', workingDirectory: '/work/b' },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockBots),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], createLogger());

    await manager.refreshAll();

    const bots = manager.getPeerBots();
    expect(bots).toHaveLength(2);
    expect(bots[0].name).toBe('bot-a');
    expect(bots[0].peerUrl).toBe('http://localhost:9200');
    expect(bots[0].peerName).toBe('alice');
    expect(bots[1].name).toBe('bot-b');
    expect(bots[1].description).toBe('B bot');

    const statuses = manager.getPeerStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].healthy).toBe(true);
    expect(statuses[0].botCount).toBe(2);
  });

  it('marks peer as unhealthy when unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    manager = new PeerManager([
      { name: 'bob', url: 'http://unreachable:9999' },
    ], createLogger());

    await manager.refreshAll();

    expect(manager.getPeerBots()).toEqual([]);
    const statuses = manager.getPeerStatuses();
    expect(statuses[0].healthy).toBe(false);
    expect(statuses[0].error).toBe('ECONNREFUSED');
  });

  it('marks peer as unhealthy on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    manager = new PeerManager([
      { name: 'locked', url: 'http://locked:9100' },
    ], createLogger());

    await manager.refreshAll();

    expect(manager.getPeerBots()).toEqual([]);
    const statuses = manager.getPeerStatuses();
    expect(statuses[0].healthy).toBe(false);
    expect(statuses[0].error).toContain('401');
  });

  it('filters out transitive bots (bots with peerUrl)', async () => {
    const mockBots = {
      bots: [
        { name: 'local-bot', platform: 'feishu', workingDirectory: '/work' },
        { name: 'transitive-bot', platform: 'feishu', workingDirectory: '/other', peerUrl: 'http://third:9300' },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockBots),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], createLogger());

    await manager.refreshAll();

    const bots = manager.getPeerBots();
    expect(bots).toHaveLength(1);
    expect(bots[0].name).toBe('local-bot');
  });

  it('findBotPeer returns correct peer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        bots: [{ name: 'backend-bot', platform: 'feishu', workingDirectory: '/work' }],
      }),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200', secret: 'sec' },
    ], createLogger());

    await manager.refreshAll();

    const result = manager.findBotPeer('backend-bot');
    expect(result).toBeDefined();
    expect(result!.peer.name).toBe('alice');
    expect(result!.bot.name).toBe('backend-bot');
  });

  it('findBotPeer returns undefined for unknown bot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [] }),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], createLogger());

    await manager.refreshAll();
    expect(manager.findBotPeer('nonexistent')).toBeUndefined();
  });

  it('findBotOnPeer returns bot from specific peer', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('9200/api/bots')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ bots: [{ name: 'bot-a', platform: 'feishu', workingDirectory: '/a' }] }) });
      }
      if (url.includes('9300/api/bots')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ bots: [{ name: 'bot-b', platform: 'telegram', workingDirectory: '/b' }] }) });
      }
      // skills endpoints
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ skills: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
      { name: 'bob', url: 'http://localhost:9300' },
    ], createLogger());

    await manager.refreshAll();

    const result = manager.findBotOnPeer('bob', 'bot-b');
    expect(result).toBeDefined();
    expect(result!.peer.name).toBe('bob');

    // Should not find alice's bot on bob
    expect(manager.findBotOnPeer('bob', 'bot-a')).toBeUndefined();
  });

  it('forwardTask sends POST with X-MetaBot-Origin header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, responseText: 'done' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([], createLogger());

    const result = await manager.forwardTask(
      { name: 'alice', url: 'http://localhost:9200', secret: 'sec' },
      { botName: 'bot-a', chatId: 'chat1', prompt: 'hello' },
    );

    expect(result).toEqual({ success: true, responseText: 'done' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9200/api/talk',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-MetaBot-Origin': 'peer',
          'Authorization': 'Bearer sec',
        }),
      }),
    );
  });

  it('sends auth header when peer has secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'secure-peer', url: 'http://remote:9100', secret: 'my-secret' },
    ], createLogger());

    await manager.refreshAll();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://remote:9100/api/bots',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Authorization': 'Bearer my-secret', 'X-MetaBot-Origin': 'peer' }),
      }),
    );
  });

  it('does not send auth header when peer has no secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'local-peer', url: 'http://localhost:9200' },
    ], createLogger());

    await manager.refreshAll();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9200/api/bots',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-MetaBot-Origin': 'peer' }),
      }),
    );
  });

  it('normalizes trailing slashes in URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [{ name: 'b', platform: 'feishu', workingDirectory: '/' }] }),
    }));

    manager = new PeerManager([
      { name: 'trailing', url: 'http://localhost:9200///' },
    ], createLogger());

    await manager.refreshAll();

    const bots = manager.getPeerBots();
    expect(bots[0].peerUrl).toBe('http://localhost:9200');
  });

  // ---------------------------------------------------------------------------
  // Registry mode (METABOT_CORE_AGENT_BUS_URL set) — discovery via central
  // /api/agents endpoint.
  // ---------------------------------------------------------------------------

  describe('registry mode (METABOT_CORE_AGENT_BUS_URL)', () => {
    it('self-registers on construct when registry env is configured', async () => {
      process.env.METABOT_CORE_AGENT_BUS_URL = 'https://metabot.example.com/core';
      process.env.METABOT_CORE_TOKEN = 'core-bearer';
      process.env.METABOT_AGENT_SELF_URL = 'http://self.example:9100';
      process.env.METABOT_AGENT_TALK_SECRET = 'self-talk-secret';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], createLogger());

      // Let the unawaited selfRegisterWithRetry() microtask run.
      await new Promise((r) => setImmediate(r));

      const registerCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/api/agents') && c[1]?.method === 'POST',
      );
      expect(registerCall, 'expected POST /api/agents from self-register').toBeDefined();
      const [registerUrl, registerInit] = registerCall!;
      expect(registerUrl).toBe('https://metabot.example.com/core/api/agents');
      expect((registerInit as RequestInit).headers).toMatchObject({
        'Authorization': 'Bearer core-bearer',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse((registerInit as RequestInit).body as string)).toEqual({
        url: 'http://self.example:9100',
        talkSecret: 'self-talk-secret',
        visible: true,
      });
    });

    it('emits POST /api/agents/heartbeat every 60s', async () => {
      process.env.METABOT_CORE_AGENT_BUS_URL = 'https://metabot.example.com/core';
      process.env.METABOT_CORE_TOKEN = 'core-bearer';
      process.env.METABOT_AGENT_SELF_URL = 'http://self.example:9100';
      process.env.METABOT_AGENT_TALK_SECRET = 'self-talk-secret';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', fetchMock);

      vi.useFakeTimers();
      manager = new PeerManager([], createLogger());

      // Drain the immediate self-register POST.
      await vi.advanceTimersByTimeAsync(0);
      fetchMock.mockClear();

      // Tick forward by the heartbeat interval.
      await vi.advanceTimersByTimeAsync(60_000);

      const heartbeatCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/api/agents/heartbeat'),
      );
      expect(heartbeatCall, 'expected POST /api/agents/heartbeat after 60s').toBeDefined();
      const [, hbInit] = heartbeatCall!;
      expect((hbInit as RequestInit).method).toBe('POST');
      expect((hbInit as RequestInit).headers).toMatchObject({
        'Authorization': 'Bearer core-bearer',
      });
    });

    it('drives peer list from GET /api/agents response', async () => {
      process.env.METABOT_CORE_AGENT_BUS_URL = 'https://metabot.example.com/core';
      process.env.METABOT_CORE_TOKEN = 'core-bearer';
      // SELF_URL deliberately unset → no self-register, no heartbeat — keeps
      // this test focused on the registry-discovery path.

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === 'https://metabot.example.com/core/api/agents') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              agents: [
                { botName: 'alice', url: 'http://alice:9100', talkSecret: 'sec-a', visible: true, lastSeenAt: 'now' },
              ],
            }),
          });
        }
        // Subsequent refreshAll() will hit http://alice:9100/api/bots + /api/skills
        if (url === 'http://alice:9100/api/bots') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              bots: [{ name: 'alice-bot', platform: 'feishu', workingDirectory: '/work/alice' }],
            }),
          });
        }
        if (url === 'http://alice:9100/api/skills') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skills: [] }) });
        }
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], createLogger());

      // Drive one poll tick manually (the timer interval is 30s; we trigger
      // the same code path directly via the private method).
      await (manager as any).runPollTick();

      const peers = manager.getPeerStatuses();
      expect(peers.map((p) => p.name).sort()).toEqual(['alice']);
      const alicePeer = peers.find((p) => p.name === 'alice');
      expect(alicePeer!.url).toBe('http://alice:9100');
      expect(alicePeer!.healthy).toBe(true);

      const bots = manager.getPeerBots();
      expect(bots).toHaveLength(1);
      expect(bots[0].name).toBe('alice-bot');
      expect(bots[0].peerName).toBe('alice');
    });

    it('falls back to static configs when GET /api/agents fails', async () => {
      process.env.METABOT_CORE_AGENT_BUS_URL = 'https://metabot.example.com/core';
      process.env.METABOT_CORE_TOKEN = 'core-bearer';

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === 'https://metabot.example.com/core/api/agents') {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        if (url === 'http://static-peer:9100/api/bots') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              bots: [{ name: 'static-bot', platform: 'feishu', workingDirectory: '/work/static' }],
            }),
          });
        }
        if (url === 'http://static-peer:9100/api/skills') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skills: [] }) });
        }
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      });
      vi.stubGlobal('fetch', fetchMock);

      const logger = createLogger();
      manager = new PeerManager(
        [{ name: 'static', url: 'http://static-peer:9100' }],
        logger,
      );

      await (manager as any).runPollTick();

      // Static peer survived the failed registry fetch.
      const peers = manager.getPeerStatuses();
      expect(peers.map((p) => p.name)).toContain('static');
      const staticPeer = peers.find((p) => p.name === 'static');
      expect(staticPeer!.healthy).toBe(true);
      expect(manager.getPeerBots().some((b) => b.name === 'static-bot')).toBe(true);

      // A single warn fired for the agent-bus failure.
      const warnCalls = (logger.warn as any).mock.calls;
      const sawFallbackWarn = warnCalls.some((c: any[]) =>
        typeof c[1] === 'string' && c[1].includes('agent bus unreachable'),
      );
      expect(sawFallbackWarn).toBe(true);
    });
  });
});
