import type { Logger } from '../utils/logger.js';
import { formatSpontaneousCardBody } from './spontaneous-activity.js';

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_MAX_DEFERRAL_MS = 30 * 60_000;
const DEFAULT_MAX_ITEMS = 25;

interface DeferredActivityEntry {
  bodies: string[];
  omittedCount: number;
  firstQueuedAt: number;
  retryCount: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface DeferredActivityDeliveryOptions {
  isBusy: (chatId: string) => boolean;
  deliver: (chatId: string, body: string) => Promise<void>;
  logger: Logger;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxDeferralMs?: number;
  maxItems?: number;
  coalesceMs?: number;
}

/**
 * Coalesces background activity until a foreground turn releases the chat.
 * Exact duplicates are removed and the queue is bounded. At the deferral
 * deadline, activity is delivered even if the turn is still running.
 */
export class DeferredActivityDelivery {
  private readonly entries = new Map<string, DeferredActivityEntry>();
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxDeferralMs: number;
  private readonly maxItems: number;
  private readonly coalesceMs: number;

  constructor(private readonly options: DeferredActivityDeliveryOptions) {
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxDeferralMs = options.maxDeferralMs ?? DEFAULT_MAX_DEFERRAL_MS;
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    this.coalesceMs = options.coalesceMs ?? 0;
  }

  async enqueue(chatId: string, body: string): Promise<void> {
    const normalized = body.trim();
    if (!normalized) return;

    let entry = this.entries.get(chatId);
    if (!entry) {
      entry = {
        bodies: [],
        omittedCount: 0,
        firstQueuedAt: Date.now(),
        retryCount: 0,
      };
      this.entries.set(chatId, entry);
    }

    if (!entry.bodies.includes(normalized)) {
      entry.bodies.push(normalized);
      if (entry.bodies.length > this.maxItems) {
        entry.bodies.shift();
        entry.omittedCount += 1;
      }
    }

    if (!entry.timer) {
      if (this.coalesceMs > 0) {
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          void this.flush(chatId);
        }, this.coalesceMs);
        entry.timer.unref?.();
      } else {
        await this.flush(chatId);
      }
    }
  }

  destroy(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  private async flush(chatId: string): Promise<void> {
    const entry = this.entries.get(chatId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }

    const elapsedMs = Date.now() - entry.firstQueuedAt;
    if (this.options.isBusy(chatId) && elapsedMs < this.maxDeferralMs) {
      this.defer(chatId, entry, this.maxDeferralMs - elapsedMs);
      return;
    }

    this.entries.delete(chatId);
    const body = formatDeferredActivityBody(entry.bodies, entry.omittedCount);
    try {
      await this.options.deliver(chatId, body);
      this.options.logger.info(
        { chatId, eventCount: entry.bodies.length, omittedCount: entry.omittedCount, elapsedMs },
        'Delivered deferred agent activity',
      );
    } catch (err) {
      const deliveryElapsedMs = Date.now() - entry.firstQueuedAt;
      if (deliveryElapsedMs < this.maxDeferralMs) {
        this.entries.set(chatId, entry);
        this.defer(chatId, entry, this.maxDeferralMs - deliveryElapsedMs);
        this.options.logger.warn({ err, chatId }, 'Agent activity delivery failed; retrying');
        return;
      }
      this.options.logger.error({ err, chatId }, 'Agent activity delivery failed after deferral window');
    }
  }

  private defer(chatId: string, entry: DeferredActivityEntry, remainingMs: number): void {
    const exponentialDelay = this.initialDelayMs * 2 ** Math.min(entry.retryCount, 10);
    const delayMs = Math.min(exponentialDelay, this.maxDelayMs, remainingMs);
    entry.retryCount += 1;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.flush(chatId);
    }, delayMs);
    entry.timer.unref?.();
    this.options.logger.info(
      { chatId, retryCount: entry.retryCount, delayMs, remainingMs, eventCount: entry.bodies.length },
      'Deferred agent activity while chat is busy',
    );
  }
}

export function formatDeferredActivityBody(bodies: string[], omittedCount: number): string {
  const body = formatSpontaneousCardBody(bodies);
  if (omittedCount === 0) return body;
  const noun = omittedCount === 1 ? 'event' : 'events';
  return `_(${omittedCount} earlier ${noun} omitted while the chat was busy)_\n\n${body}`;
}
