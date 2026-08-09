import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DocSync, type DocSyncConfig, type FullDocument } from '../src/sync/doc-sync.js';
import type { FolderTreeNode } from '../src/memory/memory-client.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn(() => createLogger()) } as any;
}

// Mock Feishu wiki/docx API responses
function createMockLarkClient() {
  let nodeCounter = 0;
  const nodes = new Map<string, any>([
    ['root_123', { space_id: 'space_123', node_token: 'root_123', parent_node_token: '' }],
    ['root_other', { space_id: 'space_123', node_token: 'root_other', parent_node_token: '' }],
  ]);
  return {
    __nodes: nodes,
    wiki: {
      v2: {
        space: {
          get: vi.fn().mockResolvedValue({ data: { space: { space_id: 'space_123' } } }),
          list: vi.fn().mockResolvedValue({ data: { items: [{ space_id: 'space_123', name: 'MetaMemory' }] } }),
          create: vi.fn().mockResolvedValue({ data: { space: { space_id: 'space_new' } } }),
          getNode: vi.fn().mockImplementation(({ params }: any) => Promise.resolve({
            data: { node: nodes.get(params.token) },
          })),
        },
        spaceNode: {
          create: vi.fn().mockImplementation((request: any) => {
            nodeCounter++;
            const node = {
              space_id: request.path.space_id,
              node_token: `node_${nodeCounter}`,
              obj_token: `doc_${nodeCounter}`,
              parent_node_token: request.data.parent_node_token || '',
            };
            nodes.set(node.node_token, node);
            return Promise.resolve({
              data: { node },
            });
          }),
        },
      },
    },
    docx: {
      v1: {
        documentBlockChildren: {
          create: vi.fn().mockResolvedValue({ data: {} }),
          get: vi.fn().mockResolvedValue({ data: { items: [] } }),
          batchDelete: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    },
  };
}

function createMockMemoryClient(docs: FullDocument[] = [], tree?: FolderTreeNode) {
  const defaultTree: FolderTreeNode = {
    id: 'root',
    name: 'Root',
    path: '/',
    children: [],
    document_count: docs.length,
  };
  return {
    baseUrl: 'https://metabot.xvirobotics.com/core',
    token: 'test-token',
    secret: 'test-token',
    listFolderTree: vi.fn().mockResolvedValue(tree || defaultTree),
    listDocuments: vi.fn().mockResolvedValue(
      docs.map((d) => ({ id: d.id, title: d.title, path: d.path, folder_id: d.folder_id, tags: d.tags, created_at: d.created_at, updated_at: d.updated_at })),
    ),
    getDocument: vi.fn().mockImplementation(async (docId: string) => docs.find((d) => d.id === docId) || null),
  } as any;
}

function makeSampleDoc(overrides: Partial<FullDocument> = {}): FullDocument {
  return {
    id: 'doc1',
    title: 'Test Doc',
    folder_id: 'root',
    path: '/Test Doc',
    content: '# Hello\n\nWorld',
    tags: ['test'],
    created_by: 'user',
    created_at: '2024-01-01',
    updated_at: '2024-01-02',
    ...overrides,
  };
}

describe('DocSync', () => {
  let tmpDir: string;
  let docSync: DocSync;
  let mockClient: ReturnType<typeof createMockLarkClient>;
  let mockMemory: ReturnType<typeof createMockMemoryClient>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-sync-test-'));
  });

  afterEach(() => {
    if (docSync) docSync.destroy();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(
    docs: FullDocument[] = [],
    tree?: FolderTreeNode,
    configOverrides: Partial<DocSyncConfig> = {},
  ) {
    mockClient = createMockLarkClient();
    mockMemory = createMockMemoryClient(docs, tree);

    const config: DocSyncConfig = {
      feishuAppId: 'test_id',
      feishuAppSecret: 'test_secret',
      databaseDir: tmpDir,
      wikiSpaceName: 'MetaMemory',
      throttleMs: 0, // no delay in tests
      ...configOverrides,
    };

    docSync = new DocSync(config, mockMemory, createLogger());

    // Replace internal Lark client with mock
    (docSync as any).client = mockClient;

    // Mock fetchDocument to return from our docs array
    vi.spyOn(docSync as any, 'fetchDocument').mockImplementation(async (docId: string) => {
      return docs.find((d) => d.id === docId) || null;
    });
  }

  it('reports not syncing initially', () => {
    setup();
    expect(docSync.isSyncing()).toBe(false);
  });

  it('returns empty stats when no docs synced', () => {
    setup();
    const stats = docSync.getStats();
    expect(stats.documentCount).toBe(0);
    expect(stats.folderCount).toBe(0);
  });

  it('returns error if sync is already in progress', async () => {
    setup();
    // Simulate syncing state
    (docSync as any).syncing = true;
    const result = await docSync.syncAll();
    expect(result.errors).toContain('Sync already in progress');
    (docSync as any).syncing = false;
  });

  it('syncs a single document successfully', async () => {
    const doc = makeSampleDoc();
    setup([doc]);

    const result = await docSync.syncAll();
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(docSync.isSyncing()).toBe(false);
  });

  it('skips unchanged documents on second sync', async () => {
    const doc = makeSampleDoc();
    setup([doc]);

    // First sync
    await docSync.syncAll();

    // Second sync — same content
    const result = await docSync.syncAll();
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
  });

  it('updates documents when content changes', async () => {
    const doc = makeSampleDoc();
    setup([doc]);

    // First sync
    await docSync.syncAll();

    // Change the document content
    doc.content = '# Updated\n\nNew content';

    const result = await docSync.syncAll();
    expect(result.updated).toBe(1);
  });

  it('syncs folder structure', async () => {
    const tree: FolderTreeNode = {
      id: 'root',
      name: 'Root',
      path: '/',
      children: [
        {
          id: 'f1',
          name: 'Research',
          path: '/Research',
          children: [],
          document_count: 0,
        },
      ],
      document_count: 0,
    };

    setup([], tree);
    await docSync.syncAll();

    const stats = docSync.getStats();
    expect(stats.folderCount).toBe(1);
  });

  it('detects and cleans up deleted documents', async () => {
    const doc = makeSampleDoc();
    setup([doc]);

    // First sync creates the doc mapping
    await docSync.syncAll();

    // Now remove the doc from MetaMemory
    (docSync as any).fetchDocument = vi.fn().mockResolvedValue(null);
    mockMemory.listDocuments.mockResolvedValue([]);

    const result = await docSync.syncAll();
    expect(result.deleted).toBe(1);
  });

  it('creates top-level documents under the configured Wiki root', async () => {
    const doc = makeSampleDoc();
    setup([doc], undefined, { wikiSpaceId: 'space_123', rootNodeToken: 'root_123' });

    const result = await docSync.syncAll();

    expect(result.errors).toHaveLength(0);
    expect(mockClient.wiki.v2.space.getNode).toHaveBeenCalledWith({
      params: { token: 'root_123', obj_type: 'wiki' },
    });
    expect(mockClient.wiki.v2.spaceNode.create).toHaveBeenCalledWith(expect.objectContaining({
      path: { space_id: 'space_123' },
      data: expect.objectContaining({ parent_node_token: 'root_123' }),
    }));
  });

  it('fails closed when the configured root belongs to another Space', async () => {
    setup([makeSampleDoc()], undefined, { wikiSpaceId: 'space_123', rootNodeToken: 'foreign_root' });
    mockClient.wiki.v2.space.getNode.mockResolvedValueOnce({
      data: { node: { space_id: 'space_other', node_token: 'foreign_root' } },
    });

    const result = await docSync.syncAll();

    expect(result.errors.join('\n')).toContain('does not belong to Wiki Space space_123');
    expect(mockClient.wiki.v2.spaceNode.create).not.toHaveBeenCalled();
  });

  it('rejects reusing populated state for another Wiki root', async () => {
    const doc = makeSampleDoc();
    setup([doc], undefined, { wikiSpaceId: 'space_123', rootNodeToken: 'root_123' });
    expect((await docSync.syncAll()).errors).toHaveLength(0);
    docSync.destroy();

    mockClient = createMockLarkClient();
    docSync = new DocSync({
      feishuAppId: 'test_id',
      feishuAppSecret: 'test_secret',
      databaseDir: tmpDir,
      wikiSpaceId: 'space_123',
      rootNodeToken: 'root_other',
      throttleMs: 0,
    }, mockMemory, createLogger());
    (docSync as any).client = mockClient;

    const result = await docSync.syncAll();
    expect(result.errors.join('\n')).toContain('use a new WIKI_SYNC_STATE_DIR');
  });

  it('refuses to update a mapped document moved outside the configured root', async () => {
    const doc = makeSampleDoc();
    setup([doc], undefined, { wikiSpaceId: 'space_123', rootNodeToken: 'root_123' });
    expect((await docSync.syncAll()).errors).toHaveLength(0);
    doc.content = 'changed after an external move';
    mockClient.__nodes.get('node_1').parent_node_token = 'root_other';

    const result = await docSync.syncDocument(doc.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside configured root root_123');
    expect(mockClient.docx.v1.documentBlockChildren.get).not.toHaveBeenCalled();
  });

  it('finds existing wiki space by name', async () => {
    setup();
    const spaceId = await (docSync as any).ensureWikiSpace();
    expect(spaceId).toBe('space_123');
    // Verify space.list was called
    expect(mockClient.wiki.v2.space.list).toHaveBeenCalled();
  });

  it('creates wiki space when none exists', async () => {
    setup();
    // Override list to return empty
    mockClient.wiki.v2.space.list.mockResolvedValueOnce({ data: { items: [] } });
    // Override get to fail (stored space invalid)
    mockClient.wiki.v2.space.get.mockRejectedValueOnce(new Error('not found'));

    const spaceId = await (docSync as any).ensureWikiSpace();
    expect(spaceId).toBe('space_new');
    expect(mockClient.wiki.v2.space.create).toHaveBeenCalled();
  });

  it('syncDocument syncs a single doc by ID', async () => {
    const doc = makeSampleDoc();
    setup([doc]);

    const result = await docSync.syncDocument('doc1');
    expect(result.success).toBe(true);
  });

  it('syncDocument returns error for missing doc', async () => {
    setup([]);
    const result = await docSync.syncDocument('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('destroy closes the store', () => {
    setup();
    // Should not throw
    docSync.destroy();
    docSync = undefined as any; // prevent double-destroy in afterEach
  });
});
