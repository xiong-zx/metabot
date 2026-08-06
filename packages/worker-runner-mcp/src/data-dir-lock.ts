import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { WorkerRunnerError } from './types.js';

const MAX_LOCK_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WorkerDataDirLockOwner {
  instance_id: string;
  pid: number;
  hostname: string;
  started_at: string;
}

export interface WorkerStaleLockDiagnostic {
  archivePath: string;
  owner: WorkerDataDirLockOwner;
}

function isLiveLocalOwner(owner: WorkerDataDirLockOwner): boolean | undefined {
  if (owner.hostname !== hostname()) return undefined;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

function readOwner(lockPath: string): WorkerDataDirLockOwner {
  let descriptor: number | undefined;
  let value: unknown;
  try {
    descriptor = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size < 1 || stats.size > MAX_LOCK_BYTES) throw new Error('invalid lock file size');
    value = JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch (error) {
    throw new WorkerRunnerError(
      'Worker Runner data directory lock is unreadable',
      'DATA_DIR_LOCKED',
      { lockPath, ownerState: 'unknown' },
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (!isOwner(value)) {
    throw new WorkerRunnerError('Worker Runner data directory lock has invalid owner metadata', 'DATA_DIR_LOCKED', {
      lockPath,
      ownerState: 'unknown',
    });
  }
  return value;
}

function isOwner(value: unknown): value is WorkerDataDirLockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return (
    Object.keys(owner).length === 4 &&
    typeof owner.instance_id === 'string' &&
    UUID_PATTERN.test(owner.instance_id) &&
    Number.isSafeInteger(owner.pid) &&
    (owner.pid as number) > 0 &&
    typeof owner.hostname === 'string' &&
    owner.hostname.length > 0 &&
    typeof owner.started_at === 'string' &&
    Number.isFinite(Date.parse(owner.started_at))
  );
}

export class WorkerDataDirLock {
  readonly lockPath: string;
  readonly owner: WorkerDataDirLockOwner;
  readonly staleLocks: WorkerStaleLockDiagnostic[] = [];
  private released = false;

  private constructor(dataDir: string) {
    this.lockPath = path.join(dataDir, '.worker-runner.lock');
    this.owner = {
      instance_id: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      started_at: new Date().toISOString(),
    };
    this.acquire();
  }

  static acquire(dataDir: string): WorkerDataDirLock {
    return new WorkerDataDirLock(dataDir);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (!existsSync(this.lockPath)) return;
    let current: WorkerDataDirLockOwner;
    try {
      current = readOwner(this.lockPath);
    } catch {
      return;
    }
    if (current.instance_id === this.owner.instance_id) unlinkSync(this.lockPath);
  }

  private acquire(): void {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let descriptor: number | undefined;
      let created = false;
      try {
        descriptor = openSync(
          this.lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
        writeFileSync(descriptor, `${JSON.stringify(this.owner)}\n`, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        return;
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if (created) {
          try {
            unlinkSync(this.lockPath);
          } catch {
            // This failed acquisition owned the path; concurrent removal is harmless.
          }
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new WorkerRunnerError(
            'Could not acquire the Worker Runner data directory lock',
            'DATA_DIR_LOCKED',
            { lockPath: this.lockPath },
            { cause: error },
          );
        }
      }

      const existing = readOwner(this.lockPath);
      const live = isLiveLocalOwner(existing);
      if (live !== false) {
        throw new WorkerRunnerError('Worker Runner data directory is owned by another server', 'DATA_DIR_LOCKED', {
          lockPath: this.lockPath,
          owner: existing,
          ownerState: live === true ? 'live' : 'remote_or_unverifiable',
        });
      }

      const archivePath = path.join(
        path.dirname(this.lockPath),
        `.worker-runner.lock.stale-${Date.now()}-${existing.instance_id}.json`,
      );
      try {
        renameSync(this.lockPath, archivePath);
        this.staleLocks.push({ archivePath, owner: existing });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new WorkerRunnerError(
            'Could not archive a stale Worker Runner data directory lock',
            'DATA_DIR_LOCKED',
            { lockPath: this.lockPath, owner: existing },
            { cause: error },
          );
        }
      }
    }
    throw new WorkerRunnerError(
      'Could not acquire the Worker Runner data directory lock after retries',
      'DATA_DIR_LOCKED',
      { lockPath: this.lockPath },
    );
  }
}
