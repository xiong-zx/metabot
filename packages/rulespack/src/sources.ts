import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { digestObject } from './canonical.js';
import { RulesPackError } from './errors.js';
import type { RuleInputV1, RuleV1, SourceGeneration, SourceKind, SourceSnapshot } from './model.js';
import { normalizeRule, parseRuleArray } from './validate.js';

export interface SourceLoadContext {
  now: string;
  signal?: AbortSignal;
}

export interface RuleSourceAdapter {
  readonly id: string;
  readonly kind: SourceKind;
  readonly required: boolean;
  load(context: SourceLoadContext): Promise<SourceSnapshot>;
}

export interface StructuredSourceOptions {
  id: string;
  kind: Exclude<SourceKind, 'file' | 'metamemory'>;
  revision: string;
  generation?: string;
  rules: readonly RuleInputV1[];
  required?: boolean;
  trustedAuthority?: boolean;
  freshForMs?: number;
  ref?: string;
}

function sourceGeneration(
  sourceId: string,
  kind: SourceKind,
  revision: string,
  rules: readonly RuleV1[],
  observedAt: string,
  generation?: string,
  freshForMs?: number,
): SourceGeneration {
  const snapshotDigest = digestObject(
    [...rules]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, version, digest }) => ({ id, version, digest })),
  );
  return {
    sourceId,
    kind,
    generation: generation ?? snapshotDigest,
    revision,
    snapshotDigest,
    observedAt,
    ...(freshForMs ? { freshUntil: new Date(Date.parse(observedAt) + freshForMs).toISOString() } : {}),
    health: 'fresh',
    ruleCount: rules.length,
  };
}

function normalizeForSource(
  input: RuleInputV1,
  source: { id: string; kind: SourceKind; revision: string; ref: string; trustedAuthority: boolean },
): RuleV1 {
  const { digest: _digest, tokenEstimate: _tokenEstimate, ...withoutComputed } = input;
  return normalizeRule({
    ...withoutComputed,
    source: {
      kind: source.kind,
      adapterId: source.id,
      revision: source.revision,
      ref: source.ref,
      ...(source.trustedAuthority ? { trustedAuthority: true } : {}),
    },
  });
}

export class StructuredSource implements RuleSourceAdapter {
  readonly id: string;
  readonly kind: StructuredSourceOptions['kind'];
  readonly required: boolean;
  readonly #options: StructuredSourceOptions;

  constructor(options: StructuredSourceOptions) {
    this.#options = options;
    this.id = options.id;
    this.kind = options.kind;
    this.required = options.required ?? false;
    if (options.kind === 'temporary') {
      for (const rule of options.rules) {
        if (!rule.lifecycle.expiresAt) {
          throw new RulesPackError('VALIDATION_ERROR', 'Temporary Rules require expiresAt');
        }
      }
    }
    if (options.kind === 'curated') {
      for (const rule of options.rules) {
        if (rule.metadata?.approved !== true) {
          throw new RulesPackError('VALIDATION_ERROR', 'Curated Rules require metadata.approved=true');
        }
      }
    }
  }

  async load(context: SourceLoadContext): Promise<SourceSnapshot> {
    context.signal?.throwIfAborted();
    const rules = this.#options.rules.map((rule) =>
      normalizeForSource(rule, {
        id: this.id,
        kind: this.kind,
        revision: this.#options.revision,
        ref: this.#options.ref ?? `${this.kind}:${this.id}`,
        trustedAuthority: this.#options.trustedAuthority ?? false,
      }),
    );
    return {
      source: sourceGeneration(
        this.id,
        this.kind,
        this.#options.revision,
        rules,
        context.now,
        this.#options.generation,
        this.#options.freshForMs,
      ),
      rules,
    };
  }
}

export const configSource = (options: Omit<StructuredSourceOptions, 'kind'>): RuleSourceAdapter =>
  new StructuredSource({ ...options, kind: 'config' });
export const rulesetSource = (options: Omit<StructuredSourceOptions, 'kind'>): RuleSourceAdapter =>
  new StructuredSource({ ...options, kind: 'ruleset' });
export const temporarySource = (options: Omit<StructuredSourceOptions, 'kind'>): RuleSourceAdapter =>
  new StructuredSource({ ...options, kind: 'temporary' });
export const curatedSource = (options: Omit<StructuredSourceOptions, 'kind'>): RuleSourceAdapter =>
  new StructuredSource({ ...options, kind: 'curated' });

export interface TrustedFileSourceOptions {
  id: string;
  trustedRoot: string;
  path: string;
  required?: boolean;
  maxBytes?: number;
  trustedAuthority?: boolean;
  nativeLoaded?: boolean;
}

interface RulesFileV1 {
  schemaVersion: 1;
  revision: string;
  generation?: string;
  rules: unknown;
}

export class TrustedFileSource implements RuleSourceAdapter {
  readonly id: string;
  readonly kind = 'file' as const;
  readonly required: boolean;
  readonly #options: TrustedFileSourceOptions;

  constructor(options: TrustedFileSourceOptions) {
    this.id = options.id;
    this.required = options.required ?? false;
    this.#options = options;
  }

  async load(context: SourceLoadContext): Promise<SourceSnapshot> {
    context.signal?.throwIfAborted();
    const root = await realpath(this.#options.trustedRoot);
    const requested = isAbsolute(this.#options.path)
      ? this.#options.path
      : resolve(root, this.#options.path);
    const actual = await realpath(requested);
    const escaped = relative(root, actual);
    if (escaped.startsWith('..') || isAbsolute(escaped)) {
      throw new RulesPackError('PATH_ESCAPE', 'Rules file resolves outside its trusted root', {
        trustedRoot: root,
        requested: this.#options.path,
      });
    }
    const fileStat = await stat(actual);
    const maxBytes = this.#options.maxBytes ?? 1_048_576;
    if (!fileStat.isFile() || fileStat.size > maxBytes) {
      throw new RulesPackError('VALIDATION_ERROR', 'Rules file is not a regular bounded file', {
        size: fileStat.size,
        maxBytes,
      });
    }
    if (this.#options.nativeLoaded) {
      const rules: readonly RuleV1[] = [];
      return {
        source: sourceGeneration(this.id, this.kind, `native:${fileStat.mtimeMs}`, rules, context.now),
        rules,
      };
    }
    const content = await readFile(actual, 'utf8');
    let parsed: RulesFileV1;
    try {
      parsed = JSON.parse(content) as RulesFileV1;
    } catch (error) {
      throw new RulesPackError('VALIDATION_ERROR', 'Rules file must be structured JSON', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (parsed.schemaVersion !== 1 || typeof parsed.revision !== 'string') {
      throw new RulesPackError('VALIDATION_ERROR', 'Rules file schemaVersion/revision is invalid');
    }
    const rawRules = parseRuleArray(parsed.rules);
    const rules = rawRules.map((rule) =>
      normalizeForSource(rule, {
        id: this.id,
        kind: this.kind,
        revision: parsed.revision,
        ref: actual,
        trustedAuthority: this.#options.trustedAuthority ?? false,
      }),
    );
    return {
      source: sourceGeneration(this.id, this.kind, parsed.revision, rules, context.now, parsed.generation),
      rules,
    };
  }
}

export interface MetaMemoryRuleReader {
  readStructuredRules(paths: readonly string[], signal?: AbortSignal): Promise<{
    revision: string;
    generation?: string;
    rules: readonly RuleInputV1[];
  }>;
}

export interface MetaMemorySourceOptions {
  id: string;
  paths: readonly string[];
  allowedRoots: readonly string[];
  reader: MetaMemoryRuleReader;
  required?: boolean;
  freshForMs?: number;
}

export class MetaMemorySource implements RuleSourceAdapter {
  readonly id: string;
  readonly kind = 'metamemory' as const;
  readonly required: boolean;
  readonly #options: MetaMemorySourceOptions;

  constructor(options: MetaMemorySourceOptions) {
    this.id = options.id;
    this.required = options.required ?? false;
    this.#options = options;
    for (const path of options.paths) {
      if (!options.allowedRoots.some((root) => path === root || path.startsWith(`${root.replace(/\/$/u, '')}/`))) {
        throw new RulesPackError('PATH_ESCAPE', 'MetaMemory path is outside the host-local allowlist', { path });
      }
    }
  }

  async load(context: SourceLoadContext): Promise<SourceSnapshot> {
    const loaded = await this.#options.reader.readStructuredRules(this.#options.paths, context.signal);
    const rules = loaded.rules.map((rule) =>
      normalizeForSource(rule, {
        id: this.id,
        kind: this.kind,
        revision: loaded.revision,
        ref: this.#options.paths.join(','),
        trustedAuthority: false,
      }),
    );
    return {
      source: sourceGeneration(
        this.id,
        this.kind,
        loaded.revision,
        rules,
        context.now,
        loaded.generation,
        this.#options.freshForMs,
      ),
      rules,
    };
  }
}
