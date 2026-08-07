import type { Credential } from '../auth/credentials.js';
import type { DocumentSummary, MemoryStore } from './memory-store.js';
import { isHiddenFromMemoryView } from './hidden-paths.js';

export interface MemoryIndexReconciliationReport {
  generated_at: string;
  root: string;
  index_path: string;
  status_path: string;
  dead_references: Array<{ source_path: string; target_path: string }>;
  unindexed_documents: Array<{
    id: string;
    path: string;
    title: string;
    tags: string[];
    version: number;
  }>;
  duplicate_project_rows: Array<{ project: string; count: number }>;
  stale_source_versions: Array<{
    path: string;
    indexed_version: number;
    actual_version: number;
  }>;
  zero_version_documents: Array<{ id: string; path: string }>;
  consumer_lag: ReturnType<MemoryStore['getDocumentChangeStats']>['consumer_lag'];
  summary: {
    referenced_paths: number;
    dead_references: number;
    unindexed_documents: number;
    duplicate_project_rows: number;
    stale_source_versions: number;
    zero_version_documents: number;
  };
}

export function reconcileMemoryIndexes(
  store: MemoryStore,
  cred: Credential,
  options: {
    root?: string;
    indexPath?: string;
    statusPath?: string;
  } = {},
): MemoryIndexReconciliationReport {
  if (cred.role !== 'admin') {
    throw Object.assign(new Error('admin_required'), { statusCode: 403 });
  }
  const root = normalizeRoot(options.root || process.env.METABOT_CORE_MEMORY_SERVER_ROOT || '/cargo1');
  const indexPath = options.indexPath || `${root}/index/metamemory-index`;
  const statusPath = options.statusPath || `${root}/status/project-progress-status`;
  const index = store.getDocument(indexPath, cred);
  const status = store.getDocument(statusPath, cred);
  const sources = [
    ...(index ? [{ path: index.path, content: index.content }] : []),
    ...(status ? [{ path: status.path, content: status.content }] : []),
  ];
  const referencedBySource = sources.flatMap((source) =>
    extractInlineCodePaths(source.content)
      .filter((targetPath) => isPathInsideRoot(targetPath, root))
      .map((targetPath) => ({ source_path: source.path, target_path: targetPath })),
  );
  const referencedPaths = new Set(referencedBySource.map((reference) => reference.target_path));
  const documents = listAllDocuments(store, root, cred).filter((document) => !isHiddenFromMemoryView(document.path));
  const folders = store.listFolders(root, cred).filter((folder) => !isHiddenFromMemoryView(folder.path));
  const existingPaths = new Set([
    ...documents.map((document) => document.path),
    ...folders.map((folder) => folder.path),
  ]);
  const deadReferences = uniqueReferences(
    referencedBySource.filter((reference) => !existingPaths.has(reference.target_path)),
  );
  const managedPaths = new Set([indexPath, statusPath]);
  const unindexedDocuments = documents
    .filter((document) => !managedPaths.has(document.path))
    .filter((document) => !isCoveredByReference(document.path, referencedPaths))
    .map((document) => ({
      id: document.id,
      path: document.path,
      title: document.title,
      tags: document.tags,
      version: document.version,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const duplicateProjectRows = duplicateProjectNames(status?.content || '');
  const documentByPath = new Map(documents.map((document) => [document.path, document]));
  const staleSourceVersions = routingSourceVersions(index?.content || '')
    .flatMap((source) => {
      const document = documentByPath.get(source.path);
      if (!document || document.version === source.version) return [];
      return [
        {
          path: source.path,
          indexed_version: source.version,
          actual_version: document.version,
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const zeroVersionDocuments = documents
    .filter((document) => document.version === 0)
    .map((document) => ({ id: document.id, path: document.path }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const consumerLag = store.getDocumentChangeStats().consumer_lag;

  return {
    generated_at: new Date().toISOString(),
    root,
    index_path: indexPath,
    status_path: statusPath,
    dead_references: deadReferences,
    unindexed_documents: unindexedDocuments,
    duplicate_project_rows: duplicateProjectRows,
    stale_source_versions: staleSourceVersions,
    zero_version_documents: zeroVersionDocuments,
    consumer_lag: consumerLag,
    summary: {
      referenced_paths: referencedPaths.size,
      dead_references: deadReferences.length,
      unindexed_documents: unindexedDocuments.length,
      duplicate_project_rows: duplicateProjectRows.length,
      stale_source_versions: staleSourceVersions.length,
      zero_version_documents: zeroVersionDocuments.length,
    },
  };
}

function listAllDocuments(store: MemoryStore, root: string, cred: Credential) {
  const documents: DocumentSummary[] = [];
  let offset = 0;
  while (true) {
    const page = store.listDocuments({ prefix: root, limit: 500, offset }, cred);
    documents.push(...page);
    if (page.length < 500) break;
    offset += page.length;
  }
  return documents;
}

function normalizeRoot(value: string): string {
  const trimmed = value.trim();
  const rooted = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return rooted.length > 1 ? rooted.replace(/\/+$/, '') : rooted;
}

function isPathInsideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function extractInlineCodePaths(markdown: string): string[] {
  const paths: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let cursor = 0;
    while (cursor < line.length) {
      const open = line.indexOf('`', cursor);
      if (open < 0) break;
      const close = line.indexOf('`', open + 1);
      if (close < 0) break;
      const token = line.slice(open + 1, close);
      const matches = token.match(/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/g) || [];
      for (const match of matches) {
        paths.push(match.replace(/[;,]+$/, '').replace(/\/+$/, ''));
      }
      cursor = close + 1;
    }
  }
  return [...new Set(paths.filter(Boolean))];
}

function isCoveredByReference(path: string, references: Set<string>): boolean {
  if (references.has(path)) return true;
  for (const reference of references) {
    if (path.startsWith(`${reference}/`)) return true;
  }
  return false;
}

function uniqueReferences(
  references: Array<{ source_path: string; target_path: string }>,
): Array<{ source_path: string; target_path: string }> {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.source_path}\0${reference.target_path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function duplicateProjectNames(markdown: string): Array<{ project: string; count: number }> {
  const section = sectionBody(markdown, 'Current Projects');
  if (!section) return [];
  const counts = new Map<string, number>();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitMarkdownTableRow(line);
    if (cells.length === 0) continue;
    const project = cells[0].trim();
    if (!project || project === 'Project' || /^-+$/.test(project)) continue;
    counts.set(project, (counts.get(project) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => a.project.localeCompare(b.project));
}

function routingSourceVersions(markdown: string): Array<{ path: string; version: number }> {
  const rows = markdown.split(/\r?\n/).filter((line) => line.trim().startsWith('|'));
  const headerIndex = rows.findIndex((line) => {
    const cells = splitMarkdownTableRow(line);
    return cells.includes('Document') && cells.includes('Version');
  });
  if (headerIndex < 0) return [];
  const header = splitMarkdownTableRow(rows[headerIndex]);
  const documentIndex = header.indexOf('Document');
  const versionIndex = header.indexOf('Version');
  const sources: Array<{ path: string; version: number }> = [];
  for (const row of rows.slice(headerIndex + 2)) {
    const cells = splitMarkdownTableRow(row);
    const path = extractInlineCodePaths(cells[documentIndex] || '')[0];
    const version = Number.parseInt(cells[versionIndex] || '', 10);
    if (path && Number.isInteger(version) && version >= 0) {
      sources.push({ path, version });
    }
  }
  return sources;
}

function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line.trim()));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

function splitMarkdownTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  let code = false;
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '`') {
      code = !code;
      current += char;
      continue;
    }
    if (char === '|' && !code) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}
