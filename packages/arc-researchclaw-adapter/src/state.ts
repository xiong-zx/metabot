import { existsSync, readFileSync } from 'node:fs';

import { ArcError } from '@xvirobotics/arc-mcp';

import { readJsonFile } from './files.js';
import { RUNNER_STATE_VERSION, type OfficialRunnerState } from './types.js';

export function readRunnerState(statePath: string): OfficialRunnerState {
  if (!existsSync(statePath)) throw new ArcError('runner_failure', 'Official ARC runner state is missing');
  const value = readJsonFile(statePath) as Partial<OfficialRunnerState> | null;
  if (
    !value ||
    value.contract_version !== RUNNER_STATE_VERSION ||
    typeof value.run_id !== 'string' ||
    !['starting', 'running', 'completed', 'failed', 'cancelled'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.supervisor_pid) ||
    (value.child_pid !== null && !Number.isSafeInteger(value.child_pid))
  ) {
    throw new ArcError('runner_failure', 'Official ARC runner state is invalid');
  }
  return value as OfficialRunnerState;
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      if (/^State:\s+[ZX]/m.test(status)) return false;
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
