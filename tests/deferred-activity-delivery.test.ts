import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeferredActivityDelivery } from '../src/bridge/deferred-activity-delivery.js';
import type { Logger } from '../src/utils/logger.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DeferredActivityDelivery', () => {
  it('deduplicates activity and delivers it once the chat becomes idle', async () => {
    vi.useFakeTimers();
    let busy = true;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const queue = new DeferredActivityDelivery({ isBusy: () => busy, deliver, logger });

    await queue.enqueue('chat', 'agent completed');
    await queue.enqueue('chat', 'agent completed');
    expect(deliver).not.toHaveBeenCalled();

    busy = false;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('chat', 'agent completed');
    queue.destroy();
  });

  it('delivers at the 30-minute cap even if the chat remains busy', async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const queue = new DeferredActivityDelivery({ isBusy: () => true, deliver, logger });

    await queue.enqueue('chat', 'bounded result');
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('chat', 'bounded result');
    queue.destroy();
  });

  it('retries transient delivery failure without losing the body', async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined);
    const queue = new DeferredActivityDelivery({ isBusy: () => false, deliver, logger });

    await queue.enqueue('chat', 'retry me');
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith('chat', 'retry me');
    queue.destroy();
  });

  it('bounds queued bodies and reports omitted activity', async () => {
    vi.useFakeTimers();
    let busy = true;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const queue = new DeferredActivityDelivery({ isBusy: () => busy, deliver, logger, maxItems: 2 });

    await queue.enqueue('chat', 'first');
    await queue.enqueue('chat', 'second');
    await queue.enqueue('chat', 'third');
    busy = false;
    await vi.advanceTimersByTimeAsync(30_000);

    const body = deliver.mock.calls[0][1] as string;
    expect(body).toContain('1 earlier event omitted');
    expect(body).not.toContain('first');
    expect(body).toContain('second');
    expect(body).toContain('third');
    queue.destroy();
  });
});
