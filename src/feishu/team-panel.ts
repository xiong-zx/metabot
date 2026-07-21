/**
 * Compact Agent Team panel shared by the v1 and v2 Feishu card builders.
 *
 * The panel used to print the full team id plus one line per agent (including
 * every idle one) and every open/recent task, which turned into a permanent
 * noisy header on cards that happened to carry a teamState. Users only need to
 * know (a) that a team exists, (b) how many of its agents are actually busy,
 * and (c) a sentence about what the busy ones are doing. Everything else
 * collapses to a single line.
 */
import type { TeamMember, TeamState, TeamTask } from '../types.js';
import { truncate } from './card-builder-utils.js';

/** Max working-agent activity lines rendered under the header. */
const MAX_ACTIVITY_LINES = 2;
/** Max open (pending/in-progress) task lines rendered when nobody is working. */
const MAX_OPEN_TASK_LINES = 2;

export function agentsForTeamState(teamState: TeamState): TeamMember[] {
  return teamState.agents ?? teamState.teammates ?? [];
}

export function agentForTeamTask(task: TeamTask): string | undefined {
  return task.agent ?? task.teammate;
}

/**
 * Render the compact team panel, or `undefined` when there is nothing worth
 * showing (no agents and no tasks).
 */
export function buildTeamPanelMarkdown(teamState: TeamState | undefined): string | undefined {
  if (!teamState) return undefined;
  const agents = agentsForTeamState(teamState);
  const tasks = teamState.tasks ?? [];
  if (agents.length === 0 && tasks.length === 0) return undefined;

  const working = agents.filter((a) => a.status === 'working');
  const pending = tasks.filter((t) => t.status === 'pending');
  const inProgress = tasks.filter((t) => t.status === 'in_progress');
  const done = tasks.filter((t) => t.status === 'completed');

  const label = teamLabel(teamState.name);
  const lines: string[] = [];

  if (working.length > 0) {
    lines.push(`🧑‍🤝‍🧑 **Team**${label} — ⏳ ${working.length}/${agents.length} working`);
    for (const agent of working.slice(0, MAX_ACTIVITY_LINES)) {
      lines.push(`· \`${agent.name}\` ${agent.lastSubject ? truncate(agent.lastSubject, 70) : 'working'}`);
    }
    const hidden = working.length - MAX_ACTIVITY_LINES;
    if (hidden > 0) lines.push(`· +${hidden} more working`);
  } else {
    // Nobody is working: collapse the whole team to one status line.
    const idleSummary = agents.length > 0 ? `💤 idle (${agents.length} agent${agents.length === 1 ? '' : 's'})` : '💤 idle';
    lines.push(`🧑‍🤝‍🧑 **Team**${label} — ${idleSummary}`);
  }

  const openSummary = summarizeTasks(pending.length, inProgress.length, done.length);
  if (openSummary) lines.push(`· ${openSummary}`);

  // With no agent actively working, a couple of open task subjects are the
  // only signal about what the team is waiting on — worth the two lines.
  if (working.length === 0) {
    const open = [...inProgress, ...pending].slice(0, MAX_OPEN_TASK_LINES);
    for (const task of open) {
      const owner = agentForTeamTask(task);
      const icon = task.status === 'in_progress' ? '⏳' : '◻️';
      lines.push(`· ${icon} ${truncate(task.subject, 70)}${owner ? ` → \`${owner}\`` : ''}`);
    }
  }

  return lines.join('\n');
}

/** `research-codex@chat:oc_abc…` renders as just `research-codex`. */
function teamLabel(name: string | undefined): string {
  if (!name) return '';
  const short = name.split('@')[0] || name;
  return ` \`${truncate(short, 32)}\``;
}

function summarizeTasks(pending: number, inProgress: number, done: number): string | undefined {
  const parts: string[] = [];
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (done > 0) parts.push(`${done} done`);
  return parts.length > 0 ? `**Tasks:** ${parts.join(' · ')}` : undefined;
}
