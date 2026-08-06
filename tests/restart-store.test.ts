import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RestartStore } from '../src/runtime/restart-store.js';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'metabot-restart-store-')), 'restart.sqlite');
}

describe('RestartStore', () => {
  it('claims a requestId transactionally and deduplicates a second claimant', () => {
    const dbPath = databasePath();
    const first = new RestartStore({ dbPath });
    const second = new RestartStore({ dbPath });
    try {
      const input = {
        requestId: 'restart-001',
        kind: 'restart' as const,
        requesterBot: 'pm',
        requesterChat: 'chat-1',
        source: 'test',
        reason: 'verify claim',
        targetRoot: '/srv/metabot',
        targetApps: ['metabot'],
        targetScripts: { metabot: '/srv/metabot/src/index.ts' },
        now: 100,
      };
      expect(first.claim(input)).toMatchObject({ duplicate: false, record: { attemptCount: 1 } });
      expect(second.claim({ ...input, reason: 'must not replace', now: 200 })).toMatchObject({
        duplicate: true,
        record: { reason: 'verify claim', attemptCount: 1, status: 'claimed' },
      });
      expect(first.list()).toHaveLength(1);
    } finally {
      second.close();
      first.close();
    }
  });

  it('persists the ordered startup, save, terminal, report, and continuation evidence', () => {
    const dbPath = databasePath();
    const store = new RestartStore({ dbPath });
    try {
      store.claim({
        requestId: 'deploy-001',
        kind: 'deploy',
        targetRoot: '/srv/metabot-next',
        now: 10,
      });
      store.markRestarting('deploy-001', { oldRuntimePid: 11, now: 20 });
      store.markStartupHealthy('deploy-001', { runtimePid: 22, now: 30 });
      store.markHealthy('deploy-001', { runtimePid: 22, now: 40 });
      expect(store.claimReport('deploy-001', 50)).toBe(true);
      expect(store.claimReport('deploy-001', 51)).toBe(false);
      store.recordReportOutcome('deploy-001', 'delivered', { delivered: true, now: 60 });
      store.recordContinuationDecision('deploy-001', {
        recoveryOwner: 'task-scheduler',
        continuationKey: 'restart-resume:deploy-001',
        continuationTaskId: 'task-1',
        now: 70,
      });

      store.close();
      const reopened = new RestartStore({ dbPath });
      try {
        expect(reopened.get('deploy-001')).toMatchObject({
          status: 'healthy',
          oldRuntimePid: 11,
          runtimePid: 22,
          startupHealthyAt: 30,
          processListSavedAt: 40,
          reportClaimedAt: 50,
          reportedAt: 60,
          reportOutcome: 'delivered',
          recoveryOwner: 'task-scheduler',
          continuationKey: 'restart-resume:deploy-001',
          continuationTaskId: 'task-1',
        });
      } finally {
        reopened.close();
      }
    } finally {
      try { store.close(); } catch { /* already closed */ }
    }
  });

  it('rejects unsafe request IDs and illegal terminal transitions', () => {
    const store = new RestartStore({ dbPath: databasePath() });
    try {
      expect(() => store.claim({
        requestId: '../escape',
        kind: 'restart',
        targetRoot: '/srv/metabot',
      })).toThrow(/requestId/);
      store.claim({ requestId: 'safe', kind: 'restart', targetRoot: '/srv/metabot' });
      store.markFailed('safe', 'preflight failed');
      expect(() => store.markHealthy('safe')).toThrow(/from failed/);
    } finally {
      store.close();
    }
  });
});
