import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ArcArtifactStore } from './artifact-store.js';
import {
  ARC_INPUT_CONTRACT_VERSION,
  arcExecutionHandleSchema,
  arcRunStatusSchema,
  type ArcExecutionHandle,
  type ArcExecutionInput,
  type ArcOutput,
  type ArcRunRecord,
  type ArcRunStatus,
  validateArcExecutionInput,
} from './contract.js';
import { ArcError, asArcError } from './errors.js';
import type { ArcRunner } from './runner.js';
import { ArcRunStore, type ArcRunListOptions } from './run-store.js';

const nonEmpty = z.string().trim().min(1);

export const arcStartRequestSchema = z
  .object({
    project_id: nonEmpty.max(200),
    project_root: nonEmpty,
    objective: nonEmpty,
    idempotency_key: nonEmpty.max(200),
    run_id: nonEmpty.max(200).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
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
  recoverInterrupted?: boolean;
  now?: () => string;
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
  private readonly artifactPollIntervalMs: number;
  private readonly artifactWaitTimeoutMs: number;
  private readonly now: () => string;
  private disposed = false;

  constructor(
    readonly store: ArcRunStore,
    readonly artifacts: ArcArtifactStore,
    readonly runner: ArcRunner,
    options: ArcCoordinatorOptions = {},
  ) {
    this.artifactPollIntervalMs = options.artifactPollIntervalMs ?? 25;
    this.artifactWaitTimeoutMs = options.artifactWaitTimeoutMs ?? 2_000;
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.recoverInterrupted) this.store.recoverInterruptedRuns(this.now());
  }

  async start(value: unknown): Promise<ArcRunRecord> {
    const request = parsedRequest(arcStartRequestSchema, value, 'ARC start');
    const projectRoot = this.artifacts.canonicalProjectRoot(request.project_root);
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
      now: requestedAt,
    });
    if (!created.created) {
      if (created.run.request_fingerprint !== requestFingerprint) {
        throw new ArcError('run_conflict', 'Idempotency key was already used for a different request', {
          details: { runId: created.run.run_id, projectId: request.project_id },
        });
      }
      return created.run;
    }

    let handle: ArcExecutionHandle;
    try {
      handle = arcExecutionHandleSchema.parse(await this.runner.start(executionInput));
    } catch (error) {
      const failure = asArcError(error);
      return this.store.transition(runId, ['queued'], {
        status: 'failed',
        phase: 'failed',
        error: { code: failure.code, message: failure.message },
        finishedAt: this.now(),
        updatedAt: this.now(),
      });
    }
    const running = this.store.transition(runId, ['queued'], {
      status: 'running',
      phase: 'executing',
      progress: 0.05,
      runnerHandle: handle,
      startedAt: this.now(),
      updatedAt: this.now(),
    });
    this.collect(running);
    return running;
  }

  get(value: unknown): ArcRunRecord {
    const request = parsedRequest(arcRunIdRequestSchema, value, 'ARC get');
    return this.store.requireRun(request.run_id);
  }

  list(value: unknown = {}): ArcRunRecord[] {
    const request = parsedRequest(arcListRequestSchema, value, 'ARC list');
    const options: ArcRunListOptions = {
      ...(request.project_id ? { projectId: request.project_id } : {}),
      ...(request.status ? { status: request.status } : {}),
      ...(request.limit ? { limit: request.limit } : {}),
    };
    return this.store.listRuns(options);
  }

  async pause(value: unknown): Promise<ArcRunRecord> {
    const request = parsedRequest(arcRunIdRequestSchema, value, 'ARC pause');
    const current = this.store.requireRun(request.run_id);
    if (current.status === 'paused') return current;
    if (current.status !== 'running' || !current.runner_handle) {
      throw new ArcError('invalid_transition', `Cannot pause ARC run from ${current.status}`, {
        details: { runId: current.run_id, phase: current.phase },
      });
    }
    await this.runner.pause(current.runner_handle);
    return this.store.transition(current.run_id, ['running'], {
      status: 'paused',
      phase: 'paused',
      updatedAt: this.now(),
    });
  }

  async resume(value: unknown): Promise<ArcRunRecord> {
    const request = parsedRequest(arcRunIdRequestSchema, value, 'ARC resume');
    const current = this.store.requireRun(request.run_id);
    if (current.status === 'running') return current;
    if (current.status !== 'paused' || !current.runner_handle) {
      throw new ArcError('invalid_transition', `Cannot resume ARC run from ${current.status}`, {
        details: { runId: current.run_id, phase: current.phase },
      });
    }
    await this.runner.resume(current.runner_handle);
    const running = this.store.transition(current.run_id, ['paused'], {
      status: 'running',
      phase: 'executing',
      error: null,
      recoveryGeneration: current.recovery_generation + 1,
      updatedAt: this.now(),
    });
    this.collect(running);
    return running;
  }

  async cancel(value: unknown): Promise<ArcRunRecord> {
    const request = parsedRequest(arcRunIdRequestSchema, value, 'ARC cancel');
    const current = this.store.requireRun(request.run_id);
    if (current.status === 'cancelled') return current;
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new ArcError('invalid_transition', `Cannot cancel ARC run from ${current.status}`, {
        details: { runId: current.run_id },
      });
    }
    if (current.runner_handle) await this.runner.cancel(current.runner_handle);
    return this.store.transition(current.run_id, [current.status], {
      status: 'cancelled',
      phase: 'cancelled',
      finishedAt: this.now(),
      updatedAt: this.now(),
    });
  }

  readOutput(runId: string): ArcOutput {
    const run = this.store.requireRun(runId);
    return this.artifacts.readOutput({
      projectId: run.project_id,
      projectRoot: run.project_root,
      runId: run.run_id,
    });
  }

  async waitForTerminal(runId: string, timeoutMs = 5_000): Promise<ArcRunRecord> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const run = this.store.requireRun(runId);
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

  private collect(run: ArcRunRecord): void {
    if (!run.runner_handle || this.collections.has(run.run_id)) return;
    const promise = this.settle(run, run.runner_handle).finally(() => {
      this.collections.delete(run.run_id);
    });
    this.collections.set(run.run_id, promise);
  }

  private async settle(run: ArcRunRecord, handle: ArcExecutionHandle): Promise<void> {
    try {
      await this.runner.collect(handle);
      if (this.disposed) return;
      const output = await this.artifacts.waitForOutput({
        projectId: run.project_id,
        projectRoot: run.project_root,
        runId: run.run_id,
        timeoutMs: this.artifactWaitTimeoutMs,
        pollIntervalMs: this.artifactPollIntervalMs,
      });
      if (this.disposed) return;
      const current = this.store.requireRun(run.run_id);
      if (current.status !== 'running') return;
      this.store.transition(run.run_id, ['running'], {
        status: output.status,
        phase: output.status === 'failed' ? 'failed' : 'completed',
        progress: 1,
        outputStatus: output.status,
        error: null,
        finishedAt: this.now(),
        updatedAt: this.now(),
      });
    } catch (error) {
      if (this.disposed) return;
      const failure = asArcError(error);
      const current = this.store.getRun(run.run_id);
      if (!current || current.status !== 'running') return;
      this.store.transition(run.run_id, ['running'], {
        status: 'failed',
        phase: 'failed',
        error: { code: failure.code, message: failure.message },
        finishedAt: this.now(),
        updatedAt: this.now(),
      });
    }
  }
}
