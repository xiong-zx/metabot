import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { DocSync, type DocSyncConfig, type FullDocument } from '../src/sync/doc-sync.js';
import type { FolderTreeNode } from '../src/memory/memory-client.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn(() => createLogger()) } as any;
}

// Mock Feishu wiki/docx API responses
function createMockLarkClient() {
  let nodeCounter = 0;
  const nodes = new Map<string, any>([
    ['root_123', { space_id: 'space_123', node_token: 'root_123', parent_node_token: '', title: 'Host root' }],
    ['root_other', { space_id: 'space_123', node_token: 'root_other', parent_node_token: '', title: 'Other root' }],
  ]);
  return {
    wiki: {
      v2: {
        space: {
          get: vi.fn().mockResolvedValue({ data: { space: { space_id: 'space_123' } } }),
          getNode: vi.fn().mockImplementation(({ params }: any) => Promise.resolve({
            data: { node: nodes.get(params.token) },
          })),
          list: vi.fn().mockResolvedValue({ data: { items: [{ space_id: 'space_123', name: 'MetaMemory' }] } }),
          create: vi.fn().mockResolvedValue({ data: { space: { space_id: 'space_new' } } }),
        },
        spaceNode: {
          create: vi.fn().mockImplementation(({ data }: any) => {
            nodeCounter++;
            const node = {
              space_id: 'space_123',
              node_token: `node_${nodeCounter}`,
              obj_token: `doc_${nodeCounter}`,
              parent_node_token: data.parent_node_token || '',
              title: data.title,
            };
            nodes.set(node.node_token, node);
            return Promise.resolve({
              data: { node },
            });
          }),
          move: vi.fn().mockImplementation(({ path, data }: any) => {
            const node = nodes.get(path.node_token);
            if (node) node.parent_node_token = data.target_parent_token || '';
            return Promise.resolve({ data: { node } });
          }),
          updateTitle: vi.fn().mockImplementation(({ path, data }: any) => {
            const node = nodes.get(path.node_token);
            if (node) node.title = data.title;
            return Promise.resolve({ data: {} });
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
    drive: {
      v1: {
        file: {
          delete: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    },
    __nodes: nodes,
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
    listDocuments: vi.fn().mockImplementation(async (folderId?: string) =>
      docs
        .filter((d) => !folderId || d.folder_id === folderId)
        .map((d) => ({ id: d.id, title: d.title, path: d.path, folder_id: d.folder_id, tags: d.tags, created_at: d.created_at, updated_at: d.updated_at }))),
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

  function setup(docs: FullDocument[] = [], tree?: FolderTreeNode, overrides: Partial<DocSyncConfig> = {}) {
    mockClient = createMockLarkClient();
    mockMemory = createMockMemoryClient(docs, tree);

    const config: DocSyncConfig = {
      feishuAppId: 'test_id',
      feishuAppSecret: 'test_secret',
      databaseDir: tmpDir,
      wikiSpaceName: 'MetaMemory',
      throttleMs: 0, // no delay in tests
      ...overrides,
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

  it('creates its SDK client on the configured Lark tenant', () => {
    mockMemory = createMockMemoryClient();
    docSync = new DocSync({
      feishuAppId: 'test_id',
      feishuAppSecret: 'test_secret',
      feishuDomain: 'lark',
      databaseDir: tmpDir,
    }, mockMemory, createLogger());

    const expected = new lark.Client({
      appId: 'test_id',
      appSecret: 'test_secret',
      domain: lark.Domain.Lark,
    });
    expect((docSync as any).client.domain).toBe(expected.domain);
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

  it('projects a configured Memory source directly onto the Wiki root', async () => {
    const tree: FolderTreeNode = {
      id: 'root',
      name: 'Root',
      path: '/',
      children: [
        { id: 'cargo', name: 'cargo1', path: '/cargo1', children: [], document_count: 1 },
        {
          id: 'imac',
          name: 'imac',
          path: '/imac',
          children: [
            { id: 'imac-research', name: 'research', path: '/imac/research', children: [], document_count: 1 },
          ],
          document_count: 1,
        },
      ],
      document_count: 0,
    };
    const docs = [
      makeSampleDoc({ id: 'cargo-doc', title: 'Cargo', folder_id: 'cargo', path: '/cargo1/Cargo' }),
      makeSampleDoc({ id: 'overview', title: 'Overview', folder_id: 'imac', path: '/imac/Overview' }),
      makeSampleDoc({ id: 'paper', title: 'Paper', folder_id: 'imac-research', path: '/imac/research/Paper' }),
    ];
    setup(docs, tree, {
      wikiSpaceId: 'space_123',
      rootNodeToken: 'root_123',
      sourceRoot: '/imac/',
    });

    const result = await docSync.syncAll();
    const creates = mockClient.wiki.v2.spaceNode.create.mock.calls.map(([request]: any[]) => request.data);

    expect(result.errors).toHaveLength(0);
    expect(result.created).toBe(2);
    expect(creates).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'research', parent_node_token: 'root_123' }),
      expect.objectContaining({ title: 'Overview', parent_node_token: 'root_123' }),
      expect.objectContaining({ title: 'Paper' }),
    ]));
    expect(creates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'imac' }),
      expect.objectContaining({ title: 'cargo1' }),
      expect.objectContaining({ title: 'Cargo' }),
    ]));
    expect(docSync.getStats()).toMatchObject({ documentCount: 2, folderCount: 1, sourceRoot: '/imac' });
  });

  it('fails closed when the configured Memory source does not exist', async () => {
    setup([], undefined, {
      wikiSpaceId: 'space_123',
      rootNodeToken: 'root_123',
      sourceRoot: '/missing',
    });

    const result = await docSync.syncAll();

    expect(result.errors).toContain('WIKI_SYNC_SOURCE_ROOT /missing was not found in MetaMemory');
    expect(mockClient.wiki.v2.spaceNode.create).not.toHaveBeenCalled();
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

  it('creates every top-level node under the configured Wiki root', async () => {
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
    expect(docSync.getStats().rootNodeToken).toBe('root_123');
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

  it('deletes remote documents only after validating the configured root', async () => {
    const doc = makeSampleDoc();
    setup([doc], undefined, {
      wikiSpaceId: 'space_123',
      rootNodeToken: 'root_123',
      deleteRemoteDocuments: true,
    });
    expect((await docSync.syncAll()).errors).toHaveLength(0);

    const result = await docSync.deleteDocument(doc.id);

    expect(result.success).toBe(true);
    expect(mockClient.drive.v1.file.delete).toHaveBeenCalledWith({
      path: { file_token: 'doc_1' },
      params: { type: 'docx' },
    });
    expect(docSync.getStats().documentCount).toBe(0);
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

  it('refuses to sync a document outside the configured Memory source', async () => {
    const doc = makeSampleDoc({ folder_id: 'cargo', path: '/cargo1/Outside' });
    setup([doc], undefined, {
      wikiSpaceId: 'space_123',
      rootNodeToken: 'root_123',
      sourceRoot: '/imac',
    });

    const result = await docSync.syncDocument(doc.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside WIKI_SYNC_SOURCE_ROOT /imac');
    expect(mockClient.wiki.v2.spaceNode.create).not.toHaveBeenCalled();
  });

  it('drops a mapping when an incremental event moves a document outside the source', async () => {
    const doc = makeSampleDoc({ folder_id: 'imac', path: '/imac/Tracked' });
    const tree: FolderTreeNode = {
      id: 'root',
      name: 'Root',
      path: '/',
      children: [
        { id: 'imac', name: 'imac', path: '/imac', children: [], document_count: 1 },
      ],
      document_count: 0,
    };
    setup([doc], tree, {
      wikiSpaceId: 'space_123',
      rootNodeToken: 'root_123',
      sourceRoot: '/imac',
    });
    expect((await docSync.syncAll()).errors).toHaveLength(0);
    expect(docSync.getStats().documentCount).toBe(1);

    doc.path = '/cargo1/Moved';
    doc.folder_id = 'cargo';
    const result = await docSync.syncChanges([doc.id]);

    expect(result.success).toBe(true);
    expect(docSync.getStats().documentCount).toBe(0);
    expect(mockClient.drive.v1.file.delete).not.toHaveBeenCalled();
  });

  it('syncChanges validates one target and coalesces duplicate document IDs', async () => {
    const docs = [
      makeSampleDoc({ id: 'doc1', path: '/Doc 1', title: 'Doc 1' }),
      makeSampleDoc({ id: 'doc2', path: '/Doc 2', title: 'Doc 2' }),
    ];
    setup(docs, undefined, { wikiSpaceId: 'space_123', rootNodeToken: 'root_123' });

    const result = await docSync.syncChanges(['doc1', 'doc1', 'doc2']);

    expect(result.success).toBe(true);
    expect(mockClient.wiki.v2.space.get).toHaveBeenCalledTimes(1);
    expect(mockClient.wiki.v2.space.getNode).toHaveBeenCalledTimes(1);
    expect(mockMemory.listFolderTree).toHaveBeenCalledTimes(1);
    expect(mockClient.wiki.v2.spaceNode.create).toHaveBeenCalledTimes(2);
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
