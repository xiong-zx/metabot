/**
 * Store for async task status.
 *
 * When /api/talk receives `async: true`, the task is executed in the background
 * and this store tracks its lifecycle (accepted → running → completed/failed).
 * Completed tasks are automatically cleaned up after 1 hour. The bridge can
 * optionally persist task records so task ids survive a service restart.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AsyncTask {
  id: string;
  botName: string;
  chatId: string;
  prompt: string;
  status: 'accepted' | 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  result?: {
    success: boolean;
    responseText: string;
    costUsd?: number;
    durationMs?: number;
    error?: string;
    errorCode?: string;
    retryAfterMs?: number;
    busy?: {
      chatId: string;
      startedAt: string;
      durationMs: number;
      hasVisibleCard: boolean;
    };
  };
  callbackChatId?: string;
  callbackBotName?: string;
}

const DEFAULT_STALE_TASK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 300_000;
const ASYNC_TASKS_FILENAME = 'async-tasks.json';

export class AsyncTaskStore {
  private tasks = new Map<string, AsyncTask>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private readonly staleTaskMs: number;
  private readonly storageFile: string | undefined;

  constructor(options: { staleTaskMs?: number; cleanupIntervalMs?: number; storageFile?: string } = {}) {
    this.staleTaskMs = options.staleTaskMs ?? resolveStaleTaskMs();
    this.storageFile = options.storageFile;
    this.loadPersistedTasks(Date.now());
    const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

    // Expire orphaned running tasks, then clean up completed tasks older than 1 hour.
    this.cleanupInterval = setInterval(() => {
      this.expireStaleTasks(Date.now());
      const cutoff = Date.now() - 3600_000;
      let changed = false;
      for (const [id, task] of this.tasks) {
        if (task.completedAt && task.completedAt < cutoff) {
          this.tasks.delete(id);
          changed = true;
        }
      }
      if (changed) this.persist();
    }, cleanupIntervalMs);
    this.cleanupInterval.unref?.();
  }

  create(opts: {
    botName: string;
    chatId: string;
    prompt: string;
    callbackChatId?: string;
    callbackBotName?: string;
  }): AsyncTask {
    const task: AsyncTask = {
      id: crypto.randomUUID().slice(0, 8),
      botName: opts.botName,
      chatId: opts.chatId,
      prompt: opts.prompt,
      status: 'accepted',
      createdAt: Date.now(),
      callbackChatId: opts.callbackChatId,
      callbackBotName: opts.callbackBotName,
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  get(id: string): AsyncTask | undefined {
    const task = this.tasks.get(id);
    if (task) this.expireTaskIfStale(task, Date.now());
    return task;
  }

  update(id: string, updates: Partial<AsyncTask>): void {
    const task = this.tasks.get(id);
    if (task) {
      Object.assign(task, updates);
      this.persist();
    }
  }

  list(): AsyncTask[] {
    this.expireStaleTasks(Date.now());
    return Array.from(this.tasks.values());
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  private expireStaleTasks(now: number): void {
    for (const task of this.tasks.values()) {
      this.expireTaskIfStale(task, now);
    }
  }

  private expireTaskIfStale(task: AsyncTask, now: number): void {
    if (task.status !== 'accepted' && task.status !== 'running') return;
    if (now - task.createdAt <= this.staleTaskMs) return;
    task.status = 'failed';
    task.completedAt = now;
    task.result = {
      success: false,
      responseText: '',
      error: `Async talk task expired after ${this.staleTaskMs}ms without completing`,
      errorCode: 'task_expired',
    };
    this.persist();
  }

  private loadPersistedTasks(now: number): void {
    if (this.storageFile === undefined || !fs.existsSync(this.storageFile)) return;
    let changed = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storageFile, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        const task = normalizePersistedTask(value);
        if (task === undefined) {
          changed = true;
          continue;
        }
        if (task.status === 'accepted' || task.status === 'running') {
          task.status = 'failed';
          task.completedAt = now;
          task.result = {
            success: false,
            responseText: '',
            error: 'Async talk task was interrupted by MetaBot service restart',
            errorCode: 'task_interrupted_by_restart',
          };
          changed = true;
        }
        this.tasks.set(task.id, task);
      }
    } catch {
      return;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    if (this.storageFile === undefined) return;
    try {
      fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
      const tmp = `${this.storageFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.tasks.values()], null, 2));
      fs.renameSync(tmp, this.storageFile);
    } catch {
      // Status persistence is best-effort; the in-memory lifecycle remains authoritative while the process is alive.
    }
  }
}

export function defaultAsyncTaskStoreFile(): string {
  return path.join(process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot'), ASYNC_TASKS_FILENAME);
}

function normalizePersistedTask(value: unknown): AsyncTask | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.botName !== 'string' ||
    typeof record.chatId !== 'string' ||
    typeof record.prompt !== 'string' ||
    typeof record.createdAt !== 'number' ||
    !isTaskStatus(record.status)
  ) {
    return undefined;
  }
  return {
    id: record.id,
    botName: record.botName,
    chatId: record.chatId,
    prompt: record.prompt,
    status: record.status,
    createdAt: record.createdAt,
    completedAt: typeof record.completedAt === 'number' ? record.completedAt : undefined,
    result: normalizeTaskResult(record.result),
    callbackChatId: typeof record.callbackChatId === 'string' ? record.callbackChatId : undefined,
    callbackBotName: typeof record.callbackBotName === 'string' ? record.callbackBotName : undefined,
  };
}

function isTaskStatus(value: unknown): value is AsyncTask['status'] {
  return value === 'accepted' || value === 'running' || value === 'completed' || value === 'failed';
}

function normalizeTaskResult(value: unknown): AsyncTask['result'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.success !== 'boolean' || typeof record.responseText !== 'string') return undefined;
  return {
    success: record.success,
    responseText: record.responseText,
    costUsd: typeof record.costUsd === 'number' ? record.costUsd : undefined,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : undefined,
    retryAfterMs: typeof record.retryAfterMs === 'number' ? record.retryAfterMs : undefined,
    busy:
      typeof record.busy === 'object' && record.busy !== null && !Array.isArray(record.busy)
        ? normalizeBusy(record.busy as Record<string, unknown>)
        : undefined,
  };
}

function normalizeBusy(value: Record<string, unknown>): NonNullable<AsyncTask['result']>['busy'] | undefined {
  if (
    typeof value.chatId !== 'string' ||
    typeof value.startedAt !== 'string' ||
    typeof value.durationMs !== 'number' ||
    typeof value.hasVisibleCard !== 'boolean'
  ) {
    return undefined;
  }
  return {
    chatId: value.chatId,
    startedAt: value.startedAt,
    durationMs: value.durationMs,
    hasVisibleCard: value.hasVisibleCard,
  };
}

function resolveStaleTaskMs(): number {
  const raw = process.env.METABOT_ASYNC_TASK_STALE_MS;
  if (!raw) return DEFAULT_STALE_TASK_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_STALE_TASK_MS;
}
