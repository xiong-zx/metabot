import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerStore } from '../src/store.js';

const directories: string[] = [];
const stores: WorkerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Worker Runner data-directory ownership', () => {
  it('rejects a second live owner and releases the lock when the store closes', () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, 'state', 'workers.sqlite');
    const first = new WorkerStore(databasePath);
    stores.push(first);

    expect(() => new WorkerStore(databasePath)).toThrowError(
      expect.objectContaining({
        code: 'DATA_DIR_LOCKED',
        details: expect.objectContaining({ ownerState: 'live' }),
      }),
    );

    first.close();
    const replacement = new WorkerStore(databasePath);
    stores.push(replacement);
  });

  it('archives a verifiably stale local owner before acquiring the data directory', () => {
    const directory = temporaryDirectory();
    const dataDir = path.join(directory, 'state');
    mkdirSync(dataDir, { recursive: true });
    writeOwner(dataDir, { pid: 2_000_000_000, ownerHostname: hostname() });

    const store = new WorkerStore(path.join(dataDir, 'workers.sqlite'));
    stores.push(store);
    expect(store.lock.staleLocks).toHaveLength(1);
    expect(store.lock.staleLocks[0]?.owner.pid).toBe(2_000_000_000);
    expect(existsSync(store.lock.staleLocks[0]!.archivePath)).toBe(true);
  });

  it('fails closed for a remote or otherwise unverifiable owner', () => {
    const directory = temporaryDirectory();
    const dataDir = path.join(directory, 'state');
    mkdirSync(dataDir, { recursive: true });
    const lockPath = writeOwner(dataDir, { pid: 123, ownerHostname: `${hostname()}-remote` });

    expect(() => new WorkerStore(path.join(dataDir, 'workers.sqlite'))).toThrowError(
      expect.objectContaining({
        code: 'DATA_DIR_LOCKED',
        details: expect.objectContaining({ ownerState: 'remote_or_unverifiable' }),
      }),
    );
    expect(existsSync(lockPath)).toBe(true);
  });

  it('fails closed without replacing malformed lock metadata', () => {
    const directory = temporaryDirectory();
    const dataDir = path.join(directory, 'state');
    mkdirSync(dataDir, { recursive: true });
    const lockPath = path.join(dataDir, '.worker-runner.lock');
    writeFileSync(lockPath, '{"pid":"not-valid"}\n', { encoding: 'utf8', mode: 0o600 });

    expect(() => new WorkerStore(path.join(dataDir, 'workers.sqlite'))).toThrowError(
      expect.objectContaining({
        code: 'DATA_DIR_LOCKED',
        details: expect.objectContaining({ ownerState: 'unknown' }),
      }),
    );
    expect(readFileSync(lockPath, 'utf8')).toBe('{"pid":"not-valid"}\n');
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'worker-lock-'));
  directories.push(directory);
  return directory;
}

function writeOwner(dataDir: string, input: { pid: number; ownerHostname: string }): string {
  const lockPath = path.join(dataDir, '.worker-runner.lock');
  writeFileSync(
    lockPath,
    `${JSON.stringify({
      instance_id: randomUUID(),
      pid: input.pid,
      hostname: input.ownerHostname,
      started_at: new Date(0).toISOString(),
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return lockPath;
}
