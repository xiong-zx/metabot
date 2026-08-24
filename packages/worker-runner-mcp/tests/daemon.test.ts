import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerRunnerDaemon } from '../src/daemon.js';
import { LocalCapabilityVerifier, issueLocalCapability, type LocalCapabilityPurpose } from '../src/local-auth.js';
import { WorkerService } from '../src/service.js';
import { WorkerStore } from '../src/store.js';
import {
  ARC_SERVICE_PRINCIPAL,
  LOCAL_LIFECYCLE_ADMIN_PRINCIPAL,
  type ScopedDispatchWorkerInput,
  type TrustedPrincipal,
  type WorkerRulesPackProvider,
} from '../src/types.js';
import { FakeProcessRunner, RecordingNotifier } from './helpers.js';

const CAPABILITY_KEYS = generateKeyPairSync('ed25519');
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Worker Runner daemon authentication', () => {
  it('rejects a RulesPack grant path outside its confined private root before session creation', async () => {
    const kit = await makeDaemon();
    const outside = path.join(kit.dir, 'outside-grant.json');
    writeFileSync(outside, '{}', { mode: 0o600 });
    chmodSync(outside, 0o600);
    const response = await fetch(kit.daemon.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${kit.issue(PM)}`,
        'content-type': 'application/json',
        'x-metabot-rulespack-grant-file': outside,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });
    expect(response.status).toBe(401);
  });

  it('fails closed without a capability and rejects a token for another purpose', async () => {
    const kit = await makeDaemon();
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    };
    expect((await fetch(kit.daemon.url, { method: 'POST', body: JSON.stringify(initialize) })).status).toBe(401);

    const wrongPurpose = issue(PM, 'arc');
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

  it.each([
    { role: 'admin' as const, botName: 'forged-lifecycle', chatId: 'local:daemon-lifecycle' },
    { role: 'admin' as const, botName: 'metabot-local-lifecycle', chatId: 'local:forged-lifecycle' },
  ])('rejects a signed admin capability unless every lifecycle identity field is exact', async (principal) => {
    const kit = await makeDaemon();
    const response = await initialize(kit.daemon.url, issueUnchecked(principal));
    expect(response.status).toBe(401);
  });

  it('allows the exact lifecycle admin a bounded all-scope list but denies status and every mutation', async () => {
    const kit = await makeDaemon((store, dir) => {
      store.createWorker('wrk-a', scopedInput(dir), 2, 1);
      store.createWorker(
        'wrk-b',
        { ...scopedInput(dir), botName: 'bot-b', chatId: 'chat-b', dedupeKey: 'other-scope' },
        2,
        2,
      );
    });
    const connected = await connect(kit.daemon.url, kit.issue(LOCAL_LIFECYCLE_ADMIN_PRINCIPAL));
    cleanups.push(() => connected.client.close());

    const listed = await connected.client.callTool({
      name: 'worker_list',
      arguments: { all_scopes: true, limit: 1 },
    });
    expect((listed.structuredContent as { workers: unknown[] }).workers).toHaveLength(1);
    const status = await connected.client.callTool({ name: 'worker_status', arguments: { id: 'wrk-a' } });
    expect(status).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    const dispatched = await connected.client.callTool({
      name: 'worker_dispatch',
      arguments: { workdir: kit.dir, prompt: 'must not run', engine: 'codex' },
    });
    expect(dispatched).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    const aborted = await connected.client.callTool({ name: 'worker_abort', arguments: { id: 'wrk-a' } });
    expect(aborted).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
  });

  it('lets the exact ARC service dispatch, observe, and abort only its own workers', async () => {
    const kit = await makeDaemon((store, dir) => store.createWorker('wrk-other', scopedInput(dir), 2, 1));
    const connected = await connect(kit.daemon.url, kit.issue(ARC_SERVICE_PRINCIPAL));
    cleanups.push(() => connected.client.close());

    const dispatched = await connected.client.callTool({
      name: 'worker_dispatch',
      arguments: { workdir: kit.dir, prompt: 'run ARC work', engine: 'codex' },
    });
    expect(dispatched.isError).not.toBe(true);
    const id = (dispatched.structuredContent as { worker: { id: string } }).worker.id;
    const status = await connected.client.callTool({ name: 'worker_status', arguments: { id } });
    expect(status).toMatchObject({ structuredContent: { worker: { id } } });
    const listed = await connected.client.callTool({ name: 'worker_list', arguments: {} });
    expect(listed).toMatchObject({ structuredContent: { workers: [expect.objectContaining({ id })] } });
    await vi.waitFor(() => expect(kit.store.require(id).status).toBe('running'));
    const ownPid = kit.store.require(id).pid;
    const otherStatusBefore = kit.store.require('wrk-other').status;
    const aborted = await connected.client.callTool({ name: 'worker_abort', arguments: { id } });
    expect(aborted).toMatchObject({ structuredContent: { worker: { id, status: 'aborted' } } });
    const allScopes = await connected.client.callTool({ name: 'worker_list', arguments: { all_scopes: true } });
    expect(allScopes).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    const otherStatus = await connected.client.callTool({ name: 'worker_status', arguments: { id: 'wrk-other' } });
    expect(otherStatus).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    const otherAbort = await connected.client.callTool({ name: 'worker_abort', arguments: { id: 'wrk-other' } });
    expect(otherAbort).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    expect(kit.store.require('wrk-other').status).toBe(otherStatusBefore);
    expect(kit.runner.aborts).toEqual([ownPid]);
  });

  it('does not grant ARC service treatment to partial or role-forged identities', async () => {
    const kit = await makeDaemon((store, dir) =>
      store.createWorker('wrk-service', {
        ...scopedInput(dir),
        botName: ARC_SERVICE_PRINCIPAL.botName,
        chatId: ARC_SERVICE_PRINCIPAL.chatId,
      }, 2, 1),
    );
    const partial = await connect(kit.daemon.url, kit.issue({
      role: 'pm',
      botName: ARC_SERVICE_PRINCIPAL.botName,
      chatId: 'local:arc-service-forged',
    }));
    cleanups.push(() => partial.client.close());
    const partialStatus = await partial.client.callTool({ name: 'worker_status', arguments: { id: 'wrk-service' } });
    expect(partialStatus).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    const partialAbort = await partial.client.callTool({ name: 'worker_abort', arguments: { id: 'wrk-service' } });
    expect(partialAbort).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });

    const forgedRole = await connect(kit.daemon.url, kit.issue({
      role: 'manager',
      botName: ARC_SERVICE_PRINCIPAL.botName,
      chatId: ARC_SERVICE_PRINCIPAL.chatId,
    }));
    cleanups.push(() => forgedRole.client.close());
    const forgedDispatch = await forgedRole.client.callTool({
      name: 'worker_dispatch',
      arguments: { workdir: kit.dir, prompt: 'must not run', engine: 'codex' },
    });
    expect(forgedDispatch).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    const forgedAbort = await forgedRole.client.callTool({ name: 'worker_abort', arguments: { id: 'wrk-service' } });
    expect(forgedAbort).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    const forgedAllScopes = await forgedRole.client.callTool({ name: 'worker_list', arguments: { all_scopes: true } });
    expect(forgedAllScopes).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    expect(kit.runner.aborts).toEqual([]);
  });

  it('binds a verified principal to the session and denies cross-scope access', async () => {
    const kit = await makeDaemon((store, dir) => store.createWorker('wrk-other', scopedInput(dir), 2, 1));
    const connected = await connect(kit.daemon.url, kit.issue(OTHER_PM));
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
        authorization: `Bearer ${kit.issue(PM)}`,
        'content-type': 'application/json',
        'mcp-session-id': sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(rebound.status).toBe(403);
  });

  it.each(['manager', 'agent', 'worker'] as const)(
    'lets %s principals read their scope but not dispatch or abort',
    async (role) => {
    const kit = await makeDaemon((store, dir) => store.createWorker('wrk-own', scopedInput(dir), 2, 1));
    const readOnly: TrustedPrincipal = { role, botName: 'bot-a', chatId: 'chat-a' };
    const connected = await connect(kit.daemon.url, kit.issue(readOnly));
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
    },
  );

  it('retains the authorizing capability durably without exposing it through tools', async () => {
    const kit = await makeDaemon();
    const capability = kit.issue(PM);
    const connected = await connect(kit.daemon.url, capability);
    cleanups.push(() => connected.client.close());
    const dispatched = await connected.client.callTool({
      name: 'worker_dispatch',
      arguments: { workdir: kit.dir, prompt: 'persist private authorization', engine: 'codex' },
    });
    const worker = (dispatched.structuredContent as { worker: { id: string } }).worker;
    expect(kit.store.getAuthorizingCapability(worker.id)).toBe(capability);
    expect(JSON.stringify(dispatched.structuredContent)).not.toContain(capability);
    const status = await connected.client.callTool({ name: 'worker_status', arguments: { id: worker.id } });
    expect(JSON.stringify(status.structuredContent)).not.toContain(capability);
  });

  it('restricts bot-scoped RulesPack control to lifecycle admin and delegates to the current provider', async () => {
    const controlStatus = vi.fn((botName: string) => ({
      botName,
      state: 'configured' as const,
      botScoped: true,
      mode: 'enforce' as const,
      configuredMode: 'enforce' as const,
      operatorModeVersion: 0,
      appliesTo: 'subsequent-codex-policy-preparations' as const,
      inFlight: 'unchanged' as const,
    }));
    const setControlMode = vi.fn((
      botName: string,
      mode: 'off' | 'shadow' | 'enforce' | null,
      expectedVersion: number,
      operationId: string,
    ) => ({
      botName,
      state: 'configured' as const,
      botScoped: true,
      mode: mode ?? 'enforce',
      configuredMode: 'enforce' as const,
      operatorModeVersion: expectedVersion + 1,
      operatorModeOperationId: operationId,
      ...(mode === null ? {} : { operatorModeOverride: { mode, updatedAt: '2026-08-19T00:00:00.000Z' } }),
      appliesTo: 'subsequent-codex-policy-preparations' as const,
      inFlight: 'unchanged' as const,
    }));
    const provider: WorkerRulesPackProvider = {
      prepare: async () => undefined,
      controlStatus,
      setControlMode,
    };
    const kit = await makeDaemon(undefined, provider);
    const statusUrl = rulesPackUrl(kit.daemon.url, 'admin', 'status');
    const modeUrl = rulesPackUrl(kit.daemon.url, 'admin', 'mode');

    expect((await fetch(statusUrl)).status).toBe(401);
    expect((await fetch(modeUrl, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${kit.issue(PM)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'off', expectedVersion: 0, operationId: 'forbidden' }),
    })).status).toBe(403);

    const lifecycle = kit.issue(LOCAL_LIFECYCLE_ADMIN_PRINCIPAL);
    const status = await fetch(statusUrl, { headers: { authorization: `Bearer ${lifecycle}` } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      botName: 'admin', mode: 'enforce', appliesTo: 'subsequent-codex-policy-preparations', inFlight: 'unchanged',
    });
    const changed = await fetch(modeUrl, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${lifecycle}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'off', expectedVersion: 0, operationId: 'mode-off-1' }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      botName: 'admin', mode: 'off', operatorModeOverride: { mode: 'off' },
    });
    expect(controlStatus).toHaveBeenCalledWith('admin');
    expect(setControlMode).toHaveBeenCalledWith('admin', 'off', 0, 'mode-off-1');
  });
});

const PM: TrustedPrincipal = { role: 'pm', botName: 'bot-a', chatId: 'chat-a' };
const OTHER_PM: TrustedPrincipal = { role: 'pm', botName: 'bot-b', chatId: 'chat-b' };

async function makeDaemon(
  seed?: (store: WorkerStore, dir: string) => void,
  rulesPackProvider?: WorkerRulesPackProvider,
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-daemon-'));
  const rulesPackGrantRoot = path.join(dir, 'private-grants');
  mkdirSync(rulesPackGrantRoot, { mode: 0o700 });
  const store = new WorkerStore(path.join(dir, 'state', 'workers.sqlite'));
  seed?.(store, dir);
  const runner = new FakeProcessRunner();
  const service = new WorkerService(store, runner, new RecordingNotifier(), undefined, testConfig(), {
    dynamicPrincipals: true,
    ...(rulesPackProvider ? { rulesPackProvider } : {}),
  });
  const verifier = new LocalCapabilityVerifier([CAPABILITY_KEYS.publicKey], 'worker');
  const daemon = new WorkerRunnerDaemon(service, {
    endpoint: 'http://127.0.0.1:0/mcp',
    capabilityVerifier: verifier,
    rulesPackGrantRoot,
  });
  await daemon.start();
  cleanups.push(async () => {
    await daemon.close();
    service.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, runner, service, issue: (principal: TrustedPrincipal) => issue(principal), daemon };
}

function rulesPackUrl(urlValue: URL, botName: string, action: 'status' | 'mode'): URL {
  const url = new URL(urlValue);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/rulespack/bots/${encodeURIComponent(botName)}/${action}`;
  return url;
}

function issue(principal: TrustedPrincipal, purpose: LocalCapabilityPurpose = 'worker'): string {
  return issueLocalCapability(CAPABILITY_KEYS.privateKey, {
    v: 1,
    purpose,
    role: principal.role,
    botName: principal.botName,
    chatId: principal.chatId,
    exp: Date.now() + 60_000,
  });
}

function issueUnchecked(principal: TrustedPrincipal): string {
  const claims = {
    v: 1,
    purpose: 'worker',
    role: principal.role,
    botName: principal.botName,
    chatId: principal.chatId,
    exp: Date.now() + 60_000,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${cryptoSign(null, Buffer.from(payload), CAPABILITY_KEYS.privateKey).toString('base64url')}`;
}

function initialize(url: URL, capability: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }),
  });
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
