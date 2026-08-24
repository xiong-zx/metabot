import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import { ArcCoordinator } from '../src/coordinator.js';
import {
  ArcTerminalNotifierService,
  type ArcTerminalCallbackEnvelope,
  type ArcTerminalNotifier,
  signArcTerminalCallback,
  verifyArcTerminalCallback,
} from '../src/notifier.js';
import { ArcRunStore } from '../src/run-store.js';
import { ArcProjectScope } from '../src/scope-policy.js';
import { FakeArcRunner } from './fake-runner.js';
import { projectDirectory, removeDirectory, temporaryDirectory, validOutput } from './helpers.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('ARC durable terminal callback', () => {
  it('emits one origin-scoped stable envelope outside coordinator logic', async () => {
    const kit = makeKit();
    const run = await kit.coordinator.start(
      {
        project_id: 'project-1',
        project_root: kit.projectRoot,
        objective: 'Produce a terminal callback.',
        idempotency_key: 'callback-1',
        run_id: 'run-callback-1',
      },
      { bot_name: 'research-pm', chat_id: 'chat-a' },
      'signed-arc-capability',
    );
    kit.runner.finish(run.runner_handle!.id, validOutput('project-1', run.run_id));
    await kit.coordinator.waitForTerminal(run.run_id);
    expect(kit.store.getNotificationState(run.run_id)).toMatchObject({ state: 'waiting', attempts: 0 });

    await kit.service.tick();
    await kit.service.tick();
    expect(kit.notifier.envelopes).toHaveLength(1);
    expect(kit.notifier.envelopes[0]).toMatchObject({
      contract_version: 'metabot.terminal-callback.v1',
      purpose: 'arc.terminal',
      event_id: 'arc:run-callback-1:terminal:v1',
      bot_name: 'research-pm',
      chat_id: 'chat-a',
      status: 'completed',
      authorizing_capability: 'signed-arc-capability',
    });
    expect(kit.notifier.envelopes[0]?.finished_at).toEqual(expect.any(Number));
    expect(kit.store.getNotificationState(run.run_id)).toMatchObject({ state: 'delivered', attempts: 1 });
  });

  it('retries after notifier recreation with the same event id', async () => {
    let now = 1_000;
    const kit = makeKit(() => now);
    const run = await kit.coordinator.start(
      {
        project_id: 'project-1',
        project_root: kit.projectRoot,
        objective: 'Retry a failed callback.',
        idempotency_key: 'callback-retry',
        run_id: 'run-callback-retry',
      },
      { bot_name: 'research-pm', chat_id: 'chat-a' },
      'signed-arc-capability',
    );
    kit.runner.finish(run.runner_handle!.id, validOutput('project-1', run.run_id));
    await kit.coordinator.waitForTerminal(run.run_id);
    kit.notifier.error = new Error('receiver unavailable');
    await kit.service.tick();
    expect(kit.store.getNotificationState(run.run_id)).toMatchObject({ state: 'failed', attempts: 1 });

    now += 10;
    const resumedNotifier = new RecordingNotifier();
    const resumed = new ArcTerminalNotifierService(kit.store, resumedNotifier, {
      pollIntervalMs: 10,
      retryInitialMs: 10,
      retryMaxMs: 10,
      now: () => now,
    });
    cleanups.push(() => resumed.dispose());
    await resumed.tick();
    expect(resumedNotifier.envelopes.map((item) => item.event_id)).toEqual([
      'arc:run-callback-retry:terminal:v1',
    ]);
    expect(kit.store.getNotificationState(run.run_id).state).toBe('delivered');
  });

  it('detects bad signatures for the stable callback body', () => {
    const keys = generateKeyPairSync('ed25519');
    const body = JSON.stringify({ event_id: 'arc:run-1:terminal:v1' });
    const signature = signArcTerminalCallback(body, keys.privateKey);
    expect(signature).toMatch(/^ed25519:/);
    expect(verifyArcTerminalCallback(body, signature, keys.publicKey)).toBe(true);
    expect(verifyArcTerminalCallback(`${body} `, signature, keys.publicKey)).toBe(false);
    const rotated = generateKeyPairSync('ed25519');
    expect(verifyArcTerminalCallback(body, signature, rotated.publicKey)).toBe(false);
    expect(verifyArcTerminalCallback(body, signature, [rotated.publicKey, keys.publicKey])).toBe(true);
  });
});

class RecordingNotifier implements ArcTerminalNotifier {
  readonly envelopes: ArcTerminalCallbackEnvelope[] = [];
  error?: Error;

  async notify(envelope: ArcTerminalCallbackEnvelope): Promise<void> {
    this.envelopes.push(envelope);
    if (this.error) throw this.error;
  }
}

function makeKit(now: () => number = () => Date.now()) {
  const temporary = temporaryDirectory('arc-notifier-');
  const projectRoot = projectDirectory(temporary);
  const artifacts = new ArcArtifactStore();
  const store = new ArcRunStore(path.join(temporary, 'state'));
  const runner = new FakeArcRunner();
  const scope = new ArcProjectScope(artifacts, { allowedProjectRoots: [projectRoot], fixedProjectId: 'project-1' });
  const coordinator = new ArcCoordinator(store, artifacts, runner, { scope });
  const notifier = new RecordingNotifier();
  const service = new ArcTerminalNotifierService(store, notifier, {
    pollIntervalMs: 10,
    retryInitialMs: 10,
    retryMaxMs: 10,
    now,
  });
  cleanups.push(() => {
    service.dispose();
    coordinator.dispose();
    store.close();
    removeDirectory(temporary);
  });
  return { temporary, projectRoot, store, runner, coordinator, notifier, service };
}
