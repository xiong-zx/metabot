import { existsSync, readFileSync } from 'node:fs';

import type { BoundedBudgetEvidence } from './bounded-execution.js';
import type { ArcExecutionInput } from './contract.js';
import { ArcError } from './errors.js';
import { readJsonFile } from './official-paths.js';
import type { ArcRunnerResult } from './runner.js';

export const OFFICIAL_RUNNER_STATE_VERSION = 'metabot.arc.official-runner-state.v1' as const;
export const OFFICIAL_SUPERVISOR_REQUEST_VERSION = 'metabot.arc.official-supervisor-request.v1' as const;
export const OFFICIAL_HITL_BRIDGE_CONTRACT_VERSION = 'metabot.arc.official-hitl-bridge.v1' as const;

export type OfficialRunnerStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface OfficialRunnerState {
  contract_version: typeof OFFICIAL_RUNNER_STATE_VERSION;
  run_id: string;
  status: OfficialRunnerStatus;
  /** 0 until the detached supervisor registers itself. */
  supervisor_pid: number;
  child_pid: number | null;
  official_version: string;
  official_revision: string;
  release_id: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
}

export interface OfficialSupervisorRequest {
  contract_version: typeof OFFICIAL_SUPERVISOR_REQUEST_VERSION;
  input: ArcExecutionInput;
  python: string;
  runner_path: string;
  compat_path: string;
  config_path: string;
  /** SHA-256 of the exact config file immediately before the official child is spawned. */
  config_sha256: string;
  run_dir: string;
  gate_dir: string;
  state_path: string;
  request_path: string;
  control_path: string;
  mode: string;
  profile?: string;
  from_stage?: string;
  to_stage?: string;
  auto_approve: boolean;
  skip_preflight: boolean;
  skip_noncritical_stage: boolean;
  no_graceful_degradation: boolean;
  incremental_experiment: boolean;
  official_version: string;
  official_revision: string;
  release_id: string;
  stage_count: number;
  poll_interval_ms: number;
  /**
   * Present only for a run the driver proved bounded before spawning it. Its
   * absence is the historical unbudgeted shape and is never read as "bounded",
   * so records written before this field existed keep their exact meaning.
   */
  budget_policy?: BoundedBudgetEvidence;
}

export function readRunnerState(statePath: string): OfficialRunnerState {
  if (!existsSync(statePath)) {
    throw new ArcError('runner_failure', 'Official AutoResearchClaw runner state is missing');
  }
  const value = readJsonFile(statePath) as Partial<OfficialRunnerState> | null;
  if (
    !value ||
    value.contract_version !== OFFICIAL_RUNNER_STATE_VERSION ||
    typeof value.run_id !== 'string' ||
    !['starting', 'running', 'completed', 'failed', 'cancelled'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.supervisor_pid) ||
    (value.supervisor_pid as number) < 0 ||
    (value.child_pid !== null && !Number.isSafeInteger(value.child_pid)) ||
    typeof value.official_revision !== 'string' ||
    typeof value.release_id !== 'string'
  ) {
    throw new ArcError('runner_failure', 'Official AutoResearchClaw runner state is invalid');
  }
  return value as OfficialRunnerState;
}

export function readSupervisorRequest(requestPath: string): OfficialSupervisorRequest {
  const value = readJsonFile(requestPath) as Partial<OfficialSupervisorRequest> | null;
  if (
    !value ||
    value.contract_version !== OFFICIAL_SUPERVISOR_REQUEST_VERSION ||
    !value.input ||
    typeof value.python !== 'string' ||
    !/^[a-f0-9]{64}$/.test(String(value.config_sha256)) ||
    typeof value.run_dir !== 'string' ||
    typeof value.gate_dir !== 'string' ||
    typeof value.state_path !== 'string' ||
    typeof value.request_path !== 'string' ||
    typeof value.control_path !== 'string' ||
    typeof value.release_id !== 'string' ||
    !Number.isSafeInteger(value.stage_count)
  ) {
    throw new ArcError('runner_failure', 'Official AutoResearchClaw supervisor request is invalid');
  }
  return value as OfficialSupervisorRequest;
}

export function terminalRunnerResult(status: OfficialRunnerStatus): ArcRunnerResult | undefined {
  if (status === 'completed' || status === 'failed') return { state: 'finished' };
  if (status === 'cancelled') return { state: 'cancelled' };
  return undefined;
}

/**
 * A zombie is not alive: it can no longer execute and its PID cannot be reused
 * until it is reaped, so treating it as dead keeps recovery from waiting
 * forever on a process that already published its terminal state.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  if (process.platform === 'linux') {
    try {
      if (/^State:\s+[ZX]/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'))) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
