import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerManagerAutoResearchClawAdapter, type WorkerManagerLike } from '../src/memory-core/index.js';
import type { DispatchInput } from '../src/workers/worker-manager.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-worker-manager-arc-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeWorkerManager(status: 'running' | 'completed' | 'failed' | 'aborted' = 'completed') {
  const dispatches: DispatchInput[] = [];
  const manager: WorkerManagerLike = {
    dispatch(input) {
      dispatches.push(input);
      return {
        id: 'worker-alpha',
        workerChatId: 'worker-worker-alpha',
        workingDirectory: input.workingDirectory,
        status: 'running',
      };
    },
    getWorker(id) {
      return {
        id,
        workerChatId: 'worker-worker-alpha',
        workingDirectory: dir,
        status,
        error: status === 'failed' ? 'worker failed' : undefined,
      };
    },
  };
  return { manager, dispatches };
}

describe('WorkerManagerAutoResearchClawAdapter', () => {
  it('dispatches a WorkerManager task with the required artifact instruction', async () => {
    const { manager, dispatches } = fakeWorkerManager();
    const adapter = new WorkerManagerAutoResearchClawAdapter({
      workerManager: manager,
      botName: 'admin',
      pmChatId: 'oc_test',
      model: 'gpt-5.4',
      pollIntervalMs: 1,
    });

    const handle = await adapter.dispatch({
      projectId: 'proj-alpha',
      runId: 'run-alpha',
      projectRoot: dir,
      task: 'Run research',
      prompt: 'Research prompt',
      contextPack: {} as any,
    });

    const artifactPath = path.join(dir, '.metabot-memory', 'autoresearchclaw', 'run-alpha-output.json');
    expect(handle).toMatchObject({
      workerId: 'worker-alpha',
      workerChatId: 'worker-worker-alpha',
      artifactUri: `file://${artifactPath}`,
    });
    expect(dispatches[0]).toMatchObject({
      botName: 'admin',
      pmChatId: 'oc_test',
      workingDirectory: dir,
      label: 'autoresearchclaw-proj-alpha-run-alpha',
      model: 'gpt-5.4',
    });
    expect(dispatches[0]!.prompt).toContain('Research prompt');
    expect(dispatches[0]!.prompt).toContain('Write the final AutoResearchClaw JSON object');
    expect(dispatches[0]!.prompt).toContain('Do not dispatch nested workers');
    expect(dispatches[0]!.prompt).toContain(path.join('.metabot-memory', 'autoresearchclaw', 'run-alpha-output.json'));
    expect(fs.existsSync(path.dirname(artifactPath))).toBe(true);
  });

  it('collects the JSON artifact after the worker completes', async () => {
    const { manager } = fakeWorkerManager('completed');
    fs.writeFileSync(path.join(dir, 'autoresearchclaw-output.json'), JSON.stringify({ ok: true }));
    const adapter = new WorkerManagerAutoResearchClawAdapter({
      workerManager: manager,
      botName: 'admin',
      pmChatId: 'oc_test',
      pollIntervalMs: 1,
    });

    const output = await adapter.collectOutput({
      workerId: 'worker-alpha',
      workerChatId: 'worker-worker-alpha',
      artifactUri: `file://${path.join(dir, 'autoresearchclaw-output.json')}`,
    });

    expect(output).toEqual({ ok: true });
  });

  it('collects a valid artifact without waiting for a still-running worker to exit', async () => {
    const { manager } = fakeWorkerManager('running');
    fs.writeFileSync(path.join(dir, 'autoresearchclaw-output.json'), JSON.stringify({ ok: true }));
    const adapter = new WorkerManagerAutoResearchClawAdapter({
      workerManager: manager,
      botName: 'admin',
      pmChatId: 'oc_test',
      pollIntervalMs: 1,
      collectTimeoutMs: 100,
    });

    const output = await adapter.collectOutput({
      workerId: 'worker-alpha',
      workerChatId: 'worker-worker-alpha',
      artifactUri: `file://${path.join(dir, 'autoresearchclaw-output.json')}`,
    });

    expect(output).toEqual({ ok: true });
  });

  it('fails collection when the worker fails or the artifact is missing', async () => {
    const failedAdapter = new WorkerManagerAutoResearchClawAdapter({
      workerManager: fakeWorkerManager('failed').manager,
      botName: 'admin',
      pmChatId: 'oc_test',
      pollIntervalMs: 1,
      artifactGraceMs: 1,
    });
    await expect(
      failedAdapter.collectOutput({ workerId: 'worker-alpha', artifactUri: `file://${path.join(dir, 'x.json')}` }),
    ).rejects.toThrow(/worker-alpha failed/);

    const completedAdapter = new WorkerManagerAutoResearchClawAdapter({
      workerManager: fakeWorkerManager('completed').manager,
      botName: 'admin',
      pmChatId: 'oc_test',
      pollIntervalMs: 1,
      artifactGraceMs: 1,
    });
    await expect(
      completedAdapter.collectOutput({
        workerId: 'worker-alpha',
        artifactUri: `file://${path.join(dir, 'missing.json')}`,
      }),
    ).rejects.toThrow(/artifact not found/);
  });

  it('waits briefly for a completed worker artifact to appear', async () => {
    const { manager } = fakeWorkerManager('completed');
    const artifactPath = path.join(dir, 'delayed-output.json');
    const adapter = new WorkerManagerAutoResearchClawAdapter({
      workerManager: manager,
      botName: 'admin',
      pmChatId: 'oc_test',
      pollIntervalMs: 1,
      artifactGraceMs: 100,
    });

    setTimeout(() => {
      fs.writeFileSync(artifactPath, JSON.stringify({ ok: true }));
    }, 5);

    await expect(
      adapter.collectOutput({
        workerId: 'worker-alpha',
        workerChatId: 'worker-worker-alpha',
        artifactUri: `file://${artifactPath}`,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects artifact paths that escape the project root', async () => {
    expect(
      () =>
        new WorkerManagerAutoResearchClawAdapter({
          workerManager: fakeWorkerManager('completed').manager,
          botName: 'admin',
          pmChatId: 'oc_test',
          outputFileName: '../outside.json',
        }),
    ).toThrow(/outputFileName/);

    const completedAdapter = new WorkerManagerAutoResearchClawAdapter({
      workerManager: fakeWorkerManager('completed').manager,
      botName: 'admin',
      pmChatId: 'oc_test',
      pollIntervalMs: 1,
    });
    await expect(
      completedAdapter.collectOutput({
        workerId: 'worker-alpha',
        artifactUri: `file://${path.join(path.dirname(dir), 'outside.json')}`,
      }),
    ).rejects.toThrow(/escapes project root/);
  });

  it('times out while the worker is still running', async () => {
    vi.useFakeTimers();
    const adapter = new WorkerManagerAutoResearchClawAdapter({
      workerManager: fakeWorkerManager('running').manager,
      botName: 'admin',
      pmChatId: 'oc_test',
      pollIntervalMs: 10,
      collectTimeoutMs: 15,
    });
    const promise = adapter.collectOutput({ workerId: 'worker-alpha' });
    const assertion = expect(promise).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    vi.useRealTimers();
  });
});
