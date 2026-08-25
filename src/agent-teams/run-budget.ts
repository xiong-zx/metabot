import { createHash } from 'node:crypto';

const PERMISSION_DENIAL = /\b(permission denied|not allowed|requires? (?:a )?permission|tool .* denied)\b/iu;

export interface AgentTeamExecutionLimits {
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  repeatedOutputLimit: number;
  permissionDenialLimit: number;
  sameFailureLimit: number;
  failedRunLimit: number;
}

export const DEFAULT_AGENT_TEAM_EXECUTION_LIMITS: AgentTeamExecutionLimits = {
  maxTurns: 50,
  maxBudgetUsd: 3,
  timeoutMs: 2 * 60 * 60_000,
  idleTimeoutMs: 15 * 60_000,
  repeatedOutputLimit: 8,
  permissionDenialLimit: 3,
  sameFailureLimit: 2,
  failedRunLimit: 3,
};

export class AgentTeamRunBudget {
  private lastOutputFingerprint?: string;
  private repeatedOutputCount = 0;
  private readonly permissionFingerprints = new Map<string, number>();
  private terminalReason?: string;

  constructor(private readonly limits: AgentTeamExecutionLimits) {}

  observe(output: string): string | undefined {
    if (this.terminalReason) return this.terminalReason;
    const normalized = output.trim();
    if (!normalized) return undefined;
    const fingerprint = digest(normalized);
    if (fingerprint === this.lastOutputFingerprint) this.repeatedOutputCount += 1;
    else {
      this.lastOutputFingerprint = fingerprint;
      this.repeatedOutputCount = 1;
    }
    if (this.repeatedOutputCount >= this.limits.repeatedOutputLimit) {
      this.terminalReason = `No-progress budget exceeded after ${this.repeatedOutputCount} repeated updates`;
      return this.terminalReason;
    }
    if (PERMISSION_DENIAL.test(normalized)) {
      const count = (this.permissionFingerprints.get(fingerprint) ?? 0) + 1;
      this.permissionFingerprints.set(fingerprint, count);
      if (count >= this.limits.permissionDenialLimit) {
        this.terminalReason = `Permission-denial budget exceeded after ${count} repeated denials`;
      }
    }
    return this.terminalReason;
  }
}

export function resolveAgentTeamExecutionLimits(
  overrides: Partial<AgentTeamExecutionLimits> = {},
  env: NodeJS.ProcessEnv = process.env,
): AgentTeamExecutionLimits {
  return {
    maxTurns: positive(overrides.maxTurns ?? env.METABOT_AGENT_TEAM_MAX_TURNS, DEFAULT_AGENT_TEAM_EXECUTION_LIMITS.maxTurns),
    maxBudgetUsd: positiveNumber(
      overrides.maxBudgetUsd ?? env.METABOT_AGENT_TEAM_MAX_BUDGET_USD,
      DEFAULT_AGENT_TEAM_EXECUTION_LIMITS.maxBudgetUsd,
    ),
    timeoutMs: positive(overrides.timeoutMs ?? env.METABOT_AGENT_TEAM_TIMEOUT_MS, DEFAULT_AGENT_TEAM_EXECUTION_LIMITS.timeoutMs),
    idleTimeoutMs: positive(
      overrides.idleTimeoutMs ?? env.METABOT_AGENT_TEAM_IDLE_TIMEOUT_MS,
      DEFAULT_AGENT_TEAM_EXECUTION_LIMITS.idleTimeoutMs,
    ),
    repeatedOutputLimit: positive(
      overrides.repeatedOutputLimit ?? env.METABOT_AGENT_TEAM_REPEATED_OUTPUT_LIMIT,
      DEFAULT_AGENT_TEAM_EXECUTION_LIMITS.repeatedOutputLimit,
    ),
    permissionDenialLimit: positive(
      overrides.permissionDenialLimit ?? env.METABOT_AGENT_TEAM_PERMISSION_DENIAL_LIMIT,
      DEFAULT_AGENT_TEAM_EXECUTION_LIMITS.permissionDenialLimit,
    ),
    sameFailureLimit: positive(
      overrides.sameFailureLimit ?? env.METABOT_AGENT_TEAM_SAME_FAILURE_LIMIT,
      DEFAULT_AGENT_TEAM_EXECUTION_LIMITS.sameFailureLimit,
    ),
    failedRunLimit: positive(
      overrides.failedRunLimit ?? env.METABOT_AGENT_TEAM_FAILED_RUN_LIMIT,
      DEFAULT_AGENT_TEAM_EXECUTION_LIMITS.failedRunLimit,
    ),
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function positive(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
