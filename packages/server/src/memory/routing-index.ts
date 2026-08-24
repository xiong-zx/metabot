import type { Credential } from '../auth/credentials.js';
import type { DocumentSummary, MemoryStore, RoutingIndexRebuildResult } from './memory-store.js';
import { normalizePath } from './acl.js';

export interface RoutingIndexPreview {
  root: string;
  target_path: string;
  target_version: number;
  source_document_count: number;
  changed: boolean;
  content: string;
}

export function previewRoutingIndex(
  store: MemoryStore,
  cred: Credential,
  root = '/cargo1',
  targetPath?: string,
): RoutingIndexPreview {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(targetPath || `${normalizedRoot}/index/metamemory-index`);
  assertCanonicalRoutingTarget(normalizedRoot, normalizedTarget);
  const target = store.getDocument(normalizedTarget, cred);
  if (!target) {
    throw Object.assign(new Error('routing_index_not_found'), { statusCode: 404 });
  }
  const sourceDocuments = store
    .listRoutingDocuments(normalizedRoot, cred)
    .filter((document) => document.path !== normalizedTarget);
  const content = renderRoutingIndex(sourceDocuments);
  return {
    root: normalizedRoot,
    target_path: normalizedTarget,
    target_version: target.version,
    source_document_count: sourceDocuments.length,
    changed: target.content !== content,
    content,
  };
}

export function rebuildRoutingIndex(
  store: MemoryStore,
  cred: Credential,
  expectedVersion: number,
  root = '/cargo1',
  targetPath?: string,
): RoutingIndexPreview & RoutingIndexRebuildResult {
  const preview = previewRoutingIndex(store, cred, root, targetPath);
  const result = store.rebuildRoutingIndexContent(preview.target_path, preview.content, expectedVersion, cred);
  return {
    ...preview,
    target_version: result.document.version,
    ...result,
  };
}

export function renderRoutingIndex(documents: DocumentSummary[]): string {
  const rows = [...documents]
    .sort(compareRoutingDocuments)
    .map((document) =>
      [
        document.index_role || '',
        document.project_key || '',
        `${document.title} (\`${document.path}\`)`,
        String(document.version),
        document.index_keywords.join(', '),
        document.index_summary || '',
      ].map(escapeTableCell),
    );
  return [
    '# MetaMemory Routing Index',
    '',
    '> Deterministically generated from structured document routing metadata.',
    '',
    '| Role | Project | Document | Version | Keywords | Summary |',
    '| --- | --- | --- | ---: | --- | --- |',
    ...rows.map((cells) => `| ${cells.join(' | ')} |`),
    '',
  ].join('\n');
}

function compareRoutingDocuments(a: DocumentSummary, b: DocumentSummary): number {
  return (
    (a.index_role || '').localeCompare(b.index_role || '') ||
    (a.project_key || '').localeCompare(b.project_key || '') ||
    a.title.localeCompare(b.title) ||
    a.path.localeCompare(b.path)
  );
}

function escapeTableCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function assertCanonicalRoutingTarget(root: string, targetPath: string): void {
  const indexRoot = `${root}/index`;
  if (!(targetPath === indexRoot || targetPath.startsWith(`${indexRoot}/`))) {
    throw Object.assign(new Error('routing_index_target_outside_index_root'), {
      statusCode: 400,
    });
  }
}
