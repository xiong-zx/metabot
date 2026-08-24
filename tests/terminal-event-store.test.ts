import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TerminalEventDeferredError,
  TerminalEventDispatcher,
  TerminalEventStore,
} from '../src/services/terminal-event-store.js';
import type { TerminalCallbackEnvelope } from '../src/api/routes/worker-events-routes.js';

const dirs: string[] = [];
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `metabot-${name}-`));
  dirs.push(dir);
  return join(dir, 'events.sqlite');
}

function envelope(eventId: string): TerminalCallbackEnvelope {
  return {
    contract_version: 'metabot.terminal-callback.v1',
    purpose: 'worker.terminal',
    event_id: eventId,
    bot_name: 'pm-codex',
    chat_id: 'chat-1',
    status: 'completed',
    finished_at: 10_000,
    iat: 10_000,
    authorizing_capability: 'retained-capability',
    payload: { worker: { id: 'worker-1' } },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal event state');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('terminal callback durable inbox', () => {
  it('replays a received row after restart and marks it woken', async () => {
    const dbPath = tempDb('terminal-replay');
    const first = new TerminalEventStore(logger, { dbPath });
    first.insert(envelope('event-replay'), 1_000);
    first.close();

    const reopened = new TerminalEventStore(logger, { dbPath });
    const wake = vi.fn(async () => {});
    const dispatcher = new TerminalEventDispatcher({
      store: reopened,
      logger,
      wake,
      sweepIntervalMs: 10_000,
    });
    dispatcher.start();
    await waitFor(() => reopened.get('event-replay')?.state === 'woken');

    expect(wake).toHaveBeenCalledTimes(1);
    expect(reopened.get('event-replay')).toMatchObject({ state: 'woken', attempts: 1 });
    dispatcher.stop();
    reopened.close();
  });

  it('reclaims an expired lease and absorbs a daemon retry without inserting twice', () => {
    const store = new TerminalEventStore(logger, {
      dbPath: tempDb('terminal-lease'),
      leaseMs: 100,
    });
    expect(store.insert(envelope('event-lease'), 1_000).inserted).toBe(true);
    expect(store.leaseNext(1_000)).toMatchObject({ state: 'leased', attempts: 1 });
    expect(store.insert(envelope('event-lease'), 1_050).inserted).toBe(false);
    expect(store.count()).toBe(1);
    expect(store.leaseNext(1_099)).toBeUndefined();
    expect(store.leaseNext(1_100)).toMatchObject({ state: 'leased', attempts: 2 });
    store.close();
  });

  it('reclaims an expired lease during a periodic sweep', async () => {
    const store = new TerminalEventStore(logger, {
      dbPath: tempDb('terminal-periodic'),
      leaseMs: 20,
    });
    store.insert(envelope('event-periodic'));
    expect(store.leaseNext()).toMatchObject({ state: 'leased', attempts: 1 });
    const wake = vi.fn(async () => {});
    const dispatcher = new TerminalEventDispatcher({
      store,
      logger,
      wake,
      sweepIntervalMs: 10,
    });
    dispatcher.start();
    await waitFor(() => store.get('event-periodic')?.state === 'woken');

    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.get('event-periodic')).toMatchObject({ state: 'woken', attempts: 2 });
    dispatcher.stop();
    store.close();
  });

  it('bounds repeated wake failures and leaves an operator-visible failed row', async () => {
    const store = new TerminalEventStore(logger, {
      dbPath: tempDb('terminal-failed'),
      maxAttempts: 2,
      backoffBaseMs: 0,
    });
    store.insert(envelope('event-failed'));
    const dispatcher = new TerminalEventDispatcher({
      store,
      logger,
      wake: vi.fn(async () => { throw new Error('wake failed'); }),
    });

    await dispatcher.sweep();

    expect(store.get('event-failed')).toMatchObject({
      state: 'failed',
      attempts: 2,
      lastError: 'wake failed',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-failed', attempts: 2 }),
      'Terminal callback wake exhausted its retry budget',
    );
    dispatcher.stop();
    store.close();
  });

  it('keeps a busy-chat wake durable without consuming the failure budget', async () => {
    const store = new TerminalEventStore(logger, {
      dbPath: tempDb('terminal-busy'),
      maxAttempts: 1,
    });
    store.insert(envelope('event-busy'));
    let busy = true;
    const wake = vi.fn(async () => {
      if (busy) throw new TerminalEventDeferredError('Chat is busy with another task', 10);
    });
    const dispatcher = new TerminalEventDispatcher({ store, logger, wake });

    await dispatcher.sweep();
    expect(store.get('event-busy')).toMatchObject({
      state: 'received',
      attempts: 0,
      lastError: 'Chat is busy with another task',
    });

    busy = false;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    await dispatcher.sweep();
    expect(store.get('event-busy')).toMatchObject({ state: 'woken', attempts: 1 });
    expect(wake).toHaveBeenCalledTimes(2);
    dispatcher.stop();
    store.close();
  });
});
