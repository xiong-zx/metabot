import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWikiSyncRuntime } from '../src/sync/wiki-sync-runtime.js';

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

const service = {
  appId: 'cli_test',
  appSecret: 'secret',
  domain: 'lark' as const,
};

describe('createWikiSyncRuntime', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('does not construct Wiki services when sync is disabled', () => {
    expect(
      createWikiSyncRuntime({
        feishuService: service,
        logger: logger(),
        env: { WIKI_SYNC_ENABLED: 'false' },
      }),
    ).toEqual({});
  });

  it('fails closed when auto-sync lacks explicit target configuration', () => {
    expect(() =>
      createWikiSyncRuntime({
        feishuService: service,
        logger: logger(),
        env: { WIKI_AUTO_SYNC: 'true' },
      }),
    ).toThrow('WIKI_SPACE_ID, WIKI_SYNC_ROOT_NODE_TOKEN, WIKI_SYNC_STATE_DIR');
  });

  it('requires a root node before enabling remote deletion', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-runtime-test-'));
    expect(() =>
      createWikiSyncRuntime({
        feishuService: service,
        logger: logger(),
        cwd: tmpDir,
        env: {
          WIKI_SYNC_STATE_DIR: 'state',
          WIKI_SYNC_DELETE_REMOTE: 'true',
        },
      }),
    ).toThrow('WIKI_SYNC_DELETE_REMOTE=true requires WIKI_SYNC_ROOT_NODE_TOKEN');
  });

  it('constructs root-isolated manual and automatic services from explicit config', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-runtime-test-'));
    const runtime = createWikiSyncRuntime({
      feishuService: service,
      logger: logger(),
      cwd: tmpDir,
      env: {
        WIKI_SYNC_ENABLED: 'true',
        WIKI_AUTO_SYNC: 'true',
        WIKI_SPACE_ID: 'space_123',
        WIKI_SYNC_ROOT_NODE_TOKEN: 'root_imac',
        WIKI_SYNC_STATE_DIR: 'state/imac',
        WIKI_AUTO_SYNC_CONSUMER: 'wiki-imac',
      },
    });

    expect(runtime.docSync).toBeDefined();
    expect(runtime.wikiAutoSync).toBeDefined();
    expect((runtime.docSync as any).config.rootNodeToken).toBe('root_imac');
    expect((runtime.docSync as any).config.databaseDir).toBe(path.join(tmpDir, 'state/imac'));
    expect((runtime.wikiAutoSync as any).config.consumer).toBe('wiki-imac');

    await runtime.wikiAutoSync?.destroy();
    runtime.docSync?.destroy();
  });
});
