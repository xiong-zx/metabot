import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
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
  constructor(private readonly baseUrl = process.env.METABOT_CORE_URL ?? 'http://127.0.0.1:9200') {}

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
      const response = await fetch(
        `${this.baseUrl.replace(/\/+$/u, '')}/api/memory/documents/${encodeURIComponent(memoryPath)}`,
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
