import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  RulesPackError,
  StructuredSource,
  digestObject,
  normalizeRule,
  type RuleInputV1,
  type RuleSourceAdapter,
  type SourceSnapshot,
} from '@metabot/rulespack';

export interface AgentsStructuredFileSourceOptions {
  id: string;
  trustedRoot: string;
  path: string;
  required?: boolean;
  maxBytes?: number;
  trustedAuthority?: boolean;
  nativeLoaded?: boolean;
  projectId?: string;
}

interface AgentsRulesBlock {
  schemaVersion: 1;
  revision: string;
  generation?: string;
  rules: readonly RuleInputV1[];
}

/**
 * Reads exactly one fenced `rulespack-json` block from an explicitly listed
 * AGENTS/project file. Surrounding prose is never interpreted as a Rule.
 */
export class AgentsStructuredFileSource implements RuleSourceAdapter {
  readonly kind = 'file' as const;
  readonly id: string;
  readonly required: boolean;

  constructor(private readonly options: AgentsStructuredFileSourceOptions) {
    this.id = options.id;
    this.required = options.required ?? false;
  }

  async load(context: { now: string; signal?: AbortSignal }): Promise<SourceSnapshot> {
    context.signal?.throwIfAborted();
    const root = await realpath(this.options.trustedRoot);
    const requested = isAbsolute(this.options.path) ? this.options.path : resolve(root, this.options.path);
    const actual = await realpath(requested);
    const escaped = relative(root, actual);
    if (escaped.startsWith('..') || isAbsolute(escaped)) {
      throw new RulesPackError('PATH_ESCAPE', 'AGENTS Rules file resolves outside its trusted root');
    }
    const file = await stat(actual);
    const maxBytes = this.options.maxBytes ?? 1_048_576;
    if (!file.isFile() || file.size > maxBytes) {
      throw new RulesPackError('VALIDATION_ERROR', 'AGENTS Rules file is not a regular bounded file');
    }
    if (this.options.nativeLoaded) {
      const text = await readFile(actual, 'utf8');
      const contentDigest = digestObject({ nativeContent: text });
      return new StructuredSource({
        id: this.id,
        kind: 'ruleset',
        revision: `native:${contentDigest}`,
        generation: contentDigest,
        rules: [],
        required: this.required,
      })
        .load(context)
        .then((snapshot) => ({
          source: { ...snapshot.source, kind: 'file' as const },
          rules: [],
        }));
    }
    const text = await readFile(actual, 'utf8');
    const matches = [...text.matchAll(/```rulespack-json\s*\n([\s\S]*?)\n```/gu)];
    if (matches.length !== 1 || !matches[0]?.[1]) {
      throw new RulesPackError(
        'VALIDATION_ERROR',
        'AGENTS Rules file must contain exactly one fenced rulespack-json block',
      );
    }
    let parsed: AgentsRulesBlock;
    try {
      parsed = JSON.parse(matches[0][1]) as AgentsRulesBlock;
    } catch (error) {
      throw new RulesPackError('VALIDATION_ERROR', 'AGENTS rulespack-json block must be valid JSON', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (parsed.schemaVersion !== 1 || typeof parsed.revision !== 'string' || !Array.isArray(parsed.rules)) {
      throw new RulesPackError('VALIDATION_ERROR', 'AGENTS rulespack-json schema is invalid');
    }
    const delegated = new StructuredSource({
      id: this.id,
      kind: 'ruleset',
      revision: parsed.revision,
      ...(parsed.generation ? { generation: parsed.generation } : {}),
      rules: bindProject(parsed.rules, this.options.projectId),
      required: this.required,
      trustedAuthority: this.options.trustedAuthority ?? false,
      ref: actual,
    });
    const snapshot = await delegated.load(context);
    const fileRules = snapshot.rules.map((rule) => {
      const { digest: _digest, tokenEstimate: _tokenEstimate, ...input } = rule;
      return normalizeRule({
        ...input,
        source: { ...rule.source, kind: 'file' as const },
      });
    });
    const snapshotDigest = digestObject(
      [...fileRules]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, version, digest: ruleDigest }) => ({ id, version, digest: ruleDigest })),
    );
    return {
      source: {
        ...snapshot.source,
        kind: 'file',
        snapshotDigest,
        generation: parsed.generation ?? snapshotDigest,
      },
      rules: fileRules,
    };
  }
}

export interface ProjectStructuredFileSourceOptions extends AgentsStructuredFileSourceOptions {
  projectId: string;
}

/** Structured JSON project source that applies its authenticated root binding before Rule validation. */
export class ProjectStructuredFileSource implements RuleSourceAdapter {
  readonly kind = 'file' as const;
  readonly id: string;
  readonly required: boolean;

  constructor(private readonly options: ProjectStructuredFileSourceOptions) {
    this.id = options.id;
    this.required = options.required ?? false;
  }

  async load(context: { now: string; signal?: AbortSignal }): Promise<SourceSnapshot> {
    context.signal?.throwIfAborted();
    const root = await realpath(this.options.trustedRoot);
    const requested = isAbsolute(this.options.path) ? this.options.path : resolve(root, this.options.path);
    const actual = await realpath(requested);
    const escaped = relative(root, actual);
    if (escaped.startsWith('..') || isAbsolute(escaped)) {
      throw new RulesPackError('PATH_ESCAPE', 'Project Rules file resolves outside its trusted root');
    }
    const file = await stat(actual);
    const maxBytes = this.options.maxBytes ?? 1_048_576;
    if (!file.isFile() || file.size > maxBytes) {
      throw new RulesPackError('VALIDATION_ERROR', 'Project Rules file is not a regular bounded file');
    }
    if (this.options.nativeLoaded) {
      const text = await readFile(actual, 'utf8');
      const contentDigest = digestObject({ nativeContent: text });
      const empty = await new StructuredSource({
        id: this.id,
        kind: 'ruleset',
        revision: `native:${contentDigest}`,
        generation: contentDigest,
        rules: [],
        required: this.required,
      }).load(context);
      return { source: { ...empty.source, kind: 'file' }, rules: [] };
    }
    let parsed: AgentsRulesBlock;
    try {
      parsed = JSON.parse(await readFile(actual, 'utf8')) as AgentsRulesBlock;
    } catch (error) {
      throw new RulesPackError('VALIDATION_ERROR', 'Project Rules file must be structured JSON', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (parsed.schemaVersion !== 1 || typeof parsed.revision !== 'string') {
      throw new RulesPackError('VALIDATION_ERROR', 'Project Rules file schema is invalid');
    }
    const delegated = new StructuredSource({
      id: this.id,
      kind: 'ruleset',
      revision: parsed.revision,
      ...(parsed.generation ? { generation: parsed.generation } : {}),
      rules: bindProject(parsed.rules, this.options.projectId),
      required: this.required,
      trustedAuthority: this.options.trustedAuthority ?? false,
      ref: actual,
    });
    return asFileSnapshot(await delegated.load(context), parsed.generation);
  }
}

function bindProject(rules: readonly RuleInputV1[], projectId: string | undefined): readonly RuleInputV1[] {
  if (!projectId) return rules;
  return rules.map((rule) => {
    if (rule.binding?.projectId && rule.binding.projectId !== projectId) {
      throw new RulesPackError('TARGET_MISMATCH', 'Project-native Rule claims a different project binding');
    }
    return { ...rule, binding: { ...rule.binding, projectId } };
  });
}

function asFileSnapshot(snapshot: SourceSnapshot, generation?: string): SourceSnapshot {
  const rules = snapshot.rules.map((rule) => {
    const { digest: _digest, tokenEstimate: _tokenEstimate, ...input } = rule;
    return normalizeRule({ ...input, source: { ...rule.source, kind: 'file' as const } });
  });
  const snapshotDigest = digestObject(
    [...rules]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, version, digest: ruleDigest }) => ({ id, version, digest: ruleDigest })),
  );
  return {
    source: { ...snapshot.source, kind: 'file', snapshotDigest, generation: generation ?? snapshotDigest },
    rules,
  };
}
