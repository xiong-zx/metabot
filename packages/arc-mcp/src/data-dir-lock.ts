import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ArcError } from './errors.js';

const lockOwnerSchema = z
  .object({
    instance_id: z.string().uuid(),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    started_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type ArcDataDirLockOwner = z.infer<typeof lockOwnerSchema>;

export interface ArcStaleLockDiagnostic {
  archivePath: string;
  owner: ArcDataDirLockOwner;
}

function isLiveLocalOwner(owner: ArcDataDirLockOwner): boolean | undefined {
  if (owner.hostname !== hostname()) return undefined;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

function readOwner(lockPath: string): ArcDataDirLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw new ArcError('data_dir_locked', 'ARC data directory lock is unreadable', {
      cause: error,
      details: { lockPath, ownerState: 'unknown' },
    });
  }
  const parsed = lockOwnerSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArcError('data_dir_locked', 'ARC data directory lock has invalid owner metadata', {
      details: { lockPath, ownerState: 'unknown' },
    });
  }
  return parsed.data;
}

export class ArcDataDirLock {
  readonly lockPath: string;
  readonly owner: ArcDataDirLockOwner;
  readonly staleLocks: ArcStaleLockDiagnostic[] = [];
  private released = false;

  private constructor(dataDir: string) {
    this.lockPath = path.join(dataDir, '.arc-mcp.lock');
    this.owner = {
      instance_id: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      started_at: new Date().toISOString(),
    };
    this.acquire();
  }

  static acquire(dataDir: string): ArcDataDirLock {
    return new ArcDataDirLock(dataDir);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (!existsSync(this.lockPath)) return;
    let current: ArcDataDirLockOwner;
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
            // The failed acquisition owns this path. A concurrent removal is harmless.
          }
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new ArcError('data_dir_locked', 'Could not acquire the ARC data directory lock', {
            cause: error,
            details: { lockPath: this.lockPath },
          });
        }
      }

      const existing = readOwner(this.lockPath);
      const live = isLiveLocalOwner(existing);
      if (live !== false) {
        throw new ArcError('data_dir_locked', 'ARC data directory is owned by another server', {
          details: {
            lockPath: this.lockPath,
            owner: existing,
            ownerState: live === true ? 'live' : 'remote_or_unverifiable',
          },
        });
      }

      const archivePath = path.join(
        path.dirname(this.lockPath),
        `.arc-mcp.lock.stale-${Date.now()}-${existing.instance_id}.json`,
      );
      try {
        renameSync(this.lockPath, archivePath);
        this.staleLocks.push({ archivePath, owner: existing });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ArcError('data_dir_locked', 'Could not archive a stale ARC data directory lock', {
            cause: error,
            details: { lockPath: this.lockPath, owner: existing },
          });
        }
      }
    }
    throw new ArcError('data_dir_locked', 'Could not acquire the ARC data directory lock after retries', {
      details: { lockPath: this.lockPath },
    });
  }
}
