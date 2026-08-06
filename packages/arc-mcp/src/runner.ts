import type { ArcExecutionHandle, ArcExecutionInput } from './contract.js';
import { ArcError } from './errors.js';

export type ArcRunnerState = 'running' | 'paused' | 'finished' | 'cancelled';

export interface ArcRunnerResult {
  state: ArcRunnerState;
}

export function validateArcRunnerResult(value: unknown, operation: string): ArcRunnerResult {
  const state = (value as { state?: unknown } | null)?.state;
  if (!['running', 'paused', 'finished', 'cancelled'].includes(String(state))) {
    throw new ArcError('runner_failure', `ARC runner returned an invalid ${operation} state`);
  }
  return { state: state as ArcRunnerState };
}

/**
 * The only execution dependency owned by ARC. A future Worker Runner adapter
 * can implement this interface without ARC importing WorkerManager or bridge code.
 *
 * Contract:
 * - start is idempotent by input.run_id and returns the same durable handle
 *   after retry or process restart.
 * - control methods are idempotent and return the underlying run's current
 *   state. A terminal race returns finished/cancelled instead of throwing.
 * - collect has at most one active call per coordinator process. It remains
 *   pending across pause/resume, and returns finished only after the runner has
 *   atomically written the authoritative output artifact. A new process may
 *   collect the same durable handle after recovery.
 */
export interface ArcRunner {
  start(input: ArcExecutionInput): Promise<ArcExecutionHandle>;
  pause(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
  resume(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
  cancel(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
  collect(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
}

/**
 * A completed ARC artifact is intentionally passive. A future Memory MCP may
 * implement this interface and consume it explicitly; ARC never promotes it.
 */
export interface ArcResultConsumer {
  consume(result: { runId: string; projectId: string; projectRoot: string; artifactPath: string }): Promise<void>;
}
