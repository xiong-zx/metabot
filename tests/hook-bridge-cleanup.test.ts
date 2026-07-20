/**
 * Regression: `dispose()` on the PTY hook bridge only runs on normal
 * teardown. A crash, `kill -9`, or `pm2 restart` skips it, so live bridge
 * dirs (`/tmp/metabot-pty-<id>/`) leak forever — nothing else ever cleans
 * them up. `cleanupStaleBridgeDirs()` is the startup-time sweep that fixes
 * this; these tests pin its exact matching and safety behavior so a future
 * edit can't quietly widen it into deleting unrelated tmp entries.
 *
 * All scanning happens inside a throwaway scratch dir passed as `baseDir`,
 * never the real `os.tmpdir()` — this suite runs on the same machine as a
 * live MetaBot instance, and that instance's own `/tmp/metabot-pty-<id>`
 * bridge dir must never be touched by a test run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupStaleBridgeDirs } from '../src/engines/claude/pty/hook-bridge.js';

let scratch: string;

function makeBridgeDir(id: string): string {
  const dir = join(scratch, `metabot-pty-${id}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'settings.json'), '{}', { mode: 0o600 });
  return dir;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hook-bridge-cleanup-test-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('cleanupStaleBridgeDirs', () => {
  it('removes directories matching the bridge naming pattern', () => {
    const dir = makeBridgeDir('deadbeef');
    expect(existsSync(dir)).toBe(true);

    const removed = cleanupStaleBridgeDirs(undefined, scratch);

    expect(removed).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes multiple stale dirs in one sweep', () => {
    const a = makeBridgeDir('11111111');
    const b = makeBridgeDir('22222222');

    const removed = cleanupStaleBridgeDirs(undefined, scratch);

    expect(removed).toBe(2);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  it('does not touch entries that merely start with the same prefix but do not match the id shape', () => {
    // Not the 8-hex-char id shape createHookBridge() actually produces.
    const looseDir = join(scratch, 'metabot-pty-not-a-real-id');
    mkdirSync(looseDir, { recursive: true });

    const removed = cleanupStaleBridgeDirs(undefined, scratch);

    expect(removed).toBe(0);
    expect(existsSync(looseDir)).toBe(true);
  });

  it('is idempotent — a second sweep with nothing new removes nothing', () => {
    makeBridgeDir('33333333');
    cleanupStaleBridgeDirs(undefined, scratch);

    const removed = cleanupStaleBridgeDirs(undefined, scratch);
    expect(removed).toBe(0);
  });

  it('leaves unrelated entries in the scanned dir alone', () => {
    const unrelated = join(scratch, 'not-metabot-something');
    mkdirSync(unrelated, { recursive: true });

    makeBridgeDir('44444444');
    cleanupStaleBridgeDirs(undefined, scratch);

    expect(existsSync(unrelated)).toBe(true);
  });

  it('returns 0 and does not throw when the scanned dir does not exist', () => {
    const missing = join(scratch, 'does-not-exist');

    expect(() => cleanupStaleBridgeDirs(undefined, missing)).not.toThrow();
    expect(cleanupStaleBridgeDirs(undefined, missing)).toBe(0);
  });

  it('the before/after directory listing shrinks by exactly the bridge dirs it made', () => {
    makeBridgeDir('55555555');
    makeBridgeDir('66666666');
    const before = readdirSync(scratch).filter((n) => /^metabot-pty-[0-9a-f]{8}$/.test(n));
    expect(before.length).toBe(2);

    const removed = cleanupStaleBridgeDirs(undefined, scratch);
    expect(removed).toBe(2);

    const after = readdirSync(scratch).filter((n) => /^metabot-pty-[0-9a-f]{8}$/.test(n));
    expect(after.length).toBe(0);
  });

  it('never touches the real os.tmpdir() — only scans the injected baseDir', () => {
    // Sanity check on the isolation guarantee itself: a bridge dir created
    // under the real tmpdir() must survive a sweep scoped to `scratch`.
    const realDir = join(tmpdir(), `metabot-pty-ffffffff`);
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    try {
      cleanupStaleBridgeDirs(undefined, scratch);
      expect(existsSync(realDir)).toBe(true);
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});
