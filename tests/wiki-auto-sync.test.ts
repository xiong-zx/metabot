import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WikiAutoSync } from '../src/sync/auto-sync.js';
import type { SyncResult } from '../src/sync/doc-sync.js';
import type { DocumentSummary, FolderTreeNode } from '../src/memory/memory-client.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn(() => createLogger()) } as any;
}

function makeTree(overrides: Partial<FolderTreeNode> = {}): FolderTreeNode {
  return {
    id: 'root',
    name: 'Root',
    path: '/',
    children: [],
    document_count: 0,
    ...overrides,
  };
}

function makeDoc(id: string, overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id,
    title: `Doc ${id}`,
    folder_id: 'root',
    path: `/Doc ${id}`,
    tags: ['test'],
    created_by: 'tester',
    updated_at: '2026-07-09T00:00:00.000Z',
    ...overrides,
  };
}

function makeResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    errors: [],
    durationMs: 1,
    ...overrides,
  };
}

function setup(options: {
  docs?: DocumentSummary[];
  tree?: FolderTreeNode;
  syncOnStart?: boolean;
  debounceMs?: number;
  pageSize?: number;
} = {}) {
  const docs = options.docs || [makeDoc('doc1')];
  const tree = options.tree || makeTree({ document_count: docs.length });
  const memoryClient = {
    listFolderTree: vi.fn(async () => tree),
    listDocuments: vi.fn(async (_folderId?: string, limit = 50, offset = 0) => docs.slice(offset, offset + limit)),
  } as any;
  const docSync = {
    isSyncing: vi.fn(() => false),
    syncAll: vi.fn(async () => makeResult()),
  } as any;
  const service = new WikiAutoSync(
    {
      pollMs: 60_000,
      debounceMs: options.debounceMs ?? 100,
      pageSize: options.pageSize,
      syncOnStart: options.syncOnStart,
    },
    docSync,
    memoryClient,
    createLogger(),
  );
  return { docs, tree, memoryClient, docSync, service };
}

describe('WikiAutoSync', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('captures a baseline without syncing when syncOnStart is false', async () => {
    const { docs, docSync, service } = setup({ syncOnStart: false });

    await service.checkNow('startup');
    await vi.advanceTimersByTimeAsync(100);

    expect(docSync.syncAll).not.toHaveBeenCalled();

    docs[0] = { ...docs[0], updated_at: '2026-07-09T00:01:00.000Z' };
    await service.checkNow('poll');

    await vi.advanceTimersByTimeAsync(99);
    expect(docSync.syncAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(docSync.syncAll).toHaveBeenCalledTimes(1);

    service.destroy();
  });

  it('coalesces rapid snapshot changes into one debounced sync', async () => {
    const { docs, docSync, service } = setup({ syncOnStart: false });

    await service.checkNow('startup');
    docs[0] = { ...docs[0], title: 'Changed once', updated_at: '2026-07-09T00:01:00.000Z' };
    await service.checkNow('poll-1');
    docs[0] = { ...docs[0], title: 'Changed twice', updated_at: '2026-07-09T00:02:00.000Z' };
    await service.checkNow('poll-2');

    await vi.advanceTimersByTimeAsync(100);

    expect(docSync.syncAll).toHaveBeenCalledTimes(1);
    service.destroy();
  });

  it('can run an initial sync after capturing the startup baseline', async () => {
    const { docSync, service } = setup({ syncOnStart: true, debounceMs: 10 });

    await service.checkNow('startup');
    await vi.advanceTimersByTimeAsync(10);

    expect(docSync.syncAll).toHaveBeenCalledTimes(1);
    service.destroy();
  });

  it('paginates document summaries while building the snapshot', async () => {
    const docs = Array.from({ length: 501 }, (_, i) => makeDoc(`doc${i}`));
    const { memoryClient, docSync, service } = setup({
      docs,
      pageSize: 500,
      syncOnStart: false,
      debounceMs: 10,
    });

    await service.checkNow('startup');

    expect(memoryClient.listDocuments).toHaveBeenCalledWith(undefined, 500, 0);
    expect(memoryClient.listDocuments).toHaveBeenCalledWith(undefined, 500, 500);

    docs[500] = { ...docs[500], updated_at: '2026-07-09T00:03:00.000Z' };
    await service.checkNow('poll');
    await vi.advanceTimersByTimeAsync(10);

    expect(docSync.syncAll).toHaveBeenCalledTimes(1);
    service.destroy();
  });

  it('retries later when another sync is already active', async () => {
    const { docs, docSync, service } = setup({ syncOnStart: false, debounceMs: 10 });

    await service.checkNow('startup');
    docs[0] = { ...docs[0], updated_at: '2026-07-09T00:04:00.000Z' };
    docSync.isSyncing.mockReturnValueOnce(true).mockReturnValue(false);

    await service.checkNow('poll');
    await vi.advanceTimersByTimeAsync(10);
    expect(docSync.syncAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(docSync.syncAll).toHaveBeenCalledTimes(1);
    service.destroy();
  });
});
