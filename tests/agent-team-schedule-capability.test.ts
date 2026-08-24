import { describe, expect, it } from 'vitest';
import {
  findScheduledTaskInScope,
  isAgentTeamCapabilityScheduleRoute,
  matchesScheduleScope,
  mayManageOwnSchedule,
} from '../src/agent-teams/schedule-capability.js';
import type { AgentTeamExecutionPrincipal } from '../src/agent-teams/governance-capability.js';
import type { RecurringTask, ScheduledTask } from '../src/scheduler/task-scheduler.js';

function principal(role: AgentTeamExecutionPrincipal['role']): AgentTeamExecutionPrincipal {
  return { role, botName: 'pm', chatId: 'oc_own', source: 'execution-capability' };
}

describe('Agent Team schedule capability policy', () => {
  it('accepts only the exact schedule endpoint surface', () => {
    expect(isAgentTeamCapabilityScheduleRoute('GET', '/api/schedule')).toBe(true);
    expect(isAgentTeamCapabilityScheduleRoute('POST', '/api/schedule')).toBe(true);
    expect(isAgentTeamCapabilityScheduleRoute('PATCH', '/api/schedule/task-1')).toBe(true);
    expect(isAgentTeamCapabilityScheduleRoute('DELETE', '/api/schedule/task-1')).toBe(true);
    expect(isAgentTeamCapabilityScheduleRoute('POST', '/api/schedule/task-1/pause')).toBe(true);
    expect(isAgentTeamCapabilityScheduleRoute('POST', '/api/schedule/task-1/resume')).toBe(true);

    expect(isAgentTeamCapabilityScheduleRoute('GET', '/api/schedule/task-1')).toBe(false);
    expect(isAgentTeamCapabilityScheduleRoute('POST', '/api/schedule/task-1/unknown')).toBe(false);
    expect(isAgentTeamCapabilityScheduleRoute('GET', '/api/schedule/../bots')).toBe(false);
  });

  it('allows only admin, user, and PM roles', () => {
    expect(mayManageOwnSchedule(principal('admin'))).toBe(true);
    expect(mayManageOwnSchedule(principal('user'))).toBe(true);
    expect(mayManageOwnSchedule(principal('pm'))).toBe(true);
    expect(mayManageOwnSchedule(principal('manager'))).toBe(false);
    expect(mayManageOwnSchedule(principal('agent'))).toBe(false);
    expect(mayManageOwnSchedule(principal('worker'))).toBe(false);
  });

  it('matches both bot and chat and hides out-of-scope IDs', () => {
    const ownTask = {
      id: 'own', botName: 'pm', chatId: 'oc_own', prompt: 'x', executeAt: 1,
      sendCards: true, status: 'pending', createdAt: 1, retryCount: 0,
    } as ScheduledTask;
    const otherTask = { ...ownTask, id: 'other', chatId: 'oc_other' };
    const recurring = {
      id: 'recurring', botName: 'pm', chatId: 'oc_own', prompt: 'x', cronExpr: '* * * * *',
      timezone: 'UTC', sendCards: true, status: 'active', createdAt: 1, nextExecuteAt: 2,
    } as RecurringTask;
    const user = principal('user');

    expect(matchesScheduleScope(user, ownTask)).toBe(true);
    expect(matchesScheduleScope(user, otherTask)).toBe(false);
    expect(findScheduledTaskInScope('own', user, [ownTask, otherTask], [recurring])).toBe(ownTask);
    expect(findScheduledTaskInScope('recurring', user, [ownTask, otherTask], [recurring])).toBe(recurring);
    expect(findScheduledTaskInScope('other', user, [ownTask, otherTask], [recurring])).toBeUndefined();
  });
});
