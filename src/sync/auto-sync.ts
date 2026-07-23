import { createHash } from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import type { DocumentSummary, FolderTreeNode, MemoryClient } from '../memory/memory-client.js';
import type { DocSync, SyncResult } from './doc-sync.js';

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_PAGE_SIZE = 500;

export interface WikiAutoSyncConfig {
  pollMs?: number;
  debounceMs?: number;
  pageSize?: number;
  syncOnStart?: boolean;
}

interface MemorySnapshot {
  hash: string;
  folderCount: number;
  documentCount: number;
}

/**
 * Polls metabot-core for a lightweight MetaMemory snapshot and triggers the
 * existing DocSync pipeline when the folder tree or document summaries change.
 */
export class WikiAutoSync {
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly pageSize: number;
  private readonly syncOnStart: boolean;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private running = false;
  private pendingAfterRun = false;
  private lastSnapshotHash: string | undefined;
  private lastScheduledReason = '';

  constructor(
    config: WikiAutoSyncConfig,
    private readonly docSync: DocSync,
    private readonly memoryClient: MemoryClient,
    private readonly logger: Logger,
  ) {
    this.pollMs = normalizePositiveInt(config.pollMs, DEFAULT_POLL_MS);
    this.debounceMs = normalizeNonNegativeInt(config.debounceMs, DEFAULT_DEBOUNCE_MS);
    this.pageSize = normalizePositiveInt(config.pageSize, DEFAULT_PAGE_SIZE);
    this.syncOnStart = config.syncOnStart ?? true;
  }

  start(): void {
    if (this.pollTimer || this.destroyed) return;
    this.pollTimer = setInterval(() => {
      void this.checkNow('poll');
    }, this.pollMs);
    this.pollTimer.unref?.();
    void this.checkNow('startup');
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  async checkNow(reason = 'manual'): Promise<void> {
    if (this.destroyed) return;

    let snapshot: MemorySnapshot;
    try {
      snapshot = await this.buildSnapshot();
    } catch (err: any) {
      this.logger.warn({ err: err?.message || err, reason }, 'Wiki auto-sync snapshot failed');
      return;
    }

    if (this.lastSnapshotHash === undefined) {
      this.lastSnapshotHash = snapshot.hash;
      this.logger.info({
        reason,
        folderCount: snapshot.folderCount,
        documentCount: snapshot.documentCount,
        syncOnStart: this.syncOnStart,
      }, 'Wiki auto-sync baseline captured');
      if (this.syncOnStart) {
        this.scheduleSync('startup');
      }
      return;
    }

    if (snapshot.hash === this.lastSnapshotHash) {
      this.logger.debug({
        reason,
        folderCount: snapshot.folderCount,
        documentCount: snapshot.documentCount,
      }, 'Wiki auto-sync snapshot unchanged');
      return;
    }

    this.lastSnapshotHash = snapshot.hash;
    this.logger.info({
      reason,
      folderCount: snapshot.folderCount,
      documentCount: snapshot.documentCount,
    }, 'Wiki auto-sync detected MetaMemory changes');
    this.scheduleSync(reason);
  }

  private scheduleSync(reason: string): void {
    if (this.destroyed) return;
    this.lastScheduledReason = reason;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runSync(this.lastScheduledReason);
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private async runSync(reason: string): Promise<void> {
    if (this.destroyed) return;

    if (this.running) {
      this.pendingAfterRun = true;
      return;
    }

    if (this.docSync.isSyncing()) {
      this.logger.info({ reason, retryInMs: this.debounceMs }, 'Wiki auto-sync delayed because another wiki sync is already running');
      this.scheduleSync('retry after active wiki sync');
      return;
    }

    this.running = true;
    try {
      const result = await this.docSync.syncAll();
      this.logSyncResult(reason, result);
    } catch (err: any) {
      this.logger.error({ err: err?.message || err, reason }, 'Wiki auto-sync failed');
    } finally {
      this.running = false;
      if (this.pendingAfterRun && !this.destroyed) {
        this.pendingAfterRun = false;
        this.scheduleSync('pending changes after previous auto-sync');
      }
    }
  }

  private async buildSnapshot(): Promise<MemorySnapshot> {
    const [folderTree, documents] = await Promise.all([
      this.memoryClient.listFolderTree(),
      this.listAllDocuments(),
    ]);
    const folders = flattenFolders(folderTree);
    const hash = createHash('sha256');
    for (const folder of folders) {
      hash.update(`folder\t${folder.id}\t${folder.path}\t${folder.name}\t${folder.document_count}\n`);
    }
    for (const doc of documents) {
      hash.update(`doc\t${doc.id}\t${doc.folder_id}\t${doc.path}\t${doc.title}\t${doc.updated_at}\t${doc.tags.join(',')}\n`);
    }
    return {
      hash: hash.digest('hex'),
      folderCount: folders.length,
      documentCount: documents.length,
    };
  }

  private async listAllDocuments(): Promise<DocumentSummary[]> {
    const documents: DocumentSummary[] = [];
    let offset = 0;
    while (true) {
      const page = await this.memoryClient.listDocuments(undefined, this.pageSize, offset);
      documents.push(...page);
      if (page.length < this.pageSize) break;
      offset += page.length;
    }
    documents.sort((a, b) => a.id.localeCompare(b.id));
    return documents.map((doc) => ({
      ...doc,
      tags: [...(doc.tags || [])].sort(),
    }));
  }

  private logSyncResult(reason: string, result: SyncResult): void {
    const payload = {
      reason,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      deleted: result.deleted,
      errors: result.errors.length,
      durationMs: result.durationMs,
    };
    if (result.errors.length > 0) {
      this.logger.warn(payload, 'Wiki auto-sync completed with errors');
    } else {
      this.logger.info(payload, 'Wiki auto-sync completed');
    }
  }
}

function flattenFolders(root: FolderTreeNode): FolderTreeNode[] {
  const folders: FolderTreeNode[] = [];
  const visit = (node: FolderTreeNode) => {
    folders.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  folders.sort((a, b) => a.id.localeCompare(b.id));
  return folders;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0 ? Math.floor(value) : fallback;
}
