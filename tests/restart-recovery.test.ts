import { existsSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotRegistry } from '../src/api/bot-registry.js';
import type { TaskScheduler } from '../src/scheduler/task-scheduler.js';
import type { Logger } from '../src/utils/logger.js';
import { RestartStore } from '../src/runtime/restart-store.js';

process.env.SESSION_STORE_DIR = mkdtempSync(join(tmpdir(), 'metabot-restart-recovery-'));

const {
  clearRestartBreadcrumb,
  loadRestartBreadcrumb,
  writeRestartBreadcrumb,
} = await import('../src/bridge/restart-notice.js');
const { finalizeControlledRestartAfterStartup, validatePm2RuntimeExpectations } = await import('../src/bridge/restart-recovery.js');

function logger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function recoveryFixture(chatId = 'chat-user-1', resume = true) {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'metabot-restart-recovery-db-')), 'state.sqlite');
  const store = new RestartStore({ dbPath });
  const sendTextNotice = vi.fn().mockResolvedValue(undefined);
  const bot = { sender: { sendTextNotice } };
  const registry = { get: vi.fn().mockReturnValue(bot) } as unknown as BotRegistry;
  const scheduledTask = { id: 'continuation-task-1' };
  const scheduleTaskDurably = vi.fn().mockReturnValue(scheduledTask);
  const scheduler = { scheduleTaskDurably } as unknown as TaskScheduler;
  store.claim({
    requestId: 'restart-recovery',
    kind: 'restart',
    requesterBot: 'pm',
    requesterChat: chatId,
    source: 'test',
    reason: 'continue work',
    resume,
    targetRoot: '/srv/metabot',
    targetApps: ['metabot'],
    targetScripts: { metabot: '/srv/metabot/src/index.ts' },
    now: 10,
  });
  store.markRestarting('restart-recovery', { oldRuntimePid: 10, now: 20 });
  writeRestartBreadcrumb({
    requestId: 'restart-recovery',
    kind: 'restart',
    botName: 'pm',
    chatId,
    source: 'test',
    reason: 'continue work',
    resume,
    targetRoot: '/srv/metabot',
  });
  loadRestartBreadcrumb();
  return { store, registry, scheduler, sendTextNotice, scheduleTaskDurably };
}

beforeEach(() => clearRestartBreadcrumb());

describe('controlled restart startup finalization', () => {
  it('rejects stale interpreter, arguments, and secret-safe environment fingerprints', () => {
    const kit = recoveryFixture();
    const base = kit.store.get('restart-recovery')!;
    const expected = {
      ...base,
      runtimeExpectations: {
        metabot: {
          cwd: '/srv/metabot',
          script: '/srv/metabot/src/index.ts',
          interpreter: 'node',
          interpreterArgs: ['--import', 'tsx'],
          envHashes: {
            HTTP_PROXY: createHash('sha256').update('http://proxy.invalid:7890').digest('hex'),
          },
        },
      },
    };
    const row = {
      name: 'metabot',
      pm2_env: {
        status: 'online',
        pm_cwd: '/srv/metabot',
        pm_exec_path: '/srv/metabot/src/index.ts',
        exec_interpreter: 'node',
        node_args: ['--import', 'tsx'],
        env: { HTTP_PROXY: 'http://proxy.invalid:7890' },
      },
    };
    expect(() => validatePm2RuntimeExpectations(expected, [row])).not.toThrow();
    expect(() => validatePm2RuntimeExpectations(expected, [{
      ...row, pm2_env: { ...row.pm2_env, exec_interpreter: 'bash' },
    }])).toThrow(/interpreter/);
    expect(() => validatePm2RuntimeExpectations(expected, [{
      ...row, pm2_env: { ...row.pm2_env, node_args: ['--import', 'wrong'] },
    }])).toThrow(/arguments/);
    expect(() => validatePm2RuntimeExpectations(expected, [{
      ...row, pm2_env: { ...row.pm2_env, env: { HTTP_PROXY: 'http://stale.invalid:7890' } },
    }])).toThrow(/HTTP_PROXY/);
    kit.store.close();
  });

  it('orders startup health before PM2 save and durable healthy state, then continues exactly once', async () => {
    const kit = recoveryFixture();
    const events: string[] = [];
    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => { events.push('health'); return { ok: true }; },
      persistProcessList: async () => { events.push('save'); },
      now: (() => { let value = 100; return () => ++value; })(),
    });

    expect(events).toEqual(['health', 'save']);
    expect(kit.store.get('restart-recovery')).toMatchObject({
      status: 'healthy',
      reportOutcome: 'delivered',
      recoveryOwner: 'task-scheduler',
      continuationKey: 'restart-resume:restart-recovery',
      continuationTaskId: 'continuation-task-1',
    });
    expect(kit.sendTextNotice).toHaveBeenCalledTimes(1);
    expect(kit.scheduleTaskDurably).toHaveBeenCalledTimes(1);
    expect(kit.scheduleTaskDurably).toHaveBeenCalledWith(expect.objectContaining({
      botName: 'pm',
      chatId: 'chat-user-1',
      delaySeconds: 0,
      dedupeKey: 'restart-resume:restart-recovery',
      prompt: expect.stringContaining('Continue the interrupted task now'),
    }));
    expect(existsSync(join(process.env.SESSION_STORE_DIR, 'last-restart.json'))).toBe(false);

    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => ({ ok: true }),
      persistProcessList: async () => undefined,
    });
    expect(kit.sendTextNotice).toHaveBeenCalledTimes(1);
    expect(kit.scheduleTaskDurably).toHaveBeenCalledTimes(1);
    kit.store.close();
  });

  it('retains the breadcrumb and retries after durable continuation persistence fails', async () => {
    const kit = recoveryFixture();
    kit.scheduleTaskDurably.mockImplementationOnce(() => {
      throw new Error('injected scheduler persistence failure');
    });
    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => ({ ok: true }),
      persistProcessList: async () => undefined,
    });
    expect(kit.store.get('restart-recovery')).toMatchObject({ status: 'healthy' });
    expect(kit.store.get('restart-recovery')?.continuationDecidedAt).toBeUndefined();
    expect(existsSync(join(process.env.SESSION_STORE_DIR, 'last-restart.json'))).toBe(true);

    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => ({ ok: true }),
      persistProcessList: async () => undefined,
    });
    expect(kit.scheduleTaskDurably).toHaveBeenCalledTimes(2);
    expect(kit.store.get('restart-recovery')).toMatchObject({
      recoveryOwner: 'task-scheduler',
      continuationTaskId: 'continuation-task-1',
    });
    expect(existsSync(join(process.env.SESSION_STORE_DIR, 'last-restart.json'))).toBe(false);
    kit.store.close();
  });

  it('audits a failed requester notice once without claiming delivery', async () => {
    const kit = recoveryFixture();
    kit.sendTextNotice.mockRejectedValue(new Error('injected send failure'));
    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => ({ ok: true }),
      persistProcessList: async () => undefined,
    });
    expect(kit.store.get('restart-recovery')).toMatchObject({
      reportOutcome: 'failed:send',
    });
    expect(kit.store.get('restart-recovery')?.reportedAt).toBeUndefined();
    expect(kit.sendTextNotice).toHaveBeenCalledTimes(1);

    writeRestartBreadcrumb({
      requestId: 'restart-recovery',
      kind: 'restart',
      botName: 'pm',
      chatId: 'chat-user-1',
      source: 'test',
      reason: 'continue work',
      resume: true,
      targetRoot: '/srv/metabot',
    });
    loadRestartBreadcrumb();
    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => ({ ok: true }),
      persistProcessList: async () => undefined,
    });
    expect(kit.sendTextNotice).toHaveBeenCalledTimes(1);
    kit.store.close();
  });

  it('does not save or continue when startup health fails', async () => {
    const kit = recoveryFixture();
    const persist = vi.fn().mockResolvedValue(undefined);
    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => ({ ok: false, error: 'worker unhealthy' }),
      persistProcessList: persist,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(kit.store.get('restart-recovery')).toMatchObject({
      status: 'failed',
      healthError: 'worker unhealthy',
      reportOutcome: 'delivered',
      recoveryOwner: 'none:restart-failed',
    });
    expect(kit.scheduleTaskDurably).not.toHaveBeenCalled();
    kit.store.close();
  });

  it('marks the request failed and does not continue when PM2 save fails', async () => {
    const kit = recoveryFixture();
    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => ({ ok: true }),
      persistProcessList: async () => { throw new Error('injected pm2 save failure'); },
    });
    expect(kit.store.get('restart-recovery')).toMatchObject({
      status: 'failed',
      healthError: 'injected pm2 save failure',
      recoveryOwner: 'none:restart-failed',
    });
    expect(kit.scheduleTaskDurably).not.toHaveBeenCalled();
    kit.store.close();
  });

  it('reports but does not continue when resume is disabled', async () => {
    const kit = recoveryFixture('chat-user-1', false);
    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => ({ ok: true }),
      persistProcessList: async () => undefined,
    });
    expect(kit.store.get('restart-recovery')).toMatchObject({
      status: 'healthy',
      reportOutcome: 'delivered',
      recoveryOwner: 'none:resume-disabled',
    });
    expect(kit.sendTextNotice).toHaveBeenCalledTimes(1);
    expect(kit.scheduleTaskDurably).not.toHaveBeenCalled();
    kit.store.close();
  });

  it.each([
    ['team:migration:member', 'agent-team-supervisor'],
    ['teaminst:migration:member:instance', 'agent-team-supervisor'],
    ['worker:task-123', 'execution-daemon'],
    ['arc:run-123', 'execution-daemon'],
  ])('leaves internal chat %s to its durable owner', async (chatId, owner) => {
    const kit = recoveryFixture(chatId);
    await finalizeControlledRestartAfterStartup({
      registry: kit.registry,
      scheduler: kit.scheduler,
      logger: logger(),
      store: kit.store,
      healthCheck: async () => ({ ok: true }),
      persistProcessList: async () => undefined,
    });
    expect(kit.store.get('restart-recovery')).toMatchObject({ status: 'healthy', recoveryOwner: owner });
    expect(kit.scheduleTaskDurably).not.toHaveBeenCalled();
    kit.store.close();
  });
});
