import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ArcArtifactStore,
  ArcCoordinator,
  ARC_INPUT_CONTRACT_VERSION,
  ArcRunStore,
  ArcProjectScope,
  validateArcExecutionInput,
  type ArcExecutionInput,
} from '@xvirobotics/arc-mcp';
import {
  createWorkerRunnerMcpServer,
  NoopCompletionNotifier,
  WorkerService,
  WorkerStore,
  type ProcessLaunchHooks,
  type ProcessLaunchSpec,
  type ProcessResult,
  type ProcessRunner,
  type RunningProcess,
} from '@xvirobotics/worker-runner-mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArcWorkerRunnerAdapter } from '../src/adapter.js';
import { WorkerMcpWireClient } from '../src/wire.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('ARC to real Worker Runner MCP wire', () => {
  it('recovers the queued crash window without a duplicate launch and collects the output', async () => {
    const kit = await makeKit();
    const input = executionInput(kit.projectRoot, 'run-recover');
    kit.arcStore.createRun({
      runId: input.run_id,
      projectId: input.project_id,
      projectRoot: input.project_root,
      objective: input.objective,
      idempotencyKey: 'recover-key',
      requestFingerprint: 'recover-fingerprint',
      artifactPath: input.artifact_path,
      executionInput: input,
      now: input.requested_at,
    });
    const firstHandle = await kit.adapter.start(input);
    await vi.waitFor(() => expect(kit.workerStore.require(firstHandle.id).status).toBe('running'));

    const [recovered] = await kit.coordinator.recover();
    expect(recovered).toMatchObject({
      status: 'running',
      phase: 'recovered_executing',
      runner_handle: { id: firstHandle.id },
    });
    expect(kit.processRunner.launches).toHaveLength(1);

    writeOutput(input);
    kit.processRunner.complete(4_000, success());
    await expect(kit.coordinator.waitForTerminal(input.run_id)).resolves.toMatchObject({ status: 'completed' });

    const retried = await kit.adapter.start(input);
    expect(retried.id).toBe(firstHandle.id);
    expect(kit.processRunner.launches).toHaveLength(1);
  });

  it('surfaces honest pause semantics and converges cancel through worker_abort', async () => {
    const kit = await makeKit();
    const run = await kit.coordinator.start({
      project_id: 'project-1',
      project_root: kit.projectRoot,
      objective: 'Exercise pause and cancel mapping.',
      idempotency_key: 'controls',
      run_id: 'run-controls',
    });
    await vi.waitFor(() => expect(kit.workerStore.require(run.runner_handle!.id).status).toBe('running'));

    await expect(kit.coordinator.pause({ run_id: run.run_id })).rejects.toMatchObject({ code: 'runner_failure' });
    expect(kit.arcStore.requireRun(run.run_id).status).toBe('running');
    await expect(kit.coordinator.cancel({ run_id: run.run_id })).resolves.toMatchObject({ status: 'cancelled' });
    expect(kit.processRunner.aborts).toEqual([4_000]);
  });
});

async function makeKit() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'arc-worker-adapter-'));
  const projectRoot = path.join(temporary, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const workerStore = new WorkerStore(path.join(temporary, 'worker-state', 'workers.sqlite'));
  const processRunner = new FakeProcessRunner();
  const principal = { role: 'pm' as const, botName: 'arc-service', chatId: 'arc:test-host' };
  const workerService = new WorkerService(workerStore, processRunner, new NoopCompletionNotifier(), principal, {
    maxConcurrentPerScope: 2,
    defaultTimeoutMs: 5_000,
    defaultIdleTimeoutMs: 5_000,
    maxTimeoutMs: 10_000,
    maxIdleTimeoutMs: 10_000,
    defaultDedupeTtlMs: 1_000,
    maxDedupeTtlMs: 10_000,
    maxListLimit: 20,
    notificationRetryInitialMs: 10,
    notificationRetryMaxMs: 100,
  });
  const workerServer = createWorkerRunnerMcpServer(workerService, principal);
  const client = new Client({ name: 'arc-adapter-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await workerService.start();
  await workerServer.connect(serverTransport);
  await client.connect(clientTransport);
  const adapter = new ArcWorkerRunnerAdapter({
    client: new WorkerMcpWireClient(client),
    engine: 'codex',
    timeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    pollIntervalMs: 10,
  });
  const artifacts = new ArcArtifactStore();
  const arcStore = new ArcRunStore(path.join(temporary, 'arc-state'));
  const scope = new ArcProjectScope(artifacts, { allowedProjectRoots: [projectRoot], fixedProjectId: 'project-1' });
  const coordinator = new ArcCoordinator(arcStore, artifacts, adapter, {
    scope,
    artifactPollIntervalMs: 5,
    artifactWaitTimeoutMs: 100,
  });
  cleanups.push(async () => {
    coordinator.dispose();
    await client.close();
    await workerServer.close();
    workerService.dispose();
    arcStore.close();
    workerStore.close();
    rmSync(temporary, { recursive: true, force: true });
  });
  return { temporary, projectRoot, workerStore, processRunner, workerService, adapter, arcStore, coordinator };
}

class FakeProcessRunner implements ProcessRunner {
  readonly launches: ProcessLaunchSpec[] = [];
  readonly aborts: number[] = [];
  private readonly completions = new Map<number, (result: ProcessResult) => void>();
  private nextPid = 4_000;

  async launch(spec: ProcessLaunchSpec, _hooks: ProcessLaunchHooks): Promise<RunningProcess> {
    this.launches.push(spec);
    const pid = this.nextPid++;
    let resolve!: (result: ProcessResult) => void;
    const completion = new Promise<ProcessResult>((done) => {
      resolve = done;
    });
    this.completions.set(pid, resolve);
    return { pid, completion };
  }

  async abort(pid: number): Promise<void> {
    this.aborts.push(pid);
  }

  complete(pid: number, result: ProcessResult): void {
    this.completions.get(pid)?.(result);
    this.completions.delete(pid);
  }
}

function executionInput(projectRoot: string, runId: string): ArcExecutionInput {
  return validateArcExecutionInput({
    contract_version: ARC_INPUT_CONTRACT_VERSION,
    project_id: 'project-1',
    run_id: runId,
    objective: 'Recover through the real Worker Runner MCP wire.',
    project_root: projectRoot,
    artifact_path: `.metabot-arc/runs/${runId}/output.json`,
    requested_at: '2026-08-06T00:00:00.000Z',
  });
}

function writeOutput(input: ArcExecutionInput): void {
  const target = path.join(input.project_root, input.artifact_path);
  const temporary = `${target}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    temporary,
    JSON.stringify({
      contract_version: 'autoresearchclaw.output.v2',
      project_id: input.project_id,
      run_id: input.run_id,
      status: 'completed',
      summary: 'Completed through the Worker Runner adapter.',
      hypotheses: [],
      experiments: [],
      findings: [],
      negative_results: [],
      decisions: [],
      artifacts: [],
      open_questions: [],
      recommended_followups: [],
      tool_trace: [],
    }),
  );
  renameSync(temporary, target);
}

function success(): ProcessResult {
  return { exitCode: 0, stdout: 'done', stderr: '', stdoutTruncated: false, stderrTruncated: false };
}
