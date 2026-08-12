import { existsSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import {
  ArcError,
  type ArcExecutionHandle,
  type ArcExecutionInput,
  type ArcHitlController,
  type ArcRunner,
  type ArcRunnerResult,
} from '@xvirobotics/arc-mcp';

import { atomicWriteJson, ensureSafeDirectory, readJsonFile, safeContainedPath, safeProjectRoot } from './files.js';
import { OFFICIAL_RESEARCHCLAW_REVISION, OFFICIAL_RESEARCHCLAW_VERSION } from './release.js';
import { processAlive, readRunnerState } from './state.js';
import {
  RUNNER_STATE_VERSION,
  SUPERVISOR_REQUEST_VERSION,
  type OfficialProbe,
  type OfficialRunnerStatus,
  type SupervisorRequest,
} from './types.js';

const HITL_MODES = new Set(['full-auto', 'gate-only', 'checkpoint', 'step-by-step', 'co-pilot', 'express', 'thorough', 'learning']);
const STAGE_NAME = /^[A-Z][A-Z0-9_]{0,80}$/;

export interface OfficialResearchClawAdapterOptions {
  python: string;
  bridgePath: string;
  supervisorPath: string;
  defaultConfigPath?: string;
  defaultHitlMode?: string;
  acpAgent?: string;
  acpxCommand?: string;
  pollIntervalMs?: number;
  stopTimeoutMs?: number;
}

interface HandleDetails {
  runId: string;
  projectRoot: string;
  runDir: string;
  artifactsDir: string;
  statePath: string;
  requestPath: string;
  controlPath: string;
  supervisorPid: number;
}

interface StartParameters {
  config_path?: string;
  hitl_mode: string;
  profile?: string;
  from_stage?: string;
  to_stage?: string;
  auto_approve: boolean;
  skip_preflight: boolean;
  skip_noncritical_stage: boolean;
  no_graceful_degradation: boolean;
  incremental_experiment: boolean;
}

export class OfficialResearchClawAdapter implements ArcRunner {
  readonly hitl: ArcHitlController;
  private readonly python: string;
  private readonly bridgePath: string;
  private readonly supervisorPath: string;
  private readonly pollIntervalMs: number;
  private readonly stopTimeoutMs: number;

  constructor(private readonly options: OfficialResearchClawAdapterOptions) {
    // A virtualenv's python is intentionally a symlink. Resolving it would
    // silently escape the virtualenv and lose the pinned ResearchClaw install.
    this.python = path.resolve(options.python);
    if (!existsSync(this.python)) throw new ArcError('runner_unconfigured', 'Official ARC Python executable is missing');
    this.bridgePath = realpathSync.native(options.bridgePath);
    this.supervisorPath = realpathSync.native(options.supervisorPath);
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 1_000, 'pollIntervalMs', 10, 60_000);
    this.stopTimeoutMs = boundedInteger(options.stopTimeoutMs ?? 10_000, 'stopTimeoutMs', 100, 120_000);
    this.hitl = {
      getStatus: (handle) => this.callHitl(handle, 'hitl_get_status', {}),
      approveStage: (handle, message) =>
        this.callHitl(handle, 'hitl_approve_stage', message === undefined ? {} : { message }),
      rejectStage: (handle, reason) => this.rejectHitlStage(handle, reason),
      injectGuidance: (handle, stage, guidance) =>
        this.callHitl(handle, 'hitl_inject_guidance', { stage, guidance }),
      viewOutput: (handle, stage, filename) => {
        if (filename !== undefined && (!safeFilename(filename) || filename.length > 512)) {
          throw new ArcError('invalid_contract', 'HITL output filename must be a single safe path component');
        }
        return this.callHitl(handle, 'hitl_view_output', {
          stage,
          ...(filename === undefined ? {} : { filename }),
        });
      },
    };
  }

  async start(input: ArcExecutionInput): Promise<ArcExecutionHandle> {
    const projectRoot = safeProjectRoot(input.project_root);
    const canonicalInput = { ...input, project_root: projectRoot };
    const artifactsDir = safeContainedPath(projectRoot, path.join('.metabot-arc', 'official-runs'));
    const runDir = safeContainedPath(projectRoot, path.join('.metabot-arc', 'official-runs', input.run_id));
    const outputDirectory = safeContainedPath(projectRoot, path.dirname(input.artifact_path));
    ensureSafeDirectory(projectRoot, artifactsDir);
    ensureSafeDirectory(projectRoot, runDir);
    ensureSafeDirectory(projectRoot, outputDirectory);

    const statePath = path.join(runDir, 'metabot-runner-state.json');
    const requestPath = path.join(runDir, 'metabot-supervisor-request.json');
    const controlPath = path.join(runDir, 'metabot-control.json');
    if (existsSync(requestPath)) {
      return this.recoverIdempotentStart(canonicalInput, requestPath, statePath, controlPath, artifactsDir);
    }

    const parameters = parseParameters(input.parameters, this.options.defaultHitlMode ?? 'gate-only');
    const configPath = parameters.config_path
      ? safeContainedPath(projectRoot, parameters.config_path, { mustExist: true, file: true })
      : this.options.defaultConfigPath
        ? realpathSync.native(this.options.defaultConfigPath)
        : this.writeGeneratedConfig(canonicalInput, runDir);

    const startedAt = new Date().toISOString();
    const initialState = {
      contract_version: RUNNER_STATE_VERSION,
      run_id: input.run_id,
      status: 'starting',
      supervisor_pid: 0,
      child_pid: null,
      official_version: OFFICIAL_RESEARCHCLAW_VERSION,
      official_revision: OFFICIAL_RESEARCHCLAW_REVISION,
      started_at: startedAt,
      updated_at: startedAt,
      finished_at: null,
      exit_code: null,
      signal: null,
      error: null,
    } as const;
    atomicWriteJson(statePath, initialState);

    const request: SupervisorRequest = {
      contract_version: SUPERVISOR_REQUEST_VERSION,
      input: canonicalInput,
      python: this.python,
      config_path: configPath,
      run_dir: runDir,
      state_path: statePath,
      request_path: requestPath,
      mode: parameters.hitl_mode,
      ...(parameters.profile ? { profile: parameters.profile } : {}),
      ...(parameters.from_stage ? { from_stage: parameters.from_stage } : {}),
      ...(parameters.to_stage ? { to_stage: parameters.to_stage } : {}),
      auto_approve: parameters.auto_approve,
      skip_preflight: parameters.skip_preflight,
      skip_noncritical_stage: parameters.skip_noncritical_stage,
      no_graceful_degradation: parameters.no_graceful_degradation,
      incremental_experiment: parameters.incremental_experiment,
      official_version: OFFICIAL_RESEARCHCLAW_VERSION,
      official_revision: OFFICIAL_RESEARCHCLAW_REVISION,
    };
    atomicWriteJson(requestPath, request);
    const supervisor = spawn(process.execPath, [this.supervisorPath, requestPath], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    if (!supervisor.pid) throw new ArcError('runner_failure', 'Could not start the official ARC supervisor');
    const supervisorPid = supervisor.pid;
    supervisor.unref();
    await this.awaitSupervisorRegistration(supervisorPid, statePath);
    return this.handle({
      runId: input.run_id,
      projectRoot,
      runDir,
      artifactsDir,
      statePath,
      requestPath,
      controlPath,
      supervisorPid,
    });
  }

  async recover(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    return this.status(handle);
  }

  async pause(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    const details = this.details(handle);
    const status = this.status(handle);
    if ((await status).state !== 'running') return status;
    atomicWriteJson(details.controlPath, { action: 'pause', requested_at: new Date().toISOString() });
    this.signalGroup(details.supervisorPid, 'SIGSTOP');
    return { state: 'paused' };
  }

  async resume(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    const details = this.details(handle);
    const state = readRunnerState(details.statePath);
    if (state.status === 'completed' || state.status === 'failed') return { state: 'finished' };
    if (state.status === 'cancelled') return { state: 'cancelled' };
    if (existsSync(details.controlPath)) {
      unlinkSync(details.controlPath);
      this.signalGroup(details.supervisorPid, 'SIGCONT');
    }
    return { state: 'running' };
  }

  async cancel(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    const details = this.details(handle);
    const current = await this.status(handle);
    if (current.state === 'finished' || current.state === 'cancelled') return current;
    const state = readRunnerState(details.statePath);
    atomicWriteJson(details.statePath, {
      ...state,
      status: 'cancelled',
      updated_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      signal: 'SIGTERM',
    });
    if (existsSync(details.controlPath)) {
      unlinkSync(details.controlPath);
      this.signalGroup(details.supervisorPid, 'SIGCONT');
    }
    this.signalGroup(details.supervisorPid, 'SIGTERM');
    const deadline = Date.now() + this.stopTimeoutMs;
    while (processAlive(details.supervisorPid) && Date.now() < deadline) await delay(50);
    if (processAlive(details.supervisorPid)) this.signalGroup(details.supervisorPid, 'SIGKILL');
    return { state: 'cancelled' };
  }

  async collect(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    while (true) {
      const result = await this.status(handle);
      if (result.state !== 'running') return result;
      await delay(this.pollIntervalMs);
    }
  }

  private async status(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    const details = this.details(handle);
    const state = readRunnerState(details.statePath);
    if (state.run_id !== details.runId || state.supervisor_pid !== details.supervisorPid) {
      throw new ArcError('runner_failure', 'Official ARC durable handle no longer matches its runner state');
    }
    const terminal = terminalRunnerResult(state.status);
    if (terminal) return terminal;
    if (!processAlive(details.supervisorPid)) {
      await delay(100);
      const refreshed = readRunnerState(details.statePath);
      const refreshedTerminal = terminalRunnerResult(refreshed.status);
      if (refreshedTerminal) return refreshedTerminal;
      throw new ArcError('runner_failure', 'Official ARC supervisor exited without a terminal state');
    }
    try {
      this.assertProcessIdentity(details);
    } catch (error) {
      // The supervisor can publish its terminal state immediately after the
      // liveness probe and before `ps` verifies the PID. Re-read the durable
      // state before treating that normal exit race as PID reuse.
      await delay(100);
      const refreshed = readRunnerState(details.statePath);
      const refreshedTerminal = terminalRunnerResult(refreshed.status);
      if (refreshedTerminal) return refreshedTerminal;
      throw error;
    }
    const waitingPath = path.join(details.runDir, 'hitl', 'waiting.json');
    const responsePath = path.join(details.runDir, 'hitl', 'response.json');
    if (existsSync(details.controlPath) || (existsSync(waitingPath) && !existsSync(responsePath))) {
      return { state: 'paused' };
    }
    return { state: 'running' };
  }

  private async callHitl(
    handle: ArcExecutionHandle,
    tool: string,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const details = this.details(handle);
    const result = await runJsonBridge(this.python, this.bridgePath, {
      action: 'hitl',
      artifacts_dir: details.artifactsDir,
      tool,
      arguments: { run_id: details.runId, ...values },
    });
    if (result.success !== true) {
      throw new ArcError('runner_failure', `Official AutoResearchClaw HITL call failed: ${String(result.error ?? 'unknown error')}`);
    }
    return result;
  }

  private async rejectHitlStage(handle: ArcExecutionHandle, reason: string): Promise<Record<string, unknown>> {
    const details = this.details(handle);
    const status = await this.callHitl(handle, 'hitl_get_status', {});
    const waiting = status.waiting;
    const stage =
      waiting && typeof waiting === 'object' && !Array.isArray(waiting)
        ? Number((waiting as Record<string, unknown>).stage)
        : Number.NaN;
    if (!Number.isSafeInteger(stage) || stage < 1) {
      throw new ArcError('invalid_transition', 'Official AutoResearchClaw is not waiting at a rejectable gate');
    }
    const rollback = await runJsonBridge(this.python, this.bridgePath, { action: 'gate_rollback', stage });
    if (rollback.success !== true || typeof rollback.from_stage !== 'string' || !STAGE_NAME.test(rollback.from_stage)) {
      throw new ArcError(
        'runner_failure',
        `Official AutoResearchClaw rollback resolution failed: ${String(rollback.error ?? 'invalid target')}`,
      );
    }
    const markerPath = path.join(details.runDir, 'metabot-hitl-rejection.json');
    atomicWriteJson(markerPath, {
      contract_version: 'metabot.researchclaw.hitl-rejection.v1',
      run_id: details.runId,
      stage,
      from_stage: rollback.from_stage,
      reason,
      requested_at: new Date().toISOString(),
    });
    try {
      return await this.callHitl(handle, 'hitl_reject_stage', { reason });
    } catch (error) {
      unlinkSync(markerPath);
      throw error;
    }
  }

  private recoverIdempotentStart(
    input: ArcExecutionInput,
    requestPath: string,
    statePath: string,
    controlPath: string,
    artifactsDir: string,
  ): ArcExecutionHandle {
    const existing = readJsonFile(requestPath) as SupervisorRequest;
    if (
      existing.contract_version !== SUPERVISOR_REQUEST_VERSION ||
      existing.input.run_id !== input.run_id ||
      existing.input.project_id !== input.project_id ||
      existing.input.project_root !== input.project_root ||
      existing.input.objective !== input.objective
    ) {
      throw new ArcError('run_conflict', 'Official ARC run directory belongs to a different request');
    }
    const state = readRunnerState(statePath);
    return this.handle({
      runId: input.run_id,
      projectRoot: input.project_root,
      runDir: existing.run_dir,
      artifactsDir,
      statePath,
      requestPath,
      controlPath,
      supervisorPid: state.supervisor_pid,
    });
  }

  private writeGeneratedConfig(input: ArcExecutionInput, runDir: string): string {
    const acpAgent = cleanToken(this.options.acpAgent ?? 'codex', 'ACP agent');
    const acpxCommand = this.options.acpxCommand?.trim() || 'acpx';
    const configPath = path.join(runDir, 'metabot-generated-config.json');
    const config = {
      project: { name: input.project_id, mode: 'full-auto' },
      research: {
        topic: input.objective,
        domains: [],
        daily_paper_count: 8,
        quality_threshold: 4,
        graceful_degradation: true,
      },
      runtime: { timezone: 'UTC', max_parallel_tasks: 1, approval_timeout_hours: 24, retry_limit: 2 },
      notifications: { channel: 'console', target: '', on_stage_start: true, on_stage_fail: true, on_gate_required: true },
      knowledge_base: { backend: 'markdown', root: path.join(runDir, 'knowledge-base') },
      openclaw_bridge: {},
      llm: {
        provider: 'acp',
        acp: {
          agent: acpAgent,
          cwd: input.project_root,
          acpx_command: acpxCommand,
          session_name: `researchclaw-${input.run_id}`,
          timeout_sec: 1800,
        },
      },
      security: { hitl_required_stages: [5, 9, 20], allow_publish_without_approval: false, redact_sensitive_logs: true },
      experiment: {
        mode: 'sandbox',
        time_budget_sec: 300,
        max_iterations: 10,
        metric_key: 'primary_metric',
        metric_direction: 'minimize',
        sandbox: { python_path: this.python, gpu_required: false, max_memory_mb: 4096 },
        opencode: { enabled: false, auto: false },
        repair: { enabled: true, max_cycles: 3, use_opencode: false },
        cli_agent: { provider: 'codex', binary_path: '', max_budget_usd: 5, timeout_sec: 600 },
      },
      metaclaw_bridge: { enabled: false },
    };
    atomicWriteJson(configPath, config);
    return configPath;
  }

  private handle(details: HandleDetails): ArcExecutionHandle {
    return {
      id: `researchclaw-${details.runId}`,
      metadata: {
        runner: 'official-researchclaw',
        run_id: details.runId,
        project_root: details.projectRoot,
        run_dir: details.runDir,
        artifacts_dir: details.artifactsDir,
        state_path: details.statePath,
        request_path: details.requestPath,
        control_path: details.controlPath,
        supervisor_pid: details.supervisorPid,
        official_version: OFFICIAL_RESEARCHCLAW_VERSION,
        official_revision: OFFICIAL_RESEARCHCLAW_REVISION,
      },
    };
  }

  private details(handle: ArcExecutionHandle): HandleDetails {
    const metadata = handle.metadata;
    const details = {
      runId: stringField(metadata, 'run_id'),
      projectRoot: stringField(metadata, 'project_root'),
      runDir: stringField(metadata, 'run_dir'),
      artifactsDir: stringField(metadata, 'artifacts_dir'),
      statePath: stringField(metadata, 'state_path'),
      requestPath: stringField(metadata, 'request_path'),
      controlPath: stringField(metadata, 'control_path'),
      supervisorPid: numberField(metadata, 'supervisor_pid'),
    };
    if (handle.id !== `researchclaw-${details.runId}` || metadata?.runner !== 'official-researchclaw') {
      throw new ArcError('runner_failure', 'ARC handle was not created by the official ResearchClaw adapter');
    }
    const root = safeProjectRoot(details.projectRoot);
    for (const candidate of [details.runDir, details.artifactsDir, details.statePath, details.requestPath, details.controlPath]) {
      safeContainedPath(root, candidate);
    }
    return details;
  }

  private signalGroup(supervisorPid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-supervisorPid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw new ArcError('runner_failure', `Could not signal official ARC process group: ${code ?? error}`);
    }
  }

  private async awaitSupervisorRegistration(supervisorPid: number, statePath: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = readRunnerState(statePath);
      if (state.supervisor_pid === supervisorPid) return;
      if (state.supervisor_pid !== 0) {
        this.signalGroup(supervisorPid, 'SIGTERM');
        throw new ArcError('runner_failure', 'Official ARC supervisor registered an unexpected process identity');
      }
      if (!processAlive(supervisorPid)) break;
      await delay(10);
    }
    this.signalGroup(supervisorPid, 'SIGTERM');
    throw new ArcError('runner_failure', 'Official ARC supervisor did not register its process identity');
  }

  private assertProcessIdentity(details: HandleDetails): void {
    if (process.platform === 'win32') return;
    try {
      const command = execFileSync('ps', ['-p', String(details.supervisorPid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 2_000,
      });
      // A detached child can briefly remain as a zombie until PID 1 reaps it.
      // It cannot execute or be PID-reused during that window, so the durable
      // state remains authoritative and the next poll will observe terminal.
      if (command.includes('<defunct>')) return;
      if (!command.includes(details.requestPath) || !command.includes(this.supervisorPath)) {
        throw new ArcError('runner_failure', 'Official ARC supervisor PID was reused by another process');
      }
    } catch (error) {
      if (error instanceof ArcError) throw error;
      throw new ArcError('runner_failure', 'Could not verify official ARC supervisor identity', { cause: error });
    }
  }
}

export async function probeOfficialResearchClaw(python: string, bridgePath: string): Promise<OfficialProbe> {
  const result = await runJsonBridge(path.resolve(python), realpathSync.native(bridgePath), { action: 'probe' });
  if (
    result.success !== true ||
    result.version !== OFFICIAL_RESEARCHCLAW_VERSION ||
    result.stage_count !== 23 ||
    typeof result.package_path !== 'string'
  ) {
    throw new ArcError(
      'runner_unconfigured',
      `Official AutoResearchClaw probe failed or returned an unsupported release: ${JSON.stringify(result)}`,
    );
  }
  return result as unknown as OfficialProbe;
}

async function runJsonBridge(
  python: string,
  bridgePath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [bridgePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      let result: unknown;
      try {
        result = JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown;
      } catch (error) {
        reject(new ArcError('runner_failure', 'Official AutoResearchClaw bridge returned invalid JSON', { cause: error }));
        return;
      }
      if (code !== 0) {
        reject(
          new ArcError('runner_failure', 'Official AutoResearchClaw bridge failed', {
            details: { stderr: Buffer.concat(stderr).toString('utf8').slice(0, 2_000) },
          }),
        );
        return;
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        reject(new ArcError('runner_failure', 'Official AutoResearchClaw bridge returned a non-object result'));
        return;
      }
      resolve(result as Record<string, unknown>);
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function parseParameters(value: Record<string, unknown> | undefined, fallbackMode: string): StartParameters {
  const parameters = value ?? {};
  const allowed = new Set([
    'config_path',
    'hitl_mode',
    'profile',
    'from_stage',
    'to_stage',
    'auto_approve',
    'skip_preflight',
    'skip_noncritical_stage',
    'no_graceful_degradation',
    'incremental_experiment',
  ]);
  for (const key of Object.keys(parameters)) {
    if (!allowed.has(key)) throw new ArcError('invalid_contract', `Unsupported official ARC parameter: ${key}`);
  }
  const hitlMode = optionalString(parameters.hitl_mode) ?? fallbackMode;
  if (!HITL_MODES.has(hitlMode)) throw new ArcError('invalid_contract', `Unsupported HITL mode: ${hitlMode}`);
  const fromStage = optionalString(parameters.from_stage);
  const toStage = optionalString(parameters.to_stage);
  if (fromStage && !STAGE_NAME.test(fromStage)) throw new ArcError('invalid_contract', 'from_stage is invalid');
  if (toStage && !STAGE_NAME.test(toStage)) throw new ArcError('invalid_contract', 'to_stage is invalid');
  return {
    ...(optionalString(parameters.config_path) ? { config_path: optionalString(parameters.config_path)! } : {}),
    hitl_mode: hitlMode,
    ...(optionalString(parameters.profile) ? { profile: optionalString(parameters.profile)! } : {}),
    ...(fromStage ? { from_stage: fromStage } : {}),
    ...(toStage ? { to_stage: toStage } : {}),
    auto_approve: optionalBoolean(parameters.auto_approve) ?? false,
    skip_preflight: optionalBoolean(parameters.skip_preflight) ?? false,
    skip_noncritical_stage: optionalBoolean(parameters.skip_noncritical_stage) ?? false,
    no_graceful_degradation: optionalBoolean(parameters.no_graceful_degradation) ?? false,
    incremental_experiment: optionalBoolean(parameters.incremental_experiment) ?? false,
  };
}

function stringField(value: Record<string, unknown> | undefined, key: string): string {
  const item = value?.[key];
  if (typeof item !== 'string' || !item) throw new ArcError('runner_failure', `ARC handle metadata ${key} is invalid`);
  return item;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number {
  const item = value?.[key];
  if (!Number.isSafeInteger(item) || Number(item) < 1) throw new ArcError('runner_failure', `ARC handle metadata ${key} is invalid`);
  return Number(item);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new ArcError('invalid_contract', 'Expected a non-empty string parameter');
  return value.trim();
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ArcError('invalid_contract', 'Expected a boolean parameter');
  return value;
}

function safeFilename(value: string): boolean {
  return value !== '.' && value !== '..' && path.basename(value) === value && !value.includes('\0');
}

function terminalRunnerResult(status: OfficialRunnerStatus): ArcRunnerResult | undefined {
  if (status === 'completed' || status === 'failed') return { state: 'finished' };
  if (status === 'cancelled') return { state: 'cancelled' };
  return undefined;
}

function cleanToken(value: string, label: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9._+@/-]{1,512}$/.test(token)) throw new ArcError('runner_unconfigured', `${label} is invalid`);
  return token;
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
