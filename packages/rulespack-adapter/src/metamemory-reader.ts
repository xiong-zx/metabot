import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { digestObject, RulesPackError, type MetaMemoryRuleReader, type RuleInputV1 } from '@metabot/rulespack';

interface MetaMemoryDocument {
  path?: string;
  version?: number;
  updated_at?: string;
  content?: string;
}

interface StructuredMemoryRules {
  schemaVersion: 1;
  revision: string;
  rules: readonly RuleInputV1[];
}

export class CoreMetaMemoryRuleReader implements MetaMemoryRuleReader {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.METABOT_CORE_URL ?? 'http://127.0.0.1:9200') {
    const parsed = assertLoopbackUrl(new URL(baseUrl));
    this.baseUrl = parsed.toString().replace(/\/+$/u, '');
  }

  async readStructuredRules(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<{
    revision: string;
    generation: string;
    rules: readonly RuleInputV1[];
  }> {
    const token = process.env.METABOT_CORE_TOKEN?.trim() || (await tokenFromFile());
    const documents: MetaMemoryDocument[] = [];
    const rules: RuleInputV1[] = [];
    for (const memoryPath of paths) {
      const response = await fetchLoopback(
        new URL(`${this.baseUrl.replace(/\/+$/u, '')}/api/memory/documents/${encodeURIComponent(memoryPath)}`),
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal,
        },
      );
      if (!response.ok)
        throw new RulesPackError('SOURCE_UNAVAILABLE', `MetaMemory read failed with HTTP ${response.status}`);
      const raw = (await response.json()) as { document?: MetaMemoryDocument } | MetaMemoryDocument;
      const document = (raw as { document?: MetaMemoryDocument }).document ?? (raw as MetaMemoryDocument);
      if (!document?.content) throw new RulesPackError('VALIDATION_ERROR', 'MetaMemory Rules document has no content');
      let parsed: StructuredMemoryRules;
      try {
        parsed = JSON.parse(document.content) as StructuredMemoryRules;
      } catch {
        throw new RulesPackError('VALIDATION_ERROR', 'MetaMemory Rules content must be structured JSON');
      }
      if (parsed.schemaVersion !== 1 || typeof parsed.revision !== 'string' || !Array.isArray(parsed.rules)) {
        throw new RulesPackError('VALIDATION_ERROR', 'MetaMemory Rules document schema is invalid');
      }
      documents.push(document);
      rules.push(...parsed.rules);
    }
    const revision = digestObject(
      documents.map((document) => ({
        path: document.path,
        version: document.version,
        updatedAt: document.updated_at,
      })),
    );
    return { revision, generation: digestObject({ revision, rules }), rules };
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_LOOPBACK_REDIRECTS = 5;

async function fetchLoopback(url: URL, init: RequestInit): Promise<Response> {
  let current = assertLoopbackUrl(url);
  for (let redirects = 0; redirects <= MAX_LOOPBACK_REDIRECTS; redirects += 1) {
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (response.url) assertLoopbackUrl(new URL(response.url));
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirects === MAX_LOOPBACK_REDIRECTS) {
      throw new RulesPackError('SOURCE_UNAVAILABLE', 'MetaMemory redirect limit exceeded');
    }
    const location = response.headers.get('location');
    if (!location) throw new RulesPackError('SOURCE_UNAVAILABLE', 'MetaMemory redirect omitted Location');
    current = assertLoopbackUrl(new URL(location, current));
  }
  throw new RulesPackError('SOURCE_UNAVAILABLE', 'MetaMemory redirect limit exceeded');
}

function assertLoopbackUrl(url: URL): URL {
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const ipVersion = isIP(host);
  const loopback =
    host === 'localhost' || (ipVersion === 4 && host.startsWith('127.')) || (ipVersion === 6 && host === '::1');
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password) {
    throw new RulesPackError(
      'PATH_ESCAPE',
      'RulesPack MetaMemory Core must be host-local/loopback; remote Core identity is not configured',
    );
  }
  return url;
}

async function tokenFromFile(): Promise<string> {
  try {
    const contents = await readFile(join(homedir(), '.metabot-core', 'token'), 'utf8');
    return (
      contents
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? ''
    );
  } catch {
    return '';
  }
}
