import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectServiceRestartBlockers,
  expireTimedOutServiceRestartRequests,
  findReusableServiceRestartRequest,
  getServiceRestartRequest,
  listServiceRestartRequests,
  markServiceRestartFailed,
  markServiceRestartHealthy,
  markServiceRestartRequestTimedOut,
  recordServiceRestartReadiness,
  recordServiceRestartRequest,
  resolveRestartReadyTimeoutMs,
  summarizeServiceRestartReadiness,
} from '../src/bridge/restart-coordinator.js';
import { getCardLifecycleRecord, recordCardLifecycle } from '../src/bridge/card-lifecycle-store.js';
import type { ActiveTaskRecord } from '../src/bridge/restart-recovery.js';

function task(input: Partial<ActiveTaskRecord> & Pick<ActiveTaskRecord, 'botName' | 'chatId' | 'messageId'>): ActiveTaskRecord {
  return {
    userPrompt: 'work in progress',
    startedAt: 1_000,
    updatedAt: 2_000,
    source: 'chat',
    ...input,
  };
}

describe('restart coordinator', () => {
  it('resolves restart ready timeout from env-compatible milliseconds', () => {
    expect(resolveRestartReadyTimeoutMs(undefined)).toBe(600_000);
    expect(resolveRestartReadyTimeoutMs('2500')).toBe(2_500);
    expect(resolveRestartReadyTimeoutMs('1')).toBe(1_000);
    expect(resolveRestartReadyTimeoutMs('not-a-number')).toBe(600_000);
  });

  it('blocks service restart on other active bot/chat turns', () => {
    const blockers = collectServiceRestartBlockers({
      request: { chatId: 'oc_requester', userId: 'u1' },
      requesterBotName: 'admin',
      activeTasks: [
        task({ botName: 'admin', chatId: 'oc_requester', messageId: 'same-chat' }),
        task({ botName: 'pm-codex', chatId: 'oc_busy', messageId: 'busy-1', startedAt: 500 }),
      ],
      now: 3_000,
    });

    expect(blockers).toEqual([expect.objectContaining({
      botName: 'pm-codex',
      chatId: 'oc_busy',
      messageId: 'busy-1',
      source: 'chat',
      userPrompt: 'work in progress',
    })]);
  });

  it('orders blockers by oldest active turn first', () => {
    const blockers = collectServiceRestartBlockers({
      request: { chatId: 'oc_requester', userId: 'u1' },
      requesterBotName: 'admin',
      activeTasks: [
        task({ botName: 'pm-codex', chatId: 'oc_new', messageId: 'new', startedAt: 2_000 }),
        task({ botName: 'pm-claude', chatId: 'oc_old', messageId: 'old', startedAt: 500 }),
      ],
      now: 3_000,
    });

    expect(blockers.map((blocker) => blocker.messageId)).toEqual(['old', 'new']);
  });

  it('persists blocked restart requests with blocker snapshots', () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-coordinator-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      const blockers = [{
        botName: 'pm-codex',
        chatId: 'oc_busy',
        messageId: 'msg_busy',
        source: 'chat',
        startedAt: 500,
        updatedAt: 900,
        userPrompt: 'finish tester loop',
      }];

      const record = recordServiceRestartRequest({
        requestId: 'restart-1',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u1', reason: 'deploy fixes' },
        status: 'blocked',
        blockers,
        now: 1_000,
      });

      expect(record).toMatchObject({
        requestId: 'restart-1',
        requesterBotName: 'admin',
        requesterChatId: 'oc_requester',
        userId: 'u1',
        reason: 'deploy fixes',
        force: false,
        status: 'blocked',
        blockers,
        createdAt: 1_000,
        updatedAt: 1_000,
        timeoutMs: 600_000,
        deadlineAt: 601_000,
      });
      expect(getServiceRestartRequest('restart-1')).toMatchObject({ status: 'blocked', blockers });
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes old restart requests when recording new ones', () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-coordinator-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordServiceRestartRequest({
        requestId: 'old',
        requesterBotName: 'admin',
        request: { chatId: 'oc_old', userId: 'u1' },
        status: 'blocked',
        now: 1_000,
      });
      recordServiceRestartRequest({
        requestId: 'new',
        requesterBotName: 'admin',
        request: { chatId: 'oc_new', userId: 'u1', force: true },
        status: 'forced',
        now: 1_000 + 15 * 24 * 60 * 60 * 1000,
      });

      expect(listServiceRestartRequests().map((record) => record.requestId)).toEqual(['new']);
      expect(getServiceRestartRequest('new')).toMatchObject({
        status: 'forced',
        force: true,
        scheduledAt: 1_000 + 15 * 24 * 60 * 60 * 1000,
      });
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists healthy and failed restart terminal states with runtime evidence', () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-coordinator-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordServiceRestartRequest({
        requestId: 'restart-healthy',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u1' },
        status: 'restarting',
        targetCwd: '/srv/metabot',
        targetScript: '/srv/metabot/src/index.ts',
        now: 1_000,
      });
      const healthy = markServiceRestartHealthy({
        requestId: 'restart-healthy',
        runtimePid: 1234,
        proxyReachable: true,
        processListSavedAt: 2_000,
        now: 2_000,
      });
      expect(healthy).toMatchObject({
        status: 'healthy',
        healthyAt: 2_000,
        runtimePid: 1234,
        targetCwd: '/srv/metabot',
        proxyReachable: true,
        processListSavedAt: 2_000,
      });

      recordServiceRestartRequest({
        requestId: 'restart-failed',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u1' },
        status: 'restarting',
        now: 3_000,
      });
      const failed = markServiceRestartFailed({
        requestId: 'restart-failed',
        error: 'proxy connect timeout',
        proxyReachable: false,
        now: 4_000,
      });
      expect(failed).toMatchObject({
        status: 'failed',
        failedAt: 4_000,
        healthError: 'proxy connect timeout',
        proxyReachable: false,
      });
      expect(listServiceRestartRequests()).toHaveLength(2);
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records readiness acknowledgements by bot and chat', () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-coordinator-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordServiceRestartRequest({
        requestId: 'restart-ack',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u1' },
        status: 'blocked',
        blockers: [{ botName: 'pm-codex', chatId: 'oc_busy' }],
        now: 1_000,
      });

      recordServiceRestartReadiness({
        requestId: 'restart-ack',
        botName: 'pm-codex',
        chatId: 'oc_busy',
        userId: 'u2',
        note: 'checkpoint saved',
        now: 2_000,
      });
      recordServiceRestartReadiness({
        requestId: 'restart-ack',
        botName: 'pm-codex',
        chatId: 'oc_busy',
        userId: 'u2',
        note: 'checkpoint updated',
        now: 3_000,
      });

      expect(getServiceRestartRequest('restart-ack')?.readiness).toEqual([expect.objectContaining({
        botName: 'pm-codex',
        chatId: 'oc_busy',
        status: 'ready',
        note: 'checkpoint updated',
        acknowledgedAt: 3_000,
      })]);
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies restart readiness notes into the blocker lifecycle checkpoint', () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-coordinator-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordCardLifecycle({
        lifecycleKey: 'chat:oc_busy:msg_busy',
        botName: 'pm-codex',
        chatId: 'oc_busy',
        messageId: 'msg_busy',
        source: 'chat',
        status: 'running',
        lifecycleStage: 'executing',
        userPrompt: 'finish tester loop',
        now: 1_000,
      });
      recordServiceRestartRequest({
        requestId: 'restart-checkpoint',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u1' },
        status: 'blocked',
        blockers: [{
          botName: 'pm-codex',
          chatId: 'oc_busy',
          messageId: 'msg_busy',
          lifecycleKey: 'chat:oc_busy:msg_busy',
        }],
        now: 1_500,
      });

      recordServiceRestartReadiness({
        requestId: 'restart-checkpoint',
        botName: 'pm-codex',
        chatId: 'oc_busy',
        userId: 'u2',
        note: 'saved progress in PROGRESS.md',
        now: 2_000,
      });

      expect(getCardLifecycleRecord('chat:oc_busy:msg_busy')).toMatchObject({
        lifecycleStage: 'checkpointing',
        checkpointNote: 'saved progress in PROGRESS.md',
        checkpointBy: 'pm-codex',
        checkpointAt: 2_000,
        restartRequestId: 'restart-checkpoint',
      });
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarizes readiness against the current blocker set', () => {
    const blockers = [
      { botName: 'pm-codex', chatId: 'oc_busy_1' },
      { botName: 'pm-claude', chatId: 'oc_busy_2' },
    ];

    const partial = summarizeServiceRestartReadiness({
      blockers,
      readiness: [{ botName: 'pm-codex', chatId: 'oc_busy_1', userId: 'u2', status: 'ready', acknowledgedAt: 2_000 }],
    });

    expect(partial).toMatchObject({
      total: 2,
      ready: 1,
      pending: 1,
      allReady: false,
    });
    expect(partial.pendingBlockers).toEqual([blockers[1]]);

    const complete = summarizeServiceRestartReadiness({
      blockers,
      readiness: [
        { botName: 'pm-codex', chatId: 'oc_busy_1', userId: 'u2', status: 'ready', acknowledgedAt: 2_000 },
        { botName: 'pm-claude', chatId: 'oc_busy_2', userId: 'u3', status: 'ready', acknowledgedAt: 3_000 },
      ],
    });

    expect(complete).toMatchObject({
      total: 2,
      ready: 2,
      pending: 0,
      allReady: true,
    });
  });

  it('summarizes timed-out restart readiness using the stored deadline', () => {
    const blockers = [
      { botName: 'pm-codex', chatId: 'oc_busy_1' },
      { botName: 'pm-claude', chatId: 'oc_busy_2' },
    ];

    const summary = summarizeServiceRestartReadiness({
      blockers,
      readiness: [{ botName: 'pm-codex', chatId: 'oc_busy_1', userId: 'u2', status: 'ready', acknowledgedAt: 2_000 }],
      deadlineAt: 4_000,
    }, blockers, 5_000);

    expect(summary).toMatchObject({
      total: 2,
      ready: 1,
      pending: 1,
      timedOut: true,
      deadlineAt: 4_000,
      remainingMs: 0,
    });
  });

  it('marks restart requests as timed out and keeps them reusable for the requester chat', () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-coordinator-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordServiceRestartRequest({
        requestId: 'timed-out',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u1' },
        status: 'blocked',
        blockers: [{ botName: 'pm-codex', chatId: 'oc_busy' }],
        timeoutMs: 2_000,
        now: 1_000,
      });

      const timedOut = markServiceRestartRequestTimedOut({ requestId: 'timed-out', now: 5_000 });

      expect(timedOut).toMatchObject({
        status: 'timed_out',
        deadlineAt: 3_000,
        timedOutAt: 5_000,
      });
      expect(findReusableServiceRestartRequest({
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u2' },
        now: 6_000,
      })?.requestId).toBe('timed-out');
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expires blocked restart requests with overdue pending readiness', () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-coordinator-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordServiceRestartRequest({
        requestId: 'expires-on-status',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u1' },
        status: 'blocked',
        blockers: [{ botName: 'pm-codex', chatId: 'oc_busy' }],
        timeoutMs: 2_000,
        now: 1_000,
      });

      const records = expireTimedOutServiceRestartRequests(4_000);

      expect(records.find((record) => record.requestId === 'expires-on-status')).toMatchObject({
        status: 'timed_out',
        deadlineAt: 3_000,
        timedOutAt: 4_000,
      });
      expect(getServiceRestartRequest('expires-on-status')?.status).toBe('timed_out');
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the latest reusable blocked restart request for the requester chat', () => {
    const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'metabot-restart-coordinator-'));
    process.env.SESSION_STORE_DIR = dir;
    try {
      recordServiceRestartRequest({
        requestId: 'older',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u1' },
        status: 'blocked',
        now: 1_000,
      });
      recordServiceRestartRequest({
        requestId: 'latest',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u2' },
        status: 'blocked',
        now: 2_000,
      });
      recordServiceRestartRequest({
        requestId: 'other-chat',
        requesterBotName: 'admin',
        request: { chatId: 'oc_other', userId: 'u1' },
        status: 'blocked',
        now: 3_000,
      });
      recordServiceRestartRequest({
        requestId: 'scheduled',
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u1' },
        status: 'scheduled',
        now: 4_000,
      });

      expect(findReusableServiceRestartRequest({
        requesterBotName: 'admin',
        request: { chatId: 'oc_requester', userId: 'u3' },
        now: 5_000,
      })?.requestId).toBe('latest');
    } finally {
      if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
      else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
