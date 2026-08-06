import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerService } from '../src/service.js';
import { WorkerStore } from '../src/store.js';
import type { DispatchWorkerInput, ScopedDispatchWorkerInput, TrustedPrincipal } from '../src/types.js';
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

  it('rejects Team principals and roles outside admin/user/pm', () => {
    const { store } = makeStore();
    expect(
      () =>
        new WorkerService(store, new FakeProcessRunner(), new RecordingNotifier(), {
          role: 'pm',
          botName: 'bot-a',
          chatId: 'team:project:agent',
        }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(
      () =>
        new WorkerService(store, new FakeProcessRunner(), new RecordingNotifier(), {
          role: 'agent',
          botName: 'bot-a',
          chatId: 'chat-a',
        } as unknown as TrustedPrincipal),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
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
    const dispatched = await kit.service.dispatch(input(kit.dir));
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
    });
    expect(kit.notifier.notifications[0]?.worker).not.toHaveProperty('prompt');
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
    const dispatched = await kit.service.dispatch(input(kit.dir));
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
