import { performance } from 'node:perf_hooks';
import { digestObject } from './canonical.js';
import { LruCache } from './cache.js';
import {
  compileRules,
  recomputePackDigest,
  sourceSnapshotDigest,
  subjectFingerprint,
  verifyCompiledPack,
} from './compiler.js';
import { RulesPackError } from './errors.js';
import {
  COMPILER_VERSION,
  type CompileBudget,
  type CompileTelemetry,
  type CompiledRulesPack,
  type ExecutionSubject,
  type RulesMode,
  type RulesPackStatus,
  type SourceGeneration,
} from './model.js';
import type { RuleSourceAdapter } from './sources.js';
import { RulesStore } from './store.js';
import { redactDiagnostic, validateRule, validateSourceGeneration } from './validate.js';

export interface RulesPackEngineOptions {
  store: RulesStore;
  mode?: RulesMode;
  cacheCapacity?: number;
  cacheTtlMs?: number;
  lastKnownGoodTtlMs?: number;
  defaultBudget?: CompileBudget;
  /** Testable transient compiler boundary; production uses the deterministic local compiler. */
  compiler?: typeof compileRules;
}

export interface EngineCompileOptions {
  subject: ExecutionSubject;
  budget?: CompileBudget;
  mode?: RulesMode;
  now?: string;
  sourceState?: RefreshedSourceState;
  /** Provisional delivery must not write or read caches/LKG before target acceptance. */
  provisional?: boolean;
}

export interface RefreshedSourceState {
  rules: ReturnType<RulesStore['listRules']>;
  generations: readonly SourceGeneration[];
  degradationReasons: readonly string[];
  usedLastKnownGood: boolean;
}

export interface EngineCompileResult {
  pack: CompiledRulesPack;
  telemetry: CompileTelemetry;
  /** Adapter injects this only in enforce mode. */
  injectionText: string;
}

const recoverableLkgFailure = (error: unknown): boolean =>
  error instanceof RulesPackError && error.code === 'COMPILE_UNAVAILABLE';

export class RulesPackEngine {
  readonly store: RulesStore;
  readonly #cache: LruCache<string, CompiledRulesPack>;
  mode: RulesMode;
  readonly #cacheTtlMs: number;
  readonly #lkgTtlMs: number;
  readonly #defaultBudget: CompileBudget;
  readonly #compiler: typeof compileRules;
  readonly #sourceCacheKeys = new Map<string, Set<string>>();
  #lastCompile?: CompileTelemetry;

  constructor(options: RulesPackEngineOptions) {
    this.store = options.store;
    this.mode = options.mode ?? 'off';
    this.#cache = new LruCache(options.cacheCapacity ?? 256);
    this.#cacheTtlMs = options.cacheTtlMs ?? 15 * 60_000;
    this.#lkgTtlMs = options.lastKnownGoodTtlMs ?? 60 * 60_000;
    this.#defaultBudget = options.defaultBudget ?? { maxTokens: 2_000, maxCharacters: 8_000 };
    this.#compiler = options.compiler ?? compileRules;
  }

  setMode(mode: RulesMode): void {
    this.mode = mode;
    this.#cache.clear();
  }

  async refreshSources(
    adapters: readonly RuleSourceAdapter[],
    options: { now?: string; signal?: AbortSignal } = {},
  ): Promise<RefreshedSourceState> {
    const now = options.now ?? new Date().toISOString();
    const previous = new Map(this.store.listSourceGenerations().map((source) => [source.sourceId, source]));
    const degradationReasons: string[] = [];
    let usedLastKnownGood = false;
    const generations: SourceGeneration[] = [];
    const rules = [] as ReturnType<RulesStore['listRules']>[number][];

    const outcomes = await Promise.all(
      adapters.map(async (adapter) => {
        try {
          return {
            adapter,
            snapshot: await adapter.load({ now, ...(options.signal ? { signal: options.signal } : {}) }),
          };
        } catch (error) {
          return { adapter, error };
        }
      }),
    );
    for (const outcome of outcomes) {
      if ('snapshot' in outcome && outcome.snapshot) {
        const snapshot = {
          ...outcome.snapshot,
          source: { ...outcome.snapshot.source, required: outcome.adapter.required },
        };
        const old = previous.get(outcome.adapter.id);
        this.store.replaceSourceSnapshot(snapshot);
        generations.push(snapshot.source);
        rules.push(...snapshot.rules);
        if (!old || old.generation !== snapshot.source.generation) this.invalidateSource(outcome.adapter.id);
        this.store.audit(
          'source-refresh',
          {
            health: 'fresh',
            generation: snapshot.source.generation,
            ruleCount: snapshot.rules.length,
          },
          { sourceId: outcome.adapter.id },
        );
        continue;
      }
      const message = redactDiagnostic(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      if (outcome.adapter.required) {
        throw new RulesPackError('SOURCE_UNAVAILABLE', `Required source ${outcome.adapter.id} failed`, {
          cause: message,
        });
      }
      const prior = previous.get(outcome.adapter.id);
      const withinLkgBound =
        prior &&
        (prior.health === 'fresh' || prior.health === 'stale') &&
        Date.parse(now) - Date.parse(prior.freshUntil ?? prior.observedAt) <= this.#lkgTtlMs;
      if (prior && withinLkgBound) {
        usedLastKnownGood = true;
        const stale: SourceGeneration = { ...prior, health: 'stale', error: message };
        generations.push(stale);
        rules.push(...this.store.listRules(outcome.adapter.id));
        this.store.upsertSourceGeneration(stale);
        degradationReasons.push(`source ${outcome.adapter.id} unavailable; bounded stored generation used`);
      } else {
        const unavailable: SourceGeneration = {
          sourceId: outcome.adapter.id,
          kind: outcome.adapter.kind,
          generation: 'unavailable',
          revision: 'unavailable',
          snapshotDigest: digestObject([]),
          observedAt: now,
          required: outcome.adapter.required,
          health: 'unavailable',
          error: message,
          ruleCount: 0,
        };
        generations.push(unavailable);
        this.store.upsertSourceGeneration(unavailable);
        degradationReasons.push(
          prior
            ? `source ${outcome.adapter.id} unavailable; stored generation exceeded LKG bound`
            : `source ${outcome.adapter.id} unavailable; no stored generation`,
        );
      }
      this.store.audit(
        'source-refresh',
        { health: prior && withinLkgBound ? 'stale' : 'unavailable', error: message },
        { sourceId: outcome.adapter.id },
      );
      this.invalidateSource(outcome.adapter.id);
    }
    return this.#effectiveSourceState({ rules, generations, degradationReasons, usedLastKnownGood }, now);
  }

  currentSourceState(now = new Date().toISOString()): RefreshedSourceState {
    return this.#storedSourceState(now, true, false) as RefreshedSourceState;
  }

  compile(options: EngineCompileOptions): EngineCompileResult {
    const started = performance.now();
    const now = options.now ?? new Date().toISOString();
    const mode = options.mode ?? this.mode;
    const budget = options.budget ?? this.#defaultBudget;
    const fingerprint = subjectFingerprint(options.subject);
    if (mode === 'off') {
      let sourceState: RefreshedSourceState;
      try {
        sourceState = this.#effectiveSourceState(
          options.sourceState ?? this.#storedSourceState(now, false, false),
          now,
          false,
        ) as RefreshedSourceState;
      } catch (error) {
        sourceState = {
          rules: [],
          generations: [],
          degradationReasons: [
            `source state unavailable while mode is off: ${redactDiagnostic(error instanceof Error ? error.message : String(error))}`,
          ],
          usedLastKnownGood: false,
        };
      }
      const pack = compileRules({
        subject: options.subject,
        rules: [],
        sourceGenerations: sourceState.generations,
        budget,
        mode,
        now,
        degradationReasons: sourceState.degradationReasons,
      });
      const telemetry = this.#telemetry(pack, performance.now() - started, 'bypass-off', 0, false);
      return { pack, telemetry, injectionText: '' };
    }
    const sourceState = this.#effectiveSourceState(options.sourceState ?? this.#storedSourceState(now, false), now);
    const snapshotDigest = sourceSnapshotDigest({ sourceGenerations: sourceState.generations });
    const cacheKey = digestObject({
      compilerVersion: COMPILER_VERSION,
      subjectFingerprint: fingerprint,
      sourceSnapshotDigest: snapshotDigest,
      generations: sourceState.generations.map(({ sourceId, generation }) => ({ sourceId, generation })),
      budget,
      mode,
    });
    const candidateCount = sourceState.rules?.length ?? this.store.counts().currentRules;
    const cacheEnabled = options.provisional !== true;
    const memory = cacheEnabled ? this.#cache.get(cacheKey) : undefined;
    let verifiedMemory: CompiledRulesPack | undefined;
    if (memory) {
      try {
        verifyCompiledPack(memory, now);
        if (this.store.isPackSafe(memory, now)) verifiedMemory = memory;
      } catch {
        this.#cache.delete(cacheKey);
      }
    }
    if (verifiedMemory) {
      const telemetry = this.#telemetry(
        verifiedMemory,
        performance.now() - started,
        'hit-memory',
        candidateCount,
        sourceState.usedLastKnownGood,
      );
      this.store.audit(
        'cache-hit',
        { level: 'memory', cacheKey },
        { subjectFingerprint: fingerprint, packDigest: verifiedMemory.packDigest },
      );
      return { pack: verifiedMemory, telemetry, injectionText: mode === 'enforce' ? verifiedMemory.renderedText : '' };
    }
    const persistent = cacheEnabled ? this.store.getCachedPack(cacheKey, now) : undefined;
    if (persistent) {
      this.#cache.set(cacheKey, persistent);
      this.#indexCacheKey(cacheKey, persistent.sourceGenerations);
      const telemetry = this.#telemetry(
        persistent,
        performance.now() - started,
        'hit-persistent',
        candidateCount,
        sourceState.usedLastKnownGood,
      );
      this.store.audit(
        'cache-hit',
        { level: 'persistent', cacheKey },
        { subjectFingerprint: fingerprint, packDigest: persistent.packDigest },
      );
      return { pack: persistent, telemetry, injectionText: mode === 'enforce' ? persistent.renderedText : '' };
    }

    this.store.audit('cache-miss', { cacheKey }, { subjectFingerprint: fingerprint });
    try {
      const currentRules =
        sourceState.rules ??
        sourceState.generations
          .filter((source) => source.health === 'fresh' || source.health === 'stale')
          .flatMap((source) => this.store.listRules(source.sourceId));
      this.#assertCurrentSourceSafety(currentRules, sourceState.generations);
      const pack = this.#compiler({
        subject: options.subject,
        rules: currentRules,
        sourceGenerations: sourceState.generations,
        budget,
        mode,
        now,
        degradationReasons: sourceState.degradationReasons,
      });
      if (cacheEnabled) {
        this.#cache.set(cacheKey, pack);
        this.#indexCacheKey(cacheKey, pack.sourceGenerations);
        const validUntil = new Date(Date.parse(now) + this.#cacheTtlMs).toISOString();
        this.store.putCachedPack(cacheKey, pack, validUntil);
        if (!pack.degraded) {
          this.store.putLastKnownGood(pack, new Date(Date.parse(now) + this.#lkgTtlMs).toISOString());
        }
      }
      const telemetry = this.#telemetry(
        pack,
        performance.now() - started,
        'miss',
        candidateCount,
        sourceState.usedLastKnownGood,
      );
      this.store.audit(
        'compile',
        {
          compileLatencyMs: telemetry.compileLatencyMs,
          candidateCount: telemetry.candidateCount,
          selectedRuleCount: telemetry.selectedRuleCount,
          excludedRuleCount: telemetry.excludedRuleCount,
          tokenCount: telemetry.tokenCount,
          characterCount: telemetry.characterCount,
          degraded: telemetry.degraded,
          usedLastKnownGood: telemetry.usedLastKnownGood,
        },
        { subjectFingerprint: pack.subjectFingerprint, packDigest: pack.packDigest },
      );
      return { pack, telemetry, injectionText: mode === 'enforce' ? pack.renderedText : '' };
    } catch (error) {
      if (!cacheEnabled || !recoverableLkgFailure(error)) throw error;
      const currentRules =
        sourceState.rules ??
        sourceState.generations
          .filter((source) => source.health === 'fresh' || source.health === 'stale')
          .flatMap((source) => this.store.listRules(source.sourceId));
      this.#assertCurrentSourceSafety(currentRules, sourceState.generations);
      this.#assertLkgCurrentLifecycle(currentRules, now);
      const lkg = this.store.getLastKnownGood(fingerprint, now);
      if (!lkg) throw error;
      const pack = recomputePackDigest({
        ...lkg,
        compiledAt: now,
        degraded: true,
        degradationReasons: [
          ...lkg.degradationReasons,
          `compile failed; last-known-good used: ${error instanceof Error ? error.message : String(error)}`,
        ],
        lastKnownGood: true,
      });
      const telemetry = this.#telemetry(pack, performance.now() - started, 'miss', candidateCount, true);
      this.store.audit(
        'lkg-used',
        { reason: error instanceof Error ? error.message : String(error) },
        {
          subjectFingerprint: pack.subjectFingerprint,
          packDigest: pack.packDigest,
        },
      );
      return { pack, telemetry, injectionText: mode === 'enforce' ? pack.renderedText : '' };
    }
  }

  #assertCurrentSourceSafety(
    rules: ReturnType<RulesStore['listRules']>,
    generations: readonly SourceGeneration[],
  ): void {
    const validatedRules = rules.map(validateRule);
    const validatedGenerations = generations.map(validateSourceGeneration);
    const bySource = new Map<string, typeof validatedRules>();
    for (const rule of validatedRules) {
      const sourceRules = bySource.get(rule.source.adapterId) ?? [];
      sourceRules.push(rule);
      bySource.set(rule.source.adapterId, sourceRules);
    }
    for (const source of validatedGenerations) {
      if (source.health !== 'fresh' && source.health !== 'stale') continue;
      const sourceRules = bySource.get(source.sourceId) ?? [];
      const snapshotDigest = digestObject(
        [...sourceRules]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(({ id, version, digest }) => ({ id, version, digest })),
      );
      if (source.ruleCount !== sourceRules.length || source.snapshotDigest !== snapshotDigest) {
        throw new RulesPackError('STORE_ERROR', `Source ${source.sourceId} failed its integrity check`);
      }
    }
  }

  #assertLkgCurrentLifecycle(rules: ReturnType<RulesStore['listRules']>, now: string): void {
    const nowMs = Date.parse(now);
    for (const rule of rules) {
      if (
        rule.lifecycle.status === 'revoked' ||
        (rule.lifecycle.validFrom !== undefined && Date.parse(rule.lifecycle.validFrom) > nowMs) ||
        (rule.lifecycle.expiresAt !== undefined && Date.parse(rule.lifecycle.expiresAt) <= nowMs)
      ) {
        throw new RulesPackError('VALIDATION_ERROR', `Rule ${rule.id} lifecycle is not eligible for LKG recovery`);
      }
    }
  }

  invalidateSource(sourceId: string): number {
    const keys = this.#sourceCacheKeys.get(sourceId) ?? new Set();
    for (const key of keys) this.#cache.delete(key);
    this.#sourceCacheKeys.delete(sourceId);
    return this.store.invalidateSourceCache(sourceId);
  }

  clearCache(): number {
    this.#cache.clear();
    this.#sourceCacheKeys.clear();
    return this.store.clearCache();
  }

  status(): RulesPackStatus {
    const counts = this.store.counts();
    const sources = this.#storedSourceState(new Date().toISOString(), false, false).generations;
    return {
      mode: this.mode,
      compilerVersion: COMPILER_VERSION,
      inMemoryCacheEntries: this.#cache.size,
      persistentCacheEntries: counts.persistentCacheEntries,
      currentRules: counts.currentRules,
      revokedRules: counts.revokedRules,
      sources,
      ...(this.#lastCompile ? { lastCompile: this.#lastCompile } : {}),
    };
  }

  #indexCacheKey(cacheKey: string, sources: readonly SourceGeneration[]): void {
    for (const source of sources) {
      const keys = this.#sourceCacheKeys.get(source.sourceId) ?? new Set<string>();
      keys.add(cacheKey);
      this.#sourceCacheKeys.set(source.sourceId, keys);
    }
  }

  #storedSourceState(
    now: string,
    includeRules: boolean,
    failRequired = true,
  ): Omit<RefreshedSourceState, 'rules'> & {
    rules: RefreshedSourceState['rules'] | undefined;
  } {
    const generations = this.store.listSourceGenerations();
    return this.#effectiveSourceState(
      {
        rules: includeRules ? generations.flatMap((source) => this.store.listRules(source.sourceId)) : undefined,
        generations,
        degradationReasons: [],
        usedLastKnownGood: false,
      },
      now,
      failRequired,
    );
  }

  #effectiveSourceState<T extends ReturnType<RulesStore['listRules']> | undefined>(
    state: Omit<RefreshedSourceState, 'rules'> & { rules: T },
    now: string,
    failRequired = true,
  ): Omit<RefreshedSourceState, 'rules'> & { rules: T } {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new RulesPackError('VALIDATION_ERROR', 'compile now must be an ISO timestamp');
    let usedLastKnownGood = state.usedLastKnownGood;
    const reasons = [...state.degradationReasons];
    const generations = state.generations.map((source): SourceGeneration => {
      const freshnessExpired = source.freshUntil !== undefined && Date.parse(source.freshUntil) <= nowMs;
      const staleSince = source.freshUntil ? Date.parse(source.freshUntil) : Date.parse(source.observedAt);
      const withinLkg = nowMs - staleSince <= this.#lkgTtlMs;
      if (source.health === 'fresh' && !freshnessExpired) return source;
      if ((source.health === 'fresh' && freshnessExpired) || source.health === 'stale') {
        if (source.required) {
          if (failRequired)
            throw new RulesPackError('SOURCE_UNAVAILABLE', `Required source ${source.sourceId} is stale`);
          const reason = `required source ${source.sourceId} is stale`;
          if (!reasons.includes(reason)) reasons.push(reason);
          return { ...source, health: 'unavailable', error: source.error ?? 'freshness deadline expired' };
        }
        if (withinLkg) {
          usedLastKnownGood = true;
          const reason = `source ${source.sourceId} stale; bounded stored generation used`;
          if (!reasons.includes(reason)) reasons.push(reason);
          return { ...source, health: 'stale', error: source.error ?? 'freshness deadline expired' };
        }
        const reason = `source ${source.sourceId} unavailable; stored generation exceeded LKG bound`;
        if (!reasons.includes(reason)) reasons.push(reason);
        return { ...source, health: 'unavailable', error: source.error ?? 'stored generation exceeded LKG bound' };
      }
      if (source.required) {
        if (failRequired)
          throw new RulesPackError('SOURCE_UNAVAILABLE', `Required source ${source.sourceId} is ${source.health}`);
        const reason = `required source ${source.sourceId} is ${source.health}`;
        if (!reasons.includes(reason)) reasons.push(reason);
        return source;
      }
      const reason = `source ${source.sourceId} is ${source.health}${source.error ? `: ${source.error}` : ''}`;
      if (!reasons.includes(reason)) reasons.push(reason);
      return source;
    });
    const active = new Set(
      generations
        .filter((source) => source.health === 'fresh' || source.health === 'stale')
        .map((source) => source.sourceId),
    );
    const filteredRules = state.rules?.filter((rule) => active.has(rule.source.adapterId)) as T;
    return { rules: filteredRules, generations, degradationReasons: reasons, usedLastKnownGood };
  }

  #telemetry(
    pack: CompiledRulesPack,
    latency: number,
    cache: CompileTelemetry['cache'],
    candidateCount: number,
    usedLastKnownGood: boolean,
  ): CompileTelemetry {
    const telemetry: CompileTelemetry = {
      compileLatencyMs: Number(latency.toFixed(3)),
      cache,
      candidateCount,
      selectedRuleCount: pack.rules.length,
      excludedRuleCount: pack.decisions.filter(
        (item) => item.disposition !== 'selected' && item.disposition !== 'dependency-added',
      ).length,
      tokenCount: pack.estimatedTokens,
      characterCount: pack.characters,
      packDigest: pack.packDigest,
      degraded: pack.degraded,
      usedLastKnownGood: usedLastKnownGood || pack.lastKnownGood,
      sourceFreshness: pack.sourceGenerations,
    };
    this.#lastCompile = telemetry;
    return telemetry;
  }
}
