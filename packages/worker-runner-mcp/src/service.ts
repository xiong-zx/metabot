import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { KIMI_PROMPT_MAX_BYTES, renderedPromptBytes } from './prompt.js';
import type {
  CompletionNotifier,
  DispatchWorkerInput,
  DispatchWorkerResult,
  GenericOutputContract,
  ProcessResult,
  ProcessRunner,
  ScopedDispatchWorkerInput,
  TerminalWorkerStatus,
  TrustedPrincipal,
  WorkerRecord,
  WorkerServiceConfig,
  WorkerRulesPackProvider,
} from './types.js';
import {
  TRUSTED_PRINCIPAL_BOT_NAME_MAX_LENGTH,
  TRUSTED_PRINCIPAL_CHAT_ID_MAX_LENGTH,
  TRUSTED_PRINCIPAL_ROLES,
  WORKER_ENGINES,
  WORKER_MUTATING_ROLES,
  WorkerRunnerError,
  isArcServicePrincipal,
  isLocalLifecycleAdmin,
} from './types.js';
import type { WorkerStore } from './store.js';

interface ActiveJob {
  launchId: string;
  pid: number;
  wallTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}

const DEFAULT_CONFIG: WorkerServiceConfig = {
  maxConcurrentPerScope: 4,
  defaultTimeoutMs: 60 * 60 * 1_000,
  defaultIdleTimeoutMs: 10 * 60 * 1_000,
  maxTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  maxIdleTimeoutMs: 24 * 60 * 60 * 1_000,
  defaultDedupeTtlMs: 24 * 60 * 60 * 1_000,
  maxDedupeTtlMs: 30 * 24 * 60 * 60 * 1_000,
  maxListLimit: 100,
  notificationRetryInitialMs: 1_000,
  notificationRetryMaxMs: 60_000,
};

export class WorkerService {
  private readonly active = new Map<string, ActiveJob>();
  private readonly notificationTimers = new Map<string, NodeJS.Timeout>();
  private readonly config: WorkerServiceConfig;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly makeLaunchId: () => string;
  private readonly principal?: TrustedPrincipal;
  private readonly dynamicPrincipals: boolean;

  constructor(
    private readonly store: WorkerStore,
    private readonly runner: ProcessRunner,
    private readonly notifier: CompletionNotifier,
    principal: TrustedPrincipal | undefined,
    config: Partial<WorkerServiceConfig> = {},
    options: {
      now?: () => number;
      makeId?: () => string;
      makeLaunchId?: () => string;
      dynamicPrincipals?: boolean;
      rulesPackProvider?: WorkerRulesPackProvider;
    } = {},
  ) {
    this.dynamicPrincipals = options.dynamicPrincipals === true;
    this.principal = principal
      ? normalizeTrustedPrincipal(principal)
      : this.dynamicPrincipals
        ? undefined
        : normalizeTrustedPrincipal(principal);
    this.config = { ...DEFAULT_CONFIG, ...config };
    validateConfig(this.config);
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? (() => `wrk-${randomUUID()}`);
    this.makeLaunchId = options.makeLaunchId ?? (() => `launch-${randomUUID()}`);
    this.rulesPackProvider = options.rulesPackProvider;
  }

  private readonly rulesPackProvider?: WorkerRulesPackProvider;

  getTrustedPrincipal(): TrustedPrincipal {
    if (!this.principal) {
      throw new WorkerRunnerError('The multi-principal daemon has no process-pinned principal', 'FORBIDDEN');
    }
    return { ...this.principal };
  }

  assertTrustedPrincipal(principal: TrustedPrincipal | undefined): void {
    const normalized = normalizeTrustedPrincipal(principal);
    if (this.dynamicPrincipals) return;
    if (!this.principal) throw new WorkerRunnerError('A pinned principal is required', 'FORBIDDEN');
    if (
      normalized.role !== this.principal.role ||
      normalized.botName !== this.principal.botName ||
      normalized.chatId !== this.principal.chatId
    ) {
      throw new WorkerRunnerError('MCP principal does not match the service principal', 'FORBIDDEN');
    }
  }

  async start(): Promise<void> {
    const principal = this.requirePrincipal();
    await this.recoverScope(principal);
  }

  async startAll(): Promise<void> {
    if (!this.dynamicPrincipals) {
      await this.start();
      return;
    }
    for (const scope of this.store.listScopes()) {
      await this.recoverScope(scope);
    }
  }

  private async recoverScope(principal: Pick<TrustedPrincipal, 'botName' | 'chatId'>): Promise<void> {
    const now = this.now();
    this.store.resetInterruptedNotifications(principal.botName, principal.chatId, now);
    for (const worker of this.store.listPendingNotifications(principal.botName, principal.chatId)) {
      this.scheduleNotification(worker);
    }

    for (const worker of this.store.listRestartCandidates(principal.botName, principal.chatId)) {
      if (worker.recoveryPolicy.restart === 'relaunch' && worker.recoveryPolicy.idempotent) {
        const queued = this.store.prepareRecovery(worker.id);
        if (queued) void this.launchWorker(queued, true);
        continue;
      }
      const recoveryRequired = this.store.markRecoveryRequired(
        worker.id,
        now,
        'Previous launch identity cannot be verified after restart; manual recovery is required',
      );
      if (recoveryRequired) this.scheduleNotification(recoveryRequired);
    }
  }

  async dispatch(
    rawInput: DispatchWorkerInput,
    principal?: TrustedPrincipal,
    authorizingCapability?: string,
  ): Promise<DispatchWorkerResult> {
    const actor = this.resolvePrincipal(principal);
    this.authorizeMutation(actor, 'dispatch');
    const input = this.normalizeDispatch(rawInput, actor, authorizingCapability);
    const created = this.store.createWorker(this.makeId(), input, this.config.maxConcurrentPerScope, this.now());
    if (!created.deduplicated) void this.launchWorker(created.worker, false);
    return created;
  }

  list(options: { limit?: number; allScopes?: boolean } = {}, principal?: TrustedPrincipal): WorkerRecord[] {
    const actor = this.resolvePrincipal(principal);
    const limit = normalizeLimit(options.limit, this.config.maxListLimit);
    if (options.allScopes) {
      if (!isLocalLifecycleAdmin(actor)) {
        throw new WorkerRunnerError('Only the pinned lifecycle admin may list all worker scopes', 'FORBIDDEN');
      }
      return this.store.listAll(limit);
    }
    return this.store.listScope(actor.botName, actor.chatId, limit);
  }

  status(id: string, principal?: TrustedPrincipal): WorkerRecord {
    const actor = this.resolvePrincipal(principal);
    const worker = this.store.require(normalizeId(id));
    this.authorizeScope(worker, actor);
    return worker;
  }

  async abort(idValue: string, principal?: TrustedPrincipal): Promise<WorkerRecord> {
    const actor = this.resolvePrincipal(principal);
    this.authorizeMutation(actor, 'abort');
    const id = normalizeId(idValue);
    const worker = this.store.require(id);
    this.authorizeScope(worker, actor);
    if (worker.status === 'queued') {
      return (
        this.finishQueued(id, 'aborted', 'abort_requested', 'Worker aborted before its process launch completed') ??
        this.store.require(id)
      );
    }
    if (worker.status !== 'running') return worker;

    const active = this.active.get(id);
    if (!active || active.launchId !== worker.launchId) {
      const recoveryRequired = this.store.markRecoveryRequired(
        id,
        this.now(),
        'Abort refused because the persisted launch identity is not owned by this server process',
      );
      if (recoveryRequired) this.scheduleNotification(recoveryRequired);
      return recoveryRequired ?? this.store.require(id);
    }

    this.clearActive(id, active.launchId);
    const terminal = this.finishRunning(
      id,
      active.launchId,
      'aborted',
      'abort_requested',
      'Worker aborted by its pinned authorized principal',
    );
    await this.safeAbort(active.pid);
    return terminal ?? this.store.require(id);
  }

  dispose(): void {
    for (const id of [...this.active.keys()]) this.clearActive(id);
    for (const timer of this.notificationTimers.values()) clearTimeout(timer);
    this.notificationTimers.clear();
    this.rulesPackProvider?.close?.();
  }

  private async launchWorker(worker: WorkerRecord, recovered: boolean): Promise<void> {
    const launchId = this.makeLaunchId();
    try {
      const rulesPack = worker.engine === 'codex' ? await this.rulesPackProvider?.prepare(worker) : undefined;
      const running = await this.runner.launch(
        {
          id: worker.id,
          launchId,
          engine: worker.engine,
          model: worker.model,
          workdir: worker.workdir,
          prompt: worker.prompt,
          outputContract: worker.outputContract,
          ...(rulesPack ? { rulesPack } : {}),
        },
        { onActivity: () => this.recordActivity(worker.id, launchId) },
      );
      const launched = this.store.markRunning(worker.id, launchId, running.pid, this.now(), recovered);
      if (!launched) {
        await this.safeAbort(running.pid);
        return;
      }

      const active: ActiveJob = { launchId, pid: running.pid };
      this.active.set(worker.id, active);
      this.scheduleExecutionTimers(launched, active);
      void running.completion.then((result) => this.processExited(worker.id, launchId, result));
    } catch (error) {
      this.finishQueued(worker.id, 'failed', 'spawn_error', errorMessage(error));
    }
  }

  private recordActivity(id: string, launchId: string): void {
    const active = this.active.get(id);
    if (!active || active.launchId !== launchId) return;
    const now = this.now();
    this.store.recordActivity(id, launchId, now);
    if (active.idleTimer) clearTimeout(active.idleTimer);
    const worker = this.store.get(id);
    if (!worker || worker.status !== 'running' || worker.launchId !== launchId) return;
    active.idleTimer = this.makeExecutionTimer(worker.idleTimeoutMs, () =>
      this.expireRunning(id, launchId, 'idle_timeout'),
    );
  }

  private processExited(id: string, launchId: string, result: ProcessResult): void {
    const active = this.active.get(id);
    if (active?.launchId === launchId) this.clearActive(id, launchId);
    const current = this.store.get(id);
    if (!current || current.status !== 'running' || current.launchId !== launchId) return;

    const succeeded = result.exitCode === 0 && !result.error;
    const terminal = this.store.markTerminal(id, {
      status: succeeded ? 'completed' : 'failed',
      expectedStatus: 'running',
      expectedLaunchId: launchId,
      finishedAt: this.now(),
      terminalReason: succeeded ? 'process_exit' : 'process_error',
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      ...(!succeeded
        ? {
            error:
              result.error ||
              result.stderr.trim().slice(0, 2_000) ||
              `Worker process exited with ${result.signal ? `signal ${result.signal}` : `code ${String(result.exitCode)}`}`,
          }
        : {}),
    });
    if (terminal) this.scheduleNotification(terminal);
  }

  private scheduleExecutionTimers(worker: WorkerRecord, active: ActiveJob): void {
    active.wallTimer = this.makeExecutionTimer(worker.timeoutMs, () =>
      this.expireRunning(worker.id, active.launchId, 'wall_clock_timeout'),
    );
    active.idleTimer = this.makeExecutionTimer(worker.idleTimeoutMs, () =>
      this.expireRunning(worker.id, active.launchId, 'idle_timeout'),
    );
  }

  private makeExecutionTimer(delayMs: number, callback: () => void): NodeJS.Timeout {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  }

  private expireRunning(id: string, launchId: string, reason: 'wall_clock_timeout' | 'idle_timeout'): void {
    const active = this.active.get(id);
    if (!active || active.launchId !== launchId) return;
    this.clearActive(id, launchId);
    const worker = this.store.get(id);
    const label =
      reason === 'idle_timeout'
        ? `${worker?.idleTimeoutMs}ms no-output timeout`
        : `${worker?.timeoutMs}ms wall timeout`;
    this.finishRunning(id, launchId, 'timed_out', reason, `Worker exceeded its ${label}`);
    void this.safeAbort(active.pid);
  }

  private finishQueued(
    id: string,
    status: 'failed' | 'aborted',
    terminalReason: string,
    error: string,
  ): WorkerRecord | undefined {
    const worker = this.store.markTerminal(id, {
      status,
      expectedStatus: 'queued',
      finishedAt: this.now(),
      terminalReason,
      error,
    });
    if (worker) this.scheduleNotification(worker);
    return worker;
  }

  private finishRunning(
    id: string,
    launchId: string,
    status: 'timed_out' | 'aborted',
    terminalReason: string,
    error: string,
  ): WorkerRecord | undefined {
    const worker = this.store.markTerminal(id, {
      status,
      expectedStatus: 'running',
      expectedLaunchId: launchId,
      finishedAt: this.now(),
      terminalReason,
      error,
    });
    if (worker) this.scheduleNotification(worker);
    return worker;
  }

  private scheduleNotification(worker: WorkerRecord): void {
    if (!['pending', 'failed'].includes(worker.notificationState)) return;
    if (isArcServicePrincipal({ role: 'pm', botName: worker.botName, chatId: worker.chatId })) {
      // ARC owns and polls these internal workers. Only ARC's outer run sends a
      // user-facing completion callback to the real originator.
      this.store.markNotificationSuppressed(worker.id, this.now());
      return;
    }
    const existing = this.notificationTimers.get(worker.id);
    if (existing) clearTimeout(existing);
    const dueAt = worker.notificationNextAttemptAt ?? worker.finishedAt ?? this.now();
    const timer = setTimeout(
      () => {
        this.notificationTimers.delete(worker.id);
        void this.deliverNotification(worker.id);
      },
      Math.max(0, dueAt - this.now()),
    );
    timer.unref();
    this.notificationTimers.set(worker.id, timer);
  }

  private async deliverNotification(id: string): Promise<void> {
    const now = this.now();
    const worker = this.store.claimNotification(id, now);
    if (!worker) {
      const current = this.store.get(id);
      if (current) this.scheduleNotification(current);
      return;
    }
    const authorizingCapability = this.store.getAuthorizingCapability(worker.id);
    try {
      await this.notifier.notify({
        eventId: `worker:${worker.id}:terminal:v1`,
        eventType: 'worker.terminal',
        botName: worker.botName,
        chatId: worker.chatId,
        finishedAt: requireTerminalFinishedAt(worker),
        ...(authorizingCapability ? { authorizingCapability } : {}),
        worker: {
          id: worker.id,
          ...(worker.label !== undefined ? { label: worker.label } : {}),
          engine: worker.engine,
          status: requireTerminalStatus(worker.status),
          ...(worker.exitCode !== undefined ? { exitCode: worker.exitCode } : {}),
          ...(worker.durationMs !== undefined ? { durationMs: worker.durationMs } : {}),
        },
      });
      this.store.markNotificationDelivered(id, this.now());
    } catch (error) {
      const delay = Math.min(
        this.config.notificationRetryInitialMs * 2 ** Math.min(worker.notificationAttempts - 1, 20),
        this.config.notificationRetryMaxMs,
      );
      const failed = this.store.markNotificationFailed(id, errorMessage(error), this.now() + delay);
      if (failed) this.scheduleNotification(failed);
    }
  }

  private async safeAbort(pid: number): Promise<void> {
    try {
      await this.runner.abort(pid);
    } catch {
      // The durable terminal state is authoritative; never fall back to a
      // persisted numeric PID after the current runner loses ownership.
    }
  }

  private clearActive(id: string, launchId?: string): void {
    const active = this.active.get(id);
    if (!active || (launchId && active.launchId !== launchId)) return;
    if (active.wallTimer) clearTimeout(active.wallTimer);
    if (active.idleTimer) clearTimeout(active.idleTimer);
    this.active.delete(id);
  }

  private authorizeScope(worker: WorkerRecord, principal: TrustedPrincipal): void {
    if (worker.botName !== principal.botName || worker.chatId !== principal.chatId) {
      throw new WorkerRunnerError('Worker is outside the pinned principal scope', 'FORBIDDEN');
    }
  }

  private authorizeMutation(principal: TrustedPrincipal, operation: 'dispatch' | 'abort'): void {
    if (isLocalLifecycleAdmin(principal)) {
      throw new WorkerRunnerError('The local lifecycle admin is read-only for Worker Runner', 'FORBIDDEN');
    }
    if (isArcServicePrincipal(principal)) {
      // This exact, session-bound machine identity needs only the two Worker
      // mutations used by the ARC adapter. Scope authorization still runs
      // independently before an abort can affect a durable Worker record.
      if (operation === 'dispatch' || operation === 'abort') return;
      throw new WorkerRunnerError('The ARC service principal cannot perform this Worker mutation', 'FORBIDDEN');
    }
    if (!WORKER_MUTATING_ROLES.includes(principal.role as (typeof WORKER_MUTATING_ROLES)[number])) {
      throw new WorkerRunnerError(`Role ${principal.role} is read-only for Worker Runner`, 'FORBIDDEN');
    }
  }

  private requirePrincipal(): TrustedPrincipal {
    if (!this.principal) {
      throw new WorkerRunnerError('An authenticated connection principal is required', 'FORBIDDEN');
    }
    return this.principal;
  }

  private resolvePrincipal(principal: TrustedPrincipal | undefined): TrustedPrincipal {
    const normalized = principal ? normalizeTrustedPrincipal(principal) : this.requirePrincipal();
    if (this.principal && !this.dynamicPrincipals) this.assertTrustedPrincipal(normalized);
    return normalized;
  }

  private normalizeDispatch(
    input: DispatchWorkerInput,
    principal: TrustedPrincipal,
    authorizingCapability?: string,
  ): ScopedDispatchWorkerInput {
    if (!WORKER_ENGINES.includes(input.engine)) {
      throw new WorkerRunnerError(`Unsupported worker engine: ${String(input.engine)}`, 'INVALID_INPUT');
    }
    const prompt = normalizeNonempty(input.prompt, 'prompt', 500_000);
    const outputContract =
      input.outputContract !== undefined ? normalizeOutputContract(input.outputContract) : undefined;
    if (input.engine === 'kimi' && renderedPromptBytes(prompt, outputContract) > KIMI_PROMPT_MAX_BYTES) {
      throw new WorkerRunnerError(
        `Kimi rendered prompt exceeds the ${KIMI_PROMPT_MAX_BYTES}-byte argv safety limit`,
        'INVALID_INPUT',
      );
    }
    if (!path.isAbsolute(input.workdir)) {
      throw new WorkerRunnerError('workdir must be an absolute path', 'INVALID_INPUT');
    }
    let workdir: string;
    try {
      workdir = realpathSync(input.workdir);
      if (!statSync(workdir).isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new WorkerRunnerError(`workdir is not an accessible directory: ${errorMessage(error)}`, 'INVALID_INPUT');
    }

    const timeoutMs = normalizePositiveBounded(
      input.timeoutMs ?? this.config.defaultTimeoutMs,
      'timeoutMs',
      this.config.maxTimeoutMs,
    );
    const idleTimeoutMs = normalizePositiveBounded(
      input.idleTimeoutMs ?? this.config.defaultIdleTimeoutMs,
      'idleTimeoutMs',
      this.config.maxIdleTimeoutMs,
    );
    const recoveryPolicy = input.recoveryPolicy ?? { restart: 'manual', idempotent: false };
    if (!['manual', 'relaunch'].includes(recoveryPolicy.restart) || typeof recoveryPolicy.idempotent !== 'boolean') {
      throw new WorkerRunnerError('recoveryPolicy must declare restart and idempotent', 'INVALID_INPUT');
    }
    if (recoveryPolicy.restart === 'relaunch' && !recoveryPolicy.idempotent) {
      throw new WorkerRunnerError('restart relaunch requires idempotent: true', 'INVALID_INPUT');
    }

    const completedTtlMs = normalizeNonnegativeBounded(
      input.dedupePolicy?.completedTtlMs ?? this.config.defaultDedupeTtlMs,
      'dedupePolicy.completedTtlMs',
      this.config.maxDedupeTtlMs,
    );
    const retryTerminal = input.dedupePolicy?.retryTerminal ?? true;
    if (typeof retryTerminal !== 'boolean') {
      throw new WorkerRunnerError('dedupePolicy.retryTerminal must be a boolean', 'INVALID_INPUT');
    }

    return {
      botName: principal.botName,
      chatId: principal.chatId,
      principalRole: principal.role,
      executionKind: isArcServicePrincipal(principal) ? 'arc' : 'worker',
      ...(authorizingCapability !== undefined
        ? { authorizingCapability: normalizeNonempty(authorizingCapability, 'authorizingCapability', 4_096) }
        : {}),
      workdir,
      prompt,
      engine: input.engine,
      ...(input.model !== undefined ? { model: normalizeNonempty(input.model, 'model', 200) } : {}),
      ...(input.label !== undefined ? { label: normalizeNonempty(input.label, 'label', 200) } : {}),
      ...(input.dedupeKey !== undefined ? { dedupeKey: normalizeNonempty(input.dedupeKey, 'dedupeKey', 4_096) } : {}),
      dedupePolicy: { completedTtlMs, retryTerminal },
      timeoutMs,
      idleTimeoutMs,
      recoveryPolicy,
      ...(outputContract ? { outputContract } : {}),
    };
  }
}

export function normalizeTrustedPrincipal(principal: TrustedPrincipal | undefined): TrustedPrincipal {
  if (!principal) throw new WorkerRunnerError('A server-instance-pinned trusted principal is required', 'FORBIDDEN');
  if (!TRUSTED_PRINCIPAL_ROLES.includes(principal.role)) {
    throw new WorkerRunnerError('Trusted principal role is not recognized', 'FORBIDDEN');
  }
  const botName = normalizeNonempty(
    principal.botName,
    'principal.botName',
    TRUSTED_PRINCIPAL_BOT_NAME_MAX_LENGTH,
  );
  const chatId = normalizeNonempty(
    principal.chatId,
    'principal.chatId',
    TRUSTED_PRINCIPAL_CHAT_ID_MAX_LENGTH,
  );
  if (chatId.toLowerCase().startsWith('team:')) {
    throw new WorkerRunnerError('Agent Team chats cannot be trusted Worker Runner principals', 'FORBIDDEN');
  }
  const normalized = { role: principal.role, botName, chatId };
  if (normalized.role === 'admin' && !isLocalLifecycleAdmin(normalized)) {
    throw new WorkerRunnerError('Only the fixed local lifecycle identity may use the admin role', 'FORBIDDEN');
  }
  return normalized;
}

function validateConfig(config: WorkerServiceConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (config.notificationRetryInitialMs > config.notificationRetryMaxMs) {
    throw new Error('notificationRetryInitialMs must not exceed notificationRetryMaxMs');
  }
  if (config.defaultTimeoutMs > config.maxTimeoutMs) {
    throw new Error('defaultTimeoutMs must not exceed maxTimeoutMs');
  }
  if (config.defaultIdleTimeoutMs > config.maxIdleTimeoutMs) {
    throw new Error('defaultIdleTimeoutMs must not exceed maxIdleTimeoutMs');
  }
  if (config.defaultDedupeTtlMs > config.maxDedupeTtlMs) {
    throw new Error('defaultDedupeTtlMs must not exceed maxDedupeTtlMs');
  }
  if (config.maxListLimit > 100) {
    throw new Error('maxListLimit must not exceed the hard response bound of 100');
  }
}

function normalizeOutputContract(contract: GenericOutputContract): GenericOutputContract {
  if (!contract || !['text', 'json'].includes(contract.format)) {
    throw new WorkerRunnerError('outputContract.format must be text or json', 'INVALID_INPUT');
  }
  if (contract.jsonSchema !== undefined) {
    if (contract.format !== 'json' || !isPlainObject(contract.jsonSchema)) {
      throw new WorkerRunnerError(
        'outputContract.jsonSchema requires json format and an object schema',
        'INVALID_INPUT',
      );
    }
    if (JSON.stringify(contract.jsonSchema).length > 64_000) {
      throw new WorkerRunnerError('outputContract.jsonSchema exceeds 64000 characters', 'INVALID_INPUT');
    }
  }
  return {
    format: contract.format,
    ...(contract.description !== undefined
      ? { description: normalizeNonempty(contract.description, 'outputContract.description', 10_000) }
      : {}),
    ...(contract.jsonSchema ? { jsonSchema: contract.jsonSchema } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNonempty(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkerRunnerError(`${name} must be a non-empty string`, 'INVALID_INPUT');
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new WorkerRunnerError(`${name} exceeds ${maxLength} characters`, 'INVALID_INPUT');
  }
  return normalized;
}

function normalizeId(id: unknown): string {
  return normalizeNonempty(id, 'id', 200);
}

function requireTerminalStatus(status: WorkerRecord['status']): TerminalWorkerStatus {
  if (status === 'queued' || status === 'running') {
    throw new Error(`Cannot notify for non-terminal Worker status: ${status}`);
  }
  return status;
}

function requireTerminalFinishedAt(worker: WorkerRecord): number {
  if (worker.finishedAt === undefined) {
    throw new Error(`Terminal Worker ${worker.id} is missing finishedAt`);
  }
  return worker.finishedAt;
}

function normalizeLimit(limit: number | undefined, max: number): number {
  if (limit === undefined) return Math.min(50, max);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new WorkerRunnerError(`limit must be an integer between 1 and ${max}`, 'INVALID_INPUT');
  }
  return limit;
}

function normalizePositiveBounded(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new WorkerRunnerError(`${name} must be an integer between 1 and ${max}`, 'INVALID_INPUT');
  }
  return value;
}

function normalizeNonnegativeBounded(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new WorkerRunnerError(`${name} must be an integer between 0 and ${max}`, 'INVALID_INPUT');
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
