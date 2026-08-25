import type { ExecutionSubject, RulesPackDispatchEnvelopeV1 } from '@metabot/rulespack';
import type { RulesPackExecutionPrincipal, RulesPackOperator } from '@metabot/rulespack-adapter';
import type { PeerConfig } from '../config.js';
import type { BotRegistry, RegisteredBot } from '../api/bot-registry.js';
import type { PeerBotInfo, PeerManager } from '../api/peer-manager.js';
import { attestedRulesPackProjectId } from './rulespack-peer-project.js';

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
  if (input.peerBot.engine !== 'codex' && input.peerBot.engine !== 'claude') {
    if (input.body.rulesPackDispatch) {
      throw new Error(`RulesPack dispatch requires a Codex or Claude target; ${input.peerBot.engine} is unsupported`);
    }
    return input.peerManager.forwardTask(input.peer, input.body);
  }
  const targetStatus = requireDispatchableTarget(input);
  const targetIdentity = requireAuthenticatedTargetIdentity(input);
  const dispatcher = resolveDispatcher(input.registry, input.principal, input.peer.auth?.sourceBot);
  const operator = dispatcher?.bridge.getRulesPackOperator?.();
  if (input.body.rulesPackDispatch) {
    assertEnvelopeTargetIdentity(input.body.rulesPackDispatch, targetIdentity);
    return forwardEnvelope(input, input.body.rulesPackDispatch, dispatcher, operator);
  }
  if (!operator) {
    if (targetStatus.required || targetStatus.mode === 'enforce') {
      throw new Error(
        `RulesPack source dispatcher is unavailable for protected target ${input.peer.name}/${input.body.botName}`,
      );
    }
    return input.peerManager.forwardTask(input.peer, input.body);
  }

  const target = remoteExecutionSubject(input, targetIdentity);
  const envelope = await operator.createDispatchEnvelope({
    targetSubject: target,
    audience: targetIdentity.audience,
    targetHostId: targetIdentity.hostId,
  });
  return forwardEnvelope(input, envelope, dispatcher, operator);
}

function remoteExecutionSubject(
  input: AuthenticatedPeerForwardInput,
  targetIdentity: NonNullable<PeerBotInfo['rulesPackIdentity']>,
): ExecutionSubject {
  const engine = input.peerBot.engine;
  if (engine !== 'codex' && engine !== 'claude') {
    throw new Error(`RulesPack target engine ${String(engine)} is unsupported`);
  }
  const scoped = input.principal.kind === 'scoped' ? input.principal : undefined;
  const derivedAgent = remoteAgentIdentity(input.body.chatId);
  const advertisedProjectId = authenticatedTargetProjectId(input);
  if (scoped?.projectId && advertisedProjectId && scoped.projectId !== advertisedProjectId) {
    throw new Error(
      `RulesPack authenticated project ${scoped.projectId} does not match target project ` +
        `${advertisedProjectId ?? '<unbound>'}`,
    );
  }
  const projectId = scoped?.projectId ?? advertisedProjectId;
  return {
    hostId: targetIdentity.hostId,
    bot: input.body.botName,
    roles: exactValues([...(scoped?.roles ?? []), 'peer', remoteRuntimeRole(input.body.botName, input.body.chatId)]),
    ...(scoped?.agentName ? { agent: scoped.agentName } : derivedAgent),
    ...(scoped?.workerId ? { worker: scoped.workerId } : {}),
    ...(scoped?.userId ? { userId: scoped.userId } : {}),
    ...(projectId ? { projectId } : {}),
    chatId: input.body.chatId,
    ...(scoped?.taskId ? { taskId: scoped.taskId } : {}),
    tools: exactValues(scoped?.tools ?? input.peerBot.rulesPackTools ?? []),
    dataClasses: exactValues([...(scoped?.dataClasses ?? []), 'agent-bus']),
    outputTypes: exactValues(scoped?.outputTypes ?? ['text']),
    engine,
  };
}

function requireAuthenticatedTargetIdentity(
  input: AuthenticatedPeerForwardInput,
): NonNullable<PeerBotInfo['rulesPackIdentity']> {
  const identity = input.peerBot.rulesPackIdentity;
  if (
    !identity ||
    typeof identity.hostId !== 'string' ||
    !identity.hostId ||
    typeof identity.audience !== 'string' ||
    !identity.audience
  ) {
    throw new Error(
      `RulesPack target ${input.peer.name}/${input.body.botName} does not advertise an authenticated host identity`,
    );
  }
  return identity;
}

function assertEnvelopeTargetIdentity(
  envelope: RulesPackDispatchEnvelopeV1,
  identity: NonNullable<PeerBotInfo['rulesPackIdentity']>,
): void {
  if (envelope.target?.hostId !== identity.hostId || envelope.audience !== identity.audience) {
    throw new Error('RulesPack dispatch envelope does not match the authenticated peer host identity');
  }
}

async function forwardEnvelope(
  input: AuthenticatedPeerForwardInput,
  envelope: RulesPackDispatchEnvelopeV1,
  dispatcher: RegisteredBot | undefined,
  operator: RulesPackOperator | undefined,
): Promise<object> {
  try {
    const result = await input.peerManager.forwardTask(input.peer, {
      ...input.body,
      ...(dispatcher ? { sourceBot: dispatcher.name } : {}),
      rulesPackDispatch: envelope,
    });
    if (input.peer.url === 'inbox:' || (result as { relay?: unknown }).relay === 'inbox') {
      if (isExplicitRemoteRejection(result)) {
        throw new Error('RulesPack peer explicitly rejected the dispatched envelope');
      }
      return {
        ...result,
        rulesPackDelivery: {
          status: 'queued',
          envelopeId: envelope.envelopeId,
          replayId: envelope.replayId,
          packDigest: envelope.packDigest,
        },
      };
    }
    const expectedStatus = input.peerBot.rulesPackStatus?.mode === 'shadow' ? 'shadowed' : 'consumed';
    const delivery = (result as { rulesPackDelivery?: Record<string, unknown> }).rulesPackDelivery;
    const acknowledgementMismatch =
      delivery?.status !== expectedStatus ||
      delivery.envelopeId !== envelope.envelopeId ||
      delivery.replayId !== envelope.replayId ||
      delivery.packDigest !== envelope.packDigest;
    if (!acknowledgementMismatch) return result;
    if (isExplicitRemoteRejection(result)) {
      throw new Error('RulesPack peer explicitly rejected the dispatched envelope');
    }
    throw new Error(`RulesPack peer response omitted the exact ${expectedStatus} acknowledgement`);
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

function resolveDispatcher(
  registry: BotRegistry,
  principal: RulesPackExecutionPrincipal,
  configuredSourceBot?: string,
): RegisteredBot | undefined {
  if (configuredSourceBot) {
    const configured = registry.get(configuredSourceBot.trim());
    return rulesPackOperatorBot(configured) ? configured : undefined;
  }
  if (principal.kind === 'generic' && principal.botName) {
    return bridgeTransportDispatcher(registry, principal.botName);
  }
  if (principal.kind === 'scoped' && principal.source !== 'local-admin') {
    const exactBot = registry.get(principal.botName);
    return rulesPackOperatorBot(exactBot) ? exactBot : undefined;
  }

  // The local API secret authenticates a Bridge administrator, not the remote
  // target Bot. Prefer the conventional static admin source, then accept only
  // a sole unambiguous local RulesPack operator.
  const admin = registry.get('admin');
  if (rulesPackOperatorBot(admin)) return admin;
  const candidates = registry.listRegistered().filter(rulesPackOperatorBot);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function bridgeTransportDispatcher(registry: BotRegistry, identity: string): RegisteredBot | undefined {
  const exactBot = registry.get(identity);
  if (exactBot?.config.rulesPack?.dispatch?.issuer === identity && rulesPackOperatorBot(exactBot)) return exactBot;
  const issuerMatches = registry.listRegistered().filter((bot) => (
    bot.config.rulesPack?.dispatch?.issuer === identity && rulesPackOperatorBot(bot)
  ));
  const admin = registry.get('admin');
  if (admin && issuerMatches.includes(admin)) return admin;
  return issuerMatches.sort(compareDispatchers)[0];
}

function compareDispatchers(left: RegisteredBot, right: RegisteredBot): number {
  const leftKey = [normalizedIdentity(left.name), normalizedIdentity(left.platform), left.name, left.platform];
  const rightKey = [normalizedIdentity(right.name), normalizedIdentity(right.platform), right.name, right.platform];
  for (let index = 0; index < leftKey.length; index++) {
    const compared = compareText(leftKey[index]!, rightKey[index]!);
    if (compared !== 0) return compared;
  }
  return 0;
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function rulesPackOperatorBot(bot: RegisteredBot | undefined): bot is RegisteredBot {
  return bot?.bridge.getRulesPackOperator?.() !== undefined;
}

function requireDispatchableTarget(
  input: AuthenticatedPeerForwardInput,
): NonNullable<PeerBotInfo['rulesPackStatus']> & { mode: 'shadow' | 'enforce' } {
  const target = `${input.peer.name}/${input.body.botName}`;
  const status = input.peerBot.rulesPackStatus;
  if (!status) throw new Error(`RulesPack target ${target} does not advertise support`);
  if (status.state !== 'inherited' && status.state !== 'overridden') {
    throw new Error(`RulesPack target ${target} is ${status.state}`);
  }
  if (status.mode === 'off') throw new Error(`RulesPack target ${target} is off`);
  if (status.mode !== 'shadow' && status.mode !== 'enforce') {
    throw new Error(`RulesPack target ${target} does not advertise a live mode`);
  }
  return status as typeof status & { mode: 'shadow' | 'enforce' };
}

function authenticatedDefaultProjectId(input: AuthenticatedPeerForwardInput): string | undefined {
  const status = input.peerBot.rulesPackStatus;
  if (!status || !Object.prototype.hasOwnProperty.call(status, 'defaultProjectId')) {
    throw new Error(
      `RulesPack target ${input.peer.name}/${input.body.botName} does not advertise its default project identity`,
    );
  }
  const projectId = status.defaultProjectId;
  if (
    projectId !== null &&
    (
      typeof projectId !== 'string' ||
      !projectId.trim() ||
      projectId !== projectId.trim() ||
      projectId.length > 500
    )
  ) {
    throw new Error(`RulesPack target ${input.peer.name}/${input.body.botName} advertised an invalid default project`);
  }
  return projectId ?? undefined;
}

function authenticatedTargetProjectId(input: AuthenticatedPeerForwardInput): string | undefined {
  const defaultProjectId = authenticatedDefaultProjectId(input);
  const exact = attestedRulesPackProjectId(
    input.peerBot.rulesPackStatus?.projectChatAttestations,
    input.body.botName,
    input.body.chatId,
  );
  if (exact.projectId && defaultProjectId && exact.projectId !== defaultProjectId) {
    throw new Error(
      `RulesPack target ${input.peer.name}/${input.body.botName} advertised conflicting default and chat projects`,
    );
  }
  return exact.projectId ?? defaultProjectId;
}

function exactValues(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value.length === 0)) {
    throw new Error('RulesPack remote identity contains an empty exact value');
  }
  return [...new Set(normalized)].sort();
}
