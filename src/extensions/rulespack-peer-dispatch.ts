import type { ExecutionSubject, RulesPackDispatchEnvelopeV1 } from '@metabot/rulespack';
import type { RulesPackExecutionPrincipal, RulesPackOperator } from '@metabot/rulespack-adapter';
import type { PeerConfig } from '../config.js';
import type { BotRegistry, RegisteredBot } from '../api/bot-registry.js';
import type { PeerBotInfo, PeerManager } from '../api/peer-manager.js';

interface AuthenticatedPeerForwardInput {
  registry: BotRegistry;
  peerManager: PeerManager;
  peer: PeerConfig;
  peerBot: PeerBotInfo;
  principal: RulesPackExecutionPrincipal;
  body: {
    botName: string;
    chatId: string;
    prompt: string;
    sendCards?: boolean;
    rulesPackDispatch?: RulesPackDispatchEnvelopeV1;
  };
}

/** Downstream-owned normal peer/Agent Bus hook: compile, bind, attach, and account for transport rejection. */
export async function forwardAuthenticatedPeerTask(input: AuthenticatedPeerForwardInput): Promise<object> {
  if (input.peerBot.engine !== 'codex') {
    return input.peerManager.forwardTask(input.peer, input.body);
  }
  const dispatcher = resolveDispatcher(input.registry, input.principal);
  const operator = dispatcher?.bridge.getRulesPackOperator?.();
  if (input.body.rulesPackDispatch) {
    return forwardEnvelope(input, input.body.rulesPackDispatch, operator);
  }
  if (!operator) return input.peerManager.forwardTask(input.peer, input.body);

  const target: ExecutionSubject = {
    hostId: input.peer.name,
    bot: input.body.botName,
    roles: ['peer', remoteRuntimeRole(input.body.botName, input.body.chatId)],
    ...remoteAgentIdentity(input.body.chatId),
    chatId: input.body.chatId,
    tools: input.peerBot.rulesPackTools ?? [],
    dataClasses: ['agent-bus'],
    outputTypes: ['text'],
    engine: 'codex',
  };
  const envelope = await operator.createDispatchEnvelope({
    targetSubject: target,
    audience: `metabot-host:${input.peer.name}`,
    targetHostId: input.peer.name,
  });
  return forwardEnvelope(input, envelope, operator);
}

async function forwardEnvelope(
  input: AuthenticatedPeerForwardInput,
  envelope: RulesPackDispatchEnvelopeV1,
  operator: RulesPackOperator | undefined,
): Promise<object> {
  try {
    const result = await input.peerManager.forwardTask(input.peer, { ...input.body, rulesPackDispatch: envelope });
    if (isExplicitRemoteRejection(result)) {
      throw new Error('RulesPack peer explicitly rejected the dispatched envelope');
    }
    return result;
  } catch (error) {
    operator?.recordDispatchRejected(envelope, error);
    throw error;
  }
}

function isExplicitRemoteRejection(result: object): boolean {
  const value = result as { accepted?: unknown; success?: unknown; rejected?: unknown; error?: unknown };
  return (
    value.accepted === false ||
    value.success === false ||
    value.rejected === true ||
    (typeof value.error === 'string' && value.error.length > 0)
  );
}

function remoteRuntimeRole(botName: string, chatId: string): string {
  const team = /^(?:teaminst|team):[^:]+:([^:]+)(?::.*)?$/u.exec(chatId);
  if (team) return team[1] === 'lead' ? 'manager' : 'agent';
  return botName === 'metabot' || /^pm(?:-|$)/iu.test(botName) ? 'pm' : 'user';
}

function remoteAgentIdentity(chatId: string): Pick<ExecutionSubject, 'agent'> | Record<string, never> {
  const team = /^(?:teaminst|team):[^:]+:([^:]+)(?::.*)?$/u.exec(chatId);
  return team?.[1] ? { agent: team[1] } : {};
}

function resolveDispatcher(registry: BotRegistry, principal: RulesPackExecutionPrincipal): RegisteredBot | undefined {
  const sourceBot = principal.botName;
  if (!sourceBot) return undefined;
  return registry.get(sourceBot);
}
