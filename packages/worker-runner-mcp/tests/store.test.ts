import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { WorkerStore } from '../src/store.js';
import type { ScopedDispatchWorkerInput } from '../src/types.js';
import { WorkerRunnerError } from '../src/types.js';

const dirs: string[] = [];
const stores: WorkerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WorkerStore', () => {
  it('persists queued before spawn and requires a launch identity for running/terminal transitions', () => {
    const { store, dir } = makeStore();
    const created = store.createWorker('wrk-1', input(dir), 2, 100);
    expect(created.worker.status).toBe('queued');
    expect(created.worker).not.toHaveProperty('launchId');
    expect(created.worker).not.toHaveProperty('pid');

    const running = store.markRunning('wrk-1', 'launch-1', 123, 110, false);
    expect(running).toMatchObject({ status: 'running', launchId: 'launch-1', pid: 123, launchCount: 1 });
    expect(
      store.markTerminal('wrk-1', {
        status: 'completed',
        expectedStatus: 'running',
        expectedLaunchId: 'wrong-launch',
        finishedAt: 150,
        terminalReason: 'process_exit',
      }),
    ).toBeUndefined();

    const terminal = store.markTerminal('wrk-1', {
      status: 'failed',
      expectedStatus: 'running',
      expectedLaunchId: 'launch-1',
      finishedAt: 160,
      exitCode: 2,
      terminalReason: 'process_error',
      stdout: 'partial output',
      stderr: 'bad command',
      stderrTruncated: true,
      error: 'bad command',
    });
    expect(terminal).toMatchObject({
      status: 'failed',
      durationMs: 50,
      exitCode: 2,
      stdout: 'partial output',
      stderrTruncated: true,
      notificationState: 'pending',
      notificationNextAttemptAt: 160,
    });
    expect(terminal).not.toHaveProperty('launchId');
    expect(terminal).not.toHaveProperty('pid');
  });

  it('atomically counts queued and running jobs in the per-bot+chat quota', () => {
    const { store, dir } = makeStore();
    store.createWorker('wrk-1', input(dir), 1, 100);
    expect(() => store.createWorker('wrk-2', input(dir), 1, 101)).toThrowError(
      expect.objectContaining<Partial<WorkerRunnerError>>({ code: 'CONCURRENCY_LIMIT' }),
    );

    const other = store.createWorker('wrk-3', input(dir, { chatId: 'chat-b' }), 1, 102);
    expect(other.worker.status).toBe('queued');
  });

  it('persists callback authorization privately across store restart', () => {
    const { store, dir } = makeStore();
    store.createWorker(
      'wrk-private-capability',
      input(dir, { authorizingCapability: 'signed-worker-capability' }),
      2,
      100,
    );
    expect(store.require('wrk-private-capability')).not.toHaveProperty('authorizingCapability');
    store.close();
    const reopened = new WorkerStore(path.join(dir, 'state', 'workers.sqlite'));
    stores.push(reopened);
    expect(reopened.getAuthorizingCapability('wrk-private-capability')).toBe('signed-worker-capability');
    expect(reopened.require('wrk-private-capability')).not.toHaveProperty('authorizingCapability');
  });

  it('persists a RulesPack child grant privately without surfacing it in WorkerRecord', () => {
    const { store, dir } = makeStore();
    store.createWorker('wrk-private-grant', input(dir, {
      rulesPackChildGrantJson: '{"grantId":"private-grant"}',
      rulesPackChildGrantDigest: 'sha256:private-grant',
    }), 2, 100);
    expect(store.require('wrk-private-grant')).not.toHaveProperty('rulesPackChildGrantJson');
    expect(store.getRulesPackChildGrant('wrk-private-grant')).toEqual({
      json: '{"grantId":"private-grant"}',
      digest: 'sha256:private-grant',
    });
    store.close();
    const reopened = new WorkerStore(path.join(dir, 'state', 'workers.sqlite'));
    stores.push(reopened);
    expect(reopened.getRulesPackChildGrant('wrk-private-grant')).toEqual({
      json: '{"grantId":"private-grant"}',
      digest: 'sha256:private-grant',
    });
    expect(reopened.require('wrk-private-grant')).not.toHaveProperty('rulesPackChildGrantDigest');
  });

  it('marks legacy rows without identity evidence unknown instead of defaulting them to ordinary workers', () => {
    const { store, dir } = makeStore();
    store.createWorker('legacy-row', input(dir), 2, 100);
    store.close();
    const filename = path.join(dir, 'state', 'workers.sqlite');
    const raw = new Database(filename);
    raw.prepare('UPDATE worker_jobs SET principal_role = NULL, execution_kind = NULL WHERE id = ?').run('legacy-row');
    raw.close();
    const reopened = new WorkerStore(filename);
    stores.push(reopened);
    expect(reopened.require('legacy-row')).toMatchObject({
      principalRole: 'unknown',
      executionKind: 'unknown',
    });
  });

  it('reuses successful dedupe keys only within TTL and retries terminal failures by policy', () => {
    const { store, dir } = makeStore();
    const firstInput = input(dir, { dedupeKey: 'same', dedupePolicy: { completedTtlMs: 100, retryTerminal: true } });
    store.createWorker('wrk-1', firstInput, 2, 0);
    store.markRunning('wrk-1', 'launch-1', 100, 1, false);
    store.markTerminal('wrk-1', {
      status: 'completed',
      expectedStatus: 'running',
      expectedLaunchId: 'launch-1',
      finishedAt: 10,
      terminalReason: 'process_exit',
    });

    expect(store.createWorker('wrk-2', firstInput, 2, 50)).toMatchObject({
      deduplicated: true,
      worker: { id: 'wrk-1' },
    });
    expect(store.createWorker('wrk-3', firstInput, 2, 110)).toMatchObject({
      deduplicated: false,
      retriedTerminal: true,
      worker: { id: 'wrk-3', status: 'queued' },
    });

    store.markTerminal('wrk-3', {
      status: 'failed',
      expectedStatus: 'queued',
      finishedAt: 120,
      terminalReason: 'spawn_error',
    });
    expect(store.createWorker('wrk-4', firstInput, 2, 121)).toMatchObject({
      deduplicated: false,
      retriedTerminal: true,
      worker: { id: 'wrk-4' },
    });
  });

  it('creates a protected job instead of reusing a running plain job with the same dedupe key', () => {
    const { store, dir } = makeStore();
    const plain = input(dir, { dedupeKey: 'plain-to-protected' });
    store.createWorker('wrk-plain', plain, 2, 0);
    store.markRunning('wrk-plain', 'launch-plain', 100, 1, false);

    const created = store.createWorker(
      'wrk-protected',
      input(dir, {
        dedupeKey: 'plain-to-protected',
        rulesPackChildGrantJson: '{"grantId":"grant-a"}',
        rulesPackChildGrantDigest: 'sha256:grant-a',
      }),
      2,
      2,
    );

    expect(created).toMatchObject({
      deduplicated: false,
      retriedTerminal: false,
      worker: { id: 'wrk-protected', status: 'queued' },
    });
    expect(created.worker).not.toHaveProperty('rulesPackChildGrantDigest');
    expect(store.getRulesPackChildGrant('wrk-protected')).toEqual({
      json: '{"grantId":"grant-a"}',
      digest: 'sha256:grant-a',
    });
    expect(store.createWorker('wrk-unused-plain', plain, 2, 3)).toMatchObject({
      deduplicated: true,
      retriedTerminal: false,
      worker: { id: 'wrk-plain', status: 'running' },
    });
  });

  it('creates a plain job instead of reusing a completed protected job with the same dedupe key', () => {
    const { store, dir } = makeStore();
    const protectedInput = input(dir, {
      dedupeKey: 'protected-to-plain',
      dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
      rulesPackChildGrantJson: '{"grantId":"grant-a"}',
      rulesPackChildGrantDigest: 'sha256:grant-a',
    });
    store.createWorker('wrk-protected', protectedInput, 2, 0);
    store.markRunning('wrk-protected', 'launch-protected', 100, 1, false);
    store.markTerminal('wrk-protected', {
      status: 'completed',
      expectedStatus: 'running',
      expectedLaunchId: 'launch-protected',
      finishedAt: 2,
      terminalReason: 'process_exit',
    });

    const created = store.createWorker(
      'wrk-plain',
      input(dir, {
        dedupeKey: 'protected-to-plain',
        dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
      }),
      2,
      10_000,
    );

    expect(created).toMatchObject({
      deduplicated: false,
      retriedTerminal: false,
      worker: { id: 'wrk-plain', status: 'queued' },
    });
    expect(store.getRulesPackChildGrant('wrk-plain')).toBeUndefined();
  });

  it('creates a new running-scope job when the RulesPack grant digest changes', () => {
    const { store, dir } = makeStore();
    const grantA = input(dir, {
      dedupeKey: 'grant-change',
      rulesPackChildGrantJson: '{"grantId":"grant-a"}',
      rulesPackChildGrantDigest: 'sha256:grant-a',
    });
    store.createWorker('wrk-grant-a', grantA, 2, 0);
    store.markRunning('wrk-grant-a', 'launch-grant-a', 100, 1, false);

    const created = store.createWorker(
      'wrk-grant-b',
      input(dir, {
        dedupeKey: 'grant-change',
        rulesPackChildGrantJson: '{"grantId":"grant-b"}',
        rulesPackChildGrantDigest: 'sha256:grant-b',
      }),
      2,
      2,
    );

    expect(created).toMatchObject({
      deduplicated: false,
      retriedTerminal: false,
      worker: { id: 'wrk-grant-b', status: 'queued' },
    });
    expect(store.getRulesPackChildGrant('wrk-grant-b')?.digest).toBe('sha256:grant-b');
    expect(store.createWorker('wrk-unused-grant-a', grantA, 2, 3)).toMatchObject({
      deduplicated: true,
      retriedTerminal: false,
      worker: { id: 'wrk-grant-a', status: 'running' },
    });
  });

  it('reuses the completed plain identity after a newer granted job with the same dedupe key', () => {
    const { store, dir } = makeStore();
    const plain = input(dir, {
      dedupeKey: 'plain-grant-plain-completed',
      dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
    });
    store.createWorker('wrk-plain', plain, 2, 0);
    store.markRunning('wrk-plain', 'launch-plain', 100, 1, false);
    store.markTerminal('wrk-plain', {
      status: 'completed',
      expectedStatus: 'running',
      expectedLaunchId: 'launch-plain',
      finishedAt: 2,
      terminalReason: 'process_exit',
    });
    store.createWorker(
      'wrk-granted',
      input(dir, {
        dedupeKey: 'plain-grant-plain-completed',
        dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
        rulesPackChildGrantJson: '{"grantId":"grant-a"}',
        rulesPackChildGrantDigest: 'sha256:grant-a',
      }),
      2,
      3,
    );

    expect(store.createWorker('wrk-unused-plain', plain, 2, 10_000)).toMatchObject({
      deduplicated: true,
      retriedTerminal: false,
      worker: { id: 'wrk-plain', status: 'completed' },
    });
  });

  it('reuses completed grant A after a newer grant B job with the same dedupe key', () => {
    const { store, dir } = makeStore();
    const grantA = input(dir, {
      dedupeKey: 'grant-a-b-a-completed',
      dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
      rulesPackChildGrantJson: '{"grantId":"grant-a"}',
      rulesPackChildGrantDigest: 'sha256:grant-a',
    });
    store.createWorker('wrk-grant-a', grantA, 2, 0);
    store.markRunning('wrk-grant-a', 'launch-grant-a', 100, 1, false);
    store.markTerminal('wrk-grant-a', {
      status: 'completed',
      expectedStatus: 'running',
      expectedLaunchId: 'launch-grant-a',
      finishedAt: 2,
      terminalReason: 'process_exit',
    });
    store.createWorker(
      'wrk-grant-b',
      input(dir, {
        dedupeKey: 'grant-a-b-a-completed',
        dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
        rulesPackChildGrantJson: '{"grantId":"grant-b"}',
        rulesPackChildGrantDigest: 'sha256:grant-b',
      }),
      2,
      3,
    );

    expect(store.createWorker('wrk-unused-grant-a', grantA, 2, 10_000)).toMatchObject({
      deduplicated: true,
      retriedTerminal: false,
      worker: { id: 'wrk-grant-a', status: 'completed' },
    });
  });

  it.each(['running', 'completed'] as const)(
    'reuses a %s job only when its RulesPack grant digest matches',
    (status) => {
      const { store, dir } = makeStore();
      const protectedInput = input(dir, {
        dedupeKey: `same-grant-${status}`,
        dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
        rulesPackChildGrantJson: '{"grantId":"grant-a"}',
        rulesPackChildGrantDigest: 'sha256:grant-a',
      });
      store.createWorker('wrk-grant-a', protectedInput, 2, 0);
      store.markRunning('wrk-grant-a', 'launch-grant-a', 100, 1, false);
      if (status === 'completed') {
        store.markTerminal('wrk-grant-a', {
          status: 'completed',
          expectedStatus: 'running',
          expectedLaunchId: 'launch-grant-a',
          finishedAt: 2,
          terminalReason: 'process_exit',
        });
      }

      const reused = store.createWorker('wrk-unused', protectedInput, 2, 10_000);

      expect(reused).toMatchObject({
        deduplicated: true,
        retriedTerminal: false,
        worker: { id: 'wrk-grant-a', status },
      });
      expect(reused.worker).not.toHaveProperty('rulesPackChildGrantDigest');
    },
  );

  it('can intentionally reuse a terminal failure when retryTerminal is false', () => {
    const { store, dir } = makeStore();
    const noRetry = input(dir, {
      dedupeKey: 'no-retry',
      dedupePolicy: { completedTtlMs: 100, retryTerminal: false },
    });
    store.createWorker('wrk-1', noRetry, 2, 0);
    store.markTerminal('wrk-1', {
      status: 'failed',
      expectedStatus: 'queued',
      finishedAt: 1,
      terminalReason: 'spawn_error',
    });

    expect(store.createWorker('wrk-2', noRetry, 2, 2)).toMatchObject({
      deduplicated: true,
      worker: { id: 'wrk-1', status: 'failed' },
    });
  });

  it('durably reuses a completed key beyond its TTL when retryTerminal is false', () => {
    const { store, dir } = makeStore();
    const noRetry = input(dir, {
      dedupeKey: 'arc:v1:project:run',
      dedupePolicy: { completedTtlMs: 1, retryTerminal: false },
    });
    store.createWorker('wrk-1', noRetry, 2, 0);
    store.markRunning('wrk-1', 'launch-1', 100, 1, false);
    store.markTerminal('wrk-1', {
      status: 'completed',
      expectedStatus: 'running',
      expectedLaunchId: 'launch-1',
      finishedAt: 2,
      terminalReason: 'process_exit',
    });

    expect(store.createWorker('wrk-2', noRetry, 2, 10_000)).toMatchObject({
      deduplicated: true,
      worker: { id: 'wrk-1', status: 'completed' },
    });
  });

  it.each(['failed', 'aborted', 'timed_out', 'recovery_required'] as const)(
    'allows a dedupe retry after %s when retryTerminal is enabled',
    (status) => {
      const { store, dir } = makeStore();
      const retry = input(dir, {
        dedupeKey: `retry-${status}`,
        dedupePolicy: { completedTtlMs: 100, retryTerminal: true },
      });
      store.createWorker('wrk-1', retry, 2, 0);
      if (status === 'recovery_required') {
        store.markRecoveryRequired('wrk-1', 1, 'ambiguous launch');
      } else {
        store.markTerminal('wrk-1', {
          status,
          expectedStatus: 'queued',
          finishedAt: 1,
          terminalReason: 'test_terminal',
        });
      }

      expect(store.createWorker('wrk-2', retry, 2, 2)).toMatchObject({
        deduplicated: false,
        retriedTerminal: true,
        worker: { id: 'wrk-2', status: 'queued' },
      });
    },
  );
});

function makeStore(): { store: WorkerStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-store-'));
  dirs.push(dir);
  const store = new WorkerStore(path.join(dir, 'state', 'workers.sqlite'));
  stores.push(store);
  return { store, dir };
}

function input(dir: string, patch: Partial<ScopedDispatchWorkerInput> = {}): ScopedDispatchWorkerInput {
  return {
    botName: 'bot-a',
    chatId: 'chat-a',
    workdir: dir,
    prompt: 'do the task',
    engine: 'codex',
    dedupePolicy: { completedTtlMs: 100, retryTerminal: true },
    timeoutMs: 1_000,
    idleTimeoutMs: 500,
    recoveryPolicy: { restart: 'manual', idempotent: false },
    ...patch,
  };
}
