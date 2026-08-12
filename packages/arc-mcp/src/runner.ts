import type { ArcExecutionHandle, ArcExecutionInput } from './contract.js';
import { ArcError } from './errors.js';

export type ArcRunnerState = 'running' | 'paused' | 'finished' | 'cancelled';

export interface ArcRunnerResult {
  state: ArcRunnerState;
}

export interface ArcHitlController {
  getStatus(handle: ArcExecutionHandle): Promise<Record<string, unknown>>;
  approveStage(handle: ArcExecutionHandle, message?: string): Promise<Record<string, unknown>>;
  rejectStage(handle: ArcExecutionHandle, reason: string): Promise<Record<string, unknown>>;
  injectGuidance(handle: ArcExecutionHandle, stage: number, guidance: string): Promise<Record<string, unknown>>;
  viewOutput(handle: ArcExecutionHandle, stage: number, filename?: string): Promise<Record<string, unknown>>;
}

export function validateArcRunnerResult(value: unknown, operation: string): ArcRunnerResult {
  const state = (value as { state?: unknown } | null)?.state;
  if (!['running', 'paused', 'finished', 'cancelled'].includes(String(state))) {
    throw new ArcError('runner_failure', `ARC runner returned an invalid ${operation} state`);
  }
  return { state: state as ArcRunnerState };
}

/**
 * The only execution dependency owned by ARC. The default independent
 * @xvirobotics/arc-researchclaw-adapter implements this interface over the
 * pinned official Python pipeline and its HITL adapter. ARC itself does not
 * import ResearchClaw, Worker Runner, WorkerManager, or bridge code.
 *
 * Contract:
 * - start is idempotent by input.run_id and returns the same durable handle
 *   after retry or process restart.
 * - recover probes a durable handle after coordinator restart without starting,
 *   pausing, resuming, or otherwise changing the underlying execution. It must
 *   return the actual current state and fail closed when the runner cannot
 *   prove that the handle still identifies the same execution.
 * - control methods are idempotent and return the underlying run's current
 *   state. A terminal race returns finished/cancelled instead of throwing.
 * - collect has at most one active call per coordinator process. It remains
 *   pending across pause/resume, and returns finished only after the runner has
 *   atomically written the authoritative output artifact. A new process may
 *   collect the same durable handle after recovery.
 */
export interface ArcRunner {
  /**
   * Optional official AutoResearchClaw HITL surface. The lifecycle shell keeps
   * this generic and delegates every operation to the configured runner.
   */
  readonly hitl?: ArcHitlController;
  start(input: ArcExecutionInput): Promise<ArcExecutionHandle>;
  recover(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
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
