import type { MemoryStore } from './memory-store.js';
import type { AgentStore } from '../agents/agent-store.js';
import type { Credential } from '../auth/credentials.js';
import { isHiddenFromMemoryView } from './hidden-paths.js';
import { reconcileMemoryIndexes } from './index-reconciliation.js';
import { previewRoutingIndex, rebuildRoutingIndex } from './routing-index.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

function adminOnly(cred: Credential): RouteResult | null {
  return cred.role === 'admin' ? null : err(403, 'admin_required');
}

function statusFromException(e: unknown): number {
  const s = (e as { statusCode?: number }).statusCode;
  return typeof s === 'number' ? s : 400;
}

function isHiddenIdOrPath(store: MemoryStore, idOrPath: string, kind: 'folder' | 'document'): boolean {
  if (idOrPath.startsWith('/')) return isHiddenFromMemoryView(idOrPath);
  const path = kind === 'folder'
    ? store.findFolderById(idOrPath)?.path ?? null
    : store.findDocumentPathById(idOrPath);
  return path !== null && isHiddenFromMemoryView(path);
}

function pruneHiddenSubtrees<T extends { path: string; children: T[] }>(node: T): T {
  return {
    ...node,
    children: node.children
      .filter((c) => !isHiddenFromMemoryView(c.path))
      .map(pruneHiddenSubtrees),
  };
}

// ---- Folder handlers ----

export function listFolders(store: MemoryStore, query: URLSearchParams, cred: Credential): RouteResult {
  const prefix = query.get('prefix') || undefined;
  if (prefix && isHiddenFromMemoryView(prefix)) return { status: 200, body: { folders: [] } };
  const folders = store.listFolders(prefix, cred).filter((f) => !isHiddenFromMemoryView(f.path));
  return { status: 200, body: { folders } };
}

export function getFolderTree(store: MemoryStore, cred: Credential): RouteResult {
  const tree = store.getFolderTree(cred);
  return { status: 200, body: pruneHiddenSubtrees(tree) };
}

export function getFolder(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  if (isHiddenIdOrPath(store, idOrPath, 'folder')) return err(404, 'folder_not_found');
  const folder = idOrPath.startsWith('/')
    ? store.findFolderByPath(idOrPath)
    : store.findFolderById(idOrPath);
  if (!folder) return err(404, 'folder_not_found');
  if (!canReadFolder(store, folder, cred)) return err(404, 'folder_not_found');
  return { status: 200, body: folder };
}

export function createFolder(store: MemoryStore, body: Record<string, unknown>, cred: Credential): RouteResult {
  const name = body.name as string | undefined;
  const pathHint = body.path as string | undefined;
  if (!name && !pathHint) return err(400, 'name_or_path_required');
  if (pathHint && isHiddenFromMemoryView(pathHint)) return err(403, 'hidden_namespace');
  try {
    const folder = store.createFolder({
      name: name ?? '',
      parent_id: (body.parent_id as string) ?? undefined,
      path: pathHint,
    }, cred);
    return { status: 201, body: folder };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function deleteFolder(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  if (isHiddenIdOrPath(store, idOrPath, 'folder')) return err(404, 'folder_not_found');
  try {
    store.deleteFolder(idOrPath, cred);
    return { status: 200, body: { ok: true } };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

// ---- Document handlers ----

export function listDocuments(store: MemoryStore, query: URLSearchParams, cred: Credential): RouteResult {
  const prefix = query.get('prefix') || undefined;
  if (prefix && isHiddenFromMemoryView(prefix)) return { status: 200, body: { documents: [] } };
  const folderId = query.get('folder_id') || undefined;
  if (folderId && isHiddenIdOrPath(store, folderId, 'folder')) {
    return { status: 200, body: { documents: [] } };
  }
  const docs = store.listDocuments({
    folder_id: folderId,
    prefix,
    limit: query.get('limit') ? parseInt(query.get('limit')!, 10) : undefined,
    offset: query.get('offset') ? parseInt(query.get('offset')!, 10) : undefined,
  }, cred).filter((d) => !isHiddenFromMemoryView(d.path));
  return { status: 200, body: { documents: docs } };
}

export function getDocument(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  if (isHiddenIdOrPath(store, idOrPath, 'document')) return err(404, 'document_not_found');
  const doc = store.getDocument(idOrPath, cred);
  if (!doc) return err(404, 'document_not_found');
  return { status: 200, body: doc };
}

export function createDocument(store: MemoryStore, agents: AgentStore, body: Record<string, unknown>, cred: Credential): RouteResult {
  const title = (body.title as string) ?? '';
  const pathHint = body.path as string | undefined;
  if (!title && !pathHint) return err(400, 'title_or_path_required');
  if (pathHint && isHiddenFromMemoryView(pathHint)) return err(403, 'hidden_namespace');
  const folderId = typeof body.folder_id === 'string' ? (body.folder_id as string) : undefined;
  if (folderId && isHiddenIdOrPath(store, folderId, 'folder')) return err(403, 'hidden_namespace');
  if (!hasValidRoutingMetadataShape(body)) return err(400, 'invalid_routing_metadata');
  try {
    const doc = store.createDocument({
      title,
      path: pathHint,
      folder_id: folderId,
      content: typeof body.content === 'string' ? body.content : '',
      content_type: typeof body.content_type === 'string' ? (body.content_type as string) : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      shared: resolveShared(body.shared, agents, cred),
      created_by: (body.created_by as string) || undefined,
      index_role: optionalNullableString(body.index_role),
      project_key: optionalNullableString(body.project_key),
      index_keywords: optionalStringArray(body.index_keywords),
      index_summary: optionalNullableString(body.index_summary),
    }, cred);
    return { status: 201, body: doc };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

/**
 * Resolve a new document's `shared` flag. An explicit boolean in the request
 * body always wins (per-doc override); otherwise the default comes from the
 * authoring agent's `memoryPublic` config — public bots share by default,
 * private bots don't. Unregistered/unknown bots default to private.
 */
function resolveShared(raw: unknown, agents: AgentStore, cred: Credential): boolean {
  if (typeof raw === 'boolean') return raw;
  return agents.getByName(cred.botName)?.memoryPublic ?? false;
}

export function updateDocument(store: MemoryStore, idOrPath: string, body: Record<string, unknown>, cred: Credential): RouteResult {
  if (isHiddenIdOrPath(store, idOrPath, 'document')) return err(404, 'document_not_found');
  let changeOrigin: 'indexer' | 'reconciler' | undefined;
  if (body.change_origin !== undefined) {
    const gate = adminOnly(cred);
    if (gate) return gate;
    if (body.change_origin !== 'indexer' && body.change_origin !== 'reconciler') {
      return err(400, 'invalid_change_origin');
    }
    changeOrigin = body.change_origin;
  }
  const targetFolder = typeof body.folder_id === 'string' ? (body.folder_id as string) : undefined;
  if (targetFolder && isHiddenIdOrPath(store, targetFolder, 'folder')) {
    return err(403, 'hidden_namespace');
  }
  if (
    body.expected_version !== undefined
    && (!Number.isInteger(body.expected_version) || (body.expected_version as number) < 0)
  ) {
    return err(400, 'invalid_expected_version');
  }
  if (!hasValidRoutingMetadataShape(body)) {
    return err(400, 'invalid_routing_metadata');
  }
  try {
    const doc = store.updateDocument(idOrPath, {
      title: typeof body.title === 'string' ? (body.title as string) : undefined,
      content: typeof body.content === 'string' ? (body.content as string) : undefined,
      content_type: typeof body.content_type === 'string' ? (body.content_type as string) : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      shared: typeof body.shared === 'boolean' ? (body.shared as boolean) : undefined,
      folder_id: targetFolder,
      expected_version: typeof body.expected_version === 'number'
        ? (body.expected_version as number)
        : undefined,
      index_role: optionalNullableString(body.index_role),
      project_key: optionalNullableString(body.project_key),
      index_keywords: optionalStringArray(body.index_keywords),
      index_summary: optionalNullableString(body.index_summary),
    }, cred, changeOrigin);
    if (!doc) return err(404, 'document_not_found');
    return { status: 200, body: doc };
  } catch (e: unknown) {
    if ((e as Error).message === 'version_conflict') {
      const conflict = e as Error & { expectedVersion?: number; actualVersion?: number };
      return {
        status: 409,
        body: {
          error: 'version_conflict',
          expected_version: conflict.expectedVersion,
          actual_version: conflict.actualVersion,
        },
      };
    }
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

function optionalNullableString(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : undefined;
}

function hasValidRoutingMetadataShape(body: Record<string, unknown>): boolean {
  for (const key of ['index_role', 'project_key', 'index_summary']) {
    if (key in body && typeof body[key] !== 'string' && body[key] !== null) return false;
  }
  return !(
    'index_keywords' in body
    && (!Array.isArray(body.index_keywords)
      || !body.index_keywords.every((item) => typeof item === 'string'))
  );
}

export function deleteDocument(store: MemoryStore, idOrPath: string, cred: Credential): RouteResult {
  if (isHiddenIdOrPath(store, idOrPath, 'document')) return err(404, 'document_not_found');
  try {
    const ok = store.deleteDocument(idOrPath, cred);
    if (!ok) return err(404, 'document_not_found');
    return { status: 200, body: { ok: true } };
  } catch (e: unknown) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function search(store: MemoryStore, query: URLSearchParams, cred: Credential): RouteResult {
  const q = query.get('q');
  if (!q || !q.trim()) return err(400, 'q_required');
  const limit = parseInt(query.get('limit') || '20', 10) || 20;
  const results = store.searchDocuments(q, limit, cred).filter((r) => !isHiddenFromMemoryView(r.path));
  return { status: 200, body: { results } };
}

export function listDocumentEvents(
  store: MemoryStore,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  const after = parseNonNegativeQueryInt(query.get('after'), 0);
  const limit = parsePositiveQueryInt(query.get('limit'), 100);
  if (after === null || limit === null) return err(400, 'invalid_cursor_or_limit');
  const prefix = query.get('prefix') || undefined;
  if (prefix && isHiddenFromMemoryView(prefix)) {
    return { status: 200, body: { events: [], next_after: after } };
  }
  const page = store.listDocumentChangeEventPage({ after, limit, prefix });
  return {
    status: 200,
    body: page,
  };
}

export function getDocumentEventStats(store: MemoryStore, cred: Credential): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  return { status: 200, body: store.getDocumentChangeStats() };
}

export function getDocumentEventConsumer(
  store: MemoryStore,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  const consumer = query.get('consumer') || '';
  if (!consumer) return err(400, 'consumer_required');
  try {
    return { status: 200, body: store.getDocumentChangeConsumerState(consumer) };
  } catch (e) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function advanceDocumentEventConsumer(
  store: MemoryStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  const consumer = typeof body.consumer === 'string' ? body.consumer : '';
  const throughEventId = body.through_event_id;
  if (!consumer || !Number.isInteger(throughEventId)) {
    return err(400, 'consumer_and_through_event_id_required');
  }
  try {
    return {
      status: 200,
      body: store.advanceDocumentChangeConsumer(consumer, throughEventId as number),
    };
  } catch (e) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function listDocumentEventProcessing(
  store: MemoryStore,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  const consumer = query.get('consumer') || '';
  if (!consumer) return err(400, 'consumer_required');
  const after = parseNonNegativeQueryInt(query.get('after'), 0);
  const limit = parsePositiveQueryInt(query.get('limit'), 100);
  if (after === null || limit === null) return err(400, 'invalid_cursor_or_limit');
  try {
    return {
      status: 200,
      body: { processing: store.listDocumentChangeProcessing(consumer, { after, limit }) },
    };
  } catch (e) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function recordDocumentEventProcessing(
  store: MemoryStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  const consumer = typeof body.consumer === 'string' ? body.consumer : '';
  const eventIds = Array.isArray(body.event_ids)
    ? body.event_ids.filter((value): value is number => typeof value === 'number')
    : [];
  const throughEventId = typeof body.through_event_id === 'number'
    ? body.through_event_id
    : Number.NaN;
  const allowedStatuses = ['pending', 'proposed', 'applied', 'skipped', 'failed', 'dead'];
  const status = typeof body.status === 'string' && allowedStatuses.includes(body.status)
    ? body.status as 'pending' | 'proposed' | 'applied' | 'skipped' | 'failed' | 'dead'
    : null;
  if (!consumer || !status) return err(400, 'consumer_and_status_required');
  try {
    const state = store.recordDocumentChangeProcessing({
      consumer,
      event_ids: eventIds,
      through_event_id: throughEventId,
      status,
      proposal_ref: typeof body.proposal_ref === 'string' ? body.proposal_ref : undefined,
      proposal: body.proposal && typeof body.proposal === 'object' && !Array.isArray(body.proposal)
        ? body.proposal as Record<string, unknown>
        : undefined,
      tokens_in: typeof body.tokens_in === 'number' ? body.tokens_in : undefined,
      tokens_out: typeof body.tokens_out === 'number' ? body.tokens_out : undefined,
      latency_ms: typeof body.latency_ms === 'number' ? body.latency_ms : undefined,
      review_outcome: isReviewOutcome(body.review_outcome)
        ? body.review_outcome
        : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
      advance_cursor: typeof body.advance_cursor === 'boolean'
        ? body.advance_cursor
        : undefined,
      increment_attempts: typeof body.increment_attempts === 'boolean'
        ? body.increment_attempts
        : undefined,
    });
    return { status: 200, body: state };
  } catch (e) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function reviewDocumentEventProcessing(
  store: MemoryStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  const consumer = typeof body.consumer === 'string' ? body.consumer : '';
  const eventIds = Array.isArray(body.event_ids)
    ? body.event_ids.filter((value): value is number => Number.isInteger(value))
    : [];
  if (!consumer || !isReviewOutcome(body.review_outcome)) {
    return err(400, 'consumer_event_ids_and_review_outcome_required');
  }
  try {
    return {
      status: 200,
      body: {
        updated: store.setDocumentChangeReviewOutcome(
          consumer,
          eventIds,
          body.review_outcome,
        ),
      },
    };
  } catch (e) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function pruneDocumentEvents(
  store: MemoryStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  const beforeEventId = body.before_event_id;
  if (!Number.isInteger(beforeEventId) || (beforeEventId as number) < 1) {
    return err(400, 'invalid_before_event_id');
  }
  try {
    return {
      status: 200,
      body: { deleted: store.pruneDocumentChangeEvents(beforeEventId as number) },
    };
  } catch (e) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function reconcileIndexes(
  store: MemoryStore,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  try {
    return {
      status: 200,
      body: reconcileMemoryIndexes(store, cred, {
        root: query.get('root') || undefined,
        indexPath: query.get('index_path') || undefined,
        statusPath: query.get('status_path') || undefined,
      }),
    };
  } catch (e) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function previewMemoryRoutingIndex(
  store: MemoryStore,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  try {
    return {
      status: 200,
      body: {
        ...previewRoutingIndex(
          store,
          cred,
          query.get('root') || '/cargo1',
          query.get('target_path') || undefined,
        ),
        rebuild_enabled: routingIndexRebuildEnabled(),
      },
    };
  } catch (e) {
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function rebuildMemoryRoutingIndex(
  store: MemoryStore,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  if (!routingIndexRebuildEnabled()) {
    return err(409, 'routing_index_rebuild_disabled');
  }
  if (!Number.isInteger(body.expected_version) || (body.expected_version as number) < 0) {
    return err(400, 'expected_version_required');
  }
  try {
    return {
      status: 200,
      body: rebuildRoutingIndex(
        store,
        cred,
        body.expected_version as number,
        typeof body.root === 'string' ? body.root : '/cargo1',
        typeof body.target_path === 'string' ? body.target_path : undefined,
      ),
    };
  } catch (e) {
    if ((e as Error).message === 'version_conflict') {
      const conflict = e as Error & { expectedVersion?: number; actualVersion?: number };
      return {
        status: 409,
        body: {
          error: 'version_conflict',
          expected_version: conflict.expectedVersion,
          actual_version: conflict.actualVersion,
        },
      };
    }
    return err(statusFromException(e), (e as Error).message || 'error');
  }
}

export function listMemoryRoutingIndexSnapshots(
  store: MemoryStore,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const gate = adminOnly(cred);
  if (gate) return gate;
  const targetPath = query.get('target_path') || '/cargo1/index/metamemory-index';
  const target = store.getDocument(targetPath, cred);
  if (!target) return err(404, 'routing_index_not_found');
  const limit = parsePositiveQueryInt(query.get('limit'), 20);
  if (limit === null) return err(400, 'invalid_limit');
  return {
    status: 200,
    body: { snapshots: store.listRoutingIndexSnapshots(target.id, limit) },
  };
}

function canReadFolder(store: MemoryStore, folder: { path: string }, cred: Credential): boolean {
  return store.accessibleRoots(cred).some((root) => {
    if (root === '/') return true;
    return folder.path === root || folder.path.startsWith(root + '/');
  }) || folder.path.startsWith('/shared');
}

function parseNonNegativeQueryInt(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveQueryInt(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isReviewOutcome(
  value: unknown,
): value is 'pending' | 'accepted' | 'corrected' | 'rejected' {
  return typeof value === 'string'
    && ['pending', 'accepted', 'corrected', 'rejected'].includes(value);
}

function routingIndexRebuildEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    process.env.METABOT_MEMORY_ROUTING_REBUILD_ENABLED?.trim().toLowerCase() || '',
  );
}
