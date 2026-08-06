import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKER_RUNNER_TOOLS, createWorkerRunnerMcpServer } from '../src/mcp-server.js';
import { createWorkerRunnerRuntime } from '../src/runtime.js';
import { WorkerService } from '../src/service.js';
import { WorkerStore } from '../src/store.js';
import type { ScopedDispatchWorkerInput, TrustedPrincipal } from '../src/types.js';
import { FakeProcessRunner, PM_PRINCIPAL, RecordingNotifier } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('worker runner MCP trust boundary', () => {
  it('fails closed when the server or runtime has no pinned principal', () => {
    const { dir, store, service } = makeService(PM_PRINCIPAL);
    expect(() => createWorkerRunnerMcpServer(service, undefined)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() =>
      createWorkerRunnerRuntime({ env: { METABOT_WORKER_DATA_DIR: path.join(dir, 'runtime') } }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    service.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('advertises exactly four tools whose schemas contain no model-controlled identity fields', async () => {
    const kit = await connect(PM_PRINCIPAL);
    const tools = await kit.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'worker_abort',
      'worker_dispatch',
      'worker_list',
      'worker_status',
    ]);

    const schemas = JSON.stringify(WORKER_RUNNER_TOOLS.map((tool) => tool.inputSchema));
    expect(WORKER_RUNNER_TOOLS.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    for (const forbidden of ['actor_role', 'caller_context', 'botName', 'chatId', 'pmChatId']) {
      expect(schemas).not.toContain(forbidden);
    }

    const result = await kit.client.callTool({
      name: 'worker_dispatch',
      arguments: {
        workdir: kit.dir,
        prompt: 'run once',
        engine: 'codex',
        dedupe_key: 'mcp-request-1',
        recovery_policy: { restart: 'manual', idempotent: false },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      deduplicated: false,
      worker: { id: expect.stringMatching(/^wrk-/), dedupeKey: 'mcp-request-1' },
    });
    expect(kit.runner.launches).toHaveLength(1);
  });

  it.each(['actor_role', 'caller_context', 'botName', 'chatId', 'pmChatId'])(
    'rejects the spoofed identity argument %s',
    async (field) => {
      const kit = await connect(PM_PRINCIPAL);
      const result = await kit.client.callTool({
        name: 'worker_dispatch',
        arguments: {
          workdir: kit.dir,
          prompt: 'must not run',
          engine: 'codex',
          [field]: field === 'caller_context' ? { kind: 'pm' } : 'spoofed',
        },
      });

      expect(result).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_INPUT' } });
      expect(kit.runner.launches).toHaveLength(0);
    },
  );

  it('does not leak another bot+chat scope and reserves all-scope reads for a pinned admin', async () => {
    const principal: TrustedPrincipal = { role: 'pm', botName: 'bot-b', chatId: 'chat-b' };
    const kit = await connect(principal, ({ store, dir }) => {
      store.createWorker('wrk-other', scopedInput(dir), 2, 1);
    });

    const listed = await kit.client.callTool({ name: 'worker_list', arguments: {} });
    expect(listed.structuredContent).toEqual({ workers: [] });

    const status = await kit.client.callTool({ name: 'worker_status', arguments: { id: 'wrk-other' } });
    expect(status).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });

    const allScopes = await kit.client.callTool({ name: 'worker_list', arguments: { all_scopes: true } });
    expect(allScopes).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
  });

  it('bounds list and status output independently of persisted process output', async () => {
    const kit = await connect(PM_PRINCIPAL, undefined, { maxStatusOutputChars: 16 });
    const dispatched = await kit.client.callTool({
      name: 'worker_dispatch',
      arguments: { workdir: kit.dir, prompt: 'large output', engine: 'codex' },
    });
    const id = (dispatched.structuredContent as { worker: { id: string } }).worker.id;
    await vi.waitFor(() => expect(kit.store.require(id).status).toBe('running'));
    kit.runner.complete(4_000, {
      exitCode: 0,
      stdout: `STDOUT_SENTINEL:${'o'.repeat(300_000)}`,
      stderr: `STDERR_SENTINEL:${'e'.repeat(300_000)}`,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    await vi.waitFor(() => expect(kit.store.require(id).status).toBe('completed'));

    const listed = await kit.client.callTool({ name: 'worker_list', arguments: { limit: 1 } });
    const listedWorker = (listed.structuredContent as { workers: Array<Record<string, unknown>> }).workers[0];
    expect(listedWorker).not.toHaveProperty('stdout');
    expect(listedWorker).not.toHaveProperty('stderr');
    expect(listedWorker).not.toHaveProperty('prompt');

    const status = await kit.client.callTool({ name: 'worker_status', arguments: { id } });
    expect(status.structuredContent).toMatchObject({
      worker: {
        stdout: 'STDOUT_SENTINEL:',
        stderr: 'STDERR_SENTINEL:',
        stdoutTruncated: true,
        stderrTruncated: true,
      },
    });
  });
});

async function connect(
  principal: TrustedPrincipal,
  seed?: (kit: { dir: string; store: WorkerStore }) => void,
  options: { maxStatusOutputChars?: number } = {},
) {
  const kit = makeService(principal);
  seed?.(kit);
  const server = createWorkerRunnerMcpServer(kit.service, principal, options);
  const client = new Client({ name: 'worker-runner-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => {
    await client.close();
    await server.close();
    kit.service.dispose();
    kit.store.close();
    rmSync(kit.dir, { recursive: true, force: true });
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { ...kit, client, server };
}

function makeService(principal: TrustedPrincipal) {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-mcp-'));
  const store = new WorkerStore(path.join(dir, 'state', 'workers.sqlite'));
  const runner = new FakeProcessRunner();
  const service = new WorkerService(store, runner, new RecordingNotifier(), principal, {
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
  });
  return { dir, store, runner, service };
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
