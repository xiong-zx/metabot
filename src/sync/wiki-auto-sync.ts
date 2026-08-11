import { createHash } from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import type { DocumentChangeEvent, MemoryClient } from '../memory/memory-client.js';
import type { DocSync } from './doc-sync.js';

export interface WikiAutoSyncConfig {
  consumer: string;
  pollMs?: number;
  batchSize?: number;
  fullReconcileMs?: number;
  maxAttempts?: number;
  watchRoot?: string;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FULL_RECONCILE_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/** Derive a stable cursor so distinct Wiki targets or Memory sources never share it. */
export function defaultWikiAutoSyncConsumer(spaceId: string, rootNodeToken: string, sourceRoot = '/'): string {
  const targetHash = createHash('sha256')
    .update(`${spaceId}:${rootNodeToken}:${normalizeRoot(sourceRoot)}`)
    .digest('hex')
    .slice(0, 16);
  return `wiki-sync-${targetHash}`;
}

/**
 * Durable MetaMemory change-feed consumer for incremental Wiki sync.
 * The cursor is advanced only after every document in a batch is synchronized.
 */
export class WikiAutoSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeCheck: Promise<void> | undefined;
  private destroyed = false;

  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly fullReconcileMs: number;
  private readonly maxAttempts: number;
  private readonly watchRoot: string;

  constructor(
    private readonly config: WikiAutoSyncConfig,
    private readonly docSync: DocSync,
    private readonly memoryClient: MemoryClient,
    private readonly logger: Logger,
  ) {
    if (!config.consumer.trim()) throw new Error('Wiki auto-sync consumer must not be empty');
    this.pollMs = positiveInt(config.pollMs, DEFAULT_POLL_MS);
    this.batchSize = positiveInt(config.batchSize, DEFAULT_BATCH_SIZE);
    this.fullReconcileMs = positiveInt(config.fullReconcileMs, DEFAULT_FULL_RECONCILE_MS);
    this.maxAttempts = positiveInt(config.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.watchRoot = normalizeRoot(config.watchRoot || '/');
  }

  start(): void {
    if (this.timer || this.destroyed) return;
    this.timer = setInterval(() => {
      void this.checkNow('poll');
    }, this.pollMs);
    this.timer.unref?.();
    void this.checkNow('startup');
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeCheck;
  }

  checkNow(reason = 'manual'): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.activeCheck) return this.activeCheck;
    const check = this.runCheck(reason)
      .catch((error) => {
        this.logger.error(
          { reason, err: error instanceof Error ? error.message : String(error) },
          'Wiki auto-sync check failed',
        );
      })
      .finally(() => {
        if (this.activeCheck === check) this.activeCheck = undefined;
      });
    this.activeCheck = check;
    return check;
  }

  private async runCheck(reason: string): Promise<void> {
    if (this.docSync.isSyncing()) {
      this.logger.debug({ reason }, 'Wiki auto-sync deferred while another sync is running');
      return;
    }

    const state = await this.memoryClient.getDocumentChangeConsumerState(this.config.consumer);
    if (state.initialized === undefined) {
      throw new Error('Wiki auto-sync requires a metabot-core consumer API with initialization metadata');
    }

    if (!state.initialized || this.fullReconcileDue()) {
      const result = await this.docSync.syncAll();
      if (result.errors.length > 0) {
        throw new Error(`Full Wiki sync failed: ${result.errors.join('; ')}`);
      }
      await this.memoryClient.advanceDocumentChangeConsumer(this.config.consumer, state.latest_event_id);
      this.logger.info(
        {
          reason,
          consumer: this.config.consumer,
          throughEventId: state.latest_event_id,
          initialized: state.initialized,
          created: result.created,
          updated: result.updated,
          deleted: result.deleted,
        },
        state.initialized
          ? 'Wiki auto-sync full reconciliation completed'
          : 'Wiki auto-sync initialized from a full snapshot',
      );
      return;
    }

    const feed = await this.memoryClient.listDocumentChangeEvents(
      state.last_event_id,
      this.batchSize,
      this.watchRoot === '/' ? undefined : this.watchRoot,
    );
    if (feed.events.length === 0) {
      if (feed.next_after > state.last_event_id) {
        await this.memoryClient.advanceDocumentChangeConsumer(this.config.consumer, feed.next_after);
      }
      return;
    }

    try {
      const docIds = uniqueDocumentIds(feed.events);
      const result = await this.docSync.syncChanges(docIds);
      if (!result.success) throw new Error(result.error || 'Wiki change batch failed');

      const throughEventId = Math.max(feed.next_after, feed.events.at(-1)?.id || 0);
      await this.memoryClient.recordDocumentChangeProcessing({
        consumer: this.config.consumer,
        event_ids: feed.events.map((event) => event.id),
        through_event_id: throughEventId,
        status: 'applied',
        proposal: {
          operation: 'wiki_sync',
          document_ids: docIds,
        },
        increment_attempts: false,
      });
      this.logger.info(
        {
          reason,
          consumer: this.config.consumer,
          eventCount: feed.events.length,
          documentCount: docIds.length,
          throughEventId,
        },
        'Wiki auto-sync batch applied',
      );
    } catch (error) {
      await this.recordFailure(state.last_event_id, feed.events, feed.next_after, error);
    }
  }

  private fullReconcileDue(): boolean {
    const value = this.docSync.getStats().lastFullSyncAt;
    if (!value) return true;
    const timestamp = Date.parse(value);
    return !Number.isFinite(timestamp) || Date.now() - timestamp >= this.fullReconcileMs;
  }

  private async recordFailure(
    after: number,
    events: DocumentChangeEvent[],
    nextAfter: number,
    error: unknown,
  ): Promise<void> {
    const eventIds = events.map((event) => event.id);
    const processing = await this.memoryClient.listDocumentChangeProcessing(
      this.config.consumer,
      after,
      this.batchSize,
    );
    const priorAttempts = processing
      .filter((item) => eventIds.includes(item.event_id))
      .reduce((maximum, item) => Math.max(maximum, item.attempts), 0);
    const attempt = priorAttempts + 1;
    const dead = attempt >= this.maxAttempts;
    const message = error instanceof Error ? error.message : String(error);
    await this.memoryClient.recordDocumentChangeProcessing({
      consumer: this.config.consumer,
      event_ids: eventIds,
      through_event_id: Math.max(nextAfter, events.at(-1)?.id || 0),
      status: dead ? 'dead' : 'failed',
      error: message,
      advance_cursor: dead,
      increment_attempts: true,
    });
    this.logger.warn(
      { consumer: this.config.consumer, eventIds, attempt, dead, err: message },
      dead
        ? 'Wiki auto-sync batch moved to dead letter after repeated failures'
        : 'Wiki auto-sync batch failed and will be retried',
    );
  }
}

function uniqueDocumentIds(events: DocumentChangeEvent[]): string[] {
  return [...new Set(events.map((event) => event.doc_id).filter(Boolean))];
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function normalizeRoot(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}
