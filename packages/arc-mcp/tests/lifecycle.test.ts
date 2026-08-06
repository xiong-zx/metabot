import { afterEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import { ArcCoordinator } from '../src/coordinator.js';
import type { ArcRunRecord } from '../src/contract.js';
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

function setup(options: { artifactWaitTimeoutMs?: number } = {}): {
  coordinator: ArcCoordinator;
  projectRoot: string;
  runner: FakeArcRunner;
  store: ArcRunStore;
  temporary: string;
} {
  const temporary = temporaryDirectory();
  cleanupDirectories.push(temporary);
  const projectRoot = projectDirectory(temporary);
  const store = new ArcRunStore(`${temporary}/state`);
  const runner = new FakeArcRunner();
  const artifacts = new ArcArtifactStore();
  const coordinator = new ArcCoordinator(store, artifacts, runner, {
    artifactPollIntervalMs: 5,
    artifactWaitTimeoutMs: options.artifactWaitTimeoutMs ?? 100,
    scope: new ArcProjectScope(artifacts, {
      allowedProjectRoots: [projectRoot],
      fixedProjectId: 'project-1',
    }),
  });
  cleanupStores.push(store);
  cleanupCoordinators.push(coordinator);
  return { coordinator, projectRoot, runner, store, temporary };
}

function handleId(run: ArcRunRecord): string {
  expect(run.runner_handle).not.toBeNull();
  return run.runner_handle!.id;
}

describe('ArcCoordinator lifecycle', () => {
  it('starts idempotently and rejects reuse of a key for different input', async () => {
    const { coordinator, projectRoot, runner } = setup();
    const request = {
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Evaluate the deterministic fixture.',
      idempotency_key: 'request-1',
      run_id: 'run-1',
    };
    const [first, repeated] = await Promise.all([coordinator.start(request), coordinator.start(request)]);
    expect(repeated.run_id).toBe(first.run_id);
    expect(runner.startCalls).toHaveLength(1);

    await expect(coordinator.start({ ...request, objective: 'A different objective.' })).rejects.toMatchObject({
      code: 'run_conflict',
    });

    runner.finish(handleId(first), validOutput('project-1', 'run-1'));
    await expect(coordinator.waitForTerminal('run-1')).resolves.toMatchObject({
      status: 'completed',
      output_status: 'completed',
      error: null,
    });
  });

  it('persists pause and resumes the durable runner handle after coordinator restart', async () => {
    const { coordinator, projectRoot, runner, store, temporary } = setup();
    const started = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Pause and recover the run.',
      idempotency_key: 'request-pause',
      run_id: 'run-pause',
    });
    const paused = await coordinator.pause({ run_id: started.run_id });
    expect(paused.status).toBe('paused');

    coordinator.dispose();
    cleanupCoordinators.splice(cleanupCoordinators.indexOf(coordinator), 1);
    store.close();
    cleanupStores.splice(cleanupStores.indexOf(store), 1);

    const recoveredStore = new ArcRunStore(`${temporary}/state`);
    const artifacts = new ArcArtifactStore();
    const recovered = new ArcCoordinator(recoveredStore, artifacts, runner, {
      artifactPollIntervalMs: 5,
      artifactWaitTimeoutMs: 100,
      scope: new ArcProjectScope(artifacts, {
        allowedProjectRoots: [projectRoot],
        fixedProjectId: 'project-1',
      }),
    });
    cleanupStores.push(recoveredStore);
    cleanupCoordinators.push(recovered);
    await recovered.recover();

    const resumed = await recovered.resume({ run_id: started.run_id });
    expect(resumed).toMatchObject({ status: 'running', recovery_generation: 1 });
    runner.finish(handleId(started), validOutput('project-1', started.run_id));
    await expect(recovered.waitForTerminal(started.run_id)).resolves.toMatchObject({
      status: 'completed',
      recovery_generation: 1,
    });
  });

  it('reattaches an interrupted running record without changing its execution state', async () => {
    const { coordinator, projectRoot, runner, store, temporary } = setup();
    const started = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Recover an interrupted run.',
      idempotency_key: 'request-interrupted',
      run_id: 'run-interrupted',
    });

    coordinator.dispose();
    cleanupCoordinators.splice(cleanupCoordinators.indexOf(coordinator), 1);
    store.close();
    cleanupStores.splice(cleanupStores.indexOf(store), 1);

    const recoveredStore = new ArcRunStore(`${temporary}/state`);
    const artifacts = new ArcArtifactStore();
    const recovered = new ArcCoordinator(recoveredStore, artifacts, runner, {
      artifactPollIntervalMs: 5,
      artifactWaitTimeoutMs: 100,
      scope: new ArcProjectScope(artifacts, {
        allowedProjectRoots: [projectRoot],
        fixedProjectId: 'project-1',
      }),
    });
    cleanupStores.push(recoveredStore);
    cleanupCoordinators.push(recovered);
    await recovered.recover();
    expect(recovered.get({ run_id: started.run_id })).toMatchObject({
      status: 'running',
      phase: 'recovered_executing',
    });
    expect(runner.recoverCalls).toContainEqual(started.runner_handle);
    expect(runner.pauseCalls).not.toContainEqual(started.runner_handle);

    runner.finish(handleId(started), validOutput('project-1', started.run_id));
    await expect(recovered.waitForTerminal(started.run_id)).resolves.toMatchObject({
      status: 'completed',
      recovery_generation: 1,
    });
  });

  it('cancels idempotently and returns the actual state after another terminal result', async () => {
    const { coordinator, projectRoot, runner } = setup();
    const cancelledRun = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Cancel this run.',
      idempotency_key: 'request-cancel',
      run_id: 'run-cancel',
    });
    const cancelled = await coordinator.cancel({ run_id: cancelledRun.run_id });
    expect(cancelled.status).toBe('cancelled');
    await expect(coordinator.cancel({ run_id: cancelledRun.run_id })).resolves.toMatchObject({
      status: 'cancelled',
    });

    const completedRun = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Complete this run.',
      idempotency_key: 'request-complete',
      run_id: 'run-complete',
    });
    runner.finish(handleId(completedRun), validOutput('project-1', completedRun.run_id));
    await coordinator.waitForTerminal(completedRun.run_id);
    await expect(coordinator.cancel({ run_id: completedRun.run_id })).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('fails missing and malformed artifacts without promoting a successful status', async () => {
    const { coordinator, projectRoot, runner } = setup({ artifactWaitTimeoutMs: 30 });
    const malformed = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Produce malformed evidence.',
      idempotency_key: 'request-malformed',
      run_id: 'run-malformed',
    });
    runner.finish(handleId(malformed), { status: 'completed' });
    await expect(coordinator.waitForTerminal(malformed.run_id)).resolves.toMatchObject({
      status: 'failed',
      output_status: null,
      error: { code: 'invalid_contract' },
    });

    const missing = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Omit the output artifact.',
      idempotency_key: 'request-missing',
      run_id: 'run-missing',
    });
    runner.finishWithoutArtifact(handleId(missing));
    await expect(coordinator.waitForTerminal(missing.run_id)).resolves.toMatchObject({
      status: 'failed',
      output_status: null,
      error: { code: 'artifact_missing' },
    });

    const structuredFailure = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Return valid negative evidence.',
      idempotency_key: 'request-failed-output',
      run_id: 'run-failed-output',
    });
    runner.finish(
      handleId(structuredFailure),
      validOutput('project-1', structuredFailure.run_id, { status: 'failed' }),
    );
    await expect(coordinator.waitForTerminal(structuredFailure.run_id)).resolves.toMatchObject({
      status: 'failed',
      output_status: 'failed',
      error: null,
    });
  });

  it('keeps concurrent runs independent and denies a cross-project start', async () => {
    const { coordinator, projectRoot, runner, temporary } = setup();
    const secondProject = projectDirectory(temporary, 'project-2');
    const first = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'First concurrent run.',
      idempotency_key: 'request-a',
      run_id: 'run-a',
    });
    const second = await coordinator.start({
      project_id: 'project-1',
      project_root: projectRoot,
      objective: 'Second concurrent run.',
      idempotency_key: 'request-b',
      run_id: 'run-b',
    });

    await expect(
      coordinator.start({
        project_id: 'project-2',
        project_root: secondProject,
        objective: 'Colliding run id.',
        idempotency_key: 'request-c',
        run_id: 'run-a',
      }),
    ).rejects.toMatchObject({ code: 'scope_denied' });

    runner.finish(handleId(second), validOutput('project-1', second.run_id, { status: 'partial' }));
    runner.finish(handleId(first), validOutput('project-1', first.run_id));
    await expect(coordinator.waitForTerminal(first.run_id)).resolves.toMatchObject({
      status: 'completed',
      artifact_path: '.metabot-arc/runs/run-a/output.json',
    });
    await expect(coordinator.waitForTerminal(second.run_id)).resolves.toMatchObject({
      status: 'partial',
      phase: 'partial',
      artifact_path: '.metabot-arc/runs/run-b/output.json',
    });
  });
});
