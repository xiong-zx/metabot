import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

  it('fails closed without following or changing a symlink-planted lock', () => {
    const directory = temporaryDirectory();
    const dataDir = path.join(directory, 'state');
    const targetPath = path.join(directory, 'external-lock-target.json');
    const lockPath = path.join(dataDir, '.worker-runner.lock');
    mkdirSync(dataDir, { recursive: true });
    const targetContent = ownerContent({ pid: 2_000_000_000, ownerHostname: hostname() });
    writeFileSync(targetPath, targetContent, { encoding: 'utf8', mode: 0o600 });
    const targetBefore = statSync(targetPath);
    symlinkSync(targetPath, lockPath);

    let failure: unknown;
    try {
      new WorkerStore(path.join(dataDir, 'workers.sqlite'));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'DATA_DIR_LOCKED',
      details: expect.objectContaining({ ownerState: 'unknown' }),
      cause: expect.objectContaining({ code: 'ELOOP' }),
    });
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(lockPath)).toBe(targetPath);
    expect(readdirSync(dataDir).filter((name) => name.startsWith('.worker-runner.lock.stale-'))).toEqual([]);
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe(targetContent);
    const targetAfter = statSync(targetPath);
    expect({
      ino: targetAfter.ino,
      mode: targetAfter.mode,
      size: targetAfter.size,
      mtimeMs: targetAfter.mtimeMs,
    }).toEqual({
      ino: targetBefore.ino,
      mode: targetBefore.mode,
      size: targetBefore.size,
      mtimeMs: targetBefore.mtimeMs,
    });
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'worker-lock-'));
  directories.push(directory);
  return directory;
}

function writeOwner(dataDir: string, input: { pid: number; ownerHostname: string }): string {
  const lockPath = path.join(dataDir, '.worker-runner.lock');
  writeFileSync(lockPath, ownerContent(input), { encoding: 'utf8', mode: 0o600 });
  return lockPath;
}

function ownerContent(input: { pid: number; ownerHostname: string }): string {
  return `${JSON.stringify({
    instance_id: randomUUID(),
    pid: input.pid,
    hostname: input.ownerHostname,
    started_at: new Date(0).toISOString(),
  })}\n`;
}
