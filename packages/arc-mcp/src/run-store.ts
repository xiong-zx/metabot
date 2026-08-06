import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { ArcDataDirLock } from './data-dir-lock.js';
import {
  ARC_RUN_CONTRACT_VERSION,
  type ArcExecutionHandle,
  type ArcExecutionInput,
  type ArcResultStatus,
  type ArcRunError,
  type ArcRunRecord,
  type ArcRunStatus,
  validateArcExecutionInput,
  validateArcRunRecord,
} from './contract.js';
import { ArcError } from './errors.js';

interface RunRow {
  run_id: string;
  project_id: string;
  project_root: string;
  objective: string;
  idempotency_key: string;
  execution_input_json: string | null;
  request_fingerprint: string;
  status: string;
  phase: string;
  progress: number;
  artifact_path: string;
  output_status: string | null;
  runner_handle_json: string | null;
  error_code: string | null;
  error_message: string | null;
  recovery_generation: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  version: number;
}

export interface CreateArcRunInput {
  runId: string;
  projectId: string;
  projectRoot: string;
  objective: string;
  idempotencyKey: string;
  requestFingerprint: string;
  artifactPath: string;
  executionInput: ArcExecutionInput;
  now: string;
}

export interface ArcRunListOptions {
  limit?: number;
  projectId?: string;
  projectRoots?: readonly string[];
  status?: ArcRunStatus;
  statuses?: readonly ArcRunStatus[];
}

export interface ArcRunPatch {
  artifactPath?: string;
  error?: ArcRunError | null;
  finishedAt?: string | null;
  outputStatus?: ArcResultStatus | null;
  phase?: string;
  progress?: number;
  recoveryGeneration?: number;
  runnerHandle?: ArcExecutionHandle | null;
  startedAt?: string | null;
  status?: ArcRunStatus;
  updatedAt: string;
}

export class ArcRunStore {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly lock: ArcDataDirLock;
  private readonly db: Database.Database;
  private closed = false;

  constructor(dataDir: string) {
    if (!dataDir.trim()) throw new ArcError('invalid_contract', 'ARC data directory is required');
    const resolved = path.resolve(dataDir);
    if (resolved === path.parse(resolved).root) {
      throw new ArcError('invalid_contract', 'ARC data directory cannot be a filesystem root');
    }
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const canonicalDataDir = realpathSync.native(resolved);
    if (canonicalDataDir === path.parse(canonicalDataDir).root) {
      throw new ArcError('invalid_contract', 'ARC data directory cannot resolve to a filesystem root');
    }
    this.dataDir = canonicalDataDir;
    this.databasePath = path.join(this.dataDir, 'arc-runs.sqlite');
    this.lock = ArcDataDirLock.acquire(this.dataDir);
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

  createRun(input: CreateArcRunInput): { created: boolean; run: ArcRunRecord } {
    return this.db.transaction(() => {
      const idempotent = this.getByIdempotencyKey(input.projectId, input.idempotencyKey);
      if (idempotent) return { created: false, run: idempotent };
      if (this.getRun(input.runId)) {
        throw new ArcError('run_conflict', 'run_id is already in use', {
          details: { runId: input.runId },
        });
      }
      this.db
        .prepare(
          `INSERT INTO arc_runs (
            run_id, project_id, project_root, objective, idempotency_key, execution_input_json,
            request_fingerprint, status, phase, progress, artifact_path,
            output_status, runner_handle_json, error_code, error_message,
            recovery_generation, created_at, updated_at, started_at, finished_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, NULL, NULL, NULL, NULL, 0, ?, ?, NULL, NULL, 0)`,
        )
        .run(
          input.runId,
          input.projectId,
          input.projectRoot,
          input.objective,
          input.idempotencyKey,
          JSON.stringify(input.executionInput),
          input.requestFingerprint,
          input.artifactPath,
          input.now,
          input.now,
        );
      return { created: true, run: this.requireRun(input.runId) };
    })();
  }

  getRun(runId: string): ArcRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM arc_runs WHERE run_id = ?').get(runId) as RunRow | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  requireRun(runId: string): ArcRunRecord {
    const run = this.getRun(runId);
    if (!run) {
      throw new ArcError('run_not_found', 'ARC run was not found', { details: { runId } });
    }
    return run;
  }

  getExecutionInput(runId: string): ArcExecutionInput | undefined {
    const row = this.db.prepare('SELECT execution_input_json FROM arc_runs WHERE run_id = ?').get(runId) as
      | { execution_input_json: string | null }
      | undefined;
    if (!row?.execution_input_json) return undefined;
    try {
      return validateArcExecutionInput(JSON.parse(row.execution_input_json));
    } catch (error) {
      throw new ArcError('invalid_contract', 'Stored ARC execution input is not valid JSON', {
        cause: error,
        details: { runId },
      });
    }
  }

  listRuns(options: ArcRunListOptions = {}): ArcRunRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.projectId) {
      clauses.push('project_id = ?');
      parameters.push(options.projectId);
    }
    if (options.status) {
      clauses.push('status = ?');
      parameters.push(options.status);
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
      parameters.push(...options.statuses);
    }
    if (options.projectRoots) {
      if (options.projectRoots.length === 0) return [];
      clauses.push(`project_root IN (${options.projectRoots.map(() => '?').join(', ')})`);
      parameters.push(...options.projectRoots);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM arc_runs ${where} ORDER BY created_at DESC, run_id ASC LIMIT ?`)
      .all(...parameters, limit) as RunRow[];
    return rows.map((row) => this.rowToRecord(row));
  }

  transition(runId: string, expectedStatuses: ArcRunStatus[], patch: ArcRunPatch): ArcRunRecord {
    return this.db.transaction(() => {
      const current = this.requireRun(runId);
      if (!expectedStatuses.includes(current.status)) {
        throw new ArcError('invalid_transition', `Cannot transition ARC run from ${current.status}`, {
          details: { runId, expectedStatuses, actualStatus: current.status },
        });
      }
      const next = validateArcRunRecord({
        ...current,
        ...(patch.artifactPath !== undefined ? { artifact_path: patch.artifactPath } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.finishedAt !== undefined ? { finished_at: patch.finishedAt } : {}),
        ...(patch.outputStatus !== undefined ? { output_status: patch.outputStatus } : {}),
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
        ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
        ...(patch.recoveryGeneration !== undefined ? { recovery_generation: patch.recoveryGeneration } : {}),
        ...(patch.runnerHandle !== undefined ? { runner_handle: patch.runnerHandle } : {}),
        ...(patch.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updated_at: patch.updatedAt,
        version: current.version + 1,
      });
      const result = this.db
        .prepare(
          `UPDATE arc_runs SET
             status = ?, phase = ?, progress = ?, artifact_path = ?, output_status = ?,
             runner_handle_json = ?, error_code = ?, error_message = ?,
             recovery_generation = ?, updated_at = ?, started_at = ?, finished_at = ?, version = ?
           WHERE run_id = ? AND version = ?`,
        )
        .run(
          next.status,
          next.phase,
          next.progress,
          next.artifact_path,
          next.output_status,
          next.runner_handle ? JSON.stringify(next.runner_handle) : null,
          next.error?.code ?? null,
          next.error?.message ?? null,
          next.recovery_generation,
          next.updated_at,
          next.started_at,
          next.finished_at,
          next.version,
          runId,
          current.version,
        );
      if (result.changes !== 1) {
        throw new ArcError('run_conflict', 'ARC run changed concurrently', { details: { runId } });
      }
      return next;
    })();
  }

  listRecoverableRuns(options: Pick<ArcRunListOptions, 'projectId' | 'projectRoots'>): ArcRunRecord[] {
    const clauses = ["status IN ('queued', 'running')"];
    const parameters: string[] = [];
    if (options.projectId) {
      clauses.push('project_id = ?');
      parameters.push(options.projectId);
    }
    if (options.projectRoots) {
      if (options.projectRoots.length === 0) return [];
      clauses.push(`project_root IN (${options.projectRoots.map(() => '?').join(', ')})`);
      parameters.push(...options.projectRoots);
    }
    const rows = this.db
      .prepare(`SELECT * FROM arc_runs WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`)
      .all(...parameters) as RunRow[];
    return rows.map((row) => this.rowToRecord(row));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lock.release();
  }

  private getByIdempotencyKey(projectId: string, key: string): ArcRunRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM arc_runs WHERE project_id = ? AND idempotency_key = ?')
      .get(projectId, key) as RunRow | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  private rowToRecord(row: RunRow): ArcRunRecord {
    let runnerHandle: ArcExecutionHandle | null = null;
    if (row.runner_handle_json) {
      try {
        runnerHandle = JSON.parse(row.runner_handle_json) as ArcExecutionHandle;
      } catch (error) {
        throw new ArcError('invalid_contract', 'Stored ARC runner handle is not valid JSON', {
          cause: error,
          details: { runId: row.run_id },
        });
      }
    }
    return validateArcRunRecord({
      contract_version: ARC_RUN_CONTRACT_VERSION,
      run_id: row.run_id,
      project_id: row.project_id,
      project_root: row.project_root,
      objective: row.objective,
      idempotency_key: row.idempotency_key,
      request_fingerprint: row.request_fingerprint,
      status: row.status,
      phase: row.phase,
      progress: row.progress,
      artifact_path: row.artifact_path,
      output_status: row.output_status,
      runner_handle: runnerHandle,
      error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
      recovery_generation: row.recovery_generation,
      created_at: row.created_at,
      updated_at: row.updated_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      version: row.version,
    });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS arc_runs (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        objective TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        execution_input_json TEXT,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'paused', 'completed', 'partial', 'failed', 'cancelled')
        ),
        phase TEXT NOT NULL,
        progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
        artifact_path TEXT NOT NULL,
        output_status TEXT CHECK (output_status IN ('completed', 'partial', 'failed')),
        runner_handle_json TEXT,
        error_code TEXT,
        error_message TEXT,
        recovery_generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_arc_runs_project_status_created
        ON arc_runs(project_id, status, created_at DESC);
    `);
    this.addColumnIfMissing('arc_runs', 'execution_input_json', 'TEXT');
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
