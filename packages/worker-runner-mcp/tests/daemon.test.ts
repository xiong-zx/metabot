import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerRunnerDaemon } from '../src/daemon.js';
import { LocalCapabilityAuthority } from '../src/local-auth.js';
import { WorkerService } from '../src/service.js';
import { WorkerStore } from '../src/store.js';
import type { ScopedDispatchWorkerInput, TrustedPrincipal } from '../src/types.js';
import { FakeProcessRunner, RecordingNotifier } from './helpers.js';

const KEY = Buffer.alloc(32, 9);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Worker Runner daemon authentication', () => {
  it('fails closed without a capability and rejects a token for another purpose', async () => {
    const kit = await makeDaemon();
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    };
    expect((await fetch(kit.daemon.url, { method: 'POST', body: JSON.stringify(initialize) })).status).toBe(401);

    const wrongPurpose = new LocalCapabilityAuthority(KEY, 'arc').issue(PM, { ttlMs: 60_000 });
    expect(
      (
        await fetch(kit.daemon.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${wrongPurpose}`, 'content-type': 'application/json' },
          body: JSON.stringify(initialize),
        })
      ).status,
    ).toBe(401);
  });

  it('binds a verified principal to the session and denies cross-scope access', async () => {
    const kit = await makeDaemon((store, dir) => store.createWorker('wrk-other', scopedInput(dir), 2, 1));
    const connected = await connect(kit.daemon.url, kit.authority.issue(OTHER_PM, { ttlMs: 60_000 }));
    cleanups.push(() => connected.client.close());

    const listed = await connected.client.callTool({ name: 'worker_list', arguments: {} });
    expect(listed.structuredContent).toEqual({ workers: [] });
    const status = await connected.client.callTool({ name: 'worker_status', arguments: { id: 'wrk-other' } });
    expect(status).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });

    const sessionId = connected.transport.sessionId;
    expect(sessionId).toBeTruthy();
    const rebound = await fetch(kit.daemon.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${kit.authority.issue(PM, { ttlMs: 60_000 })}`,
        'content-type': 'application/json',
        'mcp-session-id': sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(rebound.status).toBe(403);
  });

  it('lets agent principals read their scope but not dispatch or abort', async () => {
    const kit = await makeDaemon((store, dir) => store.createWorker('wrk-own', scopedInput(dir), 2, 1));
    const agent: TrustedPrincipal = { role: 'agent', botName: 'bot-a', chatId: 'chat-a' };
    const connected = await connect(kit.daemon.url, kit.authority.issue(agent, { ttlMs: 60_000 }));
    cleanups.push(() => connected.client.close());

    const listed = await connected.client.callTool({ name: 'worker_list', arguments: {} });
    expect(listed.structuredContent).toMatchObject({ workers: [{ id: 'wrk-own' }] });
    const dispatched = await connected.client.callTool({
      name: 'worker_dispatch',
      arguments: { workdir: kit.dir, prompt: 'must not run', engine: 'codex' },
    });
    expect(dispatched).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    const aborted = await connected.client.callTool({ name: 'worker_abort', arguments: { id: 'wrk-own' } });
    expect(aborted).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    expect(kit.runner.launches).toHaveLength(0);
  });
});

const PM: TrustedPrincipal = { role: 'pm', botName: 'bot-a', chatId: 'chat-a' };
const OTHER_PM: TrustedPrincipal = { role: 'pm', botName: 'bot-b', chatId: 'chat-b' };

async function makeDaemon(seed?: (store: WorkerStore, dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-daemon-'));
  const store = new WorkerStore(path.join(dir, 'state', 'workers.sqlite'));
  seed?.(store, dir);
  const runner = new FakeProcessRunner();
  const service = new WorkerService(store, runner, new RecordingNotifier(), undefined, testConfig(), {
    dynamicPrincipals: true,
  });
  const authority = new LocalCapabilityAuthority(KEY, 'worker-runner');
  const daemon = new WorkerRunnerDaemon(service, {
    endpoint: 'http://127.0.0.1:0/mcp',
    capabilityAuthority: authority,
  });
  await daemon.start();
  cleanups.push(async () => {
    await daemon.close();
    service.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, runner, service, authority, daemon };
}

async function connect(url: URL, capability: string) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${capability}` } },
  });
  const client = new Client({ name: 'worker-daemon-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function testConfig() {
  return {
    maxConcurrentPerScope: 2,
    defaultTimeoutMs: 1_000,
    defaultIdleTimeoutMs: 500,
    maxTimeoutMs: 10_000,
    maxIdleTimeoutMs: 10_000,
    defaultDedupeTtlMs: 1_000,
    maxDedupeTtlMs: 10_000,
    maxListLimit: 20,
    notificationRetryInitialMs: 10,
    notificationRetryMaxMs: 100,
  };
}

function scopedInput(dir: string): ScopedDispatchWorkerInput {
  return {
    botName: 'bot-a',
    chatId: 'chat-a',
    workdir: dir,
    prompt: 'other scope',
    engine: 'codex',
    dedupePolicy: { completedTtlMs: 1_000, retryTerminal: true },
    timeoutMs: 1_000,
    idleTimeoutMs: 500,
    recoveryPolicy: { restart: 'manual', idempotent: false },
  };
}
