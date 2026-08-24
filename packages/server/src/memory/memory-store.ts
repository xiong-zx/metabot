import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Credential } from '../auth/credentials.js';
import { canReadDoc, canReadPath, canWritePath, joinPath, normalizePath, readableRoots } from './acl.js';
import { isHiddenFromMemoryView } from './hidden-paths.js';

export const ALLOWED_CONTENT_TYPES = ['text/markdown', 'text/html'] as const;
export type ContentType = (typeof ALLOWED_CONTENT_TYPES)[number];
const DEFAULT_CONTENT_TYPE: ContentType = 'text/markdown';

export function isAllowedContentType(value: unknown): value is ContentType {
  return typeof value === 'string'
    && (ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);
}

export function assertContentType(value: unknown): ContentType {
  if (value === undefined || value === null) return DEFAULT_CONTENT_TYPE;
  if (!isAllowedContentType(value)) {
    throw Object.assign(new Error('unsupported_content_type'), { statusCode: 400 });
  }
  return value;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
  created_at: string;
  updated_at: string;
}

export interface FolderTreeNode {
  id: string;
  name: string;
  path: string;
  children: FolderTreeNode[];
  document_count: number;
}

export interface Document {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content: string;
  content_type: ContentType;
  tags: string[];
  shared: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number;
  index_role: string | null;
  project_key: string | null;
  index_keywords: string[];
  index_summary: string | null;
}

export interface DocumentSummary {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content_type: ContentType;
  tags: string[];
  shared: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number;
  index_role: string | null;
  project_key: string | null;
  index_keywords: string[];
  index_summary: string | null;
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  content_type: ContentType;
  snippet: string;
  tags: string[];
  shared: boolean;
  created_by: string;
  updated_at: string;
}

export interface DocumentCreateInput {
  title: string;
  folder_id?: string;
  path?: string;
  content?: string;
  content_type?: string;
  tags?: string[];
  shared?: boolean;
  created_by?: string;
  index_role?: string | null;
  project_key?: string | null;
  index_keywords?: string[];
  index_summary?: string | null;
}

export interface DocumentUpdateInput {
  title?: string;
  content?: string;
  content_type?: string;
  tags?: string[];
  shared?: boolean;
  folder_id?: string;
  expected_version?: number;
  index_role?: string | null;
  project_key?: string | null;
  index_keywords?: string[];
  index_summary?: string | null;
}

export type DocumentChangeOperation = 'create' | 'update' | 'delete' | 'move';
export type DocumentChangeOrigin = 'api' | 'indexer' | 'reconciler' | 't5t';
export type DocumentChangeReviewOutcome = 'pending' | 'accepted' | 'corrected' | 'rejected';
export interface DocumentRoutingMetadata {
  index_role: string | null;
  project_key: string | null;
  index_keywords: string[];
  index_summary: string | null;
}
export type DocumentChangeProcessingStatus =
  | 'pending'
  | 'proposed'
  | 'applied'
  | 'skipped'
  | 'failed'
  | 'dead';

export interface DocumentChangeEvent {
  id: number;
  event_uuid: string;
  ts: string;
  op: DocumentChangeOperation;
  cascade_of: string | null;
  doc_id: string;
  actor: string;
  origin: DocumentChangeOrigin;
  old_path: string | null;
  new_path: string | null;
  old_title: string | null;
  new_title: string | null;
  old_tags: string[];
  new_tags: string[];
  old_shared: boolean | null;
  new_shared: boolean | null;
  old_version: number | null;
  new_version: number | null;
  old_content_hash: string | null;
  new_content_hash: string | null;
  content_changed: boolean;
  changed_fields: string[];
  old_excerpt: string | null;
  new_excerpt: string | null;
  old_routing: DocumentRoutingMetadata | null;
  new_routing: DocumentRoutingMetadata | null;
}

export interface DocumentChangeEventPage {
  events: DocumentChangeEvent[];
  next_after: number;
}

export interface DocumentChangeConsumerState {
  consumer: string;
  last_event_id: number;
  updated_at: string;
  initialized: boolean;
  latest_event_id: number;
}

export interface DocumentChangeProcessing {
  consumer: string;
  event_id: number;
  status: DocumentChangeProcessingStatus;
  attempts: number;
  proposal_ref: string | null;
  proposal_json: Record<string, unknown> | null;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  review_outcome: DocumentChangeReviewOutcome | null;
  error: string | null;
  updated_at: string;
}

export interface RecordDocumentChangeProcessingInput {
  consumer: string;
  event_ids: number[];
  through_event_id: number;
  status: DocumentChangeProcessingStatus;
  proposal_ref?: string;
  proposal?: Record<string, unknown>;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  review_outcome?: DocumentChangeReviewOutcome;
  error?: string;
  advance_cursor?: boolean;
  increment_attempts?: boolean;
}

export interface DocumentChangeStats {
  total: number;
  latest_event_id: number;
  by_operation: Record<DocumentChangeOperation, number>;
  consumer_lag: Array<{
    consumer: string;
    last_event_id: number;
    lag: number;
    updated_at: string;
  }>;
}

export interface RoutingIndexSnapshot {
  id: number;
  doc_id: string;
  source_version: number;
  content: string;
  created_at: string;
}

export interface RoutingIndexRebuildResult {
  changed: boolean;
  document: Document;
  snapshot_id: number | null;
}

export interface FolderCreateInput {
  name: string;
  parent_id?: string;
  path?: string;
}

export interface FolderUpdateInput {
  name?: string;
  parent_id?: string;
  path?: string;
}

function nowISO(): string {
  return new Date().toISOString();
}

const DOCUMENT_CHANGE_EXCERPT_MAX_BYTES = 2 * 1024;
const DOCUMENT_CHANGE_DEFAULT_LIMIT = 100;
const DOCUMENT_CHANGE_MAX_LIMIT = 500;

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function boundedUtf8Prefix(content: string, maxBytes = DOCUMENT_CHANGE_EXCERPT_MAX_BYTES): string {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1] || '')) end -= 1;
  return content.slice(0, end);
}

function boundedChangeExcerpts(
  oldContent: string | null,
  newContent: string | null,
): { oldExcerpt: string | null; newExcerpt: string | null } {
  if (oldContent === null) {
    return {
      oldExcerpt: null,
      newExcerpt: newContent === null ? null : boundedUtf8Prefix(newContent),
    };
  }
  if (newContent === null) {
    return { oldExcerpt: boundedUtf8Prefix(oldContent), newExcerpt: null };
  }
  let pivot = 0;
  const sharedLength = Math.min(oldContent.length, newContent.length);
  while (pivot < sharedLength && oldContent[pivot] === newContent[pivot]) pivot += 1;
  return {
    oldExcerpt: boundedUtf8Window(oldContent, pivot),
    newExcerpt: boundedUtf8Window(newContent, pivot),
  };
}

function boundedUtf8Window(content: string, pivot: number): string {
  if (Buffer.byteLength(content, 'utf8') <= DOCUMENT_CHANGE_EXCERPT_MAX_BYTES) return content;
  let start = Math.max(0, pivot - 256);
  if (/[\uDC00-\uDFFF]/.test(content[start] || '')) start -= 1;
  const header = start > 0 ? `[excerpt offset=${start}]\n` : '';
  return header + boundedUtf8Prefix(
    content.slice(start),
    DOCUMENT_CHANGE_EXCERPT_MAX_BYTES - Buffer.byteLength(header, 'utf8'),
  );
}

function watchedSemanticRoot(): string {
  return normalizePath(
    process.env.METABOT_MEMORY_INDEX_WATCH_ROOT
      || process.env.METABOT_CORE_MEMORY_SERVER_ROOT
      || '/cargo1',
  );
}

function isWatchedSemanticPath(path: string | null): boolean {
  if (!path || isHiddenFromMemoryView(path)) return false;
  const root = watchedSemanticRoot();
  if (!(path === root || path.startsWith(`${root}/`))) return false;
  return ![
    `${root}/index`,
    `${root}/status`,
  ].some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

function normalizeExpectedVersion(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw Object.assign(new Error('invalid_expected_version'), { statusCode: 400 });
  }
  return value;
}

function normalizeChangeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DOCUMENT_CHANGE_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit!), 1), DOCUMENT_CHANGE_MAX_LIMIT);
}

function normalizeRoutingIdentifier(
  value: string | null | undefined,
  field: 'index_role' | 'project_key',
): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const normalized = value.trim();
  const pattern = field === 'index_role'
    ? /^[a-z][a-z0-9_-]{0,31}$/
    : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  if (!pattern.test(normalized)) {
    throw Object.assign(new Error(`invalid_${field}`), { statusCode: 400 });
  }
  return normalized;
}

function normalizeIndexKeywords(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw Object.assign(new Error('invalid_index_keywords'), { statusCode: 400 });
  }
  const keywords = [...new Set(value.map((item) => {
    if (typeof item !== 'string') {
      throw Object.assign(new Error('invalid_index_keywords'), { statusCode: 400 });
    }
    return item.trim();
  }).filter(Boolean))];
  if (keywords.some((item) => item.length > 64 || /[\r\n|]/.test(item))) {
    throw Object.assign(new Error('invalid_index_keywords'), { statusCode: 400 });
  }
  return keywords;
}

function normalizeIndexSummary(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length > 280) {
    throw Object.assign(new Error('invalid_index_summary'), { statusCode: 400 });
  }
  return normalized;
}

function routingMetadata(doc: Document): DocumentRoutingMetadata {
  return {
    index_role: doc.index_role,
    project_key: doc.project_key,
    index_keywords: doc.index_keywords,
    index_summary: doc.index_summary,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

export function escapeFts5Query(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' ') || '""';
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* ignore */ }
  }
  return [];
}

export class MemoryStore {
  private db: Database.Database;
  private logger: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        parent_id  TEXT REFERENCES folders(id),
        path       TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        folder_id    TEXT NOT NULL DEFAULT 'root' REFERENCES folders(id),
        path         TEXT UNIQUE NOT NULL,
        content      BLOB NOT NULL DEFAULT '',
        content_type TEXT NOT NULL DEFAULT 'text/markdown',
        tags         TEXT NOT NULL DEFAULT '[]',
        shared       INTEGER NOT NULL DEFAULT 0,
        created_by   TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        version      INTEGER NOT NULL DEFAULT 0,
        index_role   TEXT,
        project_key  TEXT,
        index_keywords TEXT NOT NULL DEFAULT '[]',
        index_summary TEXT
      );

      CREATE INDEX IF NOT EXISTS documents_folder_id_idx ON documents(folder_id);

      -- Listing endpoints all sort by updated_at DESC (home feed, prefix
      -- listing) or filter by folder then sort (folder view). Without these,
      -- SQLite full-scans the documents table and sorts in a temp B-tree —
      -- and since rows store large inline content BLOBs, that scan reads
      -- hundreds of MB just to return 50 metadata rows (observed 2.9s on a
      -- 757MB db). A covering-ish index on the sort key makes it O(limit).
      CREATE INDEX IF NOT EXISTS documents_updated_at_idx ON documents(updated_at DESC);
      CREATE INDEX IF NOT EXISTS documents_folder_updated_idx ON documents(folder_id, updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        title, content, tags, doc_id UNINDEXED
      );

      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(doc_id, title, content, tags)
        VALUES (new.id, new.title, CAST(new.content AS TEXT), new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
        INSERT INTO documents_fts(doc_id, title, content, tags)
        VALUES (new.id, new.title, CAST(new.content AS TEXT), new.tags);
      END;

      CREATE TABLE IF NOT EXISTS document_change_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        event_uuid       TEXT UNIQUE NOT NULL,
        ts               TEXT NOT NULL,
        op               TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete', 'move')),
        cascade_of       TEXT,
        doc_id           TEXT NOT NULL,
        actor            TEXT NOT NULL,
        origin           TEXT NOT NULL CHECK (origin IN ('api', 'indexer', 'reconciler', 't5t')),
        old_path         TEXT,
        new_path         TEXT,
        old_title        TEXT,
        new_title        TEXT,
        old_tags         TEXT NOT NULL DEFAULT '[]',
        new_tags         TEXT NOT NULL DEFAULT '[]',
        old_shared       INTEGER,
        new_shared       INTEGER,
        old_version      INTEGER,
        new_version      INTEGER,
        old_content_hash TEXT,
        new_content_hash TEXT,
        content_changed  INTEGER NOT NULL DEFAULT 0,
        changed_fields   TEXT NOT NULL DEFAULT '[]',
        old_excerpt      TEXT,
        new_excerpt      TEXT,
        old_routing      TEXT,
        new_routing      TEXT
      );

      CREATE INDEX IF NOT EXISTS document_change_events_doc_idx
        ON document_change_events(doc_id, id);
      CREATE INDEX IF NOT EXISTS document_change_events_path_idx
        ON document_change_events(new_path, old_path, id);

      CREATE TABLE IF NOT EXISTS index_consumer_state (
        consumer      TEXT PRIMARY KEY,
        last_event_id INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS index_event_processing (
        consumer      TEXT NOT NULL,
        event_id      INTEGER NOT NULL,
        status        TEXT NOT NULL CHECK (
          status IN ('pending', 'proposed', 'applied', 'skipped', 'failed', 'dead')
        ),
        attempts      INTEGER NOT NULL DEFAULT 0,
        proposal_ref  TEXT,
        proposal_json TEXT,
        tokens_in     INTEGER NOT NULL DEFAULT 0,
        tokens_out    INTEGER NOT NULL DEFAULT 0,
        latency_ms    INTEGER NOT NULL DEFAULT 0,
        review_outcome TEXT CHECK (
          review_outcome IS NULL
          OR review_outcome IN ('pending', 'accepted', 'corrected', 'rejected')
        ),
        error         TEXT,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (consumer, event_id),
        FOREIGN KEY (event_id) REFERENCES document_change_events(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS index_event_processing_status_idx
        ON index_event_processing(consumer, status, event_id);

      CREATE TABLE IF NOT EXISTS index_event_processing_audit (
        consumer       TEXT NOT NULL,
        event_id       INTEGER NOT NULL,
        status         TEXT NOT NULL CHECK (
          status IN ('pending', 'proposed', 'applied', 'skipped', 'failed', 'dead')
        ),
        attempts       INTEGER NOT NULL DEFAULT 0,
        proposal_ref   TEXT,
        proposal_json  TEXT,
        tokens_in      INTEGER NOT NULL DEFAULT 0,
        tokens_out     INTEGER NOT NULL DEFAULT 0,
        latency_ms     INTEGER NOT NULL DEFAULT 0,
        review_outcome TEXT CHECK (
          review_outcome IS NULL
          OR review_outcome IN ('pending', 'accepted', 'corrected', 'rejected')
        ),
        error          TEXT,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (consumer, event_id)
      );

      CREATE INDEX IF NOT EXISTS index_event_processing_audit_status_idx
        ON index_event_processing_audit(consumer, status, event_id);

      CREATE TABLE IF NOT EXISTS routing_index_snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id         TEXT NOT NULL,
        source_version INTEGER NOT NULL,
        content        BLOB NOT NULL,
        created_at     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS routing_index_snapshots_doc_idx
        ON routing_index_snapshots(doc_id, id DESC);
    `);

    // Idempotent column migration for pre-content_type databases.
    const cols = this.db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'content_type')) {
      this.db.exec(
        "ALTER TABLE documents ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text/markdown'",
      );
    }

    // Idempotent column migration for `shared` (added 2026-05-29). The
    // doc-level sharing flag that replaced path-based `/shared/` sharing.
    // Existing rows default to 0 (private); a one-time backfill marks legacy
    // `/shared/...` docs as shared so they stay cross-readable after the read
    // model stops blanket-allowing the `/shared` path. See
    // [[decision-memory-share-flag]].
    if (!cols.some((c) => c.name === 'shared')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
      this.db.exec("UPDATE documents SET shared = 1 WHERE path LIKE '/shared/%'");
    }
    if (!cols.some((c) => c.name === 'version')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.some((c) => c.name === 'index_role')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN index_role TEXT');
    }
    if (!cols.some((c) => c.name === 'project_key')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN project_key TEXT');
    }
    if (!cols.some((c) => c.name === 'index_keywords')) {
      this.db.exec("ALTER TABLE documents ADD COLUMN index_keywords TEXT NOT NULL DEFAULT '[]'");
    }
    if (!cols.some((c) => c.name === 'index_summary')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN index_summary TEXT');
    }

    const eventCols = this.db.prepare(
      "PRAGMA table_info(document_change_events)",
    ).all() as { name: string }[];
    if (!eventCols.some((c) => c.name === 'old_routing')) {
      this.db.exec('ALTER TABLE document_change_events ADD COLUMN old_routing TEXT');
    }
    if (!eventCols.some((c) => c.name === 'new_routing')) {
      this.db.exec('ALTER TABLE document_change_events ADD COLUMN new_routing TEXT');
    }

    const processingCols = this.db.prepare(
      "PRAGMA table_info(index_event_processing)",
    ).all() as { name: string }[];
    if (!processingCols.some((c) => c.name === 'latency_ms')) {
      this.db.exec(
        'ALTER TABLE index_event_processing ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!processingCols.some((c) => c.name === 'review_outcome')) {
      this.db.exec('ALTER TABLE index_event_processing ADD COLUMN review_outcome TEXT');
    }
    this.db.exec(`
      INSERT OR IGNORE INTO index_event_processing_audit (
        consumer, event_id, status, attempts, proposal_ref, proposal_json,
        tokens_in, tokens_out, latency_ms, review_outcome, error, updated_at
      )
      SELECT
        consumer, event_id, status, attempts, proposal_ref, proposal_json,
        tokens_in, tokens_out, latency_ms, review_outcome, error, updated_at
      FROM index_event_processing
    `);

    // Seed root folder
    const root = this.db.prepare('SELECT id FROM folders WHERE id = ?').get('root');
    if (!root) {
      const now = nowISO();
      this.db.prepare(
        'INSERT INTO folders (id, name, parent_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('root', 'Root', null, '/', now, now);
    }
  }

  private emitDocumentChange(input: {
    op: DocumentChangeOperation;
    oldDoc: Document | null;
    newDoc: Document | null;
    cred: Credential;
    cascadeOf?: string;
    origin?: DocumentChangeOrigin;
  }): number {
    const { oldDoc, newDoc } = input;
    const oldContent = oldDoc?.content ?? null;
    const newContent = newDoc?.content ?? null;
    const oldHash = oldContent === null ? null : contentHash(oldContent);
    const newHash = newContent === null ? null : contentHash(newContent);
    const contentChanged = oldHash !== newHash;
    const changedFields = documentChangedFields(oldDoc, newDoc);
    const watched = isWatchedSemanticPath(oldDoc?.path ?? null)
      || isWatchedSemanticPath(newDoc?.path ?? null);
    const excerpts = watched && contentChanged
      ? boundedChangeExcerpts(oldContent, newContent)
      : { oldExcerpt: null, newExcerpt: null };
    const origin = input.origin
      ?? (isHiddenFromMemoryView(oldDoc?.path ?? newDoc?.path ?? '') ? 't5t' : 'api');
    const eventUuid = crypto.randomUUID();
    const result = this.db.prepare(`
      INSERT INTO document_change_events (
        event_uuid, ts, op, cascade_of, doc_id, actor, origin,
        old_path, new_path, old_title, new_title, old_tags, new_tags,
        old_shared, new_shared, old_version, new_version,
        old_content_hash, new_content_hash, content_changed, changed_fields,
        old_excerpt, new_excerpt, old_routing, new_routing
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      eventUuid,
      nowISO(),
      input.op,
      input.cascadeOf ?? null,
      newDoc?.id ?? oldDoc?.id ?? '',
      input.cred.botName,
      origin,
      oldDoc?.path ?? null,
      newDoc?.path ?? null,
      oldDoc?.title ?? null,
      newDoc?.title ?? null,
      JSON.stringify(oldDoc?.tags ?? []),
      JSON.stringify(newDoc?.tags ?? []),
      oldDoc ? (oldDoc.shared ? 1 : 0) : null,
      newDoc ? (newDoc.shared ? 1 : 0) : null,
      oldDoc?.version ?? null,
      newDoc?.version ?? null,
      oldHash,
      newHash,
      contentChanged ? 1 : 0,
      JSON.stringify(changedFields),
      excerpts.oldExcerpt,
      excerpts.newExcerpt,
      oldDoc ? JSON.stringify(routingMetadata(oldDoc)) : null,
      newDoc ? JSON.stringify(routingMetadata(newDoc)) : null,
    );
    return Number(result.lastInsertRowid);
  }

  // ---- Folder operations ----

  /** Resolve the path a new folder would take given input. */
  private computeFolderPath(parentId: string, name: string): string {
    const parent = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(parentId) as { path: string } | undefined;
    if (!parent) throw new Error(`Parent folder not found: ${parentId}`);
    return joinPath(parent.path, name);
  }

  /**
   * Ensure all ancestor folders along `path` exist (admin-only, used during
   * member writes so members can create docs under `/users/<bot>` without
   * pre-creating each segment).
   */
  ensureFolderPath(targetPath: string): Folder {
    const normalized = normalizePath(targetPath);
    if (normalized === '/') {
      return this.findFolderByPath('/')!;
    }
    const parts = normalized.slice(1).split('/');
    let parent = this.findFolderByPath('/')!;
    let curPath = '';
    for (const part of parts) {
      curPath += '/' + part;
      let f = this.findFolderByPath(curPath);
      if (!f) {
        const id = crypto.randomUUID();
        const now = nowISO();
        this.db.prepare(
          'INSERT INTO folders (id, name, parent_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, part, parent.id, curPath, now, now);
        f = { id, name: part, parent_id: parent.id, path: curPath, created_at: now, updated_at: now };
      }
      parent = f;
    }
    return parent;
  }

  createFolder(input: FolderCreateInput, cred: Credential): Folder {
    let folderPath: string;
    let parentId: string;
    let name: string;

    if (input.path) {
      folderPath = normalizePath(input.path);
      const segments = folderPath === '/' ? [] : folderPath.slice(1).split('/');
      name = segments[segments.length - 1] || 'root';
      const parentPath = segments.length <= 1 ? '/' : '/' + segments.slice(0, -1).join('/');
      // Auto-create intermediate folders if the caller has write access on
      // any ancestor of the target path. This keeps the create-by-path UX
      // ergonomic without an extra create-each-segment dance.
      if (!canWritePath(cred, folderPath)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
      const parent = this.ensureFolderPath(parentPath);
      parentId = parent.id;
    } else {
      name = input.name;
      parentId = input.parent_id || 'root';
      folderPath = this.computeFolderPath(parentId, name);
    }

    if (!canWritePath(cred, folderPath)) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }

    const existing = this.findFolderByPath(folderPath);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const now = nowISO();
    this.db.prepare(
      'INSERT INTO folders (id, name, parent_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, name, parentId, folderPath, now, now);
    return { id, name, parent_id: parentId, path: folderPath, created_at: now, updated_at: now };
  }

  findFolderByPath(path: string): Folder | null {
    const normalized = normalizePath(path);
    const row = this.db.prepare('SELECT * FROM folders WHERE path = ?').get(normalized) as Folder | undefined;
    return row ?? null;
  }

  findFolderById(id: string): Folder | null {
    const row = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Folder | undefined;
    return row ?? null;
  }

  /** List folders with optional prefix filter, ACL-applied. */
  listFolders(prefix: string | undefined, cred: Credential): Folder[] {
    let rows: Folder[];
    if (prefix) {
      const p = normalizePath(prefix);
      const like = p === '/' ? '%' : `${escapeLikePattern(p)}/%`;
      rows = this.db.prepare("SELECT * FROM folders WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY path")
        .all(p, like) as Folder[];
    } else {
      rows = this.db.prepare('SELECT * FROM folders ORDER BY path').all() as Folder[];
    }
    return rows.filter((f) => canReadPath(cred, f.path));
  }

  getFolderTree(cred: Credential): FolderTreeNode {
    const folders = this.listFolders(undefined, cred);
    const docCounts = this.db.prepare(
      'SELECT folder_id, COUNT(*) as count FROM documents GROUP BY folder_id',
    ).all() as { folder_id: string; count: number }[];
    const countMap = new Map<string, number>();
    for (const r of docCounts) countMap.set(r.folder_id, r.count);

    const nodeMap = new Map<string, FolderTreeNode>();
    for (const f of folders) {
      nodeMap.set(f.id, {
        id: f.id, name: f.name, path: f.path, children: [],
        document_count: countMap.get(f.id) || 0,
      });
    }

    let root: FolderTreeNode | undefined;
    for (const f of folders) {
      const node = nodeMap.get(f.id)!;
      if (f.parent_id && nodeMap.has(f.parent_id)) {
        nodeMap.get(f.parent_id)!.children.push(node);
      } else if (!f.parent_id || f.id === 'root') {
        root = node;
      }
    }
    return root || { id: 'root', name: 'Root', path: '/', children: [], document_count: 0 };
  }

  deleteFolder(folderIdOrPath: string, cred: Credential): void {
    const folder = this.resolveFolder(folderIdOrPath);
    if (!folder) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    if (folder.id === 'root') throw Object.assign(new Error('cannot_delete_root'), { statusCode: 400 });
    if (!canWritePath(cred, folder.path)) throw Object.assign(new Error('forbidden'), { statusCode: 403 });

    const prefix = `${folder.path}/`;
    const descendantPattern = `${escapeLikePattern(prefix)}%`;
    const documents = this.db.prepare(
      `SELECT * FROM documents WHERE path LIKE ? ESCAPE '\\' ORDER BY path`,
    ).all(descendantPattern) as RawDocRow[];
    const folders = this.db.prepare(
      `SELECT id FROM folders WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY length(path) DESC`,
    ).all(folder.path, descendantPattern) as { id: string }[];
    const cascadeOf = crypto.randomUUID();

    const tx = this.db.transaction(() => {
      for (const row of documents) {
        const oldDoc = rowToDoc(row);
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
        this.emitDocumentChange({
          op: 'delete',
          oldDoc,
          newDoc: null,
          cred,
          cascadeOf,
        });
      }
      for (const child of folders) {
        this.db.prepare('DELETE FROM folders WHERE id = ?').run(child.id);
      }
    });
    tx();
  }

  updateFolder(folderIdOrPath: string, data: FolderUpdateInput, cred: Credential): Folder | null {
    const folder = this.resolveFolder(folderIdOrPath);
    if (!folder) return null;
    if (folder.id === 'root') throw Object.assign(new Error('cannot_update_root'), { statusCode: 400 });
    if (!canWritePath(cred, folder.path)) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }

    const target = this.resolveFolderUpdateTarget(folder, data);
    if (!canWritePath(cred, target.path)) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }

    const existing = this.findFolderByPath(target.path);
    if (existing && existing.id !== folder.id) {
      throw Object.assign(new Error('already_exists'), { statusCode: 409 });
    }

    if (
      target.path === folder.path
      && target.name === folder.name
      && target.parent_id === folder.parent_id
    ) {
      return folder;
    }

    const oldPath = folder.path;
    const oldPrefix = oldPath === '/' ? '/' : `${oldPath}/`;
    const newPrefix = target.path === '/' ? '/' : `${target.path}/`;
    const oldDescendantPattern = `${escapeLikePattern(oldPrefix)}%`;
    const now = nowISO();
    const cascadeOf = crypto.randomUUID();

    const tx = this.db.transaction(() => {
      this.db.prepare(
        'UPDATE folders SET name = ?, parent_id = ?, path = ?, updated_at = ? WHERE id = ?',
      ).run(target.name, target.parent_id, target.path, now, folder.id);

      const descendants = this.db.prepare(
        `SELECT id, path FROM folders WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path) ASC`,
      ).all(oldDescendantPattern) as { id: string; path: string }[];
      for (const descendant of descendants) {
        const nextPath = `${newPrefix}${descendant.path.slice(oldPrefix.length)}`;
        this.db.prepare('UPDATE folders SET path = ?, updated_at = ? WHERE id = ?')
          .run(nextPath, now, descendant.id);
      }

      const docs = this.db.prepare(
        `SELECT * FROM documents WHERE path LIKE ? ESCAPE '\\' ORDER BY path`,
      ).all(oldDescendantPattern) as RawDocRow[];
      for (const row of docs) {
        const oldDoc = rowToDoc(row);
        const nextPath = `${newPrefix}${row.path.slice(oldPrefix.length)}`;
        const nextVersion = oldDoc.version + 1;
        this.db.prepare(
          'UPDATE documents SET path = ?, updated_at = ?, version = ? WHERE id = ?',
        ).run(nextPath, now, nextVersion, row.id);
        this.emitDocumentChange({
          op: 'move',
          oldDoc,
          newDoc: {
            ...oldDoc,
            path: nextPath,
            updated_at: now,
            version: nextVersion,
          },
          cred,
          cascadeOf,
        });
      }
    });
    tx();

    return this.findFolderById(folder.id);
  }

  private resolveFolderUpdateTarget(folder: Folder, data: FolderUpdateInput): { name: string; parent_id: string | null; path: string } {
    if (data.path !== undefined) {
      const path = normalizePath(data.path);
      if (path === '/') throw Object.assign(new Error('cannot_update_root'), { statusCode: 400 });
      const segments = path.slice(1).split('/');
      const name = segments[segments.length - 1] || folder.name;
      const parentPath = segments.length <= 1 ? '/' : '/' + segments.slice(0, -1).join('/');
      if (parentPath === folder.path || parentPath.startsWith(folder.path + '/')) {
        throw Object.assign(new Error('cannot_move_folder_into_itself'), { statusCode: 400 });
      }
      const parent = this.ensureFolderPath(parentPath);
      return { name, parent_id: parent.id, path };
    }

    const name = data.name ?? folder.name;
    const parentId = data.parent_id ?? folder.parent_id ?? 'root';
    if (parentId === folder.id) {
      throw Object.assign(new Error('cannot_move_folder_into_itself'), { statusCode: 400 });
    }
    const parent = this.findFolderById(parentId);
    if (!parent) throw Object.assign(new Error('folder_not_found'), { statusCode: 404 });
    if (parent.path === folder.path || parent.path.startsWith(folder.path + '/')) {
      throw Object.assign(new Error('cannot_move_folder_into_itself'), { statusCode: 400 });
    }
    return { name, parent_id: parent.id, path: joinPath(parent.path, name) };
  }

  private resolveFolder(idOrPath: string): Folder | null {
    if (idOrPath.startsWith('/')) return this.findFolderByPath(idOrPath);
    return this.findFolderById(idOrPath);
  }

  // ---- Document operations ----

  createDocument(data: DocumentCreateInput, cred: Credential): Document {
    let folderId: string;
    let docPath: string;
    let title = data.title;

    if (data.path) {
      const normalized = normalizePath(data.path);
      const segments = normalized.slice(1).split('/');
      const folderPath = segments.length <= 1 ? '/' : '/' + segments.slice(0, -1).join('/');
      const last = segments[segments.length - 1];
      if (!canWritePath(cred, normalized)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
      const folder = this.ensureFolderPath(folderPath);
      folderId = folder.id;
      docPath = normalized;
      if (!title) title = last;
    } else {
      folderId = data.folder_id || 'root';
      const folder = this.findFolderById(folderId);
      if (!folder) throw Object.assign(new Error('folder_not_found'), { statusCode: 404 });
      docPath = joinPath(folder.path, slugify(title));
      if (!canWritePath(cred, docPath)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
    }

    const existing = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(docPath);
    if (existing) {
      throw Object.assign(new Error('already_exists'), { statusCode: 409 });
    }

    const contentType = assertContentType(data.content_type);
    const id = crypto.randomUUID();
    const now = nowISO();
    const tags = JSON.stringify(data.tags || []);
    const shared = data.shared === true;
    const indexRole = normalizeRoutingIdentifier(data.index_role, 'index_role');
    const projectKey = normalizeRoutingIdentifier(data.project_key, 'project_key');
    const indexKeywords = normalizeIndexKeywords(data.index_keywords);
    const indexSummary = normalizeIndexSummary(data.index_summary);
    const created: Document = {
      id, title, folder_id: folderId, path: docPath,
      content: data.content || '',
      content_type: contentType,
      tags: data.tags || [],
      shared,
      created_by: data.created_by || cred.botName,
      created_at: now, updated_at: now,
      version: 1,
      index_role: indexRole,
      project_key: projectKey,
      index_keywords: indexKeywords,
      index_summary: indexSummary,
    };
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO documents (
          id, title, folder_id, path, content, content_type, tags, shared,
          created_by, created_at, updated_at, version,
          index_role, project_key, index_keywords, index_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        title,
        folderId,
        docPath,
        created.content,
        contentType,
        tags,
        shared ? 1 : 0,
        created.created_by,
        now,
        now,
        created.version,
        indexRole,
        projectKey,
        JSON.stringify(indexKeywords),
        indexSummary,
      );
      this.emitDocumentChange({
        op: 'create',
        oldDoc: null,
        newDoc: created,
        cred,
      });
    });
    tx();
    return created;
  }

  getDocument(idOrPath: string, cred: Credential): Document | null {
    const row = (idOrPath.startsWith('/')
      ? this.db.prepare('SELECT * FROM documents WHERE path = ?').get(normalizePath(idOrPath))
      : this.db.prepare('SELECT * FROM documents WHERE id = ?').get(idOrPath)) as RawDocRow | undefined;
    if (!row) return null;
    if (!canReadDoc(cred, row.path, row.shared === 1)) return null;
    return rowToDoc(row);
  }

  /**
   * Look up a document's path by id or path, without applying any ACL.
   * Returns null when the document doesn't exist.
   *
   * Used by `/api/memory/*` route handlers to short-circuit hidden-path
   * lookups (e.g. `/t5t/*`) without leaking content. Never expose the result
   * to a caller — only use it to decide whether to 404 the request.
   */
  findDocumentPathById(idOrPath: string): string | null {
    const row = (idOrPath.startsWith('/')
      ? this.db.prepare('SELECT path FROM documents WHERE path = ?').get(normalizePath(idOrPath))
      : this.db.prepare('SELECT path FROM documents WHERE id = ?').get(idOrPath)) as { path: string } | undefined;
    return row ? row.path : null;
  }

  listDocuments(opts: { folder_id?: string; prefix?: string; limit?: number; offset?: number }, cred: Credential): DocumentSummary[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);

    let rows: RawDocRow[];
    if (opts.folder_id) {
      const folder = this.findFolderById(opts.folder_id);
      if (!folder || !canReadPath(cred, folder.path)) return [];
      rows = this.db.prepare(
        `SELECT id, title, folder_id, path, content_type, tags, shared,
                created_by, created_at, updated_at, version,
                index_role, project_key, index_keywords, index_summary
         FROM documents WHERE folder_id = ?
         ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ).all(opts.folder_id, limit, offset) as RawDocRow[];
    } else if (opts.prefix) {
      const p = normalizePath(opts.prefix);
      const like = p === '/' ? '%' : `${escapeLikePattern(p)}/%`;
      rows = this.db.prepare(
        `SELECT id, title, folder_id, path, content_type, tags, shared,
                created_by, created_at, updated_at, version,
                index_role, project_key, index_keywords, index_summary
         FROM documents WHERE path = ? OR path LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ).all(p, like, limit, offset) as RawDocRow[];
    } else {
      rows = this.db.prepare(
        `SELECT id, title, folder_id, path, content_type, tags, shared,
                created_by, created_at, updated_at, version,
                index_role, project_key, index_keywords, index_summary
         FROM documents ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ).all(limit, offset) as RawDocRow[];
    }

    return rows
      .filter((r) => canReadDoc(cred, r.path, r.shared === 1))
      .map((r) => ({
        id: r.id,
        title: r.title,
        folder_id: r.folder_id,
        path: r.path,
        content_type: normalizeStoredContentType(r.content_type),
        tags: parseTags(r.tags),
        shared: r.shared === 1,
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
        version: normalizeStoredVersion(r.version),
        index_role: r.index_role ?? null,
        project_key: r.project_key ?? null,
        index_keywords: parseTags(r.index_keywords),
        index_summary: r.index_summary ?? null,
      }));
  }

  listRoutingDocuments(root: string, cred: Credential): DocumentSummary[] {
    const normalizedRoot = normalizePath(root);
    const descendantPattern = normalizedRoot === '/'
      ? '/%'
      : `${escapeLikePattern(normalizedRoot)}/%`;
    const rows = this.db.prepare(`
      SELECT id, title, folder_id, path, content_type, tags, shared,
             created_by, created_at, updated_at, version,
             index_role, project_key, index_keywords, index_summary
      FROM documents
      WHERE index_role IS NOT NULL
        AND (path = ? OR path LIKE ? ESCAPE '\\')
      ORDER BY index_role ASC, project_key ASC, title ASC, path ASC
    `).all(normalizedRoot, descendantPattern) as RawDocRow[];
    return rows
      .filter((row) => canReadDoc(cred, row.path, row.shared === 1))
      .map((row) => {
        const doc = rowToDoc(row);
        const { content: _content, ...summary } = doc;
        return summary;
      });
  }

  rebuildRoutingIndexContent(
    idOrPath: string,
    content: string,
    expectedVersion: number,
    cred: Credential,
  ): RoutingIndexRebuildResult {
    const normalizedExpectedVersion = normalizeExpectedVersion(expectedVersion);
    const tx = this.db.transaction((): RoutingIndexRebuildResult => {
      const row = (idOrPath.startsWith('/')
        ? this.db.prepare('SELECT * FROM documents WHERE path = ?').get(normalizePath(idOrPath))
        : this.db.prepare('SELECT * FROM documents WHERE id = ?').get(idOrPath)) as RawDocRow | undefined;
      if (!row) {
        throw Object.assign(new Error('document_not_found'), { statusCode: 404 });
      }
      if (!canWritePath(cred, row.path)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
      const current = rowToDoc(row);
      if (current.version !== normalizedExpectedVersion) {
        throw Object.assign(new Error('version_conflict'), {
          statusCode: 409,
          expectedVersion: normalizedExpectedVersion,
          actualVersion: current.version,
        });
      }
      if (current.content === content) {
        return { changed: false, document: current, snapshot_id: null };
      }

      const snapshot = this.db.prepare(`
        INSERT INTO routing_index_snapshots (
          doc_id, source_version, content, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(current.id, current.version, current.content, nowISO());
      const updated = this.updateDocument(
        current.id,
        { content, expected_version: current.version },
        cred,
        'indexer',
      );
      if (!updated) throw new Error('routing_index_update_failed');
      this.db.prepare(`
        DELETE FROM routing_index_snapshots
        WHERE doc_id = ?
          AND id NOT IN (
            SELECT id FROM routing_index_snapshots
            WHERE doc_id = ?
            ORDER BY id DESC
            LIMIT 20
          )
      `).run(current.id, current.id);
      return {
        changed: true,
        document: updated,
        snapshot_id: Number(snapshot.lastInsertRowid),
      };
    });
    return tx();
  }

  listRoutingIndexSnapshots(
    docId: string,
    limit = 20,
  ): RoutingIndexSnapshot[] {
    const rows = this.db.prepare(`
      SELECT id, doc_id, source_version, content, created_at
      FROM routing_index_snapshots
      WHERE doc_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(docId, Math.min(Math.max(Math.floor(limit), 1), 100)) as Array<{
      id: number;
      doc_id: string;
      source_version: number;
      content: Buffer | string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      ...row,
      content: row.content.toString(),
    }));
  }

  updateDocument(
    idOrPath: string,
    data: DocumentUpdateInput,
    cred: Credential,
    origin?: DocumentChangeOrigin,
  ): Document | null {
    const expectedVersion = normalizeExpectedVersion(data.expected_version);
    const tx = this.db.transaction((): Document | null => {
      const row = (idOrPath.startsWith('/')
        ? this.db.prepare('SELECT * FROM documents WHERE path = ?').get(normalizePath(idOrPath))
        : this.db.prepare('SELECT * FROM documents WHERE id = ?').get(idOrPath)) as RawDocRow | undefined;
      if (!row) return null;
      if (!canWritePath(cred, row.path)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }

      const oldDoc = rowToDoc(row);
      if (expectedVersion !== undefined && expectedVersion !== oldDoc.version) {
        throw Object.assign(new Error('version_conflict'), {
          statusCode: 409,
          expectedVersion,
          actualVersion: oldDoc.version,
        });
      }

      const title = data.title ?? row.title;
      const content = data.content ?? row.content?.toString() ?? '';
      const tags = data.tags ?? parseTags(row.tags);
      const shared = data.shared ?? (row.shared === 1);
      const folderId = data.folder_id ?? row.folder_id;
      const contentType = data.content_type === undefined
        ? normalizeStoredContentType(row.content_type)
        : assertContentType(data.content_type);
      const indexRole = data.index_role === undefined
        ? oldDoc.index_role
        : normalizeRoutingIdentifier(data.index_role, 'index_role');
      const projectKey = data.project_key === undefined
        ? oldDoc.project_key
        : normalizeRoutingIdentifier(data.project_key, 'project_key');
      const indexKeywords = data.index_keywords === undefined
        ? oldDoc.index_keywords
        : normalizeIndexKeywords(data.index_keywords);
      const indexSummary = data.index_summary === undefined
        ? oldDoc.index_summary
        : normalizeIndexSummary(data.index_summary);

      let docPath = row.path;
      if (data.title !== undefined || data.folder_id !== undefined) {
        const folder = this.findFolderById(folderId);
        if (!folder) throw Object.assign(new Error('folder_not_found'), { statusCode: 404 });
        docPath = joinPath(folder.path, slugify(title));
        if (!canWritePath(cred, docPath)) {
          throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        }
      }

      const now = nowISO();
      const next: Document = {
        id: row.id,
        title,
        folder_id: folderId,
        path: docPath,
        content,
        content_type: contentType,
        tags,
        shared,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: now,
        version: oldDoc.version + 1,
        index_role: indexRole,
        project_key: projectKey,
        index_keywords: indexKeywords,
        index_summary: indexSummary,
      };
      this.db.prepare(
        `UPDATE documents SET
          title = ?, content = ?, content_type = ?, tags = ?, shared = ?,
          folder_id = ?, path = ?, updated_at = ?, version = ?,
          index_role = ?, project_key = ?, index_keywords = ?, index_summary = ?
         WHERE id = ?`,
      ).run(
        title,
        content,
        contentType,
        JSON.stringify(tags),
        shared ? 1 : 0,
        folderId,
        docPath,
        now,
        next.version,
        indexRole,
        projectKey,
        JSON.stringify(indexKeywords),
        indexSummary,
        row.id,
      );
      this.emitDocumentChange({
        op: docPath === oldDoc.path ? 'update' : 'move',
        oldDoc,
        newDoc: next,
        cred,
        origin,
      });
      return next;
    });
    return tx();
  }

  deleteDocument(idOrPath: string, cred: Credential): boolean {
    const tx = this.db.transaction((): boolean => {
      const row = (idOrPath.startsWith('/')
        ? this.db.prepare('SELECT * FROM documents WHERE path = ?').get(normalizePath(idOrPath))
        : this.db.prepare('SELECT * FROM documents WHERE id = ?').get(idOrPath)) as RawDocRow | undefined;
      if (!row) return false;
      if (!canWritePath(cred, row.path)) {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      }
      const oldDoc = rowToDoc(row);
      const result = this.db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
      if (result.changes > 0) {
        this.emitDocumentChange({
          op: 'delete',
          oldDoc,
          newDoc: null,
          cred,
        });
      }
      return result.changes > 0;
    });
    return tx();
  }

  listDocumentChangeEvents(opts: {
    after?: number;
    limit?: number;
    prefix?: string;
  } = {}): DocumentChangeEvent[] {
    return this.listDocumentChangeEventPage(opts).events;
  }

  listDocumentChangeEventPage(opts: {
    after?: number;
    limit?: number;
    prefix?: string;
  } = {}): DocumentChangeEventPage {
    const after = Number.isInteger(opts.after) && (opts.after ?? 0) >= 0 ? opts.after! : 0;
    const limit = normalizeChangeLimit(opts.limit);
    const prefix = opts.prefix ? normalizePath(opts.prefix) : undefined;
    const descendantPattern = prefix
      ? prefix === '/'
        ? '/%'
        : `${escapeLikePattern(prefix)}/%`
      : undefined;
    const query = prefix
      ? this.db.prepare(`
          SELECT * FROM document_change_events
          WHERE id > ?
            AND (
              old_path = ? OR old_path LIKE ? ESCAPE '\\'
              OR new_path = ? OR new_path LIKE ? ESCAPE '\\'
            )
          ORDER BY id ASC
          LIMIT ?
        `)
      : this.db.prepare(
          'SELECT * FROM document_change_events WHERE id > ? ORDER BY id ASC LIMIT ?',
        );
    const events: DocumentChangeEvent[] = [];
    let nextAfter = after;
    let exhausted = false;

    while (events.length < limit) {
      const remaining = limit - events.length;
      const rows = (prefix
        ? query.all(
            nextAfter,
            prefix,
            descendantPattern,
            prefix,
            descendantPattern,
            remaining,
          )
        : query.all(nextAfter, remaining)) as RawDocumentChangeEventRow[];
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      nextAfter = rows[rows.length - 1].id;
      events.push(...rows
        .map(documentChangeEventFromRow)
        .filter((event) => {
        if (isHiddenFromMemoryView(event.old_path ?? '') || isHiddenFromMemoryView(event.new_path ?? '')) {
          return false;
        }
        return true;
      }));
    }
    if (prefix && exhausted) {
      const latest = this.db.prepare(
        'SELECT COALESCE(MAX(id), 0) AS id FROM document_change_events',
      ).get() as { id: number };
      nextAfter = Math.max(nextAfter, latest.id);
    }

    return {
      events: events.slice(0, limit),
      next_after: nextAfter,
    };
  }

  getDocumentChangeConsumerState(consumer: string): DocumentChangeConsumerState {
    const normalized = normalizeConsumerName(consumer);
    const row = this.db.prepare(
      'SELECT consumer, last_event_id, updated_at FROM index_consumer_state WHERE consumer = ?',
    ).get(normalized) as Omit<DocumentChangeConsumerState, 'initialized' | 'latest_event_id'> | undefined;
    const latest = this.db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS id FROM document_change_events',
    ).get() as { id: number };
    return row
      ? { ...row, initialized: true, latest_event_id: latest.id }
      : {
          consumer: normalized,
          last_event_id: 0,
          updated_at: '',
          initialized: false,
          latest_event_id: latest.id,
        };
  }

  advanceDocumentChangeConsumer(
    consumer: string,
    throughEventId: number,
  ): DocumentChangeConsumerState {
    const normalized = normalizeConsumerName(consumer);
    if (!Number.isInteger(throughEventId) || throughEventId < 0) {
      throw Object.assign(new Error('invalid_through_event_id'), { statusCode: 400 });
    }
    const latest = this.db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS id FROM document_change_events',
    ).get() as { id: number };
    if (throughEventId > latest.id) {
      throw Object.assign(new Error('through_event_id_beyond_feed'), { statusCode: 400 });
    }
    const now = nowISO();
    this.db.prepare(`
      INSERT INTO index_consumer_state (consumer, last_event_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(consumer) DO UPDATE SET
        last_event_id = MAX(index_consumer_state.last_event_id, excluded.last_event_id),
        updated_at = excluded.updated_at
    `).run(normalized, throughEventId, now);
    return this.getDocumentChangeConsumerState(normalized);
  }

  recordDocumentChangeProcessing(
    input: RecordDocumentChangeProcessingInput,
  ): DocumentChangeConsumerState {
    const consumer = normalizeConsumerName(input.consumer);
    const eventIds = [...new Set(input.event_ids)]
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
    if (eventIds.length === 0) {
      throw Object.assign(new Error('event_ids_required'), { statusCode: 400 });
    }
    if (!Number.isInteger(input.through_event_id) || input.through_event_id < eventIds[eventIds.length - 1]) {
      throw Object.assign(new Error('invalid_through_event_id'), { statusCode: 400 });
    }
    const now = nowISO();
    const proposalJson = input.proposal ? JSON.stringify(input.proposal) : null;
    const tx = this.db.transaction(() => {
      const latest = this.db.prepare(
        'SELECT COALESCE(MAX(id), 0) AS id FROM document_change_events',
      ).get() as { id: number };
      if (input.through_event_id > latest.id) {
        throw Object.assign(new Error('through_event_id_beyond_feed'), { statusCode: 400 });
      }
      for (const eventId of eventIds) {
        const exists = this.db.prepare(
          'SELECT id FROM document_change_events WHERE id = ?',
        ).get(eventId);
        if (!exists) {
          throw Object.assign(new Error(`event_not_found:${eventId}`), { statusCode: 404 });
        }
        this.db.prepare(`
          INSERT INTO index_event_processing (
            consumer, event_id, status, attempts, proposal_ref, proposal_json,
            tokens_in, tokens_out, latency_ms, review_outcome, error, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(consumer, event_id) DO UPDATE SET
            status = excluded.status,
            attempts = index_event_processing.attempts + excluded.attempts,
            proposal_ref = excluded.proposal_ref,
            proposal_json = excluded.proposal_json,
            tokens_in = excluded.tokens_in,
            tokens_out = excluded.tokens_out,
            latency_ms = excluded.latency_ms,
            review_outcome = COALESCE(
              excluded.review_outcome,
              index_event_processing.review_outcome
            ),
            error = excluded.error,
            updated_at = excluded.updated_at
        `).run(
          consumer,
          eventId,
          input.status,
          input.increment_attempts === false ? 0 : 1,
          input.proposal_ref ?? null,
          proposalJson,
          Math.max(0, Math.floor(input.tokens_in ?? 0)),
          Math.max(0, Math.floor(input.tokens_out ?? 0)),
          Math.max(0, Math.floor(input.latency_ms ?? 0)),
          input.review_outcome ?? null,
          input.error ?? null,
          now,
        );
        this.db.prepare(`
          INSERT OR REPLACE INTO index_event_processing_audit (
            consumer, event_id, status, attempts, proposal_ref, proposal_json,
            tokens_in, tokens_out, latency_ms, review_outcome, error, updated_at
          )
          SELECT
            consumer, event_id, status, attempts, proposal_ref, proposal_json,
            tokens_in, tokens_out, latency_ms, review_outcome, error, updated_at
          FROM index_event_processing
          WHERE consumer = ? AND event_id = ?
        `).run(consumer, eventId);
      }
      if (input.advance_cursor !== false) {
        this.db.prepare(`
          INSERT INTO index_consumer_state (consumer, last_event_id, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(consumer) DO UPDATE SET
            last_event_id = MAX(index_consumer_state.last_event_id, excluded.last_event_id),
            updated_at = excluded.updated_at
        `).run(consumer, input.through_event_id, now);
      }
    });
    tx();
    return this.getDocumentChangeConsumerState(consumer);
  }

  setDocumentChangeReviewOutcome(
    consumer: string,
    eventIds: number[],
    outcome: DocumentChangeReviewOutcome,
  ): number {
    const normalized = normalizeConsumerName(consumer);
    const ids = [...new Set(eventIds)]
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
    if (ids.length === 0) {
      throw Object.assign(new Error('event_ids_required'), { statusCode: 400 });
    }
    if (!['pending', 'accepted', 'corrected', 'rejected'].includes(outcome)) {
      throw Object.assign(new Error('invalid_review_outcome'), { statusCode: 400 });
    }
    const updateActive = this.db.prepare(`
      UPDATE index_event_processing
      SET review_outcome = ?, updated_at = ?
      WHERE consumer = ? AND event_id = ?
    `);
    const updateAudit = this.db.prepare(`
      UPDATE index_event_processing_audit
      SET review_outcome = ?, updated_at = ?
      WHERE consumer = ? AND event_id = ?
    `);
    const tx = this.db.transaction(() => ids.reduce((count, eventId) => {
      const now = nowISO();
      updateActive.run(outcome, now, normalized, eventId);
      return count + updateAudit.run(outcome, now, normalized, eventId).changes;
    }, 0));
    return tx();
  }

  listDocumentChangeProcessing(
    consumer: string,
    opts: { after?: number; limit?: number } = {},
  ): DocumentChangeProcessing[] {
    const normalized = normalizeConsumerName(consumer);
    const after = Number.isInteger(opts.after) && (opts.after ?? 0) >= 0 ? opts.after! : 0;
    const limit = normalizeChangeLimit(opts.limit);
    const rows = this.db.prepare(`
      SELECT * FROM index_event_processing_audit
      WHERE consumer = ? AND event_id > ?
      ORDER BY event_id ASC
      LIMIT ?
    `).all(normalized, after, limit) as RawDocumentChangeProcessingRow[];
    return rows.map(documentChangeProcessingFromRow);
  }

  getDocumentChangeStats(): DocumentChangeStats {
    const totalRow = this.db.prepare(
      'SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS latest FROM document_change_events',
    ).get() as { count: number; latest: number };
    const byOperationRows = this.db.prepare(
      'SELECT op, COUNT(*) AS count FROM document_change_events GROUP BY op',
    ).all() as Array<{ op: DocumentChangeOperation; count: number }>;
    const byOperation: Record<DocumentChangeOperation, number> = {
      create: 0,
      update: 0,
      delete: 0,
      move: 0,
    };
    for (const row of byOperationRows) byOperation[row.op] = row.count;
    const consumers = this.db.prepare(
      'SELECT consumer, last_event_id, updated_at FROM index_consumer_state ORDER BY consumer',
    ).all() as DocumentChangeConsumerState[];
    return {
      total: totalRow.count,
      latest_event_id: totalRow.latest,
      by_operation: byOperation,
      consumer_lag: consumers.map((consumer) => ({
        ...consumer,
        lag: Math.max(0, totalRow.latest - consumer.last_event_id),
      })),
    };
  }

  pruneDocumentChangeEvents(beforeEventId: number): number {
    if (!Number.isInteger(beforeEventId) || beforeEventId < 1) {
      throw Object.assign(new Error('invalid_before_event_id'), { statusCode: 400 });
    }
    const minimumCursor = this.db.prepare(
      'SELECT MIN(last_event_id) AS value FROM index_consumer_state',
    ).get() as { value: number | null };
    if (minimumCursor.value === null) {
      throw Object.assign(new Error('consumer_state_required'), { statusCode: 409 });
    }
    const safeBefore = Math.min(beforeEventId, minimumCursor.value + 1);
    const result = this.db.prepare(
      'DELETE FROM document_change_events WHERE id < ?',
    ).run(safeBefore);
    return result.changes;
  }

  searchDocuments(query: string, limit: number, cred: Credential): SearchResult[] {
    const escaped = escapeFts5Query(query);
    const rows = this.db.prepare(`
      SELECT d.id, d.title, d.path, d.content_type, d.tags, d.shared, d.created_by, d.updated_at,
             snippet(documents_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM documents_fts fts
      JOIN documents d ON d.id = fts.doc_id
      WHERE documents_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(escaped, Math.min(Math.max(limit, 1), 100)) as RawSearchRow[];

    return rows
      .filter((r) => canReadDoc(cred, r.path, r.shared === 1))
      .map((r) => ({
        id: r.id, title: r.title, path: r.path,
        content_type: normalizeStoredContentType(r.content_type),
        snippet: r.snippet || '',
        tags: parseTags(r.tags),
        shared: r.shared === 1,
        created_by: r.created_by || '',
        updated_at: r.updated_at,
      }));
  }

  getStats(): { document_count: number; folder_count: number } {
    const docCount = (this.db.prepare('SELECT COUNT(*) as count FROM documents').get() as { count: number }).count;
    const folderCount = (this.db.prepare('SELECT COUNT(*) as count FROM folders').get() as { count: number }).count;
    return { document_count: docCount, folder_count: folderCount };
  }

  /** Accessible namespace roots — for diagnostics + manifest. */
  accessibleRoots(cred: Credential): string[] {
    return readableRoots(cred);
  }
}

interface RawDocRow {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content?: Buffer | string;
  content_type?: string | null;
  tags: string;
  shared: 0 | 1;
  created_by: string;
  created_at: string;
  updated_at: string;
  version?: number | null;
  index_role?: string | null;
  project_key?: string | null;
  index_keywords?: string | null;
  index_summary?: string | null;
}

interface RawSearchRow {
  id: string;
  title: string;
  path: string;
  content_type?: string | null;
  tags: string;
  shared: 0 | 1;
  created_by: string;
  updated_at: string;
  snippet: string | null;
}

interface RawDocumentChangeEventRow {
  id: number;
  event_uuid: string;
  ts: string;
  op: DocumentChangeOperation;
  cascade_of: string | null;
  doc_id: string;
  actor: string;
  origin: DocumentChangeOrigin;
  old_path: string | null;
  new_path: string | null;
  old_title: string | null;
  new_title: string | null;
  old_tags: string;
  new_tags: string;
  old_shared: 0 | 1 | null;
  new_shared: 0 | 1 | null;
  old_version: number | null;
  new_version: number | null;
  old_content_hash: string | null;
  new_content_hash: string | null;
  content_changed: 0 | 1;
  changed_fields: string;
  old_excerpt: string | null;
  new_excerpt: string | null;
  old_routing: string | null;
  new_routing: string | null;
}

interface RawDocumentChangeProcessingRow {
  consumer: string;
  event_id: number;
  status: DocumentChangeProcessingStatus;
  attempts: number;
  proposal_ref: string | null;
  proposal_json: string | null;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  review_outcome: DocumentChangeReviewOutcome | null;
  error: string | null;
  updated_at: string;
}

function normalizeStoredContentType(value: string | null | undefined): ContentType {
  return isAllowedContentType(value) ? value : DEFAULT_CONTENT_TYPE;
}

function normalizeStoredVersion(value: number | null | undefined): number {
  return Number.isInteger(value) && value! >= 0 ? value! : 0;
}

function rowToDoc(row: RawDocRow): Document {
  return {
    id: row.id,
    title: row.title,
    folder_id: row.folder_id,
    path: row.path,
    content: row.content?.toString() ?? '',
    content_type: normalizeStoredContentType(row.content_type),
    tags: parseTags(row.tags),
    shared: row.shared === 1,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: normalizeStoredVersion(row.version),
    index_role: row.index_role ?? null,
    project_key: row.project_key ?? null,
    index_keywords: parseTags(row.index_keywords),
    index_summary: row.index_summary ?? null,
  };
}

function documentChangedFields(oldDoc: Document | null, newDoc: Document | null): string[] {
  const fields: Array<keyof Pick<
    Document,
    | 'title'
    | 'folder_id'
    | 'path'
    | 'content'
    | 'content_type'
    | 'tags'
    | 'shared'
    | 'index_role'
    | 'project_key'
    | 'index_keywords'
    | 'index_summary'
  >> = [
    'title',
    'folder_id',
    'path',
    'content',
    'content_type',
    'tags',
    'shared',
    'index_role',
    'project_key',
    'index_keywords',
    'index_summary',
  ];
  if (!oldDoc || !newDoc) return fields;
  return fields.filter((field) => {
    if (field === 'tags' || field === 'index_keywords') {
      return JSON.stringify(oldDoc[field]) !== JSON.stringify(newDoc[field]);
    }
    return oldDoc[field] !== newDoc[field];
  });
}

function documentChangeEventFromRow(row: RawDocumentChangeEventRow): DocumentChangeEvent {
  return {
    id: row.id,
    event_uuid: row.event_uuid,
    ts: row.ts,
    op: row.op,
    cascade_of: row.cascade_of,
    doc_id: row.doc_id,
    actor: row.actor,
    origin: row.origin,
    old_path: row.old_path,
    new_path: row.new_path,
    old_title: row.old_title,
    new_title: row.new_title,
    old_tags: parseTags(row.old_tags),
    new_tags: parseTags(row.new_tags),
    old_shared: row.old_shared === null ? null : row.old_shared === 1,
    new_shared: row.new_shared === null ? null : row.new_shared === 1,
    old_version: row.old_version,
    new_version: row.new_version,
    old_content_hash: row.old_content_hash,
    new_content_hash: row.new_content_hash,
    content_changed: row.content_changed === 1,
    changed_fields: parseTags(row.changed_fields),
    old_excerpt: row.old_excerpt,
    new_excerpt: row.new_excerpt,
    old_routing: parseRoutingMetadata(row.old_routing),
    new_routing: parseRoutingMetadata(row.new_routing),
  };
}

function parseRoutingMetadata(raw: string | null): DocumentRoutingMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DocumentRoutingMetadata>;
    return {
      index_role: typeof parsed.index_role === 'string' ? parsed.index_role : null,
      project_key: typeof parsed.project_key === 'string' ? parsed.project_key : null,
      index_keywords: Array.isArray(parsed.index_keywords)
        ? parsed.index_keywords.filter((value): value is string => typeof value === 'string')
        : [],
      index_summary: typeof parsed.index_summary === 'string' ? parsed.index_summary : null,
    };
  } catch {
    return null;
  }
}

function documentChangeProcessingFromRow(
  row: RawDocumentChangeProcessingRow,
): DocumentChangeProcessing {
  let proposal: Record<string, unknown> | null = null;
  if (row.proposal_json) {
    try {
      const parsed = JSON.parse(row.proposal_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        proposal = parsed as Record<string, unknown>;
      }
    } catch {
      proposal = null;
    }
  }
  return {
    consumer: row.consumer,
    event_id: row.event_id,
    status: row.status,
    attempts: row.attempts,
    proposal_ref: row.proposal_ref,
    proposal_json: proposal,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    latency_ms: row.latency_ms,
    review_outcome: row.review_outcome,
    error: row.error,
    updated_at: row.updated_at,
  };
}

function normalizeConsumerName(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(normalized)) {
    throw Object.assign(new Error('invalid_consumer'), { statusCode: 400 });
  }
  return normalized;
}
