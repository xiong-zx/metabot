import { describe, expect, it } from 'vitest';
import {
  AgentTeamRunBudget,
  resolveAgentTeamExecutionLimits,
} from '../src/agent-teams/run-budget.js';

describe('AgentTeamRunBudget', () => {
  it('stops repeated identical output at the configured no-progress bound', () => {
    const limits = resolveAgentTeamExecutionLimits({ repeatedOutputLimit: 3 }, {});
    const budget = new AgentTeamRunBudget(limits);
    expect(budget.observe('same evidence')).toBeUndefined();
    expect(budget.observe('same evidence')).toBeUndefined();
    expect(budget.observe('same evidence')).toContain('No-progress budget exceeded');
  });

  it('stops a repeated permission denial without waiting for the turn ceiling', () => {
    const limits = resolveAgentTeamExecutionLimits({ permissionDenialLimit: 2 }, {});
    const budget = new AgentTeamRunBudget(limits);
    expect(budget.observe('Bash tool permission denied')).toBeUndefined();
    expect(budget.observe('Bash tool permission denied')).toContain('Permission-denial budget exceeded');
  });

  it('uses bounded auditable defaults for invalid environment values', () => {
    const limits = resolveAgentTeamExecutionLimits({}, {
      METABOT_AGENT_TEAM_MAX_TURNS: '0',
      METABOT_AGENT_TEAM_MAX_BUDGET_USD: 'not-a-number',
      METABOT_AGENT_TEAM_TIMEOUT_MS: '-1',
    });
    expect(limits.maxTurns).toBeGreaterThan(0);
    expect(limits.maxBudgetUsd).toBeGreaterThan(0);
    expect(limits.timeoutMs).toBeGreaterThan(0);
  });
});
