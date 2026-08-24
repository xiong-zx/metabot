import type { AgentTeamExecutionPrincipal } from './governance-capability.js';

const UUID_PATH_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';

/** Exact Bridge routes that a signed engine session may use for Agent Bus talk. */
export function isAgentTeamCapabilityTalkRoute(method: string, url: string): boolean {
  if (method === 'POST' && url === '/api/talk') return true;
  return method === 'GET'
    && new RegExp(`^/api/talk/${UUID_PATH_PATTERN}(?:\\?.*)?$`).test(url);
}

/** Only user-facing roles may delegate to the same Bot in another chat. */
export function mayDelegateAgentBusTalk(
  principal: AgentTeamExecutionPrincipal,
  targetBotName: string,
): boolean {
  return principal.botName === targetBotName
    && (principal.role === 'admin' || principal.role === 'pm' || principal.role === 'user');
}

/** A signed engine may inspect only tasks that it originally delegated. */
export function matchesAgentBusTalkSource(
  principal: AgentTeamExecutionPrincipal,
  task: { sourceBotName?: string; sourceChatId?: string },
): boolean {
  return principal.botName === task.sourceBotName && principal.chatId === task.sourceChatId;
}
