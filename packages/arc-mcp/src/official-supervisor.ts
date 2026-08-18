import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertBoundedBudgetPolicy,
  type BoundedBudgetEvidence,
  type OfficialBudgetDocument,
} from './bounded-execution.js';
import type { ArcExecutionHandle, ArcExecutionInput } from './contract.js';
import { ArcError } from './errors.js';
import type { OfficialProcessSupervisor, ResolvedOfficialRelease } from './official-driver.js';
import { loadOfficialBudgetDocument, officialCompatibilityPath } from './official-driver.js';
import {
  atomicWriteJson,
  ensureSafeDirectory,
  removeIfPresent,
  safeContainedPath,
  safeProjectRoot,
} from './official-paths.js';
import {
  OFFICIAL_RUNNER_STATE_VERSION,
  OFFICIAL_SUPERVISOR_REQUEST_VERSION,
  delay,
  processAlive,
  readRunnerState,
  readSupervisorRequest,
  terminalRunnerResult,
  type OfficialRunnerState,
  type OfficialSupervisorRequest,
} from './official-state.js';
import { OFFICIAL_WAITING_FILE } from './official-hitl-bridge.js';
import type { ArcRunnerResult } from './runner.js';

/** Official HITL modes accepted by the pinned AutoResearchClaw CLI. */
const HITL_MODES = new Set([
  'full-auto',
  'gate-only',
  'checkpoint',
  'step-by-step',
  'co-pilot',
  'express',
  'thorough',
  'learning',
]);
const STAGE_NAME = /^[A-Z][A-Z0-9_]{0,80}$/;
const HANDLE_RUNNER = 'official-autoresearchclaw' as const;
const MAX_OFFICIAL_CONFIG_BYTES = 1024 * 1024;

export function officialSupervisorPath(): string {
  return fileURLToPath(new URL('./official-supervisor-cli.js', import.meta.url));
}

export function officialDetachedRunnerPath(): string {
  return fileURLToPath(new URL('../python/detached_runner.py', import.meta.url));
}

export interface OfficialSupervisorCommand {
  command: string;
  args: readonly string[];
}

export interface OfficialArcProcessSupervisorOptions {
  /** Overridden in tests so the detached entry point can run from source. */
  supervisorCommand?: OfficialSupervisorCommand;
  detachedRunnerPath?: string;
  defaultConfigPath?: string;
  defaultHitlMode?: string;
  acpAgent?: string;
  acpxCommand?: string;
  pollIntervalMs?: number;
  registrationTimeoutMs?: number;
  stopTimeoutMs?: number;
  /**
   * Reads the budget-relevant sections of an official config. Injectable so
   * the refusal paths stay testable without an interpreter, a network, or a
   * subprocess of any kind.
   */
  loadBudgetDocument?: (release: ResolvedOfficialRelease, configPath: string) => OfficialBudgetDocument;
}

interface HandleDetails {
  runId: string;
  projectRoot: string;
  runDir: string;
  officialDir: string;
  gateDir: string;
  statePath: string;
  requestPath: string;
  controlPath: string;
  supervisorPid: number;
  releaseId: string;
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

/**
 * Durable process control over one official AutoResearchClaw pipeline.
 *
 * The pipeline outlives this daemon by design: the coordinator can restart
 * mid-run and must re-attach to the same execution. So the authority is a
 * detached supervisor process plus its atomic on-disk state, not an in-memory
 * child handle. Everything this class does is either a read of that state or a
 * signal to that process group.
 */
export class OfficialArcProcessSupervisor implements OfficialProcessSupervisor {
  private readonly supervisorCommand: OfficialSupervisorCommand;
  private readonly detachedRunnerPath: string;
  private readonly pollIntervalMs: number;
  private readonly registrationTimeoutMs: number;
  private readonly stopTimeoutMs: number;

  constructor(private readonly options: OfficialArcProcessSupervisorOptions = {}) {
    this.supervisorCommand = options.supervisorCommand ?? {
      command: process.execPath,
      args: [officialSupervisorPath()],
    };
    this.detachedRunnerPath = options.detachedRunnerPath ?? officialDetachedRunnerPath();
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 1_000, 'pollIntervalMs', 10, 60_000);
    this.registrationTimeoutMs = boundedInteger(
      options.registrationTimeoutMs ?? 10_000,
      'registrationTimeoutMs',
      100,
      120_000,
    );
    this.stopTimeoutMs = boundedInteger(options.stopTimeoutMs ?? 10_000, 'stopTimeoutMs', 100, 120_000);
  }

  async start(input: ArcExecutionInput, release: ResolvedOfficialRelease): Promise<ArcExecutionHandle> {
    const projectRoot = safeProjectRoot(input.project_root);
    const canonicalInput: ArcExecutionInput = { ...input, project_root: projectRoot };
    const runDir = safeContainedPath(projectRoot, path.join('.metabot-arc', 'runs', input.run_id));
    const officialDir = path.join(runDir, 'official');
    const gateDir = path.join(runDir, 'hitl');
    ensureSafeDirectory(projectRoot, runDir);
    ensureSafeDirectory(projectRoot, officialDir);
    ensureSafeDirectory(projectRoot, gateDir);
    ensureSafeDirectory(projectRoot, path.join(officialDir, 'hitl'));
    ensureSafeDirectory(projectRoot, safeContainedPath(projectRoot, path.dirname(input.artifact_path)));

    const statePath = path.join(runDir, 'metabot-runner-state.json');
    const requestPath = path.join(runDir, 'metabot-supervisor-request.json');
    const controlPath = path.join(runDir, 'metabot-control.json');
    if (existsSync(requestPath)) {
      return this.reattachExistingRun(canonicalInput, { runDir, officialDir, gateDir, statePath, requestPath, controlPath });
    }

    const parameters = parseParameters(input.parameters, this.options.defaultHitlMode ?? 'gate-only');
    const configPath = this.resolveConfigPath(canonicalInput, parameters, officialDir, release);
    const configSha256 = digestOfficialConfig(configPath);
    // Before anything is spawned: a run declared bounded must prove, from the
    // exact config bytes just digested, that it is.
    const budgetPolicy = this.assertBoundedConfig(release, configPath, configSha256);
    const startedAt = new Date().toISOString();
    const initialState: OfficialRunnerState = {
      contract_version: OFFICIAL_RUNNER_STATE_VERSION,
      run_id: input.run_id,
      status: 'starting',
      supervisor_pid: 0,
      child_pid: null,
      official_version: release.manifest.version,
      official_revision: release.pairing.revision,
      release_id: release.releaseId,
      started_at: startedAt,
      updated_at: startedAt,
      finished_at: null,
      exit_code: null,
      signal: null,
      error: null,
    };
    atomicWriteJson(statePath, initialState);

    const request: OfficialSupervisorRequest = {
      contract_version: OFFICIAL_SUPERVISOR_REQUEST_VERSION,
      input: canonicalInput,
      python: release.python,
      runner_path: this.detachedRunnerPath,
      compat_path: officialCompatibilityPath(),
      config_path: configPath,
      config_sha256: configSha256,
      run_dir: officialDir,
      gate_dir: gateDir,
      state_path: statePath,
      request_path: requestPath,
      control_path: controlPath,
      mode: parameters.hitl_mode,
      ...(parameters.profile ? { profile: parameters.profile } : {}),
      ...(parameters.from_stage ? { from_stage: parameters.from_stage } : {}),
      ...(parameters.to_stage ? { to_stage: parameters.to_stage } : {}),
      auto_approve: parameters.auto_approve,
      skip_preflight: parameters.skip_preflight,
      skip_noncritical_stage: parameters.skip_noncritical_stage,
      no_graceful_degradation: parameters.no_graceful_degradation,
      incremental_experiment: parameters.incremental_experiment,
      official_version: release.manifest.version,
      official_revision: release.pairing.revision,
      release_id: release.releaseId,
      stage_count: release.manifest.stage_count,
      poll_interval_ms: Math.min(this.pollIntervalMs, 2_000),
      ...(budgetPolicy ? { budget_policy: budgetPolicy } : {}),
    };
    atomicWriteJson(requestPath, request);

    const supervisorPid = this.spawnDetachedSupervisor(projectRoot, requestPath);
    await this.awaitRegistration(supervisorPid, statePath);
    return handleFor({
      runId: input.run_id,
      projectRoot,
      runDir,
      officialDir,
      gateDir,
      statePath,
      requestPath,
      controlPath,
      supervisorPid,
      releaseId: release.releaseId,
    });
  }

  /** Read-only: recovery must never change the underlying execution. */
  probe(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    return this.status(handle);
  }

  async pause(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    const details = this.details(handle);
    const current = await this.status(handle);
    if (current.state !== 'running') return current;
    atomicWriteJson(details.controlPath, { action: 'pause', requested_at: new Date().toISOString() });
    this.signalGroup(details.supervisorPid, 'SIGSTOP');
    return { state: 'paused' };
  }

  async resume(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    const details = this.details(handle);
    const state = readRunnerState(details.statePath);
    const terminal = terminalRunnerResult(state.status);
    if (terminal) return terminal;
    if (existsSync(details.controlPath)) {
      removeIfPresent(details.controlPath);
      this.signalGroup(details.supervisorPid, 'SIGCONT');
    }
    return { state: 'running' };
  }

  async cancel(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    const details = this.details(handle);
    const current = await this.status(handle);
    if (current.state === 'finished' || current.state === 'cancelled') return current;
    const state = readRunnerState(details.statePath);
    const now = new Date().toISOString();
    atomicWriteJson(details.statePath, {
      ...state,
      status: 'cancelled',
      updated_at: now,
      finished_at: now,
      signal: 'SIGTERM',
    } satisfies OfficialRunnerState);
    // A stopped process cannot act on SIGTERM, so continue it first.
    if (existsSync(details.controlPath)) {
      removeIfPresent(details.controlPath);
      this.signalGroup(details.supervisorPid, 'SIGCONT');
    }
    this.signalGroup(details.supervisorPid, 'SIGTERM');
    const deadline = Date.now() + this.stopTimeoutMs;
    while (processAlive(details.supervisorPid) && Date.now() < deadline) await delay(25);
    if (processAlive(details.supervisorPid)) this.signalGroup(details.supervisorPid, 'SIGKILL');
    return { state: 'cancelled' };
  }

  /**
   * Stays pending across pause, resume, and HITL gates: the coordinator treats
   * any non-terminal collect result as a runner failure, and a run waiting for
   * an operator decision has not failed.
   */
  async collect(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    while (true) {
      const result = await this.status(handle);
      if (result.state === 'finished' || result.state === 'cancelled') return result;
      await delay(this.pollIntervalMs);
    }
  }

  private async status(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    const details = this.details(handle);
    const state = readRunnerState(details.statePath);
    if (
      state.run_id !== details.runId ||
      state.supervisor_pid !== details.supervisorPid ||
      state.release_id !== details.releaseId
    ) {
      throw new ArcError('runner_failure', 'Official AutoResearchClaw handle no longer matches its runner state');
    }
    const terminal = terminalRunnerResult(state.status);
    if (terminal) return terminal;
    if (!processAlive(details.supervisorPid)) {
      const refreshed = await this.terminalAfterSettle(details);
      if (refreshed) return refreshed;
      throw new ArcError('runner_failure', 'Official AutoResearchClaw supervisor exited without a terminal state');
    }
    try {
      this.assertProcessIdentity(details);
    } catch (error) {
      // The supervisor can publish its terminal state between the liveness
      // probe and the identity probe. Re-read durable state before treating a
      // normal exit as PID reuse.
      const refreshed = await this.terminalAfterSettle(details);
      if (refreshed) return refreshed;
      throw error;
    }
    if (existsSync(details.controlPath)) return { state: 'paused' };
    if (existsSync(path.join(details.officialDir, 'hitl', OFFICIAL_WAITING_FILE))) return { state: 'paused' };
    return { state: 'running' };
  }

  private async terminalAfterSettle(details: HandleDetails): Promise<ArcRunnerResult | undefined> {
    await delay(100);
    return terminalRunnerResult(readRunnerState(details.statePath).status);
  }

  /**
   * A second start for the same run must attach to the existing execution
   * instead of launching a competing pipeline, and a genuinely different
   * request reusing the same run directory must fail loudly.
   */
  private reattachExistingRun(
    input: ArcExecutionInput,
    paths: Pick<HandleDetails, 'runDir' | 'officialDir' | 'gateDir' | 'statePath' | 'requestPath' | 'controlPath'>,
  ): ArcExecutionHandle {
    const existing = readSupervisorRequest(paths.requestPath);
    if (
      existing.input.run_id !== input.run_id ||
      existing.input.project_id !== input.project_id ||
      existing.input.project_root !== input.project_root ||
      existing.input.objective !== input.objective
    ) {
      throw new ArcError('run_conflict', 'Official AutoResearchClaw run directory belongs to a different request', {
        details: { runId: input.run_id },
      });
    }
    const state = readRunnerState(paths.statePath);
    if (state.supervisor_pid < 1) {
      throw new ArcError('runner_failure', 'Official AutoResearchClaw run was never registered by a supervisor');
    }
    return handleFor({
      runId: input.run_id,
      projectRoot: input.project_root,
      supervisorPid: state.supervisor_pid,
      releaseId: state.release_id,
      ...paths,
    });
  }

  /**
   * Proves the ceiling before the process that could spend exists.
   *
   * The release guard proves the *code* can enforce a ceiling; this proves the
   * *run* was given one, and the same one that was authorized. The document is
   * required to hash to the config the runner is about to be handed, so a file
   * swapped between validation and spawn is a refusal rather than a window.
   */
  private assertBoundedConfig(
    release: ResolvedOfficialRelease,
    configPath: string,
    configSha256: string,
  ): BoundedBudgetEvidence | null {
    const bounded = release.bounded;
    if (!bounded?.require) return null;
    if (!bounded.policyId?.trim()) {
      throw new ArcError(
        'runner_unconfigured',
        'Bounded execution was requested without naming a budget policy; a ceiling nobody stated is not a bound',
      );
    }
    const load = this.options.loadBudgetDocument ?? loadOfficialBudgetDocument;
    const document = load(release, configPath);
    const evidence = assertBoundedBudgetPolicy(document, { policyId: bounded.policyId });
    if (evidence.config_sha256 !== configSha256) {
      throw new ArcError(
        'runner_unconfigured',
        'The validated budget policy came from different config bytes than the ones handed to the official runner',
        { details: { validated: evidence.config_sha256, spawning: configSha256 } },
      );
    }
    return evidence;
  }

  private resolveConfigPath(
    input: ArcExecutionInput,
    parameters: StartParameters,
    officialDir: string,
    release: ResolvedOfficialRelease,
  ): string {
    if (parameters.config_path) {
      // Model-supplied; contained and existence-checked before the official
      // process ever reads it.
      return safeContainedPath(input.project_root, parameters.config_path, { mustExist: true, file: true });
    }
    if (this.options.defaultConfigPath) return realpathSync.native(this.options.defaultConfigPath);
    return this.writeGeneratedConfig(input, officialDir, release);
  }

  private writeGeneratedConfig(
    input: ArcExecutionInput,
    officialDir: string,
    release: ResolvedOfficialRelease,
  ): string {
    // The generated config drives the pipeline through ACP, which the upstream
    // guard declares structurally unbudgetable: it forwards no completion cap
    // and reports no usage. A bounded run must therefore be given a real
    // config naming a boundable provider and its policy, rather than silently
    // receiving a default that no ceiling can cover.
    if (release.bounded?.require) {
      throw new ArcError(
        'runner_unconfigured',
        'A bounded run cannot use the generated ACP config: the ACP provider reports no token usage and accepts ' +
          'no enforced completion cap, so no ceiling can be proven. Supply a config whose llm.provider is ' +
          'boundable and whose budget section names the authorized policy',
      );
    }
    const acpAgent = cleanToken(this.options.acpAgent ?? 'codex', 'ACP agent');
    const acpxCommand = this.resolveVerifiedAcpxCommand(release);
    const configPath = path.join(officialDir, 'metabot-generated-config.json');
    atomicWriteJson(configPath, {
      project: { name: input.project_id, mode: 'full-auto' },
      research: {
        topic: input.objective,
        domains: [],
        daily_paper_count: 8,
        quality_threshold: 4,
        graceful_degradation: true,
      },
      runtime: { timezone: 'UTC', max_parallel_tasks: 1, approval_timeout_hours: 24, retry_limit: 2 },
      notifications: {
        channel: 'console',
        target: '',
        on_stage_start: true,
        on_stage_fail: true,
        on_gate_required: true,
      },
      knowledge_base: { backend: 'markdown', root: path.join(officialDir, 'knowledge-base') },
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
        sandbox: { python_path: release.python, gpu_required: false, max_memory_mb: 4096 },
        opencode: { enabled: false, auto: false },
        repair: { enabled: true, max_cycles: 3, use_opencode: false },
        cli_agent: { provider: 'codex', binary_path: '', max_budget_usd: 5, timeout_sec: 600 },
      },
      metaclaw_bridge: { enabled: false },
    });
    return configPath;
  }

  /**
   * The release guard verifies one absolute acpx executable. The generated
   * official config must execute that same file, rather than resolving a bare
   * `acpx` through a potentially different PATH entry after verification.
   */
  private resolveVerifiedAcpxCommand(release: ResolvedOfficialRelease): string {
    const sealedExecutable = release.pairing.acpx?.executable;
    if (!sealedExecutable) {
      throw new ArcError('runner_unconfigured', 'The sealed ARC release has no verified acpx executable');
    }
    let verified: string;
    try {
      verified = realpathSync.native(sealedExecutable);
    } catch (cause) {
      throw new ArcError('runner_unconfigured', 'The sealed ARC release acpx executable is unavailable', { cause });
    }
    const configured = this.options.acpxCommand?.trim();
    if (!configured) return verified;
    let requested: string;
    try {
      requested = realpathSync.native(configured);
    } catch (cause) {
      throw new ArcError('runner_unconfigured', 'Configured acpx executable is unavailable', { cause });
    }
    if (requested !== verified) {
      throw new ArcError('runner_unconfigured', 'Configured acpx executable does not match the sealed release');
    }
    return verified;
  }

  private spawnDetachedSupervisor(projectRoot: string, requestPath: string): number {
    const child = spawn(
      this.supervisorCommand.command,
      [...this.supervisorCommand.args, requestPath],
      {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    if (!child.pid) {
      throw new ArcError('runner_failure', 'Could not start the official AutoResearchClaw supervisor');
    }
    // Its own process group is what makes group-wide pause/resume/cancel safe.
    child.unref();
    return child.pid;
  }

  /**
   * The parent must not report "running" until the detached process has claimed
   * the durable state. Otherwise a fast pipeline could publish a terminal state
   * that the parent then overwrites with a stale "starting" record.
   */
  private async awaitRegistration(supervisorPid: number, statePath: string): Promise<void> {
    const deadline = Date.now() + this.registrationTimeoutMs;
    while (Date.now() < deadline) {
      const state = readRunnerState(statePath);
      if (state.supervisor_pid === supervisorPid) return;
      if (state.supervisor_pid !== 0) {
        this.signalGroup(supervisorPid, 'SIGTERM');
        throw new ArcError('runner_failure', 'Official AutoResearchClaw supervisor registered an unexpected identity');
      }
      if (!processAlive(supervisorPid)) break;
      await delay(10);
    }
    this.signalGroup(supervisorPid, 'SIGTERM');
    throw new ArcError('runner_failure', 'Official AutoResearchClaw supervisor did not register its process identity');
  }

  private signalGroup(supervisorPid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-supervisorPid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        throw new ArcError('runner_failure', `Could not signal the official ARC process group: ${code ?? error}`);
      }
    }
  }

  /**
   * PID reuse would otherwise let an unrelated process inherit control of a
   * run, so a live supervisor must still be the process we launched.
   */
  private assertProcessIdentity(details: HandleDetails): void {
    if (process.platform === 'win32') return;
    let command: string;
    try {
      command = execFileSync('ps', ['-p', String(details.supervisorPid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 2_000,
      });
    } catch (cause) {
      throw new ArcError('runner_failure', 'Could not verify the official ARC supervisor identity', { cause });
    }
    // A detached child can briefly stay a zombie until PID 1 reaps it. It
    // cannot execute or be reused in that window, so durable state stays
    // authoritative and the next poll observes terminal.
    if (command.includes('<defunct>')) return;
    const script = this.supervisorCommand.args.at(-1) ?? '';
    if (!command.includes(details.requestPath) || (script && !command.includes(script))) {
      throw new ArcError('runner_failure', 'Official AutoResearchClaw supervisor PID was reused by another process');
    }
  }

  private details(handle: ArcExecutionHandle): HandleDetails {
    const metadata = handle.metadata;
    const details: HandleDetails = {
      runId: stringField(metadata, 'run_id'),
      projectRoot: stringField(metadata, 'project_root'),
      runDir: stringField(metadata, 'run_dir'),
      officialDir: stringField(metadata, 'official_dir'),
      gateDir: stringField(metadata, 'gate_dir'),
      statePath: stringField(metadata, 'state_path'),
      requestPath: stringField(metadata, 'request_path'),
      controlPath: stringField(metadata, 'control_path'),
      supervisorPid: positiveIntegerField(metadata, 'supervisor_pid'),
      releaseId: stringField(metadata, 'release_id'),
    };
    if (handle.id !== handleId(details.runId) || metadata?.runner !== HANDLE_RUNNER) {
      throw new ArcError('runner_failure', 'ARC handle was not created by the official AutoResearchClaw supervisor');
    }
    const root = safeProjectRoot(details.projectRoot);
    for (const candidate of [
      details.runDir,
      details.officialDir,
      details.gateDir,
      details.statePath,
      details.requestPath,
      details.controlPath,
    ]) {
      safeContainedPath(root, candidate);
    }
    return details;
  }
}

function digestOfficialConfig(configPath: string): string {
  const info = lstatSync(configPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw config must be a regular file');
  }
  if (info.size > MAX_OFFICIAL_CONFIG_BYTES) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw config exceeds the size limit');
  }
  return createHash('sha256').update(readFileSync(configPath)).digest('hex');
}

function handleId(runId: string): string {
  return `official-autoresearchclaw-${runId}`;
}

function handleFor(details: HandleDetails): ArcExecutionHandle {
  return {
    id: handleId(details.runId),
    metadata: {
      runner: HANDLE_RUNNER,
      run_id: details.runId,
      project_root: details.projectRoot,
      run_dir: details.runDir,
      official_dir: details.officialDir,
      gate_dir: details.gateDir,
      state_path: details.statePath,
      request_path: details.requestPath,
      control_path: details.controlPath,
      supervisor_pid: details.supervisorPid,
      release_id: details.releaseId,
    },
  };
}

export function parseParameters(
  value: Record<string, unknown> | undefined,
  fallbackMode: string,
): StartParameters {
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
    if (!allowed.has(key)) {
      throw new ArcError('invalid_contract', `Unsupported official AutoResearchClaw parameter: ${key}`);
    }
  }
  const hitlMode = optionalString(parameters.hitl_mode) ?? fallbackMode;
  if (!HITL_MODES.has(hitlMode)) throw new ArcError('invalid_contract', `Unsupported HITL mode: ${hitlMode}`);
  const fromStage = optionalString(parameters.from_stage);
  const toStage = optionalString(parameters.to_stage);
  if (fromStage && !STAGE_NAME.test(fromStage)) throw new ArcError('invalid_contract', 'from_stage is invalid');
  if (toStage && !STAGE_NAME.test(toStage)) throw new ArcError('invalid_contract', 'to_stage is invalid');
  const profile = optionalString(parameters.profile);
  if (profile && !/^[A-Za-z0-9._-]{1,128}$/.test(profile)) {
    throw new ArcError('invalid_contract', 'profile is invalid');
  }
  const configPath = optionalString(parameters.config_path);
  return {
    ...(configPath ? { config_path: configPath } : {}),
    hitl_mode: hitlMode,
    ...(profile ? { profile } : {}),
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
  if (typeof item !== 'string' || !item) {
    throw new ArcError('runner_failure', `ARC handle metadata ${key} is invalid`);
  }
  return item;
}

function positiveIntegerField(value: Record<string, unknown> | undefined, key: string): number {
  const item = value?.[key];
  if (!Number.isSafeInteger(item) || Number(item) < 1) {
    throw new ArcError('runner_failure', `ARC handle metadata ${key} is invalid`);
  }
  return Number(item);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ArcError('invalid_contract', 'Expected a non-empty string parameter');
  }
  return value.trim();
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ArcError('invalid_contract', 'Expected a boolean parameter');
  return value;
}

function cleanToken(value: string, label: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9._+@/-]{1,512}$/.test(token)) {
    throw new ArcError('runner_unconfigured', `${label} is invalid`);
  }
  return token;
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ArcError('runner_unconfigured', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
