import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ArcArtifactStore } from './artifact-store.js';
import {
  ARC_INPUT_CONTRACT_VERSION,
  arcExecutionHandleSchema,
  arcObjectiveSchema,
  arcParametersSchema,
  arcRunStatusSchema,
  type ArcExecutionInput,
  type ArcOutput,
  type ArcRunRecord,
  type ArcRunOriginator,
  type ArcRunStatus,
  validateArcExecutionInput,
} from './contract.js';
import { ArcError, asArcError } from './errors.js';
import type { ArcRunner, ArcRunnerResult } from './runner.js';
import { validateArcRunnerResult } from './runner.js';
import { ArcRunStore, type ArcRunListOptions, type ArcRunPatch } from './run-store.js';
import { ArcProjectScope } from './scope-policy.js';

const nonEmpty = z.string().trim().min(1);

export const arcStartRequestSchema = z
  .object({
    project_id: nonEmpty.max(200),
    project_root: nonEmpty.max(4096),
    objective: arcObjectiveSchema,
    idempotency_key: nonEmpty.max(200),
    run_id: nonEmpty.max(200).optional(),
    parameters: arcParametersSchema.optional(),
  })
  .strict();

export const arcRunIdRequestSchema = z.object({ run_id: nonEmpty.max(200) }).strict();

export const arcListRequestSchema = z
  .object({
    project_id: nonEmpty.max(200).optional(),
    status: arcRunStatusSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ArcStartRequest = z.infer<typeof arcStartRequestSchema>;
export type ArcListRequest = z.infer<typeof arcListRequestSchema>;

export interface ArcCoordinatorOptions {
  artifactPollIntervalMs?: number;
  artifactWaitTimeoutMs?: number;
  now?: () => string;
  scope: ArcProjectScope;
}

const TERMINAL_STATUSES = new Set<ArcRunStatus>(['completed', 'partial', 'failed', 'cancelled']);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function parsedRequest<T>(schema: z.ZodType<T>, value: unknown, kind: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ArcError('invalid_contract', `Invalid ${kind} request`, {
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
}

export class ArcCoordinator {
  private readonly collections = new Map<string, Promise<void>>();
  private readonly launches = new Map<string, Promise<ArcRunRecord>>();
  private readonly artifactPollIntervalMs: number;
  private readonly artifactWaitTimeoutMs: number;
  private readonly now: () => string;
  private readonly scope: ArcProjectScope;
  private recoveryPromise?: Promise<ArcRunRecord[]>;
  private disposed = false;

  constructor(
    readonly store: ArcRunStore,
    readonly artifacts: ArcArtifactStore,
    readonly runner: ArcRunner,
    options: ArcCoordinatorOptions,
  ) {
    this.artifactPollIntervalMs = options.artifactPollIntervalMs ?? 25;
    this.artifactWaitTimeoutMs = options.artifactWaitTimeoutMs ?? 2_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.scope = options.scope;
  }

  async recover(): Promise<ArcRunRecord[]> {
    if (!this.recoveryPromise) this.recoveryPromise = this.performRecovery();
    return this.recoveryPromise;
  }

  async start(
    value: unknown,
    originator?: ArcRunOriginator,
    authorizingCapability?: string,
  ): Promise<ArcRunRecord> {
    const request = parsedRequest(arcStartRequestSchema, value, 'ARC start');
    const projectRoot = this.scope.authorizeStart(request.project_id, request.project_root, this.artifacts);
    const runId = request.run_id ?? randomUUID();
    const artifactPath = this.artifacts.outputRelativePath(runId);
    const requestFingerprint = fingerprint({
      project_id: request.project_id,
      project_root: projectRoot,
      objective: request.objective,
      requested_run_id: request.run_id ?? null,
      parameters: request.parameters ?? {},
    });
    const requestedAt = this.now();
    const executionInput = validateArcExecutionInput({
      contract_version: ARC_INPUT_CONTRACT_VERSION,
      project_id: request.project_id,
      run_id: runId,
      objective: request.objective,
      project_root: projectRoot,
      artifact_path: artifactPath,
      requested_at: requestedAt,
      ...(request.parameters ? { parameters: request.parameters } : {}),
    });
    const created = this.store.createRun({
      runId,
      projectId: request.project_id,
      projectRoot,
      objective: request.objective,
      idempotencyKey: request.idempotency_key,
      requestFingerprint,
      artifactPath,
      executionInput,
      ...(originator ? { originator } : {}),
      ...(authorizingCapability ? { authorizingCapability } : {}),
      now: requestedAt,
    });
    const scopedRun = this.scope.authorizeRun(created.run);
    if (!created.created && scopedRun.request_fingerprint !== requestFingerprint) {
      throw new ArcError('run_conflict', 'Idempotency key was already used for a different request', {
        details: { runId: scopedRun.run_id, projectId: request.project_id },
      });
    }
    if (scopedRun.status === 'queued') {
      const storedInput = this.store.getExecutionInput(scopedRun.run_id) ?? executionInput;
      return this.launchQueued(scopedRun, storedInput, false);
    }
    if (scopedRun.status === 'running') this.ensureCollection(scopedRun);
    return scopedRun;
  }

  get(value: unknown): ArcRunRecord {
    const request = parsedRequest(arcRunIdRequestSchema, value, 'ARC get');
    return this.requireScopedRun(request.run_id);
  }

  list(value: unknown = {}): ArcRunRecord[] {
    const request = parsedRequest(arcListRequestSchema, value, 'ARC list');
    const projectId = this.scope.authorizeRequestedProjectId(request.project_id);
    const options: ArcRunListOptions = {
      projectRoots: this.scope.allowedProjectRoots,
      ...(projectId ? { projectId } : {}),
      ...(request.status ? { status: request.status } : {}),
      ...(request.limit ? { limit: request.limit } : {}),
    };
    return this.store.listRuns(options).map((run) => this.scope.authorizeRun(run));
  }

  async pause(value: unknown): Promise<ArcRunRecord> {
    const request = parsedRequest(arcRunIdRequestSchema, value, 'ARC pause');
    const current = this.requireScopedRun(request.run_id);
    if (TERMINAL_STATUSES.has(current.status) || current.status === 'paused') return current;
    if (current.status !== 'running' || !current.runner_handle) {
      throw new ArcError('invalid_transition', `Cannot pause ARC run from ${current.status}`, {
        details: { runId: current.run_id, phase: current.phase },
      });
    }
    let result: ArcRunnerResult;
    try {
      result = validateArcRunnerResult(await this.runner.pause(current.runner_handle), 'pause');
    } catch (error) {
      const latest = this.requireScopedRun(current.run_id);
      if (TERMINAL_STATUSES.has(latest.status) || latest.status === 'paused') return latest;
      throw error;
    }
    return this.synchronizeRunnerState(current.run_id, result, 'pause');
  }

  async resume(value: unknown): Promise<ArcRunRecord> {
    const request = parsedRequest(arcRunIdRequestSchema, value, 'ARC resume');
    const current = this.requireScopedRun(request.run_id);
    if (TERMINAL_STATUSES.has(current.status) || current.status === 'running') return current;
    if (current.status !== 'paused' || !current.runner_handle) {
      throw new ArcError('invalid_transition', `Cannot resume ARC run from ${current.status}`, {
        details: { runId: current.run_id, phase: current.phase },
      });
    }
    let result: ArcRunnerResult;
    try {
      result = validateArcRunnerResult(await this.runner.resume(current.runner_handle), 'resume');
    } catch (error) {
      const latest = this.requireScopedRun(current.run_id);
      if (TERMINAL_STATUSES.has(latest.status) || latest.status === 'running') return latest;
      throw error;
    }
    return this.synchronizeRunnerState(current.run_id, result, 'resume');
  }

  async cancel(value: unknown): Promise<ArcRunRecord> {
    const request = parsedRequest(arcRunIdRequestSchema, value, 'ARC cancel');
    const current = this.requireScopedRun(request.run_id);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    if (!current.runner_handle) {
      return this.transitionConverged(current.run_id, [current.status], {
        status: 'cancelled',
        phase: 'cancelled',
        finishedAt: this.now(),
        updatedAt: this.now(),
      });
    }
    let result: ArcRunnerResult;
    try {
      result = validateArcRunnerResult(await this.runner.cancel(current.runner_handle), 'cancel');
    } catch (error) {
      const latest = this.requireScopedRun(current.run_id);
      if (TERMINAL_STATUSES.has(latest.status)) return latest;
      throw error;
    }
    return this.synchronizeRunnerState(current.run_id, result, 'cancel');
  }

  readOutput(runId: string): ArcOutput {
    const run = this.requireScopedRun(runId);
    return this.artifacts.readOutput({
      projectId: run.project_id,
      projectRoot: run.project_root,
      runId: run.run_id,
    });
  }

  async waitForTerminal(runId: string, timeoutMs = 5_000): Promise<ArcRunRecord> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const run = this.requireScopedRun(runId);
      if (TERMINAL_STATUSES.has(run.status)) return run;
      if (Date.now() >= deadline) {
        throw new ArcError('runner_failure', 'Timed out waiting for ARC run to finish', {
          details: { runId },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, this.artifactPollIntervalMs));
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  private async performRecovery(): Promise<ArcRunRecord[]> {
    const runs = this.store.listRecoverableRuns({
      projectId: this.scope.fixedProjectId,
      projectRoots: this.scope.allowedProjectRoots,
    });
    const recovered: ArcRunRecord[] = [];
    for (const candidate of runs) {
      const run = this.scope.authorizeRun(candidate);
      if (run.status === 'queued') {
        const input = this.store.getExecutionInput(run.run_id);
        if (!input) {
          recovered.push(
            this.recordOperationalFailure(
              run.run_id,
              ['queued'],
              'recovery_failed',
              new ArcError('runner_failure', 'Queued run has no durable execution input'),
            ),
          );
          continue;
        }
        recovered.push(await this.launchQueued(run, input, true));
        continue;
      }
      recovered.push(await this.recoverRunning(run));
    }
    return recovered;
  }

  private launchQueued(run: ArcRunRecord, input: ArcExecutionInput, recovery: boolean): Promise<ArcRunRecord> {
    const existing = this.launches.get(run.run_id);
    if (existing) return existing;
    const promise = this.startQueued(run, input, recovery).finally(() => {
      this.launches.delete(run.run_id);
    });
    this.launches.set(run.run_id, promise);
    return promise;
  }

  private async startQueued(run: ArcRunRecord, input: ArcExecutionInput, recovery: boolean): Promise<ArcRunRecord> {
    try {
      const handle = arcExecutionHandleSchema.parse(await this.runner.start(input));
      const latest = this.requireScopedRun(run.run_id);
      if (latest.status !== 'queued') return latest;
      const running = this.transitionConverged(run.run_id, ['queued'], {
        status: 'running',
        phase: recovery ? 'recovered_executing' : 'executing',
        progress: Math.max(latest.progress, 0.05),
        runnerHandle: handle,
        error: null,
        recoveryGeneration: recovery ? latest.recovery_generation + 1 : latest.recovery_generation,
        startedAt: latest.started_at ?? this.now(),
        updatedAt: this.now(),
      });
      this.ensureCollection(running);
      return running;
    } catch (error) {
      const latest = this.requireScopedRun(run.run_id);
      if (latest.status !== 'queued') return latest;
      return this.recordOperationalFailure(
        run.run_id,
        ['queued'],
        recovery ? 'recovery_failed' : 'start_failed',
        error,
      );
    }
  }

  private async recoverRunning(run: ArcRunRecord): Promise<ArcRunRecord> {
    if (!run.runner_handle) {
      return this.recordOperationalFailure(
        run.run_id,
        ['running'],
        'recovery_failed',
        new ArcError('runner_failure', 'Running run has no durable runner handle'),
      );
    }
    try {
      const result = validateArcRunnerResult(await this.runner.recover(run.runner_handle), 'recovery probe');
      return this.synchronizeRunnerState(run.run_id, result, 'recovery');
    } catch (error) {
      const latest = this.requireScopedRun(run.run_id);
      if (TERMINAL_STATUSES.has(latest.status)) return latest;
      const failed = this.recordOperationalFailure(run.run_id, ['running'], 'recovery_failed', error);
      this.ensureCollection(failed);
      return failed;
    }
  }

  private async synchronizeRunnerState(
    runId: string,
    result: ArcRunnerResult,
    operation: 'pause' | 'resume' | 'cancel' | 'collect' | 'recovery',
  ): Promise<ArcRunRecord> {
    const current = this.requireScopedRun(runId);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    if (result.state === 'finished') return this.finalizeFinished(runId);
    if (result.state === 'cancelled') {
      return this.transitionConverged(runId, [current.status], {
        status: 'cancelled',
        phase: 'cancelled',
        finishedAt: this.now(),
        updatedAt: this.now(),
      });
    }
    if (result.state === 'paused') {
      if (current.status === 'paused') return current;
      if (current.status !== 'running') return current;
      return this.transitionConverged(runId, ['running'], {
        status: 'paused',
        phase: operation === 'recovery' ? 'restart_recovered' : 'paused',
        error: null,
        recoveryGeneration: operation === 'recovery' ? current.recovery_generation + 1 : current.recovery_generation,
        updatedAt: this.now(),
      });
    }
    if (result.state === 'running') {
      if (operation === 'recovery' && current.status === 'running') {
        const recovered = this.transitionConverged(runId, ['running'], {
          phase: 'recovered_executing',
          error: null,
          recoveryGeneration: current.recovery_generation + 1,
          updatedAt: this.now(),
        });
        this.ensureCollection(recovered);
        return recovered;
      }
      let running = current;
      if (current.status === 'paused') {
        running = this.transitionConverged(runId, ['paused'], {
          status: 'running',
          phase: 'executing',
          error: null,
          recoveryGeneration: operation === 'resume' ? current.recovery_generation + 1 : current.recovery_generation,
          updatedAt: this.now(),
        });
      }
      this.ensureCollection(running);
      return running;
    }
    return current;
  }

  private ensureCollection(run: ArcRunRecord): void {
    if (!run.runner_handle || run.status !== 'running' || this.collections.has(run.run_id) || this.disposed) {
      return;
    }
    const promise = this.settle(run).finally(() => {
      this.collections.delete(run.run_id);
    });
    this.collections.set(run.run_id, promise);
  }

  private async settle(run: ArcRunRecord): Promise<void> {
    try {
      const result = validateArcRunnerResult(await this.runner.collect(run.runner_handle!), 'collect');
      if (this.disposed) return;
      if (result.state !== 'finished' && result.state !== 'cancelled') {
        throw new ArcError('runner_failure', 'ARC runner collect returned before terminal state');
      }
      await this.synchronizeRunnerState(run.run_id, result, 'collect');
    } catch (error) {
      if (this.disposed) return;
      const current = this.store.getRun(run.run_id);
      if (!current) return;
      try {
        this.scope.authorizeRun(current);
      } catch {
        return;
      }
      if (TERMINAL_STATUSES.has(current.status) || current.status === 'paused') return;
      this.recordOperationalFailure(run.run_id, ['running'], 'collect_failed', error);
    }
  }

  private async finalizeFinished(runId: string): Promise<ArcRunRecord> {
    const current = this.requireScopedRun(runId);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    try {
      const output = await this.artifacts.waitForOutput({
        projectId: current.project_id,
        projectRoot: current.project_root,
        runId: current.run_id,
        timeoutMs: this.artifactWaitTimeoutMs,
        pollIntervalMs: this.artifactPollIntervalMs,
      });
      const latest = this.requireScopedRun(runId);
      if (TERMINAL_STATUSES.has(latest.status)) return latest;
      return this.transitionConverged(runId, [latest.status], {
        status: output.status,
        phase: output.status,
        progress: 1,
        outputStatus: output.status,
        error: null,
        finishedAt: this.now(),
        updatedAt: this.now(),
      });
    } catch (error) {
      const latest = this.requireScopedRun(runId);
      if (TERMINAL_STATUSES.has(latest.status)) return latest;
      const failure = asArcError(error);
      return this.transitionConverged(runId, [latest.status], {
        status: 'failed',
        phase: 'failed',
        error: { code: failure.code, message: failure.message },
        finishedAt: this.now(),
        updatedAt: this.now(),
      });
    }
  }

  private recordOperationalFailure(
    runId: string,
    expectedStatuses: ArcRunStatus[],
    phase: string,
    error: unknown,
  ): ArcRunRecord {
    const failure = asArcError(error);
    return this.transitionConverged(runId, expectedStatuses, {
      phase,
      error: { code: failure.code, message: failure.message },
      updatedAt: this.now(),
    });
  }

  private transitionConverged(runId: string, expectedStatuses: ArcRunStatus[], patch: ArcRunPatch): ArcRunRecord {
    try {
      return this.scope.authorizeRun(this.store.transition(runId, expectedStatuses, patch));
    } catch (error) {
      if (error instanceof ArcError && (error.code === 'invalid_transition' || error.code === 'run_conflict')) {
        return this.requireScopedRun(runId);
      }
      throw error;
    }
  }

  private requireScopedRun(runId: string): ArcRunRecord {
    return this.scope.authorizeRun(this.store.requireRun(runId));
  }
}
