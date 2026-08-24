import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RestartStore } from '../src/runtime/restart-store.js';

process.env.SESSION_STORE_DIR = mkdtempSync(join(tmpdir(), 'metabot-restart-notice-'));

const {
  clearRestartBreadcrumb,
  getRestartBreadcrumb,
  isFreshRestart,
  loadRestartBreadcrumb,
  writeRestartBreadcrumb,
} = await import('../src/bridge/restart-notice.js');

const breadcrumb = join(process.env.SESSION_STORE_DIR, 'last-restart.json');

beforeEach(() => clearRestartBreadcrumb());

describe('structured restart breadcrumb', () => {
  it('is written atomically, private, retained on load, and cleared by requestId', () => {
    writeRestartBreadcrumb({
      requestId: 'restart-atomic',
      kind: 'restart',
      botName: 'pm',
      chatId: 'chat-1',
      source: 'test',
      reason: 'test restart',
      resume: true,
      targetRoot: '/srv/metabot',
    });
    expect(statSync(breadcrumb).mode & 0o777).toBe(0o600);
    expect(loadRestartBreadcrumb()).toMatchObject({
      version: 1,
      requestId: 'restart-atomic',
      kind: 'restart',
      resume: true,
      targetRoot: '/srv/metabot',
    });
    expect(existsSync(breadcrumb)).toBe(true);
    expect(isFreshRestart()).toBe(true);

    clearRestartBreadcrumb('different-request');
    expect(existsSync(breadcrumb)).toBe(true);
    clearRestartBreadcrumb('restart-atomic');
    expect(existsSync(breadcrumb)).toBe(false);
    expect(getRestartBreadcrumb()).toBeUndefined();
  });

  it('rejects an unsafe requestId and removes stale structured state', () => {
    expect(() => writeRestartBreadcrumb({
      requestId: '../unsafe',
      kind: 'restart',
      resume: true,
      targetRoot: '/srv/metabot',
    })).toThrow(/requestId/);

    writeRestartBreadcrumb({
      requestId: 'stale-request',
      kind: 'deploy',
      resume: false,
      targetRoot: '/srv/metabot-next',
      restartedAt: Math.floor(Date.now() / 1000) - 16 * 60,
    });
    expect(JSON.parse(readFileSync(breadcrumb, 'utf8')).requestId).toBe('stale-request');
    expect(loadRestartBreadcrumb()).toBeUndefined();
    expect(existsSync(breadcrumb)).toBe(false);
  });

  it('retains a stale breadcrumb while durable recovery is still undecided', () => {
    const store = new RestartStore();
    try {
      store.claim({
        requestId: 'stale-pending-recovery',
        kind: 'restart',
        targetRoot: '/srv/metabot',
      });
      writeRestartBreadcrumb({
        requestId: 'stale-pending-recovery',
        kind: 'restart',
        resume: true,
        targetRoot: '/srv/metabot',
        restartedAt: Math.floor(Date.now() / 1000) - 60 * 60,
      });
      expect(loadRestartBreadcrumb()).toMatchObject({ requestId: 'stale-pending-recovery' });
      expect(isFreshRestart()).toBe(true);
      expect(existsSync(breadcrumb)).toBe(true);
    } finally {
      store.close();
    }
  });
});
