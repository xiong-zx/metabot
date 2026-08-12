import type { ArcExecutionInput } from '@xvirobotics/arc-mcp';

export const RUNNER_STATE_VERSION = 'metabot.researchclaw.runner-state.v1' as const;
export const SUPERVISOR_REQUEST_VERSION = 'metabot.researchclaw.supervisor-request.v1' as const;

export type OfficialRunnerStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface OfficialRunnerState {
  contract_version: typeof RUNNER_STATE_VERSION;
  run_id: string;
  status: OfficialRunnerStatus;
  supervisor_pid: number;
  child_pid: number | null;
  official_version: string;
  official_revision: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
}

export interface SupervisorRequest {
  contract_version: typeof SUPERVISOR_REQUEST_VERSION;
  input: ArcExecutionInput;
  python: string;
  config_path: string;
  run_dir: string;
  state_path: string;
  request_path: string;
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
}

export interface OfficialProbe {
  success: boolean;
  version: string;
  stage_count: number;
  package_path: string;
}
