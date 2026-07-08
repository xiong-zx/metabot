import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalSessionStoreDir = process.env.SESSION_STORE_DIR;

afterEach(() => {
  if (originalSessionStoreDir === undefined) delete process.env.SESSION_STORE_DIR;
  else process.env.SESSION_STORE_DIR = originalSessionStoreDir;
  vi.resetModules();
});

describe('card lifecycle store', () => {
  it('upserts lifecycle records by lifecycleKey', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-card-lifecycle-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const store = await import('../src/bridge/card-lifecycle-store.js');
    store.recordCardLifecycle({
      lifecycleKey: 'worker:abc',
      botName: 'pm-codex',
      chatId: 'worker-abc',
      messageId: 'worker:abc',
      source: 'api',
      status: 'thinking',
      lifecycleStage: 'received',
      userPrompt: 'Run worker',
      responseText: '',
      now: 1000,
    });
    store.recordCardLifecycle({
      lifecycleKey: 'worker:abc',
      botName: 'pm-codex',
      chatId: 'worker-abc',
      messageId: 'worker:abc',
      source: 'api',
      status: 'error',
      lifecycleStage: 'blocked',
      userPrompt: 'Run worker',
      responseText: 'failed',
      now: 2000,
    });

    expect(store.listCardLifecycleRecords()).toHaveLength(1);
    expect(store.getCardLifecycleRecord('worker:abc')).toMatchObject({
      lifecycleKey: 'worker:abc',
      status: 'error',
      lifecycleStage: 'blocked',
      responsePreview: 'failed',
      createdAt: 1000,
      updatedAt: 2000,
      closedAt: 2000,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('prunes old closed records while preserving the updated key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-card-lifecycle-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const store = await import('../src/bridge/card-lifecycle-store.js');
    store.recordCardLifecycle({
      lifecycleKey: 'old:closed',
      botName: 'pm-codex',
      chatId: 'oc_old',
      source: 'final',
      status: 'complete',
      lifecycleStage: 'closed',
      now: 1000,
    });
    store.recordCardLifecycle({
      lifecycleKey: 'new:running',
      botName: 'pm-codex',
      chatId: 'oc_new',
      source: 'chat',
      status: 'running',
      lifecycleStage: 'executing',
      now: 1000 + 8 * 24 * 60 * 60 * 1000,
    });

    expect(store.getCardLifecycleRecord('old:closed')).toBeUndefined();
    expect(store.getCardLifecycleRecord('new:running')).toMatchObject({ status: 'running' });

    rmSync(dir, { recursive: true, force: true });
  });

  it('persists agent team metadata across lifecycle updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-card-lifecycle-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const store = await import('../src/bridge/card-lifecycle-store.js');
    store.recordCardLifecycle({
      lifecycleKey: 'teaminst:ati_chat_a:reviewer:run-1',
      botName: 'pm-codex',
      chatId: 'oc_project',
      source: 'agent-activity',
      teamName: 'research@chat:oc_project',
      instanceId: 'ati_chat_a',
      agentName: 'reviewer',
      runId: 'run-1',
      taskIds: [7],
      status: 'agent_activity',
      lifecycleStage: 'closed',
      now: 1000,
    });
    store.recordCardLifecycle({
      lifecycleKey: 'teaminst:ati_chat_a:reviewer:run-1',
      botName: 'pm-codex',
      chatId: 'oc_project',
      source: 'agent-activity',
      status: 'agent_activity',
      lifecycleStage: 'closed',
      responseText: 'done',
      now: 2000,
    });

    expect(store.getCardLifecycleRecord('teaminst:ati_chat_a:reviewer:run-1')).toMatchObject({
      teamName: 'research@chat:oc_project',
      instanceId: 'ati_chat_a',
      agentName: 'reviewer',
      runId: 'run-1',
      taskIds: [7],
      responsePreview: 'done',
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('tracks a UI lease while running and preserves restart checkpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-card-lifecycle-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const store = await import('../src/bridge/card-lifecycle-store.js');
    store.recordCardLifecycle({
      lifecycleKey: 'chat:oc_busy:msg_busy',
      botName: 'pm-codex',
      chatId: 'oc_busy',
      source: 'chat',
      status: 'running',
      lifecycleStage: 'executing',
      leaseTtlMs: 5_000,
      now: 10_000,
    });
    store.checkpointCardLifecycle({
      lifecycleKey: 'chat:oc_busy:msg_busy',
      note: 'saved checkpoint before restart',
      by: 'pm-codex',
      restartRequestId: 'restart-1',
      now: 12_000,
    });

    expect(store.getCardLifecycleRecord('chat:oc_busy:msg_busy')).toMatchObject({
      leaseOwner: 'pm-codex:oc_busy',
      leaseExpiresAt: 912_000,
      lifecycleStage: 'checkpointing',
      checkpointNote: 'saved checkpoint before restart',
      checkpointBy: 'pm-codex',
      checkpointAt: 12_000,
      restartRequestId: 'restart-1',
    });

    store.recordCardLifecycle({
      lifecycleKey: 'chat:oc_busy:msg_busy',
      botName: 'pm-codex',
      chatId: 'oc_busy',
      source: 'chat',
      status: 'complete',
      lifecycleStage: 'closed',
      responseText: 'done',
      now: 20_000,
    });

    expect(store.getCardLifecycleRecord('chat:oc_busy:msg_busy')).toMatchObject({
      status: 'complete',
      closedAt: 20_000,
      checkpointNote: 'saved checkpoint before restart',
    });
    expect(store.getCardLifecycleRecord('chat:oc_busy:msg_busy')?.leaseOwner).toBeUndefined();
    expect(store.getCardLifecycleRecord('chat:oc_busy:msg_busy')?.leaseExpiresAt).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it('persists final delivery markers for idempotent final cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-card-lifecycle-'));
    process.env.SESSION_STORE_DIR = dir;
    vi.resetModules();

    const store = await import('../src/bridge/card-lifecycle-store.js');
    store.recordCardLifecycle({
      lifecycleKey: 'chat:oc_done:msg_done',
      botName: 'pm-codex',
      chatId: 'oc_done',
      messageId: 'msg_done',
      source: 'final',
      status: 'complete',
      lifecycleStage: 'closed',
      responseText: 'done',
      finalDeliveryStatus: 'card',
      finalDeliveryMessageId: 'msg_done',
      now: 15_000,
    });
    store.recordCardLifecycle({
      lifecycleKey: 'chat:oc_done:msg_done',
      botName: 'pm-codex',
      chatId: 'oc_done',
      messageId: 'msg_done',
      source: 'restart-recovery',
      status: 'complete',
      lifecycleStage: 'recovering',
      responseText: 'recovering',
      now: 20_000,
    });

    expect(store.getCardLifecycleRecord('chat:oc_done:msg_done')).toMatchObject({
      finalDeliveryStatus: 'card',
      finalDeliveredAt: 15_000,
      finalDeliveryMessageId: 'msg_done',
    });

    rmSync(dir, { recursive: true, force: true });
  });
});
