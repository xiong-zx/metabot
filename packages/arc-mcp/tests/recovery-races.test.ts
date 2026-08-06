import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import { ArcCoordinator } from '../src/coordinator.js';
import {
  ARC_INPUT_CONTRACT_VERSION,
  type ArcExecutionInput,
  type ArcRunRecord,
  validateArcExecutionInput,
} from '../src/contract.js';
import { ArcRunStore } from '../src/run-store.js';
import { ArcProjectScope } from '../src/scope-policy.js';
import { FakeArcRunner } from './fake-runner.js';
import { projectDirectory, removeDirectory, temporaryDirectory, validOutput } from './helpers.js';

const cleanupDirectories: string[] = [];
const cleanupStores: ArcRunStore[] = [];
const cleanupCoordinators: ArcCoordinator[] = [];

afterEach(() => {
  for (const coordinator of cleanupCoordinators.splice(0)) coordinator.dispose();
  for (const store of cleanupStores.splice(0)) store.close();
  for (const directory of cleanupDirectories.splice(0)) removeDirectory(directory);
});

function scope(artifacts: ArcArtifactStore, projectRoot: string): ArcProjectScope {
  return new ArcProjectScope(artifacts, {
    allowedProjectRoots: [projectRoot],
    fixedProjectId: 'project-1',
  });
}

function handleId(run: ArcRunRecord): string {
  expect(run.runner_handle).not.toBeNull();
  return run.runner_handle!.id;
}

function queuedInput(projectRoot: string, runId: string): ArcExecutionInput {
  return validateArcExecutionInput({
    contract_version: ARC_INPUT_CONTRACT_VERSION,
    project_id: 'project-1',
    run_id: runId,
    objective: 'Recover the queued crash window.',
    project_root: projectRoot,
    artifact_path: `.metabot-arc/runs/${runId}/output.json`,
    requested_at: new Date().toISOString(),
  });
}

describe('ARC recovery and terminal races', () => {
  it('retries a queued crash window with idempotent runner.start and persists the same handle', async () => {
    const temporary = temporaryDirectory();
    cleanupDirectories.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const dataDir = path.join(temporary, 'state');
    const runner = new FakeArcRunner();
    const input = queuedInput(projectRoot, 'run-queued-crash');
    const beforeCrash = new ArcRunStore(dataDir);
    beforeCrash.createRun({
      runId: input.run_id,
      projectId: input.project_id,
      projectRoot,
      objective: input.objective,
      idempotencyKey: 'request-queued-crash',
      requestFingerprint: 'fingerprint-queued-crash',
      artifactPath: input.artifact_path,
      executionInput: input,
      now: input.requested_at,
    });
    const firstHandle = await runner.start(input);
    beforeCrash.close();

    const recoveredStore = new ArcRunStore(dataDir);
    cleanupStores.push(recoveredStore);
    const artifacts = new ArcArtifactStore();
    const coordinator = new ArcCoordinator(recoveredStore, artifacts, runner, {
      artifactPollIntervalMs: 5,
      artifactWaitTimeoutMs: 100,
      scope: scope(artifacts, projectRoot),
    });
    cleanupCoordinators.push(coordinator);
    const [recovered] = await coordinator.recover();
    expect(recovered).toMatchObject({
      status: 'running',
      phase: 'recovered_executing',
      runner_handle: firstHandle,
      recovery_generation: 1,
    });
    expect(runner.startCalls).toHaveLength(2);

    runner.finish(firstHandle.id, validOutput('project-1', input.run_id));
    await expect(coordinator.waitForTerminal(input.run_id)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('records a recovery failure for a legacy queued row without durable input', async () => {
    const temporary = temporaryDirectory();
    cleanupDirectories.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const dataDir = path.join(temporary, 'state');
    const input = queuedInput(projectRoot, 'run-missing-input');
    const beforeCrash = new ArcRunStore(dataDir);
    beforeCrash.createRun({
      runId: input.run_id,
      projectId: input.project_id,
      projectRoot,
      objective: input.objective,
      idempotencyKey: 'request-missing-input',
      requestFingerprint: 'fingerprint-missing-input',
      artifactPath: input.artifact_path,
      executionInput: input,
      now: input.requested_at,
    });
    const raw = new Database(beforeCrash.databasePath);
    raw.prepare('UPDATE arc_runs SET execution_input_json = NULL WHERE run_id = ?').run(input.run_id);
    raw.close();
    beforeCrash.close();

    const recoveredStore = new ArcRunStore(dataDir);
    cleanupStores.push(recoveredStore);
    const artifacts = new ArcArtifactStore();
    const runner = new FakeArcRunner();
    const coordinator = new ArcCoordinator(recoveredStore, artifacts, runner, {
      scope: scope(artifacts, projectRoot),
    });
    cleanupCoordinators.push(coordinator);
    const [recovered] = await coordinator.recover();
    expect(recovered).toMatchObject({
      status: 'queued',
      phase: 'recovery_failed',
      error: { code: 'runner_failure' },
    });
    expect(runner.startCalls).toHaveLength(0);
  });

  it('probes and reattaches a running handle without pausing or relaunching it', async () => {
    const temporary = temporaryDirectory();
    cleanupDirectories.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const dataDir = path.join(temporary, 'state');
    const artifacts = new ArcArtifactStore();
    const runner = new FakeArcRunner();
    const beforeCrashStore = new ArcRunStore(dataDir);
    const beforeCrash = new ArcCoordinator(beforeCrashStore, artifacts, runner, {
      scope: scope(artifacts, projectRoot),
    });
    const run = await beforeCrash.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Reattach to a live durable runner handle.',
      idempotency_key: 'running-recovery',
      run_id: 'run-running-recovery',
    });
    beforeCrash.dispose();
    beforeCrashStore.close();

    const recoveredStore = new ArcRunStore(dataDir);
    cleanupStores.push(recoveredStore);
    const coordinator = new ArcCoordinator(recoveredStore, artifacts, runner, {
      artifactPollIntervalMs: 5,
      artifactWaitTimeoutMs: 100,
      scope: scope(artifacts, projectRoot),
    });
    cleanupCoordinators.push(coordinator);
    const [recovered] = await coordinator.recover();
    expect(recovered).toMatchObject({
      status: 'running',
      phase: 'recovered_executing',
      runner_handle: run.runner_handle,
      recovery_generation: 1,
    });
    expect(runner.recoverCalls).toEqual([run.runner_handle]);
    expect(runner.pauseCalls).toHaveLength(0);
    expect(runner.startCalls).toHaveLength(1);

    runner.finish(handleId(run), validOutput('project-1', run.run_id));
    await expect(coordinator.waitForTerminal(run.run_id)).resolves.toMatchObject({ status: 'completed' });
  });

  it('converges pause and cancel races to a finished artifact without duplicate collect', async () => {
    const temporary = temporaryDirectory();
    cleanupDirectories.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const store = new ArcRunStore(path.join(temporary, 'state'));
    cleanupStores.push(store);
    const artifacts = new ArcArtifactStore();
    const runner = new FakeArcRunner();
    const coordinator = new ArcCoordinator(store, artifacts, runner, {
      artifactPollIntervalMs: 5,
      artifactWaitTimeoutMs: 100,
      scope: scope(artifacts, projectRoot),
    });
    cleanupCoordinators.push(coordinator);

    const pauseRace = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Finish while pause is requested.',
      idempotency_key: 'pause-race',
      run_id: 'run-pause-race',
    });
    runner.finish(handleId(pauseRace), validOutput('project-1', pauseRace.run_id));
    await expect(coordinator.pause({ run_id: pauseRace.run_id })).resolves.toMatchObject({
      status: 'completed',
    });

    const cancelRace = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Finish while cancel is requested.',
      idempotency_key: 'cancel-race',
      run_id: 'run-cancel-race',
    });
    runner.finish(handleId(cancelRace), validOutput('project-1', cancelRace.run_id));
    await expect(coordinator.cancel({ run_id: cancelRace.run_id })).resolves.toMatchObject({
      status: 'completed',
    });

    expect(runner.collectCalls.filter((call) => call.id === handleId(pauseRace))).toHaveLength(1);
    expect(runner.collectCalls.filter((call) => call.id === handleId(cancelRace))).toHaveLength(1);
  });

  it('keeps one collect active across pause and resume', async () => {
    const temporary = temporaryDirectory();
    cleanupDirectories.push(temporary);
    const projectRoot = projectDirectory(temporary);
    const store = new ArcRunStore(path.join(temporary, 'state'));
    cleanupStores.push(store);
    const artifacts = new ArcArtifactStore();
    const runner = new FakeArcRunner();
    const coordinator = new ArcCoordinator(store, artifacts, runner, {
      artifactPollIntervalMs: 5,
      artifactWaitTimeoutMs: 100,
      scope: scope(artifacts, projectRoot),
    });
    cleanupCoordinators.push(coordinator);

    const run = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Keep a single collection waiter.',
      idempotency_key: 'single-collect',
      run_id: 'run-single-collect',
    });
    await coordinator.pause({ run_id: run.run_id });
    await coordinator.resume({ run_id: run.run_id });
    runner.finish(handleId(run), validOutput('project-1', run.run_id));
    await coordinator.waitForTerminal(run.run_id);
    expect(runner.collectCalls.filter((call) => call.id === handleId(run))).toHaveLength(1);
  });
});
