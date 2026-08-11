import { describe, expect, it, vi } from 'vitest';
import type { DocumentChangeEvent } from '../src/memory/memory-client.js';
import { defaultWikiAutoSyncConsumer, WikiAutoSync } from '../src/sync/wiki-auto-sync.js';

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function event(id: number, docId: string, op: DocumentChangeEvent['op'] = 'update'): DocumentChangeEvent {
  return {
    id,
    event_uuid: `event-${id}`,
    ts: '2026-08-08T00:00:00.000Z',
    op,
    cascade_of: null,
    doc_id: docId,
    actor: 'user',
    origin: 'api',
    old_path: `/cargo1/${docId}`,
    new_path: op === 'delete' ? null : `/cargo1/${docId}`,
    old_title: docId,
    new_title: op === 'delete' ? null : docId,
    old_tags: [],
    new_tags: [],
    old_shared: true,
    new_shared: op === 'delete' ? null : true,
    old_version: 1,
    new_version: op === 'delete' ? null : 2,
    old_content_hash: 'old',
    new_content_hash: op === 'delete' ? null : 'new',
    content_changed: op !== 'delete',
    changed_fields: ['content'],
    old_excerpt: null,
    new_excerpt: null,
    old_routing: null,
    new_routing: null,
  };
}

function docSync(overrides: Record<string, unknown> = {}) {
  return {
    isSyncing: vi.fn().mockReturnValue(false),
    getStats: vi.fn().mockReturnValue({ lastFullSyncAt: new Date().toISOString() }),
    syncAll: vi.fn().mockResolvedValue({
      created: 1,
      updated: 0,
      skipped: 0,
      deleted: 0,
      errors: [],
      durationMs: 1,
    }),
    syncDocument: vi.fn().mockResolvedValue({ success: true }),
    deleteDocument: vi.fn().mockResolvedValue({ success: true }),
    syncChanges: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as any;
}

function memory(overrides: Record<string, unknown> = {}) {
  return {
    getDocumentChangeConsumerState: vi.fn().mockResolvedValue({
      consumer: 'wiki-test',
      last_event_id: 0,
      updated_at: '',
      initialized: true,
      latest_event_id: 0,
    }),
    advanceDocumentChangeConsumer: vi.fn().mockResolvedValue({}),
    listDocumentChangeEvents: vi.fn().mockResolvedValue({ events: [], next_after: 0 }),
    getDocument: vi.fn().mockResolvedValue({ id: 'doc-1' }),
    recordDocumentChangeProcessing: vi.fn().mockResolvedValue({}),
    listDocumentChangeProcessing: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

describe('WikiAutoSync', () => {
  it('derives separate durable consumers for separate target roots', () => {
    expect(defaultWikiAutoSyncConsumer('space', 'imac')).not.toBe(defaultWikiAutoSyncConsumer('space', 'savio'));
    expect(defaultWikiAutoSyncConsumer('space', 'imac')).toBe(defaultWikiAutoSyncConsumer('space', 'imac'));
  });

  it('initializes an empty consumer from a full snapshot without replaying history', async () => {
    const sync = docSync({ getStats: vi.fn().mockReturnValue({ lastFullSyncAt: undefined }) });
    const client = memory({
      getDocumentChangeConsumerState: vi.fn().mockResolvedValue({
        consumer: 'wiki-test',
        last_event_id: 0,
        updated_at: '',
        initialized: false,
        latest_event_id: 42,
      }),
    });
    const automation = new WikiAutoSync({ consumer: 'wiki-test' }, sync, client, logger());

    await automation.checkNow('test');

    expect(sync.syncAll).toHaveBeenCalledOnce();
    expect(client.advanceDocumentChangeConsumer).toHaveBeenCalledWith('wiki-test', 42);
    expect(client.listDocumentChangeEvents).not.toHaveBeenCalled();
    await automation.destroy();
  });

  it('does not initialize the cursor when the first full snapshot fails', async () => {
    const sync = docSync({
      getStats: vi.fn().mockReturnValue({ lastFullSyncAt: undefined }),
      syncAll: vi.fn().mockResolvedValue({
        created: 0,
        updated: 0,
        skipped: 0,
        deleted: 0,
        errors: ['root rejected'],
        durationMs: 1,
      }),
    });
    const client = memory({
      getDocumentChangeConsumerState: vi.fn().mockResolvedValue({
        consumer: 'wiki-test',
        last_event_id: 0,
        updated_at: '',
        initialized: false,
        latest_event_id: 42,
      }),
    });
    const automation = new WikiAutoSync({ consumer: 'wiki-test' }, sync, client, logger());

    await automation.checkNow('test');

    expect(client.advanceDocumentChangeConsumer).not.toHaveBeenCalled();
    await automation.destroy();
  });

  it('coalesces a batch by document and advances only after all operations succeed', async () => {
    const events = [event(1, 'doc-1'), event(2, 'doc-1'), event(3, 'doc-2', 'delete')];
    const sync = docSync();
    const client = memory({
      getDocumentChangeConsumerState: vi.fn().mockResolvedValue({
        consumer: 'wiki-test',
        last_event_id: 0,
        updated_at: '',
        initialized: true,
        latest_event_id: 3,
      }),
      listDocumentChangeEvents: vi.fn().mockResolvedValue({ events, next_after: 3 }),
    });
    const automation = new WikiAutoSync({ consumer: 'wiki-test', watchRoot: '/cargo1' }, sync, client, logger());

    await automation.checkNow('test');

    expect(client.listDocumentChangeEvents).toHaveBeenCalledWith(0, 100, '/cargo1');
    expect(sync.syncChanges).toHaveBeenCalledWith(['doc-1', 'doc-2']);
    expect(client.recordDocumentChangeProcessing).toHaveBeenCalledWith(
      expect.objectContaining({
        consumer: 'wiki-test',
        event_ids: [1, 2, 3],
        through_event_id: 3,
        status: 'applied',
      }),
    );
    expect(client.advanceDocumentChangeConsumer).not.toHaveBeenCalled();
    await automation.destroy();
  });

  it('keeps the cursor for retry and dead-letters a repeatedly failing batch', async () => {
    const events = [event(7, 'doc-1')];
    const sync = docSync({ syncChanges: vi.fn().mockResolvedValue({ success: false, error: 'Lark unavailable' }) });
    const client = memory({
      getDocumentChangeConsumerState: vi.fn().mockResolvedValue({
        consumer: 'wiki-test',
        last_event_id: 6,
        updated_at: '',
        initialized: true,
        latest_event_id: 7,
      }),
      listDocumentChangeEvents: vi.fn().mockResolvedValue({ events, next_after: 7 }),
      listDocumentChangeProcessing: vi.fn().mockResolvedValue([{ event_id: 7, attempts: 1 }]),
    });
    const automation = new WikiAutoSync({ consumer: 'wiki-test', maxAttempts: 2 }, sync, client, logger());

    await automation.checkNow('test');

    expect(client.recordDocumentChangeProcessing).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dead',
        advance_cursor: true,
        increment_attempts: true,
      }),
    );
    await automation.destroy();
  });

  it('records a retryable failure without advancing the cursor', async () => {
    const events = [event(9, 'doc-1')];
    const sync = docSync({ syncChanges: vi.fn().mockResolvedValue({ success: false, error: 'temporary' }) });
    const client = memory({
      getDocumentChangeConsumerState: vi.fn().mockResolvedValue({
        consumer: 'wiki-test',
        last_event_id: 8,
        updated_at: '',
        initialized: true,
        latest_event_id: 9,
      }),
      listDocumentChangeEvents: vi.fn().mockResolvedValue({ events, next_after: 9 }),
    });
    const automation = new WikiAutoSync({ consumer: 'wiki-test', maxAttempts: 3 }, sync, client, logger());

    await automation.checkNow('test');

    expect(client.recordDocumentChangeProcessing).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        advance_cursor: false,
        increment_attempts: true,
      }),
    );
    await automation.destroy();
  });
});
