import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkerDataDirLock } from './data-dir-lock.js';
import type {
  DispatchWorkerResult,
  GenericOutputContract,
  ScopedDispatchWorkerInput,
  TerminalWorkerStatus,
  WorkerRecord,
} from './types.js';
import { WorkerRunnerError } from './types.js';

interface WorkerRow {
  id: string;
  bot_name: string;
  chat_id: string;
  principal_role: WorkerRecord['principalRole'] | null;
  execution_kind: WorkerRecord['executionKind'] | null;
  authorizing_capability: string | null;
  workdir: string;
  prompt: string;
  engine: WorkerRecord['engine'];
  model: string | null;
  label: string | null;
  dedupe_key: string | null;
  dedupe_ttl_ms: number;
  retry_terminal: number;
  timeout_ms: number;
  idle_timeout_ms: number;
  restart_policy: WorkerRecord['recoveryPolicy']['restart'];
  restart_idempotent: number;
  output_contract_json: string | null;
  status: WorkerRecord['status'];
  launch_id: string | null;
  pid: number | null;
  launch_count: number;
  recovery_count: number;
  created_at: number;
  started_at: number | null;
  last_activity_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  signal: string | null;
  terminal_reason: string | null;
  stdout: string | null;
  stderr: string | null;
  stdout_truncated: number;
  stderr_truncated: number;
  error_text: string | null;
  notification_state: WorkerRecord['notificationState'];
  notification_attempts: number;
  notification_next_attempt_at: number | null;
  notification_last_error: string | null;
  notification_delivered_at: number | null;
}

export interface TerminalPatch {
  status: TerminalWorkerStatus;
  finishedAt: number;
  terminalReason: string;
  exitCode?: number;
  signal?: string;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  error?: string;
  expectedStatus: 'queued' | 'running';
  expectedLaunchId?: string;
}

export class WorkerStore {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly lock: WorkerDataDirLock;
  private readonly db: Database.Database;
  private closed = false;

  constructor(databasePath: string) {
    if (typeof databasePath !== 'string' || !databasePath.trim()) {
      throw new WorkerRunnerError('Worker database path is required', 'INVALID_INPUT');
    }
    const resolvedDatabasePath = path.resolve(databasePath);
    const resolvedDataDir = path.dirname(resolvedDatabasePath);
    if (resolvedDataDir === path.parse(resolvedDataDir).root) {
      throw new WorkerRunnerError('Worker data directory cannot be a filesystem root', 'INVALID_INPUT');
    }
    mkdirSync(resolvedDataDir, { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync.native(resolvedDataDir);
    if (this.dataDir === path.parse(this.dataDir).root) {
      throw new WorkerRunnerError('Worker data directory cannot resolve to a filesystem root', 'INVALID_INPUT');
    }
    this.databasePath = path.join(this.dataDir, path.basename(resolvedDatabasePath));
    this.lock = WorkerDataDirLock.acquire(this.dataDir);
    try {
      this.db = new Database(this.databasePath);
    } catch (error) {
      this.lock.release();
      throw error;
    }
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.migrate();
    } catch (error) {
      this.db.close();
      this.lock.release();
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_jobs (
        id TEXT PRIMARY KEY,
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        principal_role TEXT,
        execution_kind TEXT,
        authorizing_capability TEXT,
        workdir TEXT NOT NULL,
        prompt TEXT NOT NULL,
        engine TEXT NOT NULL CHECK (engine IN ('codex', 'claude', 'kimi')),
        model TEXT,
        label TEXT,
        dedupe_key TEXT,
        dedupe_ttl_ms INTEGER NOT NULL,
        retry_terminal INTEGER NOT NULL,
        timeout_ms INTEGER NOT NULL,
        idle_timeout_ms INTEGER NOT NULL,
        restart_policy TEXT NOT NULL CHECK (restart_policy IN ('manual', 'relaunch')),
        restart_idempotent INTEGER NOT NULL,
        output_contract_json TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'completed', 'failed', 'timed_out', 'aborted', 'recovery_required')
        ),
        launch_id TEXT,
        pid INTEGER,
        launch_count INTEGER NOT NULL DEFAULT 0,
        recovery_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        last_activity_at INTEGER,
        finished_at INTEGER,
        duration_ms INTEGER,
        exit_code INTEGER,
        signal TEXT,
        terminal_reason TEXT,
        stdout TEXT,
        stderr TEXT,
        stdout_truncated INTEGER NOT NULL DEFAULT 0,
        stderr_truncated INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        notification_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (notification_state IN ('pending', 'sending', 'delivered', 'failed')),
        notification_attempts INTEGER NOT NULL DEFAULT 0,
        notification_next_attempt_at INTEGER,
        notification_last_error TEXT,
        notification_delivered_at INTEGER
      );

      DROP INDEX IF EXISTS worker_jobs_scope_dedupe;

      CREATE INDEX IF NOT EXISTS worker_jobs_scope_dedupe_lookup
        ON worker_jobs(bot_name, chat_id, dedupe_key, created_at DESC)
        WHERE dedupe_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS worker_jobs_scope_status
        ON worker_jobs(bot_name, chat_id, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS worker_jobs_notification_due
        ON worker_jobs(notification_state, notification_next_attempt_at)
        WHERE status NOT IN ('queued', 'running');
    `);
    this.addColumnIfMissing('worker_jobs', 'authorizing_capability', 'TEXT');
    this.addColumnIfMissing('worker_jobs', 'principal_role', 'TEXT');
    this.addColumnIfMissing('worker_jobs', 'execution_kind', 'TEXT');
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createWorker(
    id: string,
    input: ScopedDispatchWorkerInput,
    maxConcurrentPerScope: number,
    createdAt: number,
  ): DispatchWorkerResult {
    const transaction = this.db.transaction((): DispatchWorkerResult => {
      let retriedTerminal = false;
      if (input.dedupeKey) {
        const existing = this.findLatestByDedupe(input.botName, input.chatId, input.dedupeKey);
        if (existing) {
          const reuse = shouldReuseDedupe(existing, input, createdAt);
          if (reuse) return { worker: existing, deduplicated: true, retriedTerminal: false };
          retriedTerminal = isTerminal(existing.status);
        }
      }

      const running = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM worker_jobs
           WHERE bot_name = ? AND chat_id = ? AND status IN ('queued', 'running')`,
        )
        .get(input.botName, input.chatId) as { count: number };
      if (running.count >= maxConcurrentPerScope) {
        throw new WorkerRunnerError(
          `Concurrency quota reached for ${input.botName}/${input.chatId}: ${running.count}/${maxConcurrentPerScope}`,
          'CONCURRENCY_LIMIT',
        );
      }

      this.db
        .prepare(
          `INSERT INTO worker_jobs (
             id, bot_name, chat_id, principal_role, execution_kind, authorizing_capability, workdir, prompt, engine, model, label,
             dedupe_key, dedupe_ttl_ms, retry_terminal, timeout_ms, idle_timeout_ms,
             restart_policy, restart_idempotent, output_contract_json, status,
             created_at
           ) VALUES (
             @id, @botName, @chatId, @principalRole, @executionKind, @authorizingCapability, @workdir, @prompt, @engine, @model, @label,
             @dedupeKey, @dedupeTtlMs, @retryTerminal, @timeoutMs, @idleTimeoutMs,
             @restartPolicy, @restartIdempotent, @outputContractJson, 'queued',
             @createdAt
           )`,
        )
        .run({
          id,
          botName: input.botName,
          chatId: input.chatId,
          principalRole: input.principalRole,
          executionKind: input.executionKind,
          authorizingCapability: input.authorizingCapability ?? null,
          workdir: input.workdir,
          prompt: input.prompt,
          engine: input.engine,
          model: input.model ?? null,
          label: input.label ?? null,
          dedupeKey: input.dedupeKey ?? null,
          dedupeTtlMs: input.dedupePolicy.completedTtlMs,
          retryTerminal: input.dedupePolicy.retryTerminal ? 1 : 0,
          timeoutMs: input.timeoutMs,
          idleTimeoutMs: input.idleTimeoutMs,
          restartPolicy: input.recoveryPolicy.restart,
          restartIdempotent: input.recoveryPolicy.idempotent ? 1 : 0,
          outputContractJson: input.outputContract ? JSON.stringify(input.outputContract) : null,
          createdAt,
        });
      return { worker: this.require(id), deduplicated: false, retriedTerminal };
    });
    return transaction.immediate();
  }

  get(id: string): WorkerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM worker_jobs WHERE id = ?').get(id) as WorkerRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  require(id: string): WorkerRecord {
    const worker = this.get(id);
    if (!worker) throw new WorkerRunnerError(`Worker not found: ${id}`, 'NOT_FOUND');
    return worker;
  }

  /** Private callback authorization state; deliberately omitted from WorkerRecord. */
  getAuthorizingCapability(id: string): string | undefined {
    const row = this.db.prepare('SELECT authorizing_capability FROM worker_jobs WHERE id = ?').get(id) as
      | { authorizing_capability: string | null }
      | undefined;
    return row?.authorizing_capability ?? undefined;
  }

  findLatestByDedupe(botName: string, chatId: string, dedupeKey: string): WorkerRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM worker_jobs
         WHERE bot_name = ? AND chat_id = ? AND dedupe_key = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(botName, chatId, dedupeKey) as WorkerRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listScope(botName: string, chatId: string, limit: number): WorkerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_jobs WHERE bot_name = ? AND chat_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(botName, chatId, limit) as WorkerRow[];
    return rows.map(fromRow);
  }

  listAll(limit: number): WorkerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM worker_jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as WorkerRow[];
    return rows.map(fromRow);
  }

  listScopes(): Array<{ botName: string; chatId: string }> {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT bot_name, chat_id FROM worker_jobs
           WHERE status IN ('queued', 'running')
              OR notification_state IN ('pending', 'sending', 'failed')
           ORDER BY bot_name, chat_id`,
        )
        .all() as Array<{ bot_name: string; chat_id: string }>
    ).map((row) => ({ botName: row.bot_name, chatId: row.chat_id }));
  }

  listRestartCandidates(botName: string, chatId: string): WorkerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_jobs
         WHERE bot_name = ? AND chat_id = ? AND status IN ('queued', 'running')
         ORDER BY created_at ASC`,
      )
      .all(botName, chatId) as WorkerRow[];
    return rows.map(fromRow);
  }

  markRunning(
    id: string,
    launchId: string,
    pid: number,
    startedAt: number,
    recovered: boolean,
  ): WorkerRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE worker_jobs
         SET status = 'running', launch_id = @launchId, pid = @pid,
             started_at = @startedAt, last_activity_at = @startedAt,
             launch_count = launch_count + 1,
             recovery_count = recovery_count + @recovered
         WHERE id = @id AND status = 'queued' AND launch_id IS NULL`,
      )
      .run({ id, launchId, pid, startedAt, recovered: recovered ? 1 : 0 });
    return result.changes ? this.require(id) : undefined;
  }

  recordActivity(id: string, launchId: string, at: number): void {
    this.db
      .prepare(
        `UPDATE worker_jobs SET last_activity_at = ?
         WHERE id = ? AND status = 'running' AND launch_id = ?`,
      )
      .run(at, id, launchId);
  }

  prepareRecovery(id: string): WorkerRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE worker_jobs
         SET status = 'queued', launch_id = NULL, pid = NULL,
             started_at = NULL, last_activity_at = NULL,
             finished_at = NULL, duration_ms = NULL, exit_code = NULL,
             signal = NULL, terminal_reason = NULL, stdout = NULL, stderr = NULL,
             stdout_truncated = 0, stderr_truncated = 0, error_text = NULL
         WHERE id = ? AND status IN ('queued', 'running')
           AND restart_policy = 'relaunch' AND restart_idempotent = 1`,
      )
      .run(id);
    return result.changes ? this.require(id) : undefined;
  }

  markRecoveryRequired(id: string, finishedAt: number, reason: string): WorkerRecord | undefined {
    const current = this.get(id);
    if (!current || !['queued', 'running'].includes(current.status)) return undefined;
    const startedAt = current.startedAt ?? current.createdAt;
    const result = this.db
      .prepare(
        `UPDATE worker_jobs
         SET status = 'recovery_required', launch_id = NULL, pid = NULL,
             finished_at = @finishedAt, duration_ms = @durationMs,
             terminal_reason = 'ambiguous_restart', error_text = @reason,
             notification_state = 'pending', notification_next_attempt_at = @finishedAt,
             notification_last_error = NULL
         WHERE id = @id AND status IN ('queued', 'running')`,
      )
      .run({ id, finishedAt, durationMs: Math.max(0, finishedAt - startedAt), reason });
    return result.changes ? this.require(id) : undefined;
  }

  markTerminal(id: string, patch: TerminalPatch): WorkerRecord | undefined {
    const current = this.get(id);
    if (!current || current.status !== patch.expectedStatus) return undefined;
    if (patch.expectedLaunchId !== undefined && current.launchId !== patch.expectedLaunchId) return undefined;
    const startedAt = current.startedAt ?? current.createdAt;
    const result = this.db
      .prepare(
        `UPDATE worker_jobs
         SET status = @status, launch_id = NULL, pid = NULL,
             finished_at = @finishedAt, duration_ms = @durationMs,
             exit_code = @exitCode, signal = @signal,
             terminal_reason = @terminalReason, stdout = @stdout, stderr = @stderr,
             stdout_truncated = @stdoutTruncated, stderr_truncated = @stderrTruncated,
             error_text = @error, notification_state = 'pending',
             notification_next_attempt_at = @finishedAt, notification_last_error = NULL
         WHERE id = @id AND status = @expectedStatus
           AND (@expectedLaunchId IS NULL OR launch_id = @expectedLaunchId)`,
      )
      .run({
        id,
        status: patch.status,
        finishedAt: patch.finishedAt,
        durationMs: Math.max(0, patch.finishedAt - startedAt),
        exitCode: patch.exitCode ?? null,
        signal: patch.signal ?? null,
        terminalReason: patch.terminalReason,
        stdout: patch.stdout ?? null,
        stderr: patch.stderr ?? null,
        stdoutTruncated: patch.stdoutTruncated ? 1 : 0,
        stderrTruncated: patch.stderrTruncated ? 1 : 0,
        error: patch.error?.slice(0, 2_000) ?? null,
        expectedStatus: patch.expectedStatus,
        expectedLaunchId: patch.expectedLaunchId ?? null,
      });
    return result.changes ? this.require(id) : undefined;
  }

  resetInterruptedNotifications(botName: string, chatId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE worker_jobs
         SET notification_state = 'failed', notification_next_attempt_at = @now,
             notification_last_error = COALESCE(notification_last_error, 'notification interrupted by restart')
         WHERE bot_name = @botName AND chat_id = @chatId AND notification_state = 'sending'`,
      )
      .run({ botName, chatId, now });
  }

  listPendingNotifications(botName: string, chatId: string): WorkerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM worker_jobs
         WHERE bot_name = ? AND chat_id = ?
           AND status NOT IN ('queued', 'running') AND notification_state IN ('pending', 'failed')
         ORDER BY COALESCE(notification_next_attempt_at, finished_at, created_at) ASC`,
      )
      .all(botName, chatId) as WorkerRow[];
    return rows.map(fromRow);
  }

  claimNotification(id: string, now: number): WorkerRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE worker_jobs
         SET notification_state = 'sending', notification_attempts = notification_attempts + 1
         WHERE id = ? AND status NOT IN ('queued', 'running')
           AND notification_state IN ('pending', 'failed')
           AND COALESCE(notification_next_attempt_at, 0) <= ?`,
      )
      .run(id, now);
    return result.changes ? this.require(id) : undefined;
  }

  markNotificationDelivered(id: string, deliveredAt: number): void {
    this.db
      .prepare(
        `UPDATE worker_jobs
         SET notification_state = 'delivered', notification_delivered_at = ?,
             notification_next_attempt_at = NULL, notification_last_error = NULL
         WHERE id = ? AND notification_state = 'sending'`,
      )
      .run(deliveredAt, id);
  }

  markNotificationSuppressed(id: string, deliveredAt: number): void {
    this.db
      .prepare(
        `UPDATE worker_jobs
         SET notification_state = 'delivered', notification_delivered_at = ?,
             notification_next_attempt_at = NULL, notification_last_error = NULL
         WHERE id = ? AND notification_state IN ('pending', 'failed')`,
      )
      .run(deliveredAt, id);
  }

  markNotificationFailed(id: string, error: string, nextAttemptAt: number): WorkerRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE worker_jobs
         SET notification_state = 'failed', notification_last_error = ?, notification_next_attempt_at = ?
         WHERE id = ? AND notification_state = 'sending'`,
      )
      .run(error.slice(0, 2_000), nextAttemptAt, id);
    return result.changes ? this.require(id) : undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.lock.release();
    }
  }
}

function shouldReuseDedupe(existing: WorkerRecord, input: ScopedDispatchWorkerInput, now: number): boolean {
  if (existing.status === 'queued' || existing.status === 'running') return true;
  // A caller that declares retryTerminal=false is asking for durable
  // idempotence, not merely a longer successful-result cache. This must win
  // over the completed-result TTL or a late retry could launch twice.
  if (!input.dedupePolicy.retryTerminal) return true;
  if (existing.status === 'completed') {
    const terminalAt = existing.finishedAt ?? existing.createdAt;
    return input.dedupePolicy.completedTtlMs > 0 && now - terminalAt < input.dedupePolicy.completedTtlMs;
  }
  return false;
}

function isTerminal(status: WorkerRecord['status']): boolean {
  return status !== 'queued' && status !== 'running';
}

function fromRow(row: WorkerRow): WorkerRecord {
  const outputContract = parseOutputContract(row.output_contract_json);
  return {
    id: row.id,
    botName: row.bot_name,
    chatId: row.chat_id,
    principalRole: row.principal_role ?? 'unknown',
    executionKind: row.execution_kind ?? 'unknown',
    workdir: row.workdir,
    prompt: row.prompt,
    engine: row.engine,
    ...(row.model ? { model: row.model } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    dedupePolicy: {
      completedTtlMs: row.dedupe_ttl_ms,
      retryTerminal: row.retry_terminal === 1,
    },
    timeoutMs: row.timeout_ms,
    idleTimeoutMs: row.idle_timeout_ms,
    recoveryPolicy: {
      restart: row.restart_policy,
      idempotent: row.restart_idempotent === 1,
    },
    ...(outputContract ? { outputContract } : {}),
    status: row.status,
    ...(row.launch_id ? { launchId: row.launch_id } : {}),
    ...(row.pid !== null ? { pid: row.pid } : {}),
    launchCount: row.launch_count,
    recoveryCount: row.recovery_count,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.last_activity_at !== null ? { lastActivityAt: row.last_activity_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.signal ? { signal: row.signal } : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
    ...(row.stdout !== null ? { stdout: row.stdout } : {}),
    ...(row.stderr !== null ? { stderr: row.stderr } : {}),
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
    ...(row.error_text ? { error: row.error_text } : {}),
    notificationState: row.notification_state,
    notificationAttempts: row.notification_attempts,
    ...(row.notification_next_attempt_at !== null
      ? { notificationNextAttemptAt: row.notification_next_attempt_at }
      : {}),
    ...(row.notification_last_error ? { notificationLastError: row.notification_last_error } : {}),
    ...(row.notification_delivered_at !== null ? { notificationDeliveredAt: row.notification_delivered_at } : {}),
  };
}

function parseOutputContract(value: string | null): GenericOutputContract | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as GenericOutputContract;
  } catch {
    return undefined;
  }
}
