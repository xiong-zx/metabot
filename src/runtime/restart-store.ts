import Database from 'better-sqlite3';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const RESTART_APP_NAMES = [
  'metabot',
  'metabot-worker-runnerd',
] as const;

export type RestartKind = 'restart' | 'deploy';
export type RestartStatus = 'claimed' | 'restarting' | 'healthy' | 'failed';

export interface RuntimeExpectation {
  cwd: string;
  script: string;
  interpreter: string;
  interpreterArgs: string[];
  envHashes: Record<string, string>;
}

export interface RestartRequestRecord {
  requestId: string;
  kind: RestartKind;
  status: RestartStatus;
  createdAt: number;
  updatedAt: number;
  attemptedAt?: number;
  attemptCount: number;
  requesterBot?: string;
  requesterChat?: string;
  source?: string;
  reason?: string;
  resume: boolean;
  targetRoot: string;
  targetApps: string[];
  targetScripts: Record<string, string>;
  runtimeExpectations: Record<string, RuntimeExpectation>;
  oldRuntimePid?: number;
  runtimePid?: number;
  startupHealthyAt?: number;
  processListSavedAt?: number;
  healthError?: string;
  reportClaimedAt?: number;
  reportedAt?: number;
  reportOutcome?: string;
  recoveryOwner?: string;
  continuationKey?: string;
  continuationTaskId?: string;
  continuationDecidedAt?: number;
}

interface RestartRequestRow {
  request_id: string;
  kind: RestartKind;
  status: RestartStatus;
  created_at: number;
  updated_at: number;
  attempted_at: number | null;
  attempt_count: number;
  requester_bot: string | null;
  requester_chat: string | null;
  source: string | null;
  reason: string | null;
  resume: number;
  target_root: string;
  target_apps_json: string;
  target_scripts_json: string;
  runtime_expectations_json: string;
  old_runtime_pid: number | null;
  runtime_pid: number | null;
  startup_healthy_at: number | null;
  process_list_saved_at: number | null;
  health_error: string | null;
  report_claimed_at: number | null;
  reported_at: number | null;
  report_outcome: string | null;
  recovery_owner: string | null;
  continuation_key: string | null;
  continuation_task_id: string | null;
  continuation_decided_at: number | null;
}

export interface RestartClaimInput {
  requestId: string;
  kind: RestartKind;
  requesterBot?: string;
  requesterChat?: string;
  source?: string;
  reason?: string;
  resume?: boolean;
  targetRoot: string;
  targetApps?: string[];
  targetScripts?: Record<string, string>;
  runtimeExpectations?: Record<string, RuntimeExpectation>;
  now?: number;
}

export interface RestartStoreOptions {
  dbPath?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEXT_LENGTH = 1_000;
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export class RestartStore {
  private readonly db: Database.Database;

  constructor(options: RestartStoreOptions = {}) {
    const dbPath = resolve(options.dbPath ?? restartStatePath());
    ensurePrivateDirectory(dirname(dbPath));
    if (existsSync(dbPath)) {
      const stat = lstatSync(dbPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe restart state database: ${dbPath}`);
    }
    this.db = new Database(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  claim(input: RestartClaimInput): { duplicate: boolean; record: RestartRequestRecord } {
    assertRestartRequestId(input.requestId);
    if (input.kind !== 'restart' && input.kind !== 'deploy') {
      throw new Error(`Invalid restart kind: ${String(input.kind)}`);
    }
    const now = input.now ?? Date.now();
    const targetRoot = resolveRequiredPath(input.targetRoot, 'targetRoot');
    const targetApps = normalizeTargetApps(input.targetApps ?? [...RESTART_APP_NAMES]);
    const targetScripts = normalizeTargetScripts(input.targetScripts ?? defaultTargetScripts(targetRoot, targetApps));
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO restart_requests (
        request_id, kind, status, created_at, updated_at, attempted_at, attempt_count,
        requester_bot, requester_chat, source, reason, resume, target_root,
        target_apps_json, target_scripts_json, runtime_expectations_json, old_runtime_pid, runtime_pid,
        startup_healthy_at, process_list_saved_at, health_error, report_claimed_at,
        reported_at, report_outcome, recovery_owner, continuation_key,
        continuation_task_id, continuation_decided_at
      ) VALUES (?, ?, 'claimed', ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
    `).run(
      input.requestId,
      input.kind,
      now,
      now,
      bounded(input.requesterBot),
      bounded(input.requesterChat),
      bounded(input.source),
      bounded(input.reason),
      input.resume === false ? 0 : 1,
      targetRoot,
      JSON.stringify(targetApps),
      JSON.stringify(targetScripts),
      JSON.stringify(normalizeRuntimeExpectations(input.runtimeExpectations ?? {}, targetApps)),
    );
    const record = this.get(input.requestId);
    if (!record) throw new Error(`Restart request claim disappeared: ${input.requestId}`);
    return { duplicate: result.changes === 0, record };
  }

  get(requestId: string): RestartRequestRecord | undefined {
    assertRestartRequestId(requestId);
    const row = this.db.prepare('SELECT * FROM restart_requests WHERE request_id = ?')
      .get(requestId) as RestartRequestRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(): RestartRequestRecord[] {
    return (this.db.prepare('SELECT * FROM restart_requests ORDER BY created_at ASC').all() as RestartRequestRow[])
      .map(rowToRecord);
  }

  markRestarting(requestId: string, input: { oldRuntimePid?: number; now?: number } = {}): RestartRequestRecord {
    const now = input.now ?? Date.now();
    this.requireUpdated(this.db.prepare(`
      UPDATE restart_requests
      SET status = 'restarting', attempted_at = COALESCE(attempted_at, ?),
          old_runtime_pid = COALESCE(?, old_runtime_pid), updated_at = ?
      WHERE request_id = ? AND status IN ('claimed', 'restarting')
    `).run(now, positiveIntegerOrNull(input.oldRuntimePid), now, requestId), requestId, 'mark restarting');
    return this.require(requestId);
  }

  markStartupHealthy(requestId: string, input: { runtimePid?: number; now?: number } = {}): RestartRequestRecord {
    const now = input.now ?? Date.now();
    this.requireUpdated(this.db.prepare(`
      UPDATE restart_requests
      SET startup_healthy_at = COALESCE(startup_healthy_at, ?),
          runtime_pid = COALESCE(?, runtime_pid), updated_at = ?
      WHERE request_id = ? AND status = 'restarting'
    `).run(now, positiveIntegerOrNull(input.runtimePid), now, requestId), requestId, 'mark startup healthy');
    return this.require(requestId);
  }

  markHealthy(requestId: string, input: { runtimePid?: number; now?: number } = {}): RestartRequestRecord {
    const now = input.now ?? Date.now();
    this.requireUpdated(this.db.prepare(`
      UPDATE restart_requests
      SET status = 'healthy', runtime_pid = COALESCE(?, runtime_pid),
          startup_healthy_at = COALESCE(startup_healthy_at, ?),
          process_list_saved_at = COALESCE(process_list_saved_at, ?),
          health_error = NULL, updated_at = ?
      WHERE request_id = ? AND status = 'restarting'
    `).run(positiveIntegerOrNull(input.runtimePid), now, now, now, requestId), requestId, 'mark healthy');
    return this.require(requestId);
  }

  markFailed(requestId: string, error: string, input: { runtimePid?: number; now?: number } = {}): RestartRequestRecord {
    const now = input.now ?? Date.now();
    this.requireUpdated(this.db.prepare(`
      UPDATE restart_requests
      SET status = 'failed', runtime_pid = COALESCE(?, runtime_pid),
          health_error = ?, updated_at = ?
      WHERE request_id = ? AND status NOT IN ('healthy', 'failed')
    `).run(positiveIntegerOrNull(input.runtimePid), bounded(error) || 'Controlled restart failed', now, requestId), requestId, 'mark failed');
    return this.require(requestId);
  }

  claimReport(requestId: string, now = Date.now()): boolean {
    assertRestartRequestId(requestId);
    const result = this.db.prepare(`
      UPDATE restart_requests
      SET report_claimed_at = ?, updated_at = ?
      WHERE request_id = ? AND status IN ('healthy', 'failed') AND report_claimed_at IS NULL
    `).run(now, now, requestId);
    return result.changes === 1;
  }

  recordReportOutcome(requestId: string, outcome: string, input: { delivered?: boolean; now?: number } = {}): RestartRequestRecord {
    const now = input.now ?? Date.now();
    this.requireUpdated(this.db.prepare(`
      UPDATE restart_requests
      SET report_outcome = ?, reported_at = CASE WHEN ? = 1 THEN COALESCE(reported_at, ?) ELSE reported_at END,
          updated_at = ?
      WHERE request_id = ? AND report_claimed_at IS NOT NULL
    `).run(bounded(outcome), input.delivered === true ? 1 : 0, now, now, requestId), requestId, 'record report');
    return this.require(requestId);
  }

  recordContinuationDecision(requestId: string, input: {
    recoveryOwner: string;
    continuationKey?: string;
    continuationTaskId?: string;
    now?: number;
  }): RestartRequestRecord {
    const now = input.now ?? Date.now();
    this.requireUpdated(this.db.prepare(`
      UPDATE restart_requests
      SET recovery_owner = ?, continuation_key = ?, continuation_task_id = ?,
          continuation_decided_at = COALESCE(continuation_decided_at, ?), updated_at = ?
      WHERE request_id = ? AND status IN ('healthy', 'failed')
    `).run(
      bounded(input.recoveryOwner),
      bounded(input.continuationKey),
      bounded(input.continuationTaskId),
      now,
      now,
      requestId,
    ), requestId, 'record continuation decision');
    return this.require(requestId);
  }

  prune(now = Date.now()): number {
    const result = this.db.prepare(`
      DELETE FROM restart_requests
      WHERE status IN ('healthy', 'failed') AND updated_at < ?
    `).run(now - MAX_RECORD_AGE_MS);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }

  private require(requestId: string): RestartRequestRecord {
    const record = this.get(requestId);
    if (!record) throw new Error(`Restart request not found: ${requestId}`);
    return record;
  }

  private requireUpdated(result: Database.RunResult, requestId: string, operation: string): void {
    assertRestartRequestId(requestId);
    if (result.changes !== 1) {
      const current = this.get(requestId);
      throw new Error(`Cannot ${operation} for ${requestId}${current ? ` from ${current.status}` : ': request not found'}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS restart_requests (
        request_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('restart', 'deploy')),
        status TEXT NOT NULL CHECK (status IN ('claimed', 'restarting', 'healthy', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        attempted_at INTEGER,
        attempt_count INTEGER NOT NULL,
        requester_bot TEXT,
        requester_chat TEXT,
        source TEXT,
        reason TEXT,
        resume INTEGER NOT NULL CHECK (resume IN (0, 1)),
        target_root TEXT NOT NULL,
        target_apps_json TEXT NOT NULL,
        target_scripts_json TEXT NOT NULL,
        runtime_expectations_json TEXT NOT NULL DEFAULT '{}',
        old_runtime_pid INTEGER,
        runtime_pid INTEGER,
        startup_healthy_at INTEGER,
        process_list_saved_at INTEGER,
        health_error TEXT,
        report_claimed_at INTEGER,
        reported_at INTEGER,
        report_outcome TEXT,
        recovery_owner TEXT,
        continuation_key TEXT,
        continuation_task_id TEXT,
        continuation_decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS restart_requests_updated_idx
        ON restart_requests(updated_at);
    `);
    const columns = this.db.pragma('table_info(restart_requests)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'runtime_expectations_json')) {
      this.db.exec("ALTER TABLE restart_requests ADD COLUMN runtime_expectations_json TEXT NOT NULL DEFAULT '{}'");
    }
  }
}

export function resolveRestartStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.SESSION_STORE_DIR?.trim()
      || env.METABOT_STATE_DIR?.trim()
      || join(homedir(), '.metabot'),
  );
}

export function restartStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRestartStateDir(env), 'restart-state.sqlite');
}

export function assertRestartRequestId(value: string): void {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new Error('requestId must be 1-128 safe ASCII characters and may not contain paths');
  }
}

export function defaultTargetScripts(targetRoot: string, apps: string[]): Record<string, string> {
  const scripts: Record<string, string> = {
    metabot: join(targetRoot, 'src', 'index.ts'),
    'metabot-worker-runnerd': join(targetRoot, 'packages', 'worker-runner-mcp', 'dist', 'daemon-cli.js'),
    'metabot-core': join(targetRoot, 'packages', 'server', 'dist', 'index.js'),
  };
  return Object.fromEntries(apps.map((app) => [app, scripts[app] ?? '']));
}

function rowToRecord(row: RestartRequestRow): RestartRequestRecord {
  return {
    requestId: row.request_id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.attempted_at != null ? { attemptedAt: row.attempted_at } : {}),
    attemptCount: row.attempt_count,
    ...(row.requester_bot ? { requesterBot: row.requester_bot } : {}),
    ...(row.requester_chat ? { requesterChat: row.requester_chat } : {}),
    ...(row.source ? { source: row.source } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    resume: row.resume === 1,
    targetRoot: row.target_root,
    targetApps: JSON.parse(row.target_apps_json) as string[],
    targetScripts: JSON.parse(row.target_scripts_json) as Record<string, string>,
    runtimeExpectations: JSON.parse(row.runtime_expectations_json || '{}') as Record<string, RuntimeExpectation>,
    ...(row.old_runtime_pid != null ? { oldRuntimePid: row.old_runtime_pid } : {}),
    ...(row.runtime_pid != null ? { runtimePid: row.runtime_pid } : {}),
    ...(row.startup_healthy_at != null ? { startupHealthyAt: row.startup_healthy_at } : {}),
    ...(row.process_list_saved_at != null ? { processListSavedAt: row.process_list_saved_at } : {}),
    ...(row.health_error ? { healthError: row.health_error } : {}),
    ...(row.report_claimed_at != null ? { reportClaimedAt: row.report_claimed_at } : {}),
    ...(row.reported_at != null ? { reportedAt: row.reported_at } : {}),
    ...(row.report_outcome ? { reportOutcome: row.report_outcome } : {}),
    ...(row.recovery_owner ? { recoveryOwner: row.recovery_owner } : {}),
    ...(row.continuation_key ? { continuationKey: row.continuation_key } : {}),
    ...(row.continuation_task_id ? { continuationTaskId: row.continuation_task_id } : {}),
    ...(row.continuation_decided_at != null ? { continuationDecidedAt: row.continuation_decided_at } : {}),
  };
}

function normalizeTargetApps(input: string[]): string[] {
  const values = [...new Set(input.map((value) => value.trim()).filter(Boolean))];
  if (values.length === 0 || values.length > 8) throw new Error('targetApps must contain 1-8 app names');
  for (const value of values) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`Invalid target app: ${value}`);
  }
  return values;
}

function normalizeTargetScripts(input: Record<string, string>): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length === 0) throw new Error('targetScripts must not be empty');
  return Object.fromEntries(entries.map(([app, script]) => {
    if (!app || !script) throw new Error('targetScripts contains an empty app or script');
    return [app, resolve(script)];
  }));
}

function normalizeRuntimeExpectations(
  input: Record<string, RuntimeExpectation>,
  targetApps: string[],
): Record<string, RuntimeExpectation> {
  const entries = Object.entries(input);
  if (entries.length === 0) return {};
  if (entries.length !== targetApps.length || entries.some(([app]) => !targetApps.includes(app))) {
    throw new Error('runtimeExpectations must match targetApps exactly');
  }
  return Object.fromEntries(entries.map(([app, value]) => {
    if (!value || typeof value !== 'object') throw new Error(`Invalid runtime expectation for ${app}`);
    const envHashes = Object.fromEntries(Object.entries(value.envHashes ?? {}).map(([key, hash]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !/^[a-f0-9]{64}$/.test(hash)) {
        throw new Error(`Invalid runtime environment fingerprint for ${app}`);
      }
      return [key, hash];
    }));
    return [app, {
      cwd: resolveRequiredPath(value.cwd, `${app}.cwd`),
      script: resolveRequiredPath(value.script, `${app}.script`),
      interpreter: bounded(value.interpreter) || 'node',
      interpreterArgs: (value.interpreterArgs ?? []).map((arg) => String(arg).slice(0, MAX_TEXT_LENGTH)),
      envHashes,
    }];
  }));
}

function resolveRequiredPath(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return resolve(value);
}

function bounded(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, MAX_TEXT_LENGTH) : null;
}

function positiveIntegerOrNull(value: number | undefined): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe restart state directory: ${path}`);
  chmodSync(path, 0o700);
}
