import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MetaMemorySource,
  RulesPackEngine,
  RulesPackError,
  RulesStore,
  configSource,
  curatedSource,
  digestObject,
  dispatchEnvelopeFingerprint,
  eventId,
  normalizeRule,
  rulesetSource,
  subjectFingerprint,
  temporarySource,
  validateDispatchEnvelope,
  type CompileBudget,
  type DeliveryReceipt,
  type EngineCompileResult,
  type ExecutionSubject,
  type RuleInputV1,
  type RuleSourceAdapter,
  type RulesFeedback,
  type RulesMode,
  type RulesPackDispatchEnvelopeV1,
  type SourceSnapshot,
} from '@metabot/rulespack';
import { CoreMetaMemoryRuleReader } from './metamemory-reader.js';
import { AgentsStructuredFileSource, ProjectStructuredFileSource } from './native-source.js';
import type {
  AuthenticatedDispatchContext,
  AuthenticatedExecutionFacts,
  PreparedRulesPackTurn,
  RulesPackConfig,
  RulesPackLogger,
  RulesPackOperator,
  RulesPackOperatorStatus,
  RulesPackProjectBindingConfig,
  RulesPackStructuredSourceConfig,
} from './types.js';

const DEFAULT_BUDGET: CompileBudget = { maxTokens: 2_000, maxCharacters: 8_000 };
const DEFAULT_REFRESH_DEBOUNCE_MS = 250;
const DEFAULT_MAX_ENVELOPE_TTL_MS = 15 * 60_000;
const RESERVED_DATABASE_BASENAMES = new Set(['sessions.db', 'agent-teams.db', 'workers.sqlite', 'arc-runs.sqlite']);

interface ReplayRow {
  replay_id: string;
}

export class MetaBotRulesPackRuntime implements RulesPackOperator {
  readonly hostId: string;
  readonly dbPath: string;
  readonly audience: string;
  readonly engine: RulesPackEngine;

  private readonly config: RulesPackConfig;
  private readonly logger: RulesPackLogger;
  private readonly stateDb: DatabaseSync;
  private readonly projectBindings: Array<RulesPackProjectBindingConfig & { canonicalRoot: string }>;
  private readonly temporaryAdapters = new Map<string, RuleSourceAdapter>();
  private readonly watchers: FSWatcher[] = [];
  private readonly budget: CompileBudget;
  private initializePromise?: Promise<void>;
  private refreshPromise?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setInterval>;
  private initialized = false;
  private refreshing = false;
  private lastRefreshAt?: string;
  private lastRefreshError?: string;
  private targetMismatchRejections = 0;
  private replayRejections = 0;

  constructor(config: RulesPackConfig | undefined, logger: RulesPackLogger) {
    this.config = config ?? {};
    this.logger = logger;
    this.hostId = nonempty(this.config.hostId ?? process.env.RULESPACK_HOST_ID ?? hostname(), 'RulesPack hostId');
    this.dbPath = resolveRulesPackDbPath(this.config.dbPath);
    this.audience = nonempty(
      this.config.dispatch?.audience ?? `metabot-host:${this.hostId}`,
      'RulesPack dispatch audience',
    );
    if (this.config.metaMemory) {
      const namespace = this.config.metaMemory.hostRoot.replace(/^\/+|\/+$/gu, '').split('/')[0];
      if (!namespace || namespace.toLowerCase() !== this.hostId.toLowerCase()) {
        throw new RulesPackError('PATH_ESCAPE', 'MetaMemory hostRoot must be the namespace of this configured hostId');
      }
    }
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true });
    const store = new RulesStore(this.dbPath);
    this.engine = new RulesPackEngine({
      store,
      mode: normalizeMode(this.config.mode),
      ...(this.config.cacheCapacity !== undefined ? { cacheCapacity: this.config.cacheCapacity } : {}),
      ...(this.config.cacheTtlMs !== undefined ? { cacheTtlMs: this.config.cacheTtlMs } : {}),
      ...(this.config.lastKnownGoodTtlMs !== undefined ? { lastKnownGoodTtlMs: this.config.lastKnownGoodTtlMs } : {}),
      defaultBudget: {
        maxTokens: positiveInteger(this.config.budget?.maxTokens ?? DEFAULT_BUDGET.maxTokens, 'maxTokens'),
        maxCharacters: positiveInteger(
          this.config.budget?.maxCharacters ?? DEFAULT_BUDGET.maxCharacters,
          'maxCharacters',
        ),
      },
    });
    this.budget = {
      maxTokens: this.config.budget?.maxTokens ?? DEFAULT_BUDGET.maxTokens,
      maxCharacters: this.config.budget?.maxCharacters ?? DEFAULT_BUDGET.maxCharacters,
    };
    this.projectBindings = (this.config.projectBindings ?? [])
      .map((binding) => ({
        ...binding,
        projectId: nonempty(binding.projectId, 'RulesPack projectId'),
        canonicalRoot: realpathSync(expandPath(binding.root)),
      }))
      .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length);
    this.stateDb = new DatabaseSync(this.dbPath);
    this.stateDb.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    if (this.dbPath !== ':memory:') this.stateDb.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrateAdapterState();
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await this.refresh();
        this.installWatchers();
        const intervalMs = this.config.refreshIntervalMs;
        if (intervalMs !== undefined && intervalMs > 0) {
          this.intervalTimer = setInterval(() => this.scheduleRefresh(), intervalMs);
          this.intervalTimer.unref?.();
        }
        this.initialized = true;
      })().catch((error) => {
        this.initializePromise = undefined;
        throw error;
      });
    }
    await this.initializePromise;
  }

  async prepareTurn(
    facts: AuthenticatedExecutionFacts,
    incoming?: { envelope: RulesPackDispatchEnvelopeV1; transport: AuthenticatedDispatchContext },
  ): Promise<PreparedRulesPackTurn> {
    if (this.engine.mode === 'off') {
      void this.initialize().catch((error) => {
        this.logger.warn({ error: safeError(error) }, 'RulesPack refresh unavailable while mode is off');
      });
    } else {
      await this.initialize();
    }
    const subject = this.buildSubject(facts);
    let receivedEnvelope: RulesPackDispatchEnvelopeV1 | undefined;
    if (incoming && this.engine.mode !== 'off') {
      try {
        receivedEnvelope = this.consumeEnvelope(incoming.envelope, subject, incoming.transport);
      } catch (error) {
        this.recordRejectedEnvelope(incoming.envelope, subject, error);
        throw error;
      }
    }
    // The verified received Rules are now a bounded local temporary source.
    // Compile exactly once, applying local mandatory policy without editing
    // the received rendered bytes.
    const local = this.engine.compile({ subject, budget: this.budget });
    const injectionText = local.injectionText;
    const effectiveDigest = local.pack.packDigest;
    this.recordPreparedReceipt(local, subject);

    let injected = false;
    return {
      mode: this.engine.mode,
      subject,
      packDigest: effectiveDigest,
      injectionText,
      telemetry: local.telemetry,
      ...(receivedEnvelope ? { receivedEnvelope } : {}),
      markInjected: () => {
        if (injected || this.engine.mode !== 'enforce' || injectionText.length === 0) return;
        injected = true;
        this.engine.store.recordReceipt(
          receipt({
            packDigest: effectiveDigest,
            subject,
            status: 'injected',
            ...(receivedEnvelope
              ? {
                  issuer: receivedEnvelope.issuer,
                  audience: receivedEnvelope.audience,
                  replayId: receivedEnvelope.replayId,
                }
              : {}),
            details: { channelPosition: 'codex-user-prelude', dispatched: receivedEnvelope !== undefined },
          }),
        );
      },
    };
  }

  async createDispatchEnvelope(input: {
    facts: AuthenticatedExecutionFacts;
    audience: string;
    required?: boolean;
    parentDispatchId?: string;
    ttlMs?: number;
    now?: string;
    /** Authenticated peer registry fact; never accepted from prompt content. */
    targetHostId?: string;
    /** Authenticated dispatch/project registry fact for a remote child. */
    targetProjectId?: string;
  }): Promise<RulesPackDispatchEnvelopeV1> {
    await this.initialize();
    const subject = {
      ...this.buildSubject(input.facts),
      ...(input.targetHostId ? { hostId: nonempty(input.targetHostId, 'dispatch target hostId') } : {}),
      ...(input.targetProjectId ? { projectId: nonempty(input.targetProjectId, 'dispatch target projectId') } : {}),
    };
    const result = this.engine.compile({ subject, budget: this.budget, now: input.now });
    const issuedAt = input.now ?? new Date().toISOString();
    const ttlMs = Math.min(
      positiveInteger(input.ttlMs ?? this.config.dispatch?.maxEnvelopeTtlMs ?? DEFAULT_MAX_ENVELOPE_TTL_MS, 'ttlMs'),
      this.config.dispatch?.maxEnvelopeTtlMs ?? DEFAULT_MAX_ENVELOPE_TTL_MS,
    );
    const issuer = nonempty(this.config.dispatch?.issuer ?? `metabot-host:${this.hostId}`, 'dispatch issuer');
    const envelope: RulesPackDispatchEnvelopeV1 = {
      schemaVersion: 1,
      envelopeId: `envelope-${randomUUID()}`,
      issuer,
      audience: nonempty(input.audience, 'dispatch audience'),
      replayId: `replay-${randomUUID()}`,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
      subjectFingerprint: result.pack.subjectFingerprint,
      target: subject,
      packDigest: result.pack.packDigest,
      pack: result.pack,
      required: input.required ?? false,
      ...(input.parentDispatchId ? { parentDispatchId: input.parentDispatchId } : {}),
      authentication: { scheme: 'metabot-authenticated-transport', value: 'bound' },
    };
    this.engine.store.recordReceipt(
      receipt({
        packDigest: result.pack.packDigest,
        subject,
        status: this.engine.mode === 'shadow' ? 'shadowed' : 'compiled',
        issuer,
        audience: envelope.audience,
        replayId: envelope.replayId,
        details: { envelopeFingerprint: dispatchEnvelopeFingerprint(envelope) },
      }),
    );
    return envelope;
  }

  async replaceTemporaryRules(input: {
    sourceId: string;
    revision: string;
    rules: readonly RuleInputV1[];
    authenticatedFacts: AuthenticatedExecutionFacts;
  }): Promise<RulesPackOperatorStatus> {
    const subject = this.buildSubject(input.authenticatedFacts);
    const bounded = input.rules.map((rule) => {
      if (!rule.lifecycle.expiresAt) throw new RulesPackError('VALIDATION_ERROR', 'Temporary Rules require expiry');
      const binding = rule.binding ?? {};
      if (binding.chatId && binding.chatId !== subject.chatId) {
        throw new RulesPackError('TARGET_MISMATCH', 'Temporary Rule chat binding exceeds authenticated scope');
      }
      if (binding.userId && binding.userId !== subject.userId) {
        throw new RulesPackError('TARGET_MISMATCH', 'Temporary Rule user binding exceeds authenticated scope');
      }
      if (binding.taskId && binding.taskId !== subject.taskId) {
        throw new RulesPackError('TARGET_MISMATCH', 'Temporary Rule task binding exceeds authenticated scope');
      }
      if (binding.projectId && binding.projectId !== subject.projectId) {
        throw new RulesPackError('TARGET_MISMATCH', 'Temporary Rule project binding exceeds authenticated scope');
      }
      const includedBots = rule.targets.include?.bots;
      if (includedBots && !includedBots.includes(subject.bot)) {
        throw new RulesPackError('TARGET_MISMATCH', 'Temporary Rule bot target exceeds authenticated scope');
      }
      return {
        ...rule,
        binding: {
          ...binding,
          chatId: subject.chatId,
          ...(subject.userId ? { userId: subject.userId } : {}),
          ...(subject.taskId ? { taskId: subject.taskId } : {}),
          ...(subject.projectId ? { projectId: subject.projectId } : {}),
          hostId: subject.hostId,
        },
        targets: {
          ...rule.targets,
          include: {
            ...rule.targets.include,
            bots: [subject.bot],
            ...(subject.agent ? { agents: [subject.agent] } : {}),
            ...(subject.worker ? { workers: [subject.worker] } : {}),
            hosts: [subject.hostId],
          },
        },
      };
    });
    this.temporaryAdapters.set(
      input.sourceId,
      temporarySource({
        id: input.sourceId,
        revision: input.revision,
        rules: bounded,
        required: false,
      }),
    );
    await this.refresh();
    return this.status();
  }

  buildSubject(facts: AuthenticatedExecutionFacts): ExecutionSubject {
    if (!facts || typeof facts !== 'object')
      throw new RulesPackError('VALIDATION_ERROR', 'Authenticated facts required');
    const cwd = realpathSync(facts.cwd);
    const project = this.projectBindings.find((binding) => containedBy(binding.canonicalRoot, cwd));
    return {
      hostId: this.hostId,
      bot: nonempty(facts.botName, 'authenticated botName'),
      roles: exactValues(facts.roles),
      ...(facts.agentName ? { agent: nonempty(facts.agentName, 'authenticated agentName') } : {}),
      ...(facts.workerId ? { worker: nonempty(facts.workerId, 'authenticated workerId') } : {}),
      ...(facts.userId ? { userId: nonempty(facts.userId, 'authenticated userId') } : {}),
      ...(project ? { projectId: project.projectId } : {}),
      chatId: nonempty(facts.chatId, 'authenticated chatId'),
      ...(facts.taskId ? { taskId: nonempty(facts.taskId, 'authenticated taskId') } : {}),
      tools: exactValues(facts.tools ?? []),
      dataClasses: exactValues(facts.dataClasses ?? []),
      outputTypes: exactValues(facts.outputTypes ?? ['text']),
      engine: 'codex',
      ...(facts.sessionId ? { sessionId: nonempty(facts.sessionId, 'authenticated sessionId') } : {}),
    };
  }

  status(): RulesPackOperatorStatus {
    return {
      ...this.engine.status(),
      dbPath: this.dbPath,
      hostId: this.hostId,
      audience: this.audience,
      initialized: this.initialized,
      refreshing: this.refreshing,
      ...(this.lastRefreshAt ? { lastRefreshAt: this.lastRefreshAt } : {}),
      ...(this.lastRefreshError ? { lastRefreshError: this.lastRefreshError } : {}),
      targetMismatchRejections: this.targetMismatchRejections,
      replayRejections: this.replayRejections,
    };
  }

  setMode(mode: RulesMode): RulesPackOperatorStatus {
    this.engine.setMode(normalizeMode(mode));
    this.stateDb
      .prepare(
        'INSERT INTO rulespack_adapter_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      )
      .run('last_operator_mode', mode, new Date().toISOString());
    return this.status();
  }

  async refresh(): Promise<RulesPackOperatorStatus> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return this.status();
    }
    this.refreshing = true;
    this.refreshPromise = (async () => {
      try {
        const adapters = this.buildSourceAdapters();
        this.retireRemovedSources(adapters);
        await this.engine.refreshSources(adapters);
        this.stateDb
          .prepare(
            'INSERT INTO rulespack_adapter_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
          )
          .run(
            'configured_source_ids',
            JSON.stringify(adapters.map((adapter) => adapter.id).sort()),
            new Date().toISOString(),
          );
        this.lastRefreshAt = new Date().toISOString();
        this.lastRefreshError = undefined;
      } catch (error) {
        this.lastRefreshError = safeError(error);
        throw error;
      } finally {
        this.refreshing = false;
        this.refreshPromise = undefined;
      }
    })();
    await this.refreshPromise;
    return this.status();
  }

  clearCache(): { cleared: number; status: RulesPackOperatorStatus } {
    const cleared = this.engine.clearCache();
    return { cleared, status: this.status() };
  }

  async explain(facts: AuthenticatedExecutionFacts): Promise<EngineCompileResult> {
    await this.initialize();
    return this.engine.compile({ subject: this.buildSubject(facts), budget: this.budget });
  }

  receipts(packDigest?: string, limit = 100): readonly DeliveryReceipt[] {
    return this.engine.store.listReceipts(packDigest, boundedLimit(limit));
  }

  feedback(packDigest?: string, limit = 100): readonly RulesFeedback[] {
    return this.engine.store.listFeedback(packDigest, boundedLimit(limit));
  }

  addFeedback(input: Omit<RulesFeedback, 'feedbackId' | 'createdAt'>): RulesFeedback {
    const value: RulesFeedback = {
      ...input,
      feedbackId: eventId('feedback'),
      createdAt: new Date().toISOString(),
    };
    this.engine.store.recordFeedback(value);
    return value;
  }

  close(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    this.stateDb.close();
    this.engine.store.close();
  }

  private consumeEnvelope(
    envelope: RulesPackDispatchEnvelopeV1,
    expectedTarget: ExecutionSubject,
    transport: AuthenticatedDispatchContext,
  ): RulesPackDispatchEnvelopeV1 {
    if (!transport.authenticated || transport.authenticatedIssuer !== envelope.issuer) {
      throw new RulesPackError('TARGET_MISMATCH', 'RulesPack dispatch issuer is not transport-authenticated');
    }
    const allowed = this.config.dispatch?.allowedIssuers ?? [];
    if (!allowed.includes(envelope.issuer)) {
      throw new RulesPackError('TARGET_MISMATCH', 'RulesPack dispatch issuer is not authorized');
    }
    const maxTtl = this.config.dispatch?.maxEnvelopeTtlMs ?? DEFAULT_MAX_ENVELOPE_TTL_MS;
    if (Date.parse(envelope.expiresAt) - Date.parse(envelope.issuedAt) > maxTtl) {
      throw new RulesPackError('TARGET_MISMATCH', 'RulesPack dispatch lifetime exceeds the configured bound');
    }
    const verified = validateDispatchEnvelope(envelope, { audience: this.audience, target: expectedTarget });
    this.claimReplay(verified);
    this.persistDispatchSource(verified);
    this.engine.store.recordReceipt(
      receipt({
        packDigest: verified.packDigest,
        subject: expectedTarget,
        status: 'consumed',
        issuer: verified.issuer,
        audience: verified.audience,
        replayId: verified.replayId,
        details: { envelopeFingerprint: dispatchEnvelopeFingerprint(verified) },
      }),
    );
    return verified;
  }

  private persistDispatchSource(envelope: RulesPackDispatchEnvelopeV1): void {
    const suffix = digestObject(envelope.envelopeId).replace(/^sha256:/u, '').slice(0, 20);
    const sourceId = `dispatch-${suffix}`;
    const idMap = new Map(
      envelope.pack.rules.map((rule) => [rule.id, `${sourceId}-${rule.id}`.slice(0, 192)]),
    );
    const rules = envelope.pack.rules.map((rule) => {
      const {
        digest: _digest,
        tokenEstimate: _tokenEstimate,
        selectionReason: _selectionReason,
        dependencyOf: _dependencyOf,
        ...input
      } = rule;
      const expiresAt = earlierExpiry(rule.lifecycle.expiresAt, envelope.expiresAt);
      return normalizeRule({
        ...input,
        id: idMap.get(rule.id)!,
        ...(rule.dependencies
          ? { dependencies: rule.dependencies.map((dependency) => idMap.get(dependency) ?? dependency) }
          : {}),
        lifecycle: { ...rule.lifecycle, expiresAt },
        source: {
          kind: 'temporary',
          adapterId: sourceId,
          ref: `dispatch:${envelope.envelopeId}`,
          revision: envelope.packDigest,
          trustedAuthority: true,
        },
        metadata: {
          ...rule.metadata,
          dispatched: true,
          dispatchIssuer: envelope.issuer,
        },
      });
    });
    const snapshotDigest = digestObject(
      [...rules]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, version, digest }) => ({ id, version, digest })),
    );
    this.engine.store.replaceSourceSnapshot({
      source: {
        sourceId,
        kind: 'temporary',
        generation: snapshotDigest,
        revision: envelope.packDigest,
        snapshotDigest,
        observedAt: new Date().toISOString(),
        freshUntil: envelope.expiresAt,
        health: 'fresh',
        ruleCount: rules.length,
      },
      rules,
    });
    this.engine.invalidateSource(sourceId);
  }

  private claimReplay(envelope: RulesPackDispatchEnvelopeV1): void {
    try {
      this.stateDb
        .prepare(
          'INSERT INTO rulespack_replay_claims(replay_id, issuer, audience, pack_digest, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          envelope.replayId,
          envelope.issuer,
          envelope.audience,
          envelope.packDigest,
          envelope.expiresAt,
          new Date().toISOString(),
        );
      this.stateDb.prepare('DELETE FROM rulespack_replay_claims WHERE expires_at < ?').run(new Date().toISOString());
    } catch (error) {
      const existing = this.stateDb
        .prepare('SELECT replay_id FROM rulespack_replay_claims WHERE replay_id = ?')
        .get(envelope.replayId) as ReplayRow | undefined;
      if (existing) {
        this.replayRejections += 1;
        throw new RulesPackError('TARGET_MISMATCH', 'RulesPack dispatch replay rejected');
      }
      throw error;
    }
  }

  private recordPreparedReceipt(result: EngineCompileResult, subject: ExecutionSubject): void {
    const status = this.engine.mode === 'shadow' ? 'shadowed' : 'compiled';
    this.engine.store.recordReceipt(
      receipt({
        packDigest: result.pack.packDigest,
        subject,
        status,
        details: {
          mode: this.engine.mode,
          cache: result.telemetry.cache,
          selectedRules: result.telemetry.selectedRuleCount,
          tokenEstimate: result.telemetry.tokenCount,
          characters: result.telemetry.characterCount,
          degraded: result.telemetry.degraded,
        },
      }),
    );
  }

  private recordRejectedEnvelope(
    envelope: RulesPackDispatchEnvelopeV1,
    subject: ExecutionSubject,
    error: unknown,
  ): void {
    const message = safeError(error);
    if (/target|audience|issuer|expired|lifetime/iu.test(message)) this.targetMismatchRejections += 1;
    this.engine.store.recordReceipt(
      receipt({
        packDigest: typeof envelope?.packDigest === 'string' ? envelope.packDigest : digestObject('invalid-envelope'),
        subject,
        status: 'rejected',
        ...(typeof envelope?.issuer === 'string' ? { issuer: envelope.issuer } : {}),
        ...(typeof envelope?.audience === 'string' ? { audience: envelope.audience } : {}),
        ...(typeof envelope?.replayId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(envelope.replayId)
          ? { replayId: envelope.replayId }
          : {}),
        details: { reason: message.slice(0, 500) },
      }),
    );
  }

  private buildSourceAdapters(): readonly RuleSourceAdapter[] {
    const adapters: RuleSourceAdapter[] = [];
    if (this.config.configRules) adapters.push(structuredAdapter('config', this.config.configRules));
    for (const source of this.config.ruleSets ?? []) adapters.push(structuredAdapter('ruleset', source));
    for (const source of this.config.curatedRules ?? []) adapters.push(structuredAdapter('curated', source));
    for (const project of this.projectBindings) {
      for (const file of project.nativeFiles ?? []) {
        const source =
          file.format === 'agents-json-block'
            ? new AgentsStructuredFileSource({
                id: file.id,
                trustedRoot: project.canonicalRoot,
                path: file.path,
                required: file.required,
                maxBytes: file.maxBytes,
                trustedAuthority: file.trustedAuthority,
                nativeLoaded: file.nativeLoaded,
                projectId: project.projectId,
              })
            : new ProjectStructuredFileSource({
                id: file.id,
                trustedRoot: project.canonicalRoot,
                path: file.path,
                projectId: project.projectId,
                required: file.required,
                maxBytes: file.maxBytes,
                trustedAuthority: file.trustedAuthority,
                nativeLoaded: file.nativeLoaded,
              });
        adapters.push(new ProjectBoundSource(source, project.projectId));
      }
    }
    if (this.config.metaMemory) {
      const memory = this.config.metaMemory;
      adapters.push(
        new MetaMemorySource({
          id: memory.id ?? `metamemory-${this.hostId}`,
          paths: memory.paths,
          allowedRoots: [memory.hostRoot],
          reader: new CoreMetaMemoryRuleReader(memory.coreUrl),
          required: memory.required,
          freshForMs: memory.freshForMs,
        }),
      );
    }
    adapters.push(...this.temporaryAdapters.values());
    return adapters;
  }

  private installWatchers(): void {
    const seen = new Set<string>();
    for (const project of this.projectBindings) {
      for (const file of project.nativeFiles ?? []) {
        const candidate = resolve(project.canonicalRoot, file.path);
        const watchPath = existsSync(candidate) ? candidate : project.canonicalRoot;
        if (seen.has(watchPath)) continue;
        seen.add(watchPath);
        try {
          const watcher = watch(watchPath, { persistent: false }, () => this.scheduleRefresh());
          watcher.on('error', (error) =>
            this.logger.warn({ error: safeError(error), watchPath }, 'RulesPack source watcher failed'),
          );
          this.watchers.push(watcher);
        } catch (error) {
          this.logger.warn({ error: safeError(error), watchPath }, 'RulesPack source watcher unavailable');
        }
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = this.config.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch((error) => {
        this.logger.warn({ error: safeError(error) }, 'RulesPack background refresh degraded');
      });
    }, delay);
    this.refreshTimer.unref?.();
  }

  private migrateAdapterState(): void {
    this.stateDb.exec(`
      CREATE TABLE IF NOT EXISTS rulespack_adapter_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rulespack_replay_claims (
        replay_id TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        audience TEXT NOT NULL,
        pack_digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rulespack_replay_expiry_idx ON rulespack_replay_claims(expires_at);
    `);
  }

  private retireRemovedSources(adapters: readonly RuleSourceAdapter[]): void {
    const row = this.stateDb
      .prepare('SELECT value FROM rulespack_adapter_settings WHERE key = ?')
      .get('configured_source_ids') as { value?: string } | undefined;
    const prior = (() => {
      try {
        return row?.value ? (JSON.parse(row.value) as string[]) : [];
      } catch {
        return [];
      }
    })();
    const current = new Set(adapters.map((adapter) => adapter.id));
    const generations = new Map(this.engine.store.listSourceGenerations().map((source) => [source.sourceId, source]));
    for (const sourceId of prior.filter((id) => !current.has(id))) {
      const old = generations.get(sourceId);
      if (!old) continue;
      this.engine.store.replaceSourceSnapshot({
        source: {
          sourceId,
          kind: old.kind,
          generation: 'removed',
          revision: 'removed',
          snapshotDigest: digestObject([]),
          observedAt: new Date().toISOString(),
          health: 'fresh',
          ruleCount: 0,
        },
        rules: [],
      });
      this.engine.invalidateSource(sourceId);
    }
  }
}

class ProjectBoundSource implements RuleSourceAdapter {
  readonly id: string;
  readonly kind: RuleSourceAdapter['kind'];
  readonly required: boolean;

  constructor(
    private readonly delegate: RuleSourceAdapter,
    private readonly projectId: string,
  ) {
    this.id = delegate.id;
    this.kind = delegate.kind;
    this.required = delegate.required;
  }

  async load(context: { now: string; signal?: AbortSignal }): Promise<SourceSnapshot> {
    const snapshot = await this.delegate.load(context);
    const rules = snapshot.rules.map((rule) => {
      if (rule.binding?.projectId && rule.binding.projectId !== this.projectId) {
        throw new RulesPackError('TARGET_MISMATCH', 'Project-native Rule claims a different project binding');
      }
      const { digest: _digest, tokenEstimate: _tokenEstimate, ...input } = rule;
      return normalizeRule({
        ...input,
        binding: { ...rule.binding, projectId: this.projectId },
      });
    });
    const snapshotDigest = digestObject(
      [...rules]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, version, digest }) => ({ id, version, digest })),
    );
    return {
      source: {
        ...snapshot.source,
        snapshotDigest,
        generation: snapshotDigest,
        ruleCount: rules.length,
      },
      rules,
    };
  }
}

function structuredAdapter(
  kind: 'config' | 'ruleset' | 'curated',
  source: RulesPackStructuredSourceConfig,
): RuleSourceAdapter {
  const options = {
    id: source.id,
    revision: source.revision,
    rules: source.rules,
    required: source.required,
    trustedAuthority: source.trustedAuthority,
    freshForMs: source.freshForMs,
  };
  if (kind === 'config') return configSource(options);
  if (kind === 'curated') return curatedSource(options);
  return rulesetSource(options);
}

function receipt(input: {
  packDigest: string;
  subject: ExecutionSubject;
  status: DeliveryReceipt['status'];
  issuer?: string;
  audience?: string;
  replayId?: string;
  details?: DeliveryReceipt['details'];
}): DeliveryReceipt {
  return {
    receiptId: eventId('receipt'),
    packDigest: input.packDigest,
    subjectFingerprint: subjectFingerprint(input.subject),
    target: input.subject,
    status: input.status,
    channel: 'user',
    occurredAt: new Date().toISOString(),
    ...(input.issuer ? { issuer: input.issuer } : {}),
    ...(input.audience ? { audience: input.audience } : {}),
    ...(input.replayId ? { replayId: input.replayId } : {}),
    ...(input.details ? { details: input.details } : {}),
  };
}

export function resolveRulesPackDbPath(configured?: string): string {
  const raw =
    configured ??
    process.env.RULESPACK_DB ??
    resolve(process.env.SESSION_STORE_DIR ?? resolve(homedir(), '.metabot'), 'rulespack', 'rules-state.sqlite');
  if (raw === ':memory:') return raw;
  const resolved = expandPath(raw);
  const basename = resolved.slice(Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\')) + 1);
  if (RESERVED_DATABASE_BASENAMES.has(basename)) {
    throw new RulesPackError('VALIDATION_ERROR', 'RulesPack must use its own SQLite database path');
  }
  return resolved;
}

function expandPath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function containedBy(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function exactValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => nonempty(value, 'execution subject value')))].sort();
}

function nonempty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 500) throw new RulesPackError('VALIDATION_ERROR', `${label} is invalid`);
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RulesPackError('VALIDATION_ERROR', `${label} must be positive`);
  return value;
}

function normalizeMode(value: RulesMode | undefined): RulesMode {
  const mode = value ?? 'off';
  if (!['off', 'shadow', 'enforce'].includes(mode))
    throw new RulesPackError('VALIDATION_ERROR', 'RulesPack mode is invalid');
  return mode;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(authorization|token|secret|password)\s*[:=]\s*\S+/giu, '$1=[REDACTED]').slice(0, 1_000);
}

function boundedLimit(value: number): number {
  return Math.max(1, Math.min(Number.isFinite(value) ? Math.floor(value) : 100, 500));
}

function earlierExpiry(existing: string | undefined, envelopeExpiry: string): string {
  if (!existing) return envelopeExpiry;
  return Date.parse(existing) < Date.parse(envelopeExpiry) ? existing : envelopeExpiry;
}
