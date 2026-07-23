import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { proxyFetch } from '../utils/http.js';

export const DEFAULT_METABOT_CORE_URL = 'http://localhost:9200';

export type MetabotCoreTokenSource = 'override' | 'env' | 'file' | 'none';

export interface MetabotCoreConnectionConfig {
  baseUrl: string;
  token: string;
  tokenSource: MetabotCoreTokenSource;
  tokenFile: string;
  usingDefaultBaseUrl: boolean;
}

export interface ResolveMetabotCoreConnectionOptions {
  baseUrlOverride?: string;
  tokenOverride?: string;
  env?: NodeJS.ProcessEnv;
  tokenFile?: string;
}

export interface MetabotCoreMemoryCheck {
  ok: boolean;
  baseUrl: string;
  tokenPresent: boolean;
  tokenSource: MetabotCoreTokenSource;
  status?: number;
  folderCount?: number;
  documentCount?: number;
  error?: string;
  durationMs: number;
}

export function metabotCoreTokenFilePath(): string {
  return path.join(os.homedir(), '.metabot-core', 'token');
}

export function readFirstNonEmptyLine(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
  } catch {
    /* missing or unreadable */
  }
  return undefined;
}

export function resolveMetabotCoreConnection(
  options: ResolveMetabotCoreConnectionOptions = {},
): MetabotCoreConnectionConfig {
  const env = options.env ?? process.env;
  const explicitBaseUrl = clean(options.baseUrlOverride) || clean(env.METABOT_CORE_URL);
  const baseUrl = (explicitBaseUrl || DEFAULT_METABOT_CORE_URL).replace(/\/+$/, '');
  const tokenFile = options.tokenFile ?? metabotCoreTokenFilePath();

  const overrideToken = clean(options.tokenOverride);
  if (overrideToken) {
    return {
      baseUrl,
      token: overrideToken,
      tokenSource: 'override',
      tokenFile,
      usingDefaultBaseUrl: !explicitBaseUrl,
    };
  }

  const envToken = clean(env.METABOT_CORE_TOKEN);
  if (envToken) {
    return {
      baseUrl,
      token: envToken,
      tokenSource: 'env',
      tokenFile,
      usingDefaultBaseUrl: !explicitBaseUrl,
    };
  }

  const fileToken = readFirstNonEmptyLine(tokenFile);
  if (fileToken) {
    return {
      baseUrl,
      token: fileToken,
      tokenSource: 'file',
      tokenFile,
      usingDefaultBaseUrl: !explicitBaseUrl,
    };
  }

  return {
    baseUrl,
    token: '',
    tokenSource: 'none',
    tokenFile,
    usingDefaultBaseUrl: !explicitBaseUrl,
  };
}

export async function checkMetabotCoreMemoryConnection(
  options: ResolveMetabotCoreConnectionOptions & { timeoutMs?: number } = {},
): Promise<MetabotCoreMemoryCheck> {
  const startedAt = Date.now();
  const config = resolveMetabotCoreConnection(options);
  const base = {
    baseUrl: config.baseUrl,
    tokenPresent: Boolean(config.token),
    tokenSource: config.tokenSource,
  };

  if (!config.token) {
    return {
      ...base,
      ok: false,
      error: `no token configured; set METABOT_CORE_TOKEN or write ${config.tokenFile}`,
      durationMs: Date.now() - startedAt,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 4_000);
  try {
    const res = await proxyFetch(`${config.baseUrl}/api/memory/folders/tree`, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        ...base,
        ok: false,
        status: res.status,
        error: text.slice(0, 300) || `HTTP ${res.status}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const raw = JSON.parse(text) as unknown;
    const tree = unwrapFolderTree(raw);
    const counts = tree ? countFolderTree(tree) : { folders: 0, documents: 0 };
    return {
      ...base,
      ok: true,
      status: res.status,
      folderCount: counts.folders,
      documentCount: counts.documents,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function unwrapFolderTree(raw: unknown): any | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.folders && typeof obj.folders === 'object') return obj.folders;
  if (obj.id || obj.name || obj.path || obj.children) return obj;
  return undefined;
}

function countFolderTree(node: any): { folders: number; documents: number } {
  if (!node || typeof node !== 'object') return { folders: 0, documents: 0 };
  let folders = node.id && node.id !== 'root' ? 1 : 0;
  let documents = typeof node.document_count === 'number' ? node.document_count : 0;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    const counts = countFolderTree(child);
    folders += counts.folders;
    documents += counts.documents;
  }
  return { folders, documents };
}
