import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import { ArcCoordinator } from '../src/coordinator.js';
import { ARC_INPUT_CONTRACT_VERSION, validateArcOutput, type ArcExecutionHandle, type ArcExecutionInput } from '../src/contract.js';
import { ArcError } from '../src/errors.js';
import { OfficialArcDriver, type ResolvedOfficialRelease } from '../src/official-driver.js';
import { ArcRunStore } from '../src/run-store.js';
import { ArcProjectScope } from '../src/scope-policy.js';
import { createArcRuntime } from '../src/runtime.js';
import {
  officialGateRequestId,
  officialHitlResponse,
  publishOfficialGate,
  readOfficialWaitingState,
} from '../src/official-hitl-bridge.js';
import { atomicWriteJson } from '../src/official-paths.js';
import { readRunnerState, readSupervisorRequest, processAlive, delay } from '../src/official-state.js';
import {
  OfficialArcProcessSupervisor,
  parseParameters,
  type OfficialSupervisorCommand,
} from '../src/official-supervisor.js';
import type { ExternalReleaseManifest } from '../src/releases/manifest.js';
import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';

const require = createRequire(import.meta.url);
const supervisorSource = fileURLToPath(new URL('../src/official-supervisor-cli.ts', import.meta.url));

/**
 * Run the real detached entry point from TypeScript source. Nothing here is
 * mocked: a genuine detached Node process owns a genuine child process group.
 */
const SUPERVISOR_COMMAND: OfficialSupervisorCommand = {
  command: process.execPath,
  args: ['--import', pathToFileURL(require.resolve('tsx')).href, supervisorSource],
};

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const OFFICIAL_REVISION = 'e2e23c93b4943fd21cc531deb09850d8fda55357';

function releaseFixture(root: string): ResolvedOfficialRelease {
  const manifest = {
    schema_version: 'metabot.autoresearchclaw.release.v1',
    release_id: '0.5.0-e2e23c93b494',
    product: 'AutoResearchClaw',
    state: 'candidate',
    origin: 'https://github.com/aiming-lab/AutoResearchClaw',
    base_tag: 'v0.5.0',
    base_tag_commit: OFFICIAL_REVISION,
    describe: 'v0.5.0',
    commit: OFFICIAL_REVISION,
    source_tree: 'deadbeef',
    version: '0.5.0',
    stage_count: 23,
    source_dir: path.join(root, 'source'),
    venv_dir: path.join(root, 'venv'),
  } as unknown as ExternalReleaseManifest;
  return {
    releaseRoot: root,
    releaseId: '0.5.0-e2e23c93b494',
    // The supervisor spawns `python <runner_path> run …`; Node standing in for
    // the venv interpreter keeps the launch contract identical with no
    // provider, model, or network call.
    python: process.execPath,
    sourceDir: path.join(root, 'source'),
    manifest,
    manifestPath: path.join(root, 'manifest.json'),
    pairing: {
      source_dir: path.join(root, 'source'),
      revision: OFFICIAL_REVISION,
      source_tree: 'deadbeef',
      manifest_path: path.join(root, 'manifest.json'),
      driver_pairing: 'current',
      acpx: { executable: process.execPath, version: '0.13.0' },
    },
  };
}

function executionInput(projectRoot: string, runId: string, overrides: Partial<ArcExecutionInput> = {}): ArcExecutionInput {
  return {
    contract_version: ARC_INPUT_CONTRACT_VERSION,
    project_id: 'fixture-project',
    run_id: runId,
    objective: 'Verify the bounded official supervisor lifecycle.',
    project_root: projectRoot,
    artifact_path: path.posix.join('.metabot-arc', 'runs', runId, 'output.json'),
    requested_at: new Date().toISOString(),
    ...overrides,
  };
}

function supervisorFor(runnerFixture: string): OfficialArcProcessSupervisor {
  return new OfficialArcProcessSupervisor({
    supervisorCommand: SUPERVISOR_COMMAND,
    detachedRunnerPath: fixture(runnerFixture),
    pollIntervalMs: 25,
    registrationTimeoutMs: 20_000,
    stopTimeoutMs: 4_000,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the official supervisor fixture');
    await delay(25);
  }
}

const openRuns: Array<{ supervisor: OfficialArcProcessSupervisor; handle: ArcExecutionHandle }> = [];
const temporaryRoots: string[] = [];

function trackedRoot(): string {
  const root = temporaryDirectory('official-supervisor-');
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const run of openRuns.splice(0)) {
    try {
      await run.supervisor.cancel(run.handle);
    } catch {
      // The run already reached a terminal state.
    }
  }
  for (const root of temporaryRoots.splice(0)) removeDirectory(root);
});

describe('OfficialArcProcessSupervisor', () => {
  it('launches the official pipeline detached and publishes a provenance-first artifact', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const supervisor = supervisorFor('fake-official-complete.mjs');
    const input = executionInput(projectRoot, 'run-complete');

    const handle = await supervisor.start(input, releaseFixture(root));
    expect(handle.id).toBe('official-autoresearchclaw-run-complete');
    expect(handle.metadata).toMatchObject({
      runner: 'official-autoresearchclaw',
      run_id: 'run-complete',
      project_root: projectRoot,
      release_id: '0.5.0-e2e23c93b494',
    });
    const supervisorPid = Number(handle.metadata!.supervisor_pid);
    expect(supervisorPid).toBeGreaterThan(0);
    expect(supervisorPid).not.toBe(process.pid);

    expect(await supervisor.collect(handle)).toEqual({ state: 'finished' });

    const artifacts = new ArcArtifactStore();
    const output = artifacts.readOutput({ projectId: 'fixture-project', projectRoot, runId: 'run-complete' });
    expect(output.status).toBe('completed');
    expect(output.tool_trace[0]).toMatchObject({ tool: 'official_autoresearchclaw_pipeline', status: 'completed' });
    expect(output.tool_trace[0].summary).toContain(OFFICIAL_REVISION);
    expect(output.tool_trace[0].summary).toContain('0.5.0-e2e23c93b494');
    expect(output.metrics).toMatchObject({ official_stage_count: 23, stages_done: 23, exit_code: 0 });
    // Semantic arrays stay empty: only official artifacts are authoritative.
    expect(output.findings).toEqual([]);
    expect(output.hypotheses).toEqual([]);
    const uris = output.artifacts.map((artifact) => artifact.uri);
    expect(uris).toContain('.metabot-arc/runs/run-complete/official/pipeline_summary.json');
    expect(uris).toContain('.metabot-arc/runs/run-complete/official/deliverables/report.md');
    for (const artifact of output.artifacts) expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);

    const state = readRunnerState(path.join(projectRoot, '.metabot-arc', 'runs', 'run-complete', 'metabot-runner-state.json'));
    expect(state).toMatchObject({ status: 'completed', exit_code: 0, official_revision: OFFICIAL_REVISION });
    expect(state.child_pid).toBeGreaterThan(0);
  });

  it('passes the official CLI contract through to the pinned executable', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const supervisor = supervisorFor('fake-official-complete.mjs');
    const input = executionInput(projectRoot, 'run-argv', {
      parameters: { hitl_mode: 'checkpoint', to_stage: 'PROPOSAL_REVIEW', skip_preflight: true },
    });

    const handle = await supervisor.start(input, releaseFixture(root));
    await supervisor.collect(handle);

    const argv = JSON.parse(
      readFileSync(path.join(projectRoot, '.metabot-arc/runs/run-argv/official/metabot-observed-argv.json'), 'utf8'),
    ) as string[];
    expect(argv.slice(0, 4)).toEqual(['run', '--topic', input.objective, '--config']);
    expect(argv).toContain('--mode');
    expect(argv[argv.indexOf('--mode') + 1]).toBe('checkpoint');
    expect(argv).toContain('--to-stage');
    expect(argv).toContain('--skip-preflight');
    expect(argv).not.toContain('--auto-approve');
    const generatedConfig = JSON.parse(
      readFileSync(path.join(projectRoot, '.metabot-arc/runs/run-argv/official/metabot-generated-config.json'), 'utf8'),
    ) as { llm: { acp: { acpx_command: string } } };
    expect(generatedConfig.llm.acp.acpx_command).toBe(realpathSync.native(process.execPath));
    const configPath = path.join(
      projectRoot,
      '.metabot-arc/runs/run-argv/official/metabot-generated-config.json',
    );
    const request = readSupervisorRequest(
      path.join(projectRoot, '.metabot-arc/runs/run-argv/metabot-supervisor-request.json'),
    );
    expect(request.config_sha256).toBe(createHash('sha256').update(readFileSync(configPath)).digest('hex'));
    // A bounded run is partial, not a completed pipeline.
    const output = new ArcArtifactStore().readOutput({
      projectId: 'fixture-project',
      projectRoot,
      runId: 'run-argv',
    });
    expect(output.status).toBe('partial');
  });

  it('refuses an acpx command different from the executable verified by the sealed release', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const supervisor = new OfficialArcProcessSupervisor({
      supervisorCommand: SUPERVISOR_COMMAND,
      detachedRunnerPath: fixture('fake-official-complete.mjs'),
      acpxCommand: path.join(root, 'different-acpx'),
      pollIntervalMs: 25,
    });

    await expect(
      supervisor.start(executionInput(projectRoot, 'run-acpx-mismatch'), releaseFixture(root)),
    ).rejects.toMatchObject({ code: 'runner_unconfigured' });
  });

  it('is idempotent for a repeated start and fails closed on a conflicting one', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const supervisor = supervisorFor('fake-official-sleep.mjs');
    const input = executionInput(projectRoot, 'run-idempotent');

    const first = await supervisor.start(input, releaseFixture(root));
    openRuns.push({ supervisor, handle: first });
    const second = await supervisor.start(input, releaseFixture(root));
    expect(second).toEqual(first);

    await expect(
      supervisor.start({ ...input, objective: 'A different objective for the same run id.' }, releaseFixture(root)),
    ).rejects.toMatchObject({ code: 'run_conflict' });
  });

  it('pauses, resumes, and cancels through the real process group', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const supervisor = supervisorFor('fake-official-sleep.mjs');
    const handle = await supervisor.start(executionInput(projectRoot, 'run-signals'), releaseFixture(root));
    openRuns.push({ supervisor, handle });

    const childMarker = path.join(projectRoot, '.metabot-arc/runs/run-signals/official/metabot-child-started.json');
    await waitUntil(() => existsSync(childMarker));
    const childPid = (JSON.parse(readFileSync(childMarker, 'utf8')) as { pid: number }).pid;
    expect(await supervisor.probe(handle)).toEqual({ state: 'running' });

    expect(await supervisor.pause(handle)).toEqual({ state: 'paused' });
    expect(await supervisor.probe(handle)).toEqual({ state: 'paused' });
    expect(existsSync(path.join(projectRoot, '.metabot-arc/runs/run-signals/metabot-control.json'))).toBe(true);

    expect(await supervisor.resume(handle)).toEqual({ state: 'running' });
    expect(await supervisor.probe(handle)).toEqual({ state: 'running' });

    expect(await supervisor.cancel(handle)).toEqual({ state: 'cancelled' });
    expect(await supervisor.cancel(handle)).toEqual({ state: 'cancelled' });
    await waitUntil(() => !processAlive(childPid), 10_000);
    expect(processAlive(Number(handle.metadata!.supervisor_pid))).toBe(false);
    expect(
      readRunnerState(path.join(projectRoot, '.metabot-arc/runs/run-signals/metabot-runner-state.json')).status,
    ).toBe('cancelled');
  });

  it('re-attaches a durable handle after a coordinator restart without changing the run', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const supervisor = supervisorFor('fake-official-sleep.mjs');
    const handle = await supervisor.start(executionInput(projectRoot, 'run-recover'), releaseFixture(root));
    openRuns.push({ supervisor, handle });
    const statePath = path.join(projectRoot, '.metabot-arc/runs/run-recover/metabot-runner-state.json');
    await waitUntil(() => readRunnerState(statePath).status === 'running');

    // A fresh instance stands in for the restarted coordinator process.
    const restarted = supervisorFor('fake-official-sleep.mjs');
    const before = readRunnerState(statePath);
    expect(await restarted.probe(handle)).toEqual({ state: 'running' });
    expect(readRunnerState(statePath)).toEqual(before);
  });

  it('fails closed on a foreign handle, a reused pid, and an escaping path', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const supervisor = supervisorFor('fake-official-sleep.mjs');
    const handle = await supervisor.start(executionInput(projectRoot, 'run-identity'), releaseFixture(root));
    openRuns.push({ supervisor, handle });

    await expect(
      supervisor.probe({ ...handle, metadata: { ...handle.metadata, runner: 'arc-worker-runner-adapter' } }),
    ).rejects.toMatchObject({ code: 'runner_failure' });

    // The test runner is a live process that never registered this run.
    await expect(
      supervisor.probe({ ...handle, metadata: { ...handle.metadata, supervisor_pid: process.pid } }),
    ).rejects.toMatchObject({ code: 'runner_failure' });

    await expect(
      supervisor.probe({ ...handle, metadata: { ...handle.metadata, run_dir: path.join(root, 'elsewhere') } }),
    ).rejects.toMatchObject({ code: 'path_outside_project' });
  });

  it('bridges an official gate to the MCP HITL contract and back', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const supervisor = supervisorFor('fake-official-gate.mjs');
    const handle = await supervisor.start(executionInput(projectRoot, 'run-gate'), releaseFixture(root));
    openRuns.push({ supervisor, handle });

    const gateDir = path.join(projectRoot, '.metabot-arc', 'runs', 'run-gate', 'hitl');
    const officialHitlDir = path.join(projectRoot, '.metabot-arc', 'runs', 'run-gate', 'official', 'hitl');
    await waitUntil(() => existsSync(officialHitlDir) && !!readOfficialWaitingState(officialHitlDir));
    const waiting = readOfficialWaitingState(officialHitlDir)!;
    const requestId = officialGateRequestId(waiting);
    await waitUntil(() => existsSync(path.join(gateDir, `${requestId}.request.json`)));
    expect(await supervisor.probe(handle)).toEqual({ state: 'paused' });

    const published = JSON.parse(readFileSync(path.join(gateDir, `${requestId}.request.json`), 'utf8')) as {
      run_id: string;
      stage: string;
      prompt: string;
    };
    expect(published.run_id).toBe('run-gate');
    expect(published.stage).toBe('PROPOSAL_REVIEW');
    expect(published.prompt).toContain('gate_approval');

    // Exactly what arc_hitl_submit writes.
    atomicWriteJson(path.join(gateDir, `${requestId}.response.json`), {
      contract_version: 'autoresearchclaw.hitl.v1',
      request_id: requestId,
      run_id: 'run-gate',
      decision: 'revise',
      guidance: 'Narrow the proposal to one measurable claim.',
      responder: { bot_name: 'pm', chat_id: 'oc-fixture' },
      responded_at: new Date().toISOString(),
    });

    expect(await supervisor.collect(handle)).toEqual({ state: 'finished' });
    const observed = JSON.parse(
      readFileSync(path.join(projectRoot, '.metabot-arc/runs/run-gate/official/metabot-observed-gate.json'), 'utf8'),
    ) as { action: string; guidance: string };
    expect(observed.action).toBe('inject');
    expect(observed.guidance).toBe('Narrow the proposal to one measurable claim.');
  });
});

describe('production runtime wiring', () => {
  it('builds the official driver over the process supervisor instead of refusing to start', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const runtime = await createArcRuntime({
      env: {
        METABOT_ARC_DATA_DIR: path.join(root, 'data'),
        METABOT_ARC_PROJECT_ROOTS: JSON.stringify([projectRoot]),
        METABOT_ARC_RELEASE_ROOT: path.join(root, 'release'),
      },
    });
    try {
      expect(runtime.runner).toBeInstanceOf(OfficialArcDriver);
      // A missing sealed release must fail at launch, not be silently faked.
      await expect(
        runtime.runner.start(executionInput(projectRoot, 'run-unverified')),
      ).rejects.toMatchObject({ code: 'runner_unconfigured' });
    } finally {
      runtime.coordinator.dispose();
      runtime.store.close();
    }
  });

  it('drives one official run end to end through the coordinator', async () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const release = releaseFixture(root);
    const runner = new OfficialArcDriver({
      releaseRoot: root,
      supervisor: supervisorFor('fake-official-complete.mjs'),
      resolve: async () => release,
    });
    const artifacts = new ArcArtifactStore();
    const store = new ArcRunStore(path.join(root, 'data'));
    const coordinator = new ArcCoordinator(store, artifacts, runner, {
      scope: new ArcProjectScope(artifacts, { allowedProjectRoots: [projectRoot] }),
      artifactPollIntervalMs: 25,
      artifactWaitTimeoutMs: 20_000,
    });
    try {
      const started = await coordinator.start({
        project_id: 'fixture-project',
        project_root: projectRoot,
        objective: 'Drive the official supervisor through the coordinator.',
        idempotency_key: 'coordinator-official-1',
        run_id: 'run-coordinated',
      });
      expect(started.status).toBe('running');
      expect(started.runner_handle?.id).toBe('official-autoresearchclaw-run-coordinated');
      const finished = await coordinator.waitForTerminal('run-coordinated', 30_000);
      expect(finished.status).toBe('completed');
      expect(finished.output_status).toBe('completed');
      expect(coordinator.readOutput('run-coordinated').tool_trace[0].summary).toContain(OFFICIAL_REVISION);
    } finally {
      coordinator.dispose();
      store.close();
    }
  });
});

describe('official gate translation', () => {
  it('derives one stable request id per official gate', () => {
    const waiting = {
      stage: 5,
      stage_name: 'PROPOSAL_REVIEW',
      reason: 'gate_approval',
      since: '2026-08-15T12:00:00+00:00',
      available_actions: ['approve'],
      context_summary: '',
      output_files: [],
    };
    const first = officialGateRequestId(waiting);
    expect(first).toBe(officialGateRequestId({ ...waiting }));
    expect(first).not.toBe(officialGateRequestId({ ...waiting, since: '2026-08-15T13:00:00+00:00' }));
    expect(first).toMatch(/^stage-05-[a-f0-9]{16}$/);
  });

  it('republishing the same gate does not overwrite the operator-visible request', () => {
    const root = trackedRoot();
    const projectRoot = projectDirectory(root);
    const gateDir = path.join(projectRoot, 'hitl');
    const waiting = readOfficialWaitingState(gateDir);
    expect(waiting).toBeUndefined();

    const state = {
      stage: 9,
      stage_name: 'EXPERIMENT_GATE',
      reason: 'gate_approval',
      since: '2026-08-15T12:00:00+00:00',
      available_actions: ['approve', 'reject'],
      context_summary: 'ctx',
      output_files: [],
    };
    require('node:fs').mkdirSync(gateDir, { recursive: true, mode: 0o700 });
    const first = publishOfficialGate(gateDir, 'run-a', state, '2026-08-15T12:00:01Z');
    const contents = readFileSync(path.join(gateDir, `${first.request_id}.request.json`), 'utf8');
    const second = publishOfficialGate(gateDir, 'run-a', state, '2026-08-15T12:05:00Z');
    expect(second.request_id).toBe(first.request_id);
    expect(readFileSync(path.join(gateDir, `${first.request_id}.request.json`), 'utf8')).toBe(contents);
  });

  it('maps every MCP decision onto an official HumanAction without inventing content', () => {
    const base = { request_id: 'stage-05-abcdef0123456789', run_id: 'run-a', guidance: 'do less' } as const;
    expect(officialHitlResponse({ ...base, decision: 'approve' }, 'now')).toMatchObject({
      action: 'approve',
      message: 'do less',
      guidance: '',
      rollback_to_stage: null,
    });
    expect(officialHitlResponse({ ...base, decision: 'reject' }, 'now')).toMatchObject({ action: 'reject' });
    expect(officialHitlResponse({ ...base, decision: 'revise' }, 'now')).toMatchObject({
      action: 'inject',
      guidance: 'do less',
    });
    expect(officialHitlResponse({ ...base, decision: 'approve', guidance: null }, 'now').message).toBe('');
  });
});

describe('official start parameters', () => {
  it('accepts only the audited official CLI parameters', () => {
    expect(parseParameters(undefined, 'gate-only')).toMatchObject({ hitl_mode: 'gate-only', auto_approve: false });
    expect(() => parseParameters({ shell: 'rm -rf /' }, 'gate-only')).toThrow(ArcError);
    expect(() => parseParameters({ hitl_mode: 'anything' }, 'gate-only')).toThrow(/Unsupported HITL mode/);
    expect(() => parseParameters({ from_stage: '../../etc' }, 'gate-only')).toThrow(/from_stage is invalid/);
    expect(() => parseParameters({ profile: 'a/../b' }, 'gate-only')).toThrow(/profile is invalid/);
    expect(() => parseParameters({ auto_approve: 'yes' }, 'gate-only')).toThrow(ArcError);
  });
});

describe('official output artifact validation', () => {
  it('rejects an envelope that claims a different run', () => {
    expect(() =>
      validateArcOutput(
        {
          contract_version: 'autoresearchclaw.output.v2',
          project_id: 'fixture-project',
          run_id: 'other-run',
          status: 'completed',
          summary: 'x',
          hypotheses: [],
          experiments: [],
          findings: [],
          negative_results: [],
          decisions: [],
          artifacts: [],
          open_questions: [],
          recommended_followups: [],
          tool_trace: [],
        },
        { expectedProjectId: 'fixture-project', expectedRunId: 'run-a' },
      ),
    ).toThrow(ArcError);
  });
});
