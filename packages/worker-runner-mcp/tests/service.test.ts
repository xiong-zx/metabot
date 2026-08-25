import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RulesPackChildGrantV1 } from '@metabot/rulespack';
import {
  HttpCompletionNotifier,
  verifyTerminalCallback,
  WORKER_TERMINAL_CALLBACK_MAX_BYTES,
} from '../src/notifier.js';
import { normalizeTrustedPrincipal, WorkerService } from '../src/service.js';
import { WorkerStore } from '../src/store.js';
import {
  ARC_SERVICE_PRINCIPAL,
  TRUSTED_PRINCIPAL_BOT_NAME_MAX_LENGTH,
  TRUSTED_PRINCIPAL_CHAT_ID_MAX_LENGTH,
  type DispatchWorkerInput,
  type ScopedDispatchWorkerInput,
} from '../src/types.js';
import { FakeProcessRunner, PM_PRINCIPAL, RecordingNotifier, SUCCESS_RESULT } from './helpers.js';

const dirs: string[] = [];
const stores: WorkerStore[] = [];
const services: WorkerService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WorkerService pinned authority and lifecycle', () => {
  it('fails closed without a server-instance-pinned trusted principal', () => {
    const { store } = makeStore();
    expect(() => new WorkerService(store, new FakeProcessRunner(), new RecordingNotifier(), undefined)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('rejects Team principals while accepting low-privilege read-only roles', () => {
    const { store } = makeStore();
    expect(
      () =>
        new WorkerService(store, new FakeProcessRunner(), new RecordingNotifier(), {
          role: 'pm',
          botName: 'bot-a',
          chatId: 'team:project:agent',
        }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    const readOnly = new WorkerService(store, new FakeProcessRunner(), new RecordingNotifier(), {
      role: 'agent',
      botName: 'bot-a',
      chatId: 'chat-a',
    });
    services.push(readOnly);
    expect(readOnly.list()).toEqual([]);
  });

  it('accepts 200/500 trusted principals and rejects 201/501', () => {
    const botName = 'b'.repeat(TRUSTED_PRINCIPAL_BOT_NAME_MAX_LENGTH);
    const chatId = 'c'.repeat(TRUSTED_PRINCIPAL_CHAT_ID_MAX_LENGTH);
    expect(normalizeTrustedPrincipal({ role: 'pm', botName, chatId })).toEqual({
      role: 'pm', botName, chatId,
    });
    expect(() => normalizeTrustedPrincipal({ role: 'pm', botName: `${botName}x`, chatId }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => normalizeTrustedPrincipal({ role: 'pm', botName, chatId: `${chatId}x` }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('persists queued before spawn and transitions to running only with a launch identity', async () => {
    const kit = makeKit();
    kit.runner.holdLaunch();
    const dispatched = await kit.service.dispatch(input(kit.dir));

    expect(dispatched.worker.status).toBe('queued');
    expect(kit.store.require(dispatched.worker.id).status).toBe('queued');
    kit.runner.releaseLaunch();

    await vi.waitFor(() => {
      expect(kit.store.require(dispatched.worker.id)).toMatchObject({
        status: 'running',
        launchId: 'launch-1',
        pid: 4_000,
      });
    });
  });

  it('records terminal output and notifies once with a stable event id', async () => {
    const kit = makeKit();
    const dispatched = await kit.service.dispatch(input(kit.dir), undefined, 'signed-worker-capability');
    await vi.waitFor(() => expect(kit.store.require(dispatched.worker.id).status).toBe('running'));
    kit.runner.complete(4_000, SUCCESS_RESULT);

    await vi.waitFor(() => {
      expect(kit.store.require(dispatched.worker.id)).toMatchObject({
        status: 'completed',
        stdout: 'worker finished',
        notificationState: 'delivered',
      });
    });
    expect(kit.notifier.notifications).toHaveLength(1);
    expect(kit.notifier.notifications[0]).toMatchObject({
      eventId: `worker:${dispatched.worker.id}:terminal:v1`,
      eventType: 'worker.terminal',
      authorizingCapability: 'signed-worker-capability',
    });
    expect(kit.store.getAuthorizingCapability(dispatched.worker.id)).toBe('signed-worker-capability');
    expect(kit.store.require(dispatched.worker.id)).not.toHaveProperty('authorizingCapability');
    expect(kit.notifier.notifications[0]?.worker).toEqual({
      id: dispatched.worker.id,
      engine: 'codex',
      status: 'completed',
      exitCode: 0,
      durationMs: expect.any(Number),
    });
  });

  it('denies cross-scope status and abort while returning only the pinned scope from list', async () => {
    const { store, dir } = makeStore();
    store.createWorker('wrk-a', scopedInput(dir), 4, 1);
    const runner = new FakeProcessRunner();
    const service = new WorkerService(
      store,
      runner,
      new RecordingNotifier(),
      { role: 'pm', botName: 'bot-b', chatId: 'chat-b' },
      testConfig(),
    );
    services.push(service);

    await service.start();
    expect(service.list()).toEqual([]);
    expect(() => service.status('wrk-a')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    await expect(service.abort('wrk-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(runner.aborts).toHaveLength(0);
    expect(store.require('wrk-a').status).toBe('queued');
  });

  it('does not infer an output contract from prompt wording or workdir files', async () => {
    const kit = makeKit();
    writeFileSync(path.join(kit.dir, 'results.json'), '{"result":"existing"}');
    const dispatched = await kit.service.dispatch(input(kit.dir, { prompt: 'research and write results.json' }));

    expect(dispatched.worker.outputContract).toBeUndefined();
    await vi.waitFor(() => expect(kit.runner.launches[0]?.outputContract).toBeUndefined());
  });

  it.each(['model', 'label', 'dedupeKey'] as const)('rejects an explicitly empty optional %s', async (field) => {
    const kit = makeKit();
    await expect(kit.service.dispatch(input(kit.dir, { [field]: '' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(kit.runner.launches).toHaveLength(0);
  });

  it('accepts the bounded encoded dedupe key for maximum-size ARC identifiers', async () => {
    const kit = makeKit();
    const dedupeKey = `arc:v1:${encodeURIComponent('界'.repeat(200))}:${encodeURIComponent('界'.repeat(200))}`;
    expect(dedupeKey.length).toBeLessThanOrEqual(4_096);
    await expect(kit.service.dispatch(input(kit.dir, { dedupeKey }))).resolves.toMatchObject({
      worker: { dedupeKey },
    });
    await expect(kit.service.dispatch(input(kit.dir, { dedupeKey: 'x'.repeat(4_097) }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects an explicitly empty output-contract description', async () => {
    const kit = makeKit();
    await expect(
      kit.service.dispatch(input(kit.dir, { outputContract: { format: 'text', description: '' } })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(kit.runner.launches).toHaveLength(0);
  });

  it('rejects an oversized Kimi rendered prompt before persistence or launch', async () => {
    const kit = makeKit();
    await expect(
      kit.service.dispatch(input(kit.dir, { engine: 'kimi', prompt: '界'.repeat(6_000) })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(kit.service.list()).toEqual([]);
    expect(kit.runner.launches).toHaveLength(0);
  });

  it('rejects a hidden RulesPack grant for a Kimi worker before persistence', async () => {
    const { store, dir } = makeStore();
    const runner = new FakeProcessRunner();
    const grant = { schemaVersion: 1, purpose: 'worker' } as RulesPackChildGrantV1;
    const service = new WorkerService(store, runner, new RecordingNotifier(), PM_PRINCIPAL, testConfig(), {
      rulesPackGrantVerifier: (value) => value,
    });
    services.push(service);
    await expect(service.dispatch(input(dir, { engine: 'kimi' }), undefined, 'capability', grant)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(store.listScope(PM_PRINCIPAL.botName, PM_PRINCIPAL.chatId, 10)).toEqual([]);
    expect(runner.launches).toEqual([]);
  });

  it('verifies and injects a hidden RulesPack grant for a Claude worker', async () => {
    const { store, dir } = makeStore();
    const runner = new FakeProcessRunner();
    const grant = { schemaVersion: 1, purpose: 'worker' } as RulesPackChildGrantV1;
    const prepared = {
      injectionText: 'claude policy',
      packDigest: 'sha256:claude-policy',
      markInjected() {},
      markRejected() {},
    };
    const prepare = vi.fn(async () => prepared);
    const service = new WorkerService(store, runner, new RecordingNotifier(), PM_PRINCIPAL, testConfig(), {
      rulesPackProvider: { prepare },
      rulesPackGrantVerifier: (value) => value,
    });
    services.push(service);
    const dispatched = await service.dispatch(
      input(dir, { engine: 'claude' }),
      undefined,
      'capability',
      grant,
    );
    await vi.waitFor(() => expect(runner.launches).toHaveLength(1));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      id: dispatched.worker.id,
      engine: 'claude',
    }), grant);
    expect(runner.launches[0]).toMatchObject({ engine: 'claude', rulesPack: prepared });
  });

  it('dispatches a protected worker instead of deduplicating to a running plain worker', async () => {
    const kit = makeGrantKit();
    const first = await kit.service.dispatch(input(kit.dir, { dedupeKey: 'plain-to-protected' }));
    await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('running'));

    const second = await kit.service.dispatch(
      input(kit.dir, { dedupeKey: 'plain-to-protected' }),
      undefined,
      'capability-a',
      childGrant('grant-a'),
    );

    expect(second).toMatchObject({ deduplicated: false, worker: { id: 'wrk-2' } });
    expect(second.worker.id).not.toBe(first.worker.id);
    expect(second.worker).not.toHaveProperty('rulesPackChildGrantDigest');
    await vi.waitFor(() => expect(kit.runner.launches).toHaveLength(2));
    expect(kit.store.getRulesPackChildGrant(second.worker.id)).toBeDefined();

    const third = await kit.service.dispatch(input(kit.dir, { dedupeKey: 'plain-to-protected' }));
    expect(third).toMatchObject({
      deduplicated: true,
      retriedTerminal: false,
      worker: { id: first.worker.id, status: 'running' },
    });
    expect(kit.runner.launches).toHaveLength(2);
  });

  it('dispatches a plain worker instead of deduplicating to a completed protected worker', async () => {
    const kit = makeGrantKit();
    const dedupePolicy = { completedTtlMs: 1_000, retryTerminal: false };
    const first = await kit.service.dispatch(
      input(kit.dir, { dedupeKey: 'protected-to-plain', dedupePolicy }),
      undefined,
      'capability-a',
      childGrant('grant-a'),
    );
    await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('running'));
    kit.runner.complete(4_000, SUCCESS_RESULT);
    await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('completed'));

    const second = await kit.service.dispatch(input(kit.dir, { dedupeKey: 'protected-to-plain', dedupePolicy }));

    expect(second).toMatchObject({ deduplicated: false, retriedTerminal: false, worker: { id: 'wrk-2' } });
    expect(kit.store.getRulesPackChildGrant(second.worker.id)).toBeUndefined();
    await vi.waitFor(() => expect(kit.runner.launches).toHaveLength(2));
  });

  it('dispatches a new worker when the verified RulesPack grant digest changes', async () => {
    const kit = makeGrantKit();
    const grantA = childGrant('grant-a');
    const first = await kit.service.dispatch(
      input(kit.dir, { dedupeKey: 'grant-change' }),
      undefined,
      'capability-a',
      grantA,
    );
    await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('running'));

    const second = await kit.service.dispatch(
      input(kit.dir, { dedupeKey: 'grant-change' }),
      undefined,
      'capability-b',
      childGrant('grant-b'),
    );

    expect(second).toMatchObject({ deduplicated: false, worker: { id: 'wrk-2' } });
    expect(second.worker.id).not.toBe(first.worker.id);
    await vi.waitFor(() => expect(kit.runner.launches).toHaveLength(2));
    expect(kit.store.getRulesPackChildGrant(second.worker.id)?.digest).not.toBe(
      kit.store.getRulesPackChildGrant(first.worker.id)?.digest,
    );

    const third = await kit.service.dispatch(
      input(kit.dir, { dedupeKey: 'grant-change' }),
      undefined,
      'capability-a',
      grantA,
    );
    expect(third).toMatchObject({
      deduplicated: true,
      retriedTerminal: false,
      worker: { id: first.worker.id, status: 'running' },
    });
    expect(kit.runner.launches).toHaveLength(2);
  });

  it('reuses a completed plain worker after dispatching a newer granted worker with the same key', async () => {
    const kit = makeGrantKit();
    const dispatchInput = input(kit.dir, {
      dedupeKey: 'plain-grant-plain-completed',
      dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
    });
    const first = await kit.service.dispatch(dispatchInput);
    await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('running'));
    kit.runner.complete(4_000, SUCCESS_RESULT);
    await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('completed'));

    const second = await kit.service.dispatch(dispatchInput, undefined, 'capability-a', childGrant('grant-a'));
    await vi.waitFor(() => expect(kit.store.require(second.worker.id).status).toBe('running'));
    const third = await kit.service.dispatch(dispatchInput);

    expect(third).toMatchObject({
      deduplicated: true,
      retriedTerminal: false,
      worker: { id: first.worker.id, status: 'completed' },
    });
    expect(kit.runner.launches).toHaveLength(2);
    expect(kit.store.listScope(PM_PRINCIPAL.botName, PM_PRINCIPAL.chatId, 10)).toHaveLength(2);
  });

  it('reuses completed grant A after dispatching a newer grant B worker with the same key', async () => {
    const kit = makeGrantKit();
    const dispatchInput = input(kit.dir, {
      dedupeKey: 'grant-a-b-a-completed',
      dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
    });
    const grantA = childGrant('grant-a');
    const first = await kit.service.dispatch(dispatchInput, undefined, 'capability-a', grantA);
    await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('running'));
    kit.runner.complete(4_000, SUCCESS_RESULT);
    await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('completed'));

    const second = await kit.service.dispatch(dispatchInput, undefined, 'capability-b', childGrant('grant-b'));
    await vi.waitFor(() => expect(kit.store.require(second.worker.id).status).toBe('running'));
    const third = await kit.service.dispatch(dispatchInput, undefined, 'capability-a', grantA);

    expect(third).toMatchObject({
      deduplicated: true,
      retriedTerminal: false,
      worker: { id: first.worker.id, status: 'completed' },
    });
    expect(kit.runner.launches).toHaveLength(2);
    expect(kit.store.listScope(PM_PRINCIPAL.botName, PM_PRINCIPAL.chatId, 10)).toHaveLength(2);
  });

  it.each(['running', 'completed'] as const)(
    'deduplicates to a %s protected worker when the verified RulesPack grant digest matches',
    async (status) => {
      const kit = makeGrantKit();
      const grant = childGrant('grant-a');
      const dispatchInput = input(kit.dir, {
        dedupeKey: `same-grant-${status}`,
        dedupePolicy: { completedTtlMs: 1_000, retryTerminal: false },
      });
      const first = await kit.service.dispatch(dispatchInput, undefined, 'capability-a', grant);
      await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('running'));
      if (status === 'completed') {
        kit.runner.complete(4_000, SUCCESS_RESULT);
        await vi.waitFor(() => expect(kit.store.require(first.worker.id).status).toBe('completed'));
      }

      const second = await kit.service.dispatch(dispatchInput, undefined, 'capability-a', grant);

      expect(second).toMatchObject({
        deduplicated: true,
        retriedTerminal: false,
        worker: { id: first.worker.id, status },
      });
      expect(second.worker).not.toHaveProperty('rulesPackChildGrantJson');
      expect(second.worker).not.toHaveProperty('rulesPackChildGrantDigest');
      expect(kit.runner.launches).toHaveLength(1);
      expect(kit.store.listScope(PM_PRINCIPAL.botName, PM_PRINCIPAL.chatId, 10)).toHaveLength(1);
    },
  );

  it('aborts an owned live launch and ignores its late successful completion', async () => {
    const kit = makeKit();
    const dispatched = await kit.service.dispatch(input(kit.dir));
    await vi.waitFor(() => expect(kit.store.require(dispatched.worker.id).status).toBe('running'));

    const aborted = await kit.service.abort(dispatched.worker.id);
    kit.runner.complete(4_000, SUCCESS_RESULT);
    await Promise.resolve();

    expect(aborted.status).toBe('aborted');
    expect(kit.runner.aborts).toEqual([4_000]);
    expect(kit.store.require(dispatched.worker.id).status).toBe('aborted');
  });

  it('aborts queued work and kills only the just-created process if spawn finishes late', async () => {
    const kit = makeKit();
    kit.runner.holdLaunch();
    const dispatched = await kit.service.dispatch(input(kit.dir));
    expect((await kit.service.abort(dispatched.worker.id)).status).toBe('aborted');

    kit.runner.releaseLaunch();
    await vi.waitFor(() => expect(kit.runner.aborts).toEqual([4_000]));
    expect(kit.store.require(dispatched.worker.id).status).toBe('aborted');
  });

  it('applies a default idle timeout so a silent worker cannot hold quota forever', async () => {
    const kit = makeKit({ defaultTimeoutMs: 1_000, defaultIdleTimeoutMs: 20 });
    const dispatched = await kit.service.dispatch(input(kit.dir));
    await vi.waitFor(() => expect(kit.store.require(dispatched.worker.id).status).toBe('timed_out'), {
      timeout: 1_000,
    });

    expect(kit.store.require(dispatched.worker.id).terminalReason).toBe('idle_timeout');
    expect(kit.runner.aborts).toEqual([4_000]);
  });
});

describe('WorkerService restart recovery', () => {
  it('re-verifies and reuses the private RulesPack grant for an idempotent relaunch', async () => {
    const { store, dir } = makeStore();
    const grant = {
      schemaVersion: 1,
      purpose: 'worker',
      grantId: 'persisted-grant',
      capabilityDigest: 'sha256:capability',
      issuedAt: '2026-08-19T00:00:00.000Z',
      expiresAt: '2026-08-19T01:00:00.000Z',
      depth: 1,
      parentEnvelopeFingerprint: 'sha256:parent',
      parent: { envelopeId: 'parent-envelope' },
      constraints: { hostId: 'imac', bot: 'bot-a', chatId: 'chat-a' },
      signature: { scheme: 'ed25519', value: 'verified-signature' },
    } as unknown as RulesPackChildGrantV1;
    const prepared = () => ({
      injectionText: 'received policy',
      packDigest: 'sha256:pack',
      markInjected() {},
      markRejected() {},
    });
    const firstRunner = new FakeProcessRunner();
    const firstPrepare = vi.fn(async () => prepared());
    const verify = vi.fn((value: RulesPackChildGrantV1) => value);
    const first = new WorkerService(store, firstRunner, new RecordingNotifier(), PM_PRINCIPAL, testConfig(), {
      makeId: () => 'wrk-granted-relaunch',
      makeLaunchId: () => 'launch-first',
      rulesPackProvider: { prepare: firstPrepare },
      rulesPackGrantVerifier: verify,
    });
    services.push(first);
    const dispatched = await first.dispatch(input(dir, {
      recoveryPolicy: { restart: 'relaunch', idempotent: true },
    }), undefined, 'persisted-capability', grant);
    await vi.waitFor(() => expect(store.require(dispatched.worker.id).status).toBe('running'));
    expect(firstPrepare).toHaveBeenCalledWith(expect.objectContaining({ id: dispatched.worker.id }), grant);
    first.dispose();

    const recoveredRunner = new FakeProcessRunner();
    const recoveredPrepare = vi.fn(async () => prepared());
    const recovered = new WorkerService(
      store,
      recoveredRunner,
      new RecordingNotifier(),
      PM_PRINCIPAL,
      testConfig(),
      {
        makeLaunchId: () => 'launch-recovered',
        rulesPackProvider: { prepare: recoveredPrepare },
        rulesPackGrantVerifier: verify,
      },
    );
    services.push(recovered);
    await recovered.start();
    await vi.waitFor(() => expect(store.require(dispatched.worker.id)).toMatchObject({
      status: 'running', launchId: 'launch-recovered', recoveryCount: 1,
    }));
    expect(recoveredPrepare).toHaveBeenCalledWith(expect.objectContaining({ id: dispatched.worker.id }), grant);
    expect(store.require(dispatched.worker.id)).not.toHaveProperty('rulesPackChildGrantJson');
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('marks an ambiguous persisted running launch recovery_required and never signals its numeric PID', async () => {
    const kit = makeKit();
    seedRunning(kit.store, kit.dir, 'wrk-old', 8_001, { restart: 'manual', idempotent: false });

    await kit.service.start();

    expect(kit.runner.launches).toHaveLength(0);
    expect(kit.runner.aborts).toHaveLength(0);
    expect(kit.store.require('wrk-old')).toMatchObject({
      status: 'recovery_required',
      terminalReason: 'ambiguous_restart',
    });
  });

  it('relaunches only when that run explicitly declares idempotent restart recovery', async () => {
    const kit = makeKit();
    seedRunning(kit.store, kit.dir, 'wrk-old', 8_001, { restart: 'relaunch', idempotent: true });

    await kit.service.start();
    await vi.waitFor(() => {
      expect(kit.store.require('wrk-old')).toMatchObject({
        status: 'running',
        pid: 4_000,
        launchId: 'launch-1',
        recoveryCount: 1,
      });
    });

    expect(kit.runner.aborts).not.toContain(8_001);
    expect(kit.runner.launches).toHaveLength(1);
  });
});

describe('WorkerService durable notifications', () => {
  it('marks ARC-internal worker notifications delivered without calling the Bridge', async () => {
    const { store, dir } = makeStore();
    const runner = new FakeProcessRunner();
    const notifier = new RecordingNotifier();
    const service = new WorkerService(store, runner, notifier, ARC_SERVICE_PRINCIPAL, testConfig(), {
      makeId: () => 'wrk-arc-internal',
      makeLaunchId: () => 'launch-arc-internal',
    });
    services.push(service);

    const dispatched = await service.dispatch(input(dir), undefined, 'arc-service-capability');
    await vi.waitFor(() => expect(store.require(dispatched.worker.id).status).toBe('running'));
    runner.complete(4_000, SUCCESS_RESULT);

    await vi.waitFor(() => {
      expect(store.require(dispatched.worker.id)).toMatchObject({
        status: 'completed',
        notificationState: 'delivered',
      });
    });
    expect(notifier.notifications).toHaveLength(0);
  });

  it('delivers a small metadata-only callback when stored output exceeds the Bridge request limit', async () => {
    const { store, dir } = makeStore();
    const runner = new FakeProcessRunner();
    const signingKeys = generateKeyPairSync('ed25519');
    const requests: Array<{ body: string; signature: string }> = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      requests.push({
        body: init?.body as string,
        signature: headers['x-metabot-callback-signature'],
      });
      return new Response(null, { status: 204 });
    });
    const notifier = new HttpCompletionNotifier({
      url: 'http://127.0.0.1/worker-events',
      signingKey: signingKeys.privateKey,
      fetchImpl,
      now: () => 10_000,
    });
    const service = new WorkerService(store, runner, notifier, PM_PRINCIPAL, testConfig(), {
      makeId: () => 'wrk-large-output',
      makeLaunchId: () => 'launch-large-output',
    });
    services.push(service);
    const stdout = `STDOUT_SENTINEL:${'o'.repeat(300_000)}`;
    const stderr = `STDERR_SENTINEL:${'e'.repeat(300_000)}`;

    const dispatched = await service.dispatch(
      input(dir, {
        prompt: 'PROMPT_SENTINEL',
        model: 'MODEL_SENTINEL',
        label: 'bounded terminal callback',
        outputContract: { format: 'text', description: 'CONTRACT_SENTINEL' },
      }),
      undefined,
      'signed-worker-capability',
    );
    await vi.waitFor(() => expect(store.require(dispatched.worker.id).status).toBe('running'));
    runner.complete(4_000, {
      exitCode: 1,
      stdout,
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      error: 'ERROR_SENTINEL',
    });

    await vi.waitFor(() => expect(store.require(dispatched.worker.id).notificationState).toBe('delivered'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(Buffer.byteLength(request.body, 'utf8')).toBeLessThan(WORKER_TERMINAL_CALLBACK_MAX_BYTES);
    expect(Buffer.byteLength(request.body, 'utf8')).toBeLessThan(256 * 1_024);
    expect(request.body).not.toContain('STDOUT_SENTINEL');
    expect(request.body).not.toContain('STDERR_SENTINEL');
    expect(request.body).not.toContain('PROMPT_SENTINEL');
    expect(request.body).not.toContain('MODEL_SENTINEL');
    expect(request.body).not.toContain('CONTRACT_SENTINEL');
    expect(request.body).not.toContain('ERROR_SENTINEL');
    expect(request.body).not.toContain(dir);
    expect(verifyTerminalCallback(request.body, request.signature, signingKeys.publicKey)).toBe(true);
    const envelope = JSON.parse(request.body) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      purpose: 'worker.terminal',
      event_id: 'worker:wrk-large-output:terminal:v1',
      bot_name: 'bot-a',
      chat_id: 'chat-a',
      status: 'failed',
      finished_at: expect.any(Number),
      authorizing_capability: 'signed-worker-capability',
    });
    expect(envelope.payload).toEqual({
      id: 'wrk-large-output',
      label: 'bounded terminal callback',
      engine: 'codex',
      status: 'failed',
      exitCode: 1,
      durationMs: expect.any(Number),
    });
    expect(service.status(dispatched.worker.id)).toMatchObject({ stdout, stderr, error: 'ERROR_SENTINEL' });
  });

  it('retries in-process with bounded backoff and the same stable event id', async () => {
    const kit = makeKit({ notificationRetryInitialMs: 10, notificationRetryMaxMs: 20 });
    kit.notifier.error = new Error('callback unavailable');
    const dispatched = await kit.service.dispatch(input(kit.dir));
    await vi.waitFor(() => expect(kit.store.require(dispatched.worker.id).status).toBe('running'));
    kit.runner.complete(4_000, SUCCESS_RESULT);
    await vi.waitFor(() => expect(kit.store.require(dispatched.worker.id).notificationState).toBe('failed'));

    kit.notifier.error = undefined;
    await vi.waitFor(() => expect(kit.store.require(dispatched.worker.id).notificationState).toBe('delivered'), {
      timeout: 1_000,
    });

    expect(kit.notifier.notifications.length).toBeGreaterThanOrEqual(2);
    expect(new Set(kit.notifier.notifications.map((item) => item.eventId))).toEqual(
      new Set([`worker:${dispatched.worker.id}:terminal:v1`]),
    );
    expect(kit.store.require(dispatched.worker.id).notificationAttempts).toBeGreaterThanOrEqual(2);
  });

  it('resumes a persisted retry deadline after the service is recreated', async () => {
    const kit = makeKit({ notificationRetryInitialMs: 25, notificationRetryMaxMs: 25 });
    kit.notifier.error = new Error('callback unavailable');
    const dispatched = await kit.service.dispatch(input(kit.dir), undefined, 'persisted-worker-capability');
    await vi.waitFor(() => expect(kit.store.require(dispatched.worker.id).status).toBe('running'));
    kit.runner.complete(4_000, SUCCESS_RESULT);
    await vi.waitFor(() => expect(kit.store.require(dispatched.worker.id).notificationState).toBe('failed'));
    const eventId = kit.notifier.notifications[0]?.eventId;

    kit.service.dispose();
    const resumedNotifier = new RecordingNotifier();
    const resumedService = new WorkerService(
      kit.store,
      new FakeProcessRunner(),
      resumedNotifier,
      PM_PRINCIPAL,
      testConfig({ notificationRetryInitialMs: 25, notificationRetryMaxMs: 25 }),
    );
    services.push(resumedService);
    await resumedService.start();

    await vi.waitFor(() => expect(kit.store.require(dispatched.worker.id).notificationState).toBe('delivered'), {
      timeout: 1_000,
    });
    expect(resumedNotifier.notifications).toHaveLength(1);
    expect(resumedNotifier.notifications[0]?.eventId).toBe(eventId);
    expect(resumedNotifier.notifications[0]?.authorizingCapability).toBe('persisted-worker-capability');
  });
});

function makeKit(config: Partial<Parameters<typeof testConfig>[0]> = {}) {
  const { store, dir } = makeStore();
  const runner = new FakeProcessRunner();
  const notifier = new RecordingNotifier();
  let id = 0;
  let launchId = 0;
  const service = new WorkerService(store, runner, notifier, PM_PRINCIPAL, testConfig(config), {
    makeId: () => `wrk-${++id}`,
    makeLaunchId: () => `launch-${++launchId}`,
  });
  services.push(service);
  return { dir, store, runner, notifier, service };
}

function makeGrantKit() {
  const { store, dir } = makeStore();
  const runner = new FakeProcessRunner();
  const notifier = new RecordingNotifier();
  let id = 0;
  let launchId = 0;
  const service = new WorkerService(store, runner, notifier, PM_PRINCIPAL, testConfig(), {
    makeId: () => `wrk-${++id}`,
    makeLaunchId: () => `launch-${++launchId}`,
    rulesPackGrantVerifier: (value) => value,
  });
  services.push(service);
  return { dir, store, runner, notifier, service };
}

function makeStore(): { store: WorkerStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-service-'));
  dirs.push(dir);
  const store = new WorkerStore(path.join(dir, 'state', 'workers.sqlite'));
  stores.push(store);
  return { store, dir };
}

function testConfig(patch: Record<string, number> = {}) {
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
    ...patch,
  };
}

function input(dir: string, patch: Partial<DispatchWorkerInput> = {}): DispatchWorkerInput {
  return { workdir: dir, prompt: 'implement the task', engine: 'codex', ...patch };
}

function childGrant(grantId: string): RulesPackChildGrantV1 {
  return {
    schemaVersion: 1,
    purpose: 'worker',
    grantId,
    capabilityDigest: `sha256:${grantId}`,
    issuedAt: '2026-08-19T00:00:00.000Z',
    expiresAt: '2026-08-19T01:00:00.000Z',
    depth: 1,
    parentEnvelopeFingerprint: 'sha256:parent',
    parent: { envelopeId: 'parent-envelope' },
    constraints: { hostId: 'imac', bot: 'bot-a', chatId: 'chat-a' },
    signature: { scheme: 'ed25519', value: 'verified-signature' },
  } as unknown as RulesPackChildGrantV1;
}

function scopedInput(dir: string, patch: Partial<ScopedDispatchWorkerInput> = {}): ScopedDispatchWorkerInput {
  return {
    botName: 'bot-a',
    chatId: 'chat-a',
    workdir: dir,
    prompt: 'implement the task',
    engine: 'codex',
    dedupePolicy: { completedTtlMs: 1_000, retryTerminal: true },
    timeoutMs: 1_000,
    idleTimeoutMs: 500,
    recoveryPolicy: { restart: 'manual', idempotent: false },
    ...patch,
  };
}

function seedRunning(
  store: WorkerStore,
  dir: string,
  id: string,
  pid: number,
  recoveryPolicy: ScopedDispatchWorkerInput['recoveryPolicy'],
): void {
  store.createWorker(id, scopedInput(dir, { recoveryPolicy }), 2, Date.now() - 1_000);
  store.markRunning(id, 'old-launch', pid, Date.now() - 900, false);
}
