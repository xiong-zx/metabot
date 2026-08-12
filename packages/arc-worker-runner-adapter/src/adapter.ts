import {
  ARC_OUTPUT_JSON_SCHEMA,
  ArcError,
  type ArcExecutionHandle,
  type ArcExecutionInput,
  type ArcRunner,
  type ArcRunnerResult,
} from '@xvirobotics/arc-mcp';

import { arcWorkerDedupeKey, renderArcWorkerPrompt } from './prompt.js';
import { WorkerMcpWireClient, type WorkerRecordWire } from './wire.js';

export interface ArcWorkerRunnerAdapterOptions {
  client: WorkerMcpWireClient;
  engine: 'codex' | 'claude' | 'kimi';
  model?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class ArcWorkerRunnerAdapter implements ArcRunner {
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: ArcWorkerRunnerAdapterOptions) {
    this.timeoutMs = bounded(options.timeoutMs ?? 4 * 60 * 60 * 1_000, 'timeoutMs', 1, 7 * 24 * 60 * 60 * 1_000);
    this.idleTimeoutMs = bounded(options.idleTimeoutMs ?? 30 * 60 * 1_000, 'idleTimeoutMs', 1, 24 * 60 * 60 * 1_000);
    this.pollIntervalMs = bounded(options.pollIntervalMs ?? 5_000, 'pollIntervalMs', 10, 60_000);
    if (options.model !== undefined && !options.model.trim()) throw new Error('model cannot be empty');
  }

  async start(input: ArcExecutionInput): Promise<ArcExecutionHandle> {
    const dedupeKey = arcWorkerDedupeKey(input.project_id, input.run_id);
    let result;
    try {
      result = await this.options.client.dispatch({
        workdir: input.project_root,
        prompt: renderArcWorkerPrompt(input),
        engine: this.options.engine,
        ...(this.options.model ? { model: this.options.model } : {}),
        label: `ARC:${input.run_id}`.slice(0, 200),
        dedupe_key: dedupeKey,
        dedupe_ttl_ms: 0,
        retry_terminal: false,
        timeout_ms: this.timeoutMs,
        idle_timeout_ms: this.idleTimeoutMs,
        recovery_policy: { restart: 'manual', idempotent: false },
        output_contract: {
          format: 'json',
          description: `Write autoresearchclaw.output.v2 atomically to ${input.artifact_path}`,
          json_schema: ARC_OUTPUT_JSON_SCHEMA,
        },
      });
    } catch (error) {
      throw runnerFailure('Worker Runner dispatch failed', error);
    }
    if (result.worker.dedupeKey && result.worker.dedupeKey !== dedupeKey) {
      throw runnerFailure('Worker Runner returned a mismatched ARC dedupe key');
    }
    if (result.worker.status === 'recovery_required') throw recoveryFailure(result.worker);
    return { id: result.worker.id, metadata: { dedupe_key: dedupeKey } };
  }

  async pause(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    const worker = await this.status(handle);
    const mapped = mapWorkerState(worker);
    if (mapped.state !== 'running') return mapped;
    throw runnerFailure('pause is not supported while the underlying one-shot worker executes', undefined, {
      workerId: worker.id,
      workerStatus: worker.status,
      pauseSupport: 'not_supported_at_phase',
    });
  }

  async recover(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    return mapWorkerState(await this.status(handle));
  }

  async resume(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    return mapWorkerState(await this.status(handle));
  }

  async cancel(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    try {
      return mapWorkerState(await this.options.client.abort(handle.id));
    } catch (error) {
      throw runnerFailure('Worker Runner cancel failed', error, { workerId: handle.id });
    }
  }

  async collect(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    while (true) {
      const result = mapWorkerState(await this.status(handle));
      if (result.state !== 'running') return result;
      await delay(this.pollIntervalMs);
    }
  }

  private async status(handle: ArcExecutionHandle): Promise<WorkerRecordWire> {
    try {
      const worker = await this.options.client.status(handle.id);
      const expected = handle.metadata?.dedupe_key;
      if (typeof expected === 'string' && worker.dedupeKey && worker.dedupeKey !== expected) {
        throw new Error('Worker Runner handle dedupe key changed');
      }
      return worker;
    } catch (error) {
      if (error instanceof ArcError) throw error;
      throw runnerFailure('Worker Runner status failed', error, { workerId: handle.id });
    }
  }
}

export function mapWorkerState(worker: WorkerRecordWire): ArcRunnerResult {
  switch (worker.status) {
    case 'queued':
    case 'running':
      return { state: 'running' };
    case 'completed':
    case 'failed':
    case 'timed_out':
      return { state: 'finished' };
    case 'aborted':
      return { state: 'cancelled' };
    case 'recovery_required':
      throw recoveryFailure(worker);
  }
}

function recoveryFailure(worker: WorkerRecordWire): ArcError {
  return runnerFailure('Worker Runner requires explicit recovery; ARC will not relaunch it', undefined, {
    workerId: worker.id,
    workerStatus: worker.status,
    ...(worker.terminalReason ? { terminalReason: worker.terminalReason } : {}),
    ...(worker.error ? { workerError: worker.error } : {}),
  });
}

function runnerFailure(
  message: string,
  cause?: unknown,
  details?: Record<string, unknown>,
): ArcError {
  return new ArcError('runner_failure', message, { ...(cause ? { cause } : {}), ...(details ? { details } : {}) });
}

function bounded(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
