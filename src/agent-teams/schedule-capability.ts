import type { RecurringTask, ScheduledTask } from '../scheduler/task-scheduler.js';
import type { AgentTeamExecutionPrincipal } from './governance-capability.js';

/** Exact schedule endpoints that accept a signed engine-session capability. */
export function isAgentTeamCapabilityScheduleRoute(method: string, url: string): boolean {
  if ((method === 'GET' || method === 'POST') && url === '/api/schedule') return true;
  if (method === 'POST' && /^\/api\/schedule\/[^/]+\/(?:pause|resume)$/.test(url)) return true;
  return (method === 'PATCH' || method === 'DELETE') && /^\/api\/schedule\/[^/]+$/.test(url);
}

export function mayManageOwnSchedule(principal: AgentTeamExecutionPrincipal): boolean {
  return principal.role === 'admin' || principal.role === 'pm' || principal.role === 'user';
}

export function matchesScheduleScope(
  principal: AgentTeamExecutionPrincipal,
  task: Pick<ScheduledTask | RecurringTask, 'botName' | 'chatId'>,
): boolean {
  return principal.botName === task.botName && principal.chatId === task.chatId;
}

export function findScheduledTaskInScope(
  id: string,
  principal: AgentTeamExecutionPrincipal,
  tasks: ScheduledTask[],
  recurringTasks: RecurringTask[],
): ScheduledTask | RecurringTask | undefined {
  const task =
    tasks.find((candidate) => candidate.id === id) ?? recurringTasks.find((candidate) => candidate.id === id);
  return task && matchesScheduleScope(principal, task) ? task : undefined;
}
