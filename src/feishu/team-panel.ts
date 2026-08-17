import type { TeamState } from '../types.js';
import { truncate } from './card-builder-utils.js';

const MAX_ACTIVE_MEMBERS = 2;
const MAX_TEAM_LABEL_LENGTH = 32;

export function renderCompactTeamPanel(team: TeamState): string | null {
  if (team.teammates.length === 0 && team.tasks.length === 0) return null;

  const working = team.teammates.filter((member) => member.status === 'working');
  const label = team.name ? `: \`${shortenTeamLabel(team.name)}\`` : '';
  const memberSummary = team.teammates.length > 0 ? ` · ${working.length}/${team.teammates.length} working` : '';
  const lines = [`🧑‍🤝‍🧑 **Team${label}**${memberSummary}`];

  if (team.teammates.length > 0) {
    lines.push('');
    if (working.length === 0) {
      lines.push('💤 All teammates idle');
    } else {
      for (const member of working.slice(0, MAX_ACTIVE_MEMBERS)) {
        const subject = member.lastSubject ? ` — _${truncate(member.lastSubject, 60)}_` : '';
        lines.push(`⏳ \`${member.name}\`${subject}`);
      }
      if (working.length > MAX_ACTIVE_MEMBERS) {
        lines.push(`_+${working.length - MAX_ACTIVE_MEMBERS} more working_`);
      }
    }
  }

  appendTaskSummary(lines, team);
  return lines.join('\n');
}

function shortenTeamLabel(name: string): string {
  const normalized = name.trim();
  if (normalized.length <= MAX_TEAM_LABEL_LENGTH) return normalized;

  const suffixLength = 9;
  const prefixLength = MAX_TEAM_LABEL_LENGTH - suffixLength - 3;
  return `${normalized.slice(0, prefixLength)}...${normalized.slice(-suffixLength)}`;
}

function appendTaskSummary(lines: string[], team: TeamState): void {
  if (team.tasks.length === 0) return;

  const pending = team.tasks.filter((task) => task.status === 'pending');
  const inProgress = team.tasks.filter((task) => task.status === 'in_progress');
  const completedCount = team.tasks.filter((task) => task.status === 'completed').length;
  const completed = team.tasks.filter((task) => task.status === 'completed').slice(-5);

  lines.push('');
  lines.push(`**Tasks:** ${pending.length} pending · ${inProgress.length} in progress · ${completedCount} done`);
  for (const task of pending) {
    const owner = task.teammate ? ` → \`${task.teammate}\`` : '';
    lines.push(`◻️ ${truncate(task.subject, 80)}${owner}`);
  }
  for (const task of inProgress) {
    const owner = task.teammate ? ` → \`${task.teammate}\`` : '';
    lines.push(`⏳ ${truncate(task.subject, 80)}${owner}`);
  }
  for (const task of completed) {
    const owner = task.teammate ? ` (\`${task.teammate}\`)` : '';
    lines.push(`✅ ${truncate(task.subject, 80)}${owner}`);
  }
}
