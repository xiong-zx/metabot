import { sign as cryptoSign } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTeamGovernanceExtension, createAgentTeamGovernanceHost } from '../src/agent-teams/governance-extension.js';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';
import { BotRegistry } from '../src/api/bot-registry.js';
import { startApiServer } from '../src/api/http-server.js';
import {
  buildTerminalWakePrompt,
  TerminalEventRateLimiter,
  type TerminalCallbackEnvelope,
} from '../src/api/routes/worker-events-routes.js';
import {
  ExecutionCapabilityService,
  EXECUTION_PRINCIPAL_BOT_NAME_MAX_LENGTH,
  EXECUTION_PRINCIPAL_CHAT_ID_MAX_LENGTH,
  provisionExecutionKeyPairs,
  type TerminalCallbackPurpose,
} from '../src/services/execution-capabilities.js';
import { TerminalEventStore } from '../src/services/terminal-event-store.js';

const dirs: string[] = [];
const logger = {
  child: () => logger,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `metabot-${name}-`));
  dirs.push(dir);
  return dir;
}

function callbackSignature(keysDir: string, raw: Buffer, purpose: TerminalCallbackPurpose): string {
  const prefix = purpose === 'worker.terminal' ? 'worker-callback' : 'arc-callback';
  return `ed25519:${cryptoSign(
    null,
    raw,
    readFileSync(join(keysDir, `${prefix}.key`), 'utf8'),
  ).toString('base64')}`;
}

function makeEnvelope(
  capabilities: ExecutionCapabilityService,
  overrides: Partial<TerminalCallbackEnvelope> = {},
): TerminalCallbackEnvelope {
  const purpose = overrides.purpose ?? 'worker.terminal';
  const botName = overrides.bot_name ?? 'pm-codex';
  const chatId = overrides.chat_id ?? 'chat-1';
  return {
    contract_version: 'metabot.terminal-callback.v1',
    purpose,
    event_id: overrides.event_id ?? 'event-1',
    bot_name: botName,
    chat_id: chatId,
    status: overrides.status ?? 'completed',
    finished_at: overrides.finished_at ?? Date.now(),
    iat: overrides.iat ?? Date.now(),
    authorizing_capability: overrides.authorizing_capability ?? capabilities.issue({
      purpose: purpose === 'worker.terminal' ? 'worker' : 'arc',
      role: 'pm',
      botName,
      chatId,
      ttlMs: 1,
    }, Date.now() - 10_000),
    payload: overrides.payload ?? {
      worker: {
        id: 'worker-1',
        label: 'bounded job',
        engine: 'codex',
        exitCode: 0,
        durationMs: 123,
        stdout: 'SECRET_STDOUT_SENTINEL',
        stderr: 'SECRET_STDERR_SENTINEL',
        responseText: 'SECRET_RESPONSE_SENTINEL',
      },
    },
  };
}

async function postEnvelope(
  baseUrl: string,
  keysDir: string,
  envelope: TerminalCallbackEnvelope,
  options: { raw?: Buffer; signingPurpose?: TerminalCallbackPurpose; signature?: string } = {},
): Promise<Response> {
  const raw = options.raw ?? Buffer.from(JSON.stringify(envelope));
  return fetch(`${baseUrl}/api/worker-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-metabot-callback-signature': options.signature
        ?? callbackSignature(keysDir, raw, options.signingPurpose ?? envelope.purpose),
    },
    body: raw,
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for callback dispatch');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('signed terminal callback route', () => {
  it('authenticates exact raw bytes, persists before ack, replays asynchronously, and rejects scope abuse', async () => {
    vi.stubEnv('METABOT_RATE_LIMIT_DISABLED', '1');
    const dir = tempDir('worker-events-route');
    const keysDir = join(dir, 'keys');
    chmodSync(dir, 0o700);
    provisionExecutionKeyPairs(keysDir);
    const capabilities = new ExecutionCapabilityService(keysDir);
    const terminalStore = new TerminalEventStore(logger, { dbPath: join(dir, 'events.sqlite') });
    const teamStore = new AgentTeamStore(logger, join(dir, 'teams.sqlite'));
    const governance = new AgentTeamGovernanceExtension(
      createAgentTeamGovernanceHost(teamStore),
      logger,
      join(dir, 'governance.sqlite'),
    );
    const registry = new BotRegistry();
    let releaseFirstWake!: (value: { success: true }) => void;
    const firstWake = new Promise<{ success: true }>((resolve) => { releaseFirstWake = resolve; });
    let wakeCount = 0;
    const executeApiTask = vi.fn(async (_options: any) => {
      wakeCount += 1;
      return wakeCount === 1
        ? firstWake
        : { success: false as const, cancelled: true, responseText: '', error: 'Task was stopped' };
    });
    registry.register({
      name: 'pm-codex',
      platform: 'web',
      config: {
        claude: { defaultWorkingDirectory: dir },
      },
      bridge: {
        setAgentTeamStore: vi.fn(),
        setExecutionEnvProvider: vi.fn(),
        releaseChatExecutorIfIdle: vi.fn(async () => true),
        executeApiTask,
      },
      sender: {},
    } as any);
    const maxBotName = 'b'.repeat(EXECUTION_PRINCIPAL_BOT_NAME_MAX_LENGTH);
    const maxChatId = 'c'.repeat(EXECUTION_PRINCIPAL_CHAT_ID_MAX_LENGTH);
    registry.register({
      name: maxBotName,
      platform: 'web',
      config: {
        claude: { defaultWorkingDirectory: dir },
      },
      bridge: {
        setAgentTeamStore: vi.fn(),
        setExecutionEnvProvider: vi.fn(),
        releaseChatExecutorIfIdle: vi.fn(async () => true),
        executeApiTask,
      },
      sender: {},
    } as any);
    const server = startApiServer({
      port: 0,
      secret: 'bridge-admin-secret',
      registry,
      scheduler: {
        setWebSocketHandle: vi.fn(),
        taskCount: () => 0,
        recurringTaskCount: () => 0,
      } as any,
      logger,
      agentTeamStore: teamStore,
      agentTeamGovernance: governance,
      executionCapabilityService: capabilities,
      terminalEventStore: terminalStore,
      terminalEventRateLimiter: new TerminalEventRateLimiter(2, 60_000),
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const acceptedEnvelope = makeEnvelope(capabilities);
      const accepted = await postEnvelope(baseUrl, keysDir, acceptedEnvelope);
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({ accepted: true, duplicate: false });
      expect(terminalStore.has('event-1')).toBe(true);
      await waitFor(() => executeApiTask.mock.calls.length === 1);
      const prompt = executeApiTask.mock.calls[0][0].prompt as string;
      expect(prompt).not.toContain('SECRET_STDOUT_SENTINEL');
      expect(prompt).not.toContain('SECRET_STDERR_SENTINEL');
      expect(prompt).not.toContain('SECRET_RESPONSE_SENTINEL');
      expect(prompt).toContain('worker_status');
      releaseFirstWake({ success: true });
      await waitFor(() => terminalStore.get('event-1')?.state === 'woken');

      const duplicate = await postEnvelope(baseUrl, keysDir, acceptedEnvelope);
      expect(duplicate.status).toBe(200);
      await expect(duplicate.json()).resolves.toMatchObject({ duplicate: true });
      expect(terminalStore.count()).toBe(1);

      const compact = Buffer.from(JSON.stringify(makeEnvelope(capabilities, { event_id: 'raw-mutation' })));
      const mutated = Buffer.concat([compact, Buffer.from(' ')]);
      const mutatedResponse = await postEnvelope(baseUrl, keysDir, JSON.parse(compact.toString()), {
        raw: mutated,
        signature: callbackSignature(keysDir, compact, 'worker.terminal'),
      });
      expect(mutatedResponse.status).toBe(401);

      const mismatchedCapabilities = [
        capabilities.issue({
          purpose: 'worker', role: 'user', botName: 'pm-codex', chatId: 'other-chat', ttlMs: 60_000,
        }),
        capabilities.issue({
          purpose: 'worker', role: 'user', botName: 'other-bot', chatId: 'chat-1', ttlMs: 60_000,
        }),
      ];
      for (const [index, authorizingCapability] of mismatchedCapabilities.entries()) {
        const mismatch = await postEnvelope(baseUrl, keysDir, makeEnvelope(capabilities, {
          event_id: `capability-mismatch-${index}`,
          authorizing_capability: authorizingCapability,
        }));
        expect(mismatch.status).toBe(403);
      }

      const unknown = await postEnvelope(baseUrl, keysDir, makeEnvelope(capabilities, {
        event_id: 'unknown-bot',
        bot_name: 'not-registered',
        authorizing_capability: capabilities.issue({
          purpose: 'worker', role: 'pm', botName: 'not-registered', chatId: 'chat-1', ttlMs: 60_000,
        }),
      }));
      expect(unknown.status).toBe(404);

      for (const [eventId, iat] of [
        ['stale-event', Date.now() - 301_000],
        ['future-event', Date.now() + 301_000],
      ] as const) {
        const skewed = await postEnvelope(baseUrl, keysDir, makeEnvelope(capabilities, { event_id: eventId, iat }));
        expect(skewed.status).toBe(400);
      }

      const second = await postEnvelope(baseUrl, keysDir, makeEnvelope(capabilities, { event_id: 'event-2' }));
      expect(second.status).toBe(200);
      await waitFor(() => terminalStore.get('event-2')?.state === 'woken');
      expect(terminalStore.get('event-2')).toMatchObject({ state: 'woken', attempts: 1 });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'event-2', botName: 'pm-codex', chatId: 'chat-1' }),
        'Terminal callback wake cancelled by the user; event acknowledged',
      );
      const limited = await postEnvelope(baseUrl, keysDir, makeEnvelope(capabilities, { event_id: 'event-3' }));
      expect(limited.status).toBe(429);
      expect(terminalStore.has('event-3')).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'worker.terminal', botName: 'pm-codex' }),
        'Terminal callback acceptance rate limit exceeded',
      );

      const metadataId = 'i'.repeat(200);
      const maxEnvelope = makeEnvelope(capabilities, {
        event_id: 'max-principal-boundary',
        bot_name: maxBotName,
        chat_id: maxChatId,
        payload: { worker: { id: metadataId, status: 'completed' } },
      });
      const maxResponse = await postEnvelope(baseUrl, keysDir, maxEnvelope);
      expect(maxResponse.status).toBe(200);
      await waitFor(() => terminalStore.get(maxEnvelope.event_id)?.state === 'woken');
      expect(executeApiTask.mock.calls.at(-1)?.[0].prompt).toContain(metadataId);

      const countBeforeInvalidBounds = terminalStore.count();
      for (const envelope of [
        { ...maxEnvelope, event_id: 'overlong-bot-name', bot_name: `${maxBotName}x` },
        { ...maxEnvelope, event_id: 'overlong-chat-id', chat_id: `${maxChatId}x` },
      ]) {
        const response = await postEnvelope(baseUrl, keysDir, envelope);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_CALLBACK_ENVELOPE' });
        expect(terminalStore.has(envelope.event_id)).toBe(false);
      }
      expect(terminalStore.count()).toBe(countBeforeInvalidBounds);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      governance.close();
      teamStore.close();
      terminalStore.close();
    }
  });

  it('fails closed with 503 when callback verification keys are missing or unsafe', async () => {
    vi.stubEnv('METABOT_RATE_LIMIT_DISABLED', '1');
    const dir = tempDir('worker-events-missing-keys');
    const validKeys = join(dir, 'valid-keys');
    const missingKeys = join(dir, 'missing-keys');
    provisionExecutionKeyPairs(validKeys);
    mkdirSync(missingKeys, { mode: 0o700 });
    const issuer = new ExecutionCapabilityService(validKeys);
    const terminalStore = new TerminalEventStore(logger, { dbPath: join(dir, 'events.sqlite') });
    const registry = new BotRegistry();
    registry.register({ name: 'pm-codex', platform: 'web' } as any);
    const ctx = {
      registry,
      logger,
      executionCapabilityService: new ExecutionCapabilityService(missingKeys),
      terminalEventStore: terminalStore,
      terminalEventDispatcher: { notify: vi.fn() },
      terminalEventRateLimiter: new TerminalEventRateLimiter(),
    } as any;
    const envelope = makeEnvelope(issuer);
    const raw = Buffer.from(JSON.stringify(envelope));
    const req = (await import('node:stream')).Readable.from([raw]) as any;
    req.headers = { 'x-metabot-callback-signature': callbackSignature(validKeys, raw, 'worker.terminal') };
    let status = 0;
    let body = '';
    const res = {
      setHeader: vi.fn(),
      writeHead(next: number) { status = next; },
      end(value?: string) { body = value ?? ''; },
    } as any;
    const { handleWorkerEventsRoutes } = await import('../src/api/routes/worker-events-routes.js');

    await handleWorkerEventsRoutes(ctx, req, res, 'POST', '/api/worker-events');

    expect(status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ code: 'KEYS_UNAVAILABLE' });
    expect(terminalStore.count()).toBe(0);

    provisionExecutionKeyPairs(missingKeys);
    const callbackPublic = join(missingKeys, 'worker-callback.pub');
    const callbackTarget = join(missingKeys, 'worker-callback.pub.real');
    renameSync(callbackPublic, callbackTarget);
    symlinkSync(callbackTarget, callbackPublic);
    const unsafeReq = (await import('node:stream')).Readable.from([raw]) as any;
    unsafeReq.headers = req.headers;
    status = 0;
    body = '';
    await handleWorkerEventsRoutes(ctx, unsafeReq, res, 'POST', '/api/worker-events');
    expect(status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ code: 'UNSAFE_KEY_NODE_TYPE' });
    expect(terminalStore.count()).toBe(0);
    terminalStore.close();
  });

  it('builds a Worker metadata-only wake with the fixed status-tool instruction', () => {
    const dir = tempDir('worker-events-prompt');
    provisionExecutionKeyPairs(join(dir, 'keys'));
    const capabilities = new ExecutionCapabilityService(join(dir, 'keys'));
    const prompt = buildTerminalWakePrompt(makeEnvelope(capabilities, {
      purpose: 'worker.terminal',
      payload: { worker: { id: 'worker-1', stdout: 'DO_NOT_INCLUDE' } },
    }));
    expect(prompt).toContain('worker_status');
    expect(prompt).not.toContain('DO_NOT_INCLUDE');
  });
});
