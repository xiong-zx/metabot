import type { AgentTeamGovernanceExtension } from '../agent-teams/governance-extension.js';
import type { AgentTeamStore } from '../agent-teams/team-store.js';
import type { BotConfigBase } from '../config.js';
import {
  ExecutionCapabilityService,
  type ExecutionCapabilityRole,
} from './execution-capabilities.js';

export type DerivedExecutionRole = ExecutionCapabilityRole | 'manager' | 'agent';

export interface DerivedExecutionPrincipal {
  role: DerivedExecutionRole;
  botName: string;
  chatId: string;
  teamName?: string;
  agentName?: string;
}

/** Single trusted role derivation shared by W01 and Worker capability minting. */
export function deriveExecutionPrincipal(
  governance: AgentTeamGovernanceExtension,
  store: AgentTeamStore,
  botName: string,
  chatId: string,
): DerivedExecutionPrincipal {
  const governedMatch = /^teaminst:([^:]+):([^:]+)(?::.*)?$/.exec(chatId);
  if (governedMatch) {
    const instance = governance.getInstance(governedMatch[1]);
    const agent = instance ? store.getAgent(instance.teamName, governedMatch[2]) : undefined;
    const role = isManagerAgent(governedMatch[2], agent?.role) ? 'manager' : 'agent';
    return {
      role,
      botName,
      chatId,
      ...(instance ? { teamName: instance.teamName } : {}),
      agentName: governedMatch[2],
    };
  }
  const legacyMatch = /^team:([^:]+):([^:]+)(?::.*)?$/.exec(chatId);
  if (legacyMatch) {
    const agent = store.getAgent(legacyMatch[1], legacyMatch[2]);
    return {
      role: isManagerAgent(legacyMatch[2], agent?.role) ? 'manager' : 'agent',
      botName,
      chatId,
      teamName: legacyMatch[1],
      agentName: legacyMatch[2],
    };
  }
  return {
    role: botName === 'metabot' || /^pm(?:-|$)/i.test(botName) ? 'pm' : 'user',
    botName,
    chatId,
  };
}

export function mintOptedInExecutionCapabilities(input: {
  service: ExecutionCapabilityService;
  principal: DerivedExecutionPrincipal;
  config: Pick<BotConfigBase, 'workerTools'>;
  ttlMs?: number;
  now?: number;
  onError?: (purpose: 'worker', error: unknown) => void;
}): Record<string, string> {
  if (input.principal.role !== 'pm' && input.principal.role !== 'user') return {};
  const env: Record<string, string> = {};
  const issue = (purpose: 'worker', envName: string, optedIn: boolean | undefined) => {
    if (optedIn !== true) return;
    try {
      env[envName] = input.service.issue({
        purpose,
        role: input.principal.role as ExecutionCapabilityRole,
        botName: input.principal.botName,
        chatId: input.principal.chatId,
        ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
      }, input.now);
    } catch (error) {
      input.onError?.(purpose, error);
    }
  };
  issue('worker', 'METABOT_WORKER_CAPABILITY', input.config.workerTools);
  return env;
}

function isManagerAgent(agentName: string, role: string | undefined): boolean {
  return agentName === 'lead' || /(^|\b)(lead|manager)(\b|$)/i.test(role ?? '');
}
