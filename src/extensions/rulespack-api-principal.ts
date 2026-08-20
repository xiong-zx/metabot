import type { RulesPackDispatchEnvelopeV1 } from '@metabot/rulespack';
import type { RulesPackExecutionPrincipal } from '@metabot/rulespack-adapter';

export interface RulesPackTransportPrincipal {
  localAdministrator: boolean;
  coreBearerBotName?: string;
}

/** Translate the existing API authentication result into an immutable RulesPack principal. */
export function resolveRulesPackApiPrincipal(
  auth: RulesPackTransportPrincipal,
  target: {
    botName: string;
    chatId: string;
    dispatch?: RulesPackDispatchEnvelopeV1;
    declarations?: {
      projectId?: string;
      agentName?: string;
      workerId?: string;
      taskId?: string;
      roles?: readonly string[];
      tools?: readonly string[];
      dataClasses?: readonly string[];
      outputTypes?: readonly string[];
    };
  },
): RulesPackExecutionPrincipal {
  const declarations = target.declarations;
  if (target.dispatch) {
    const envelopeTarget = target.dispatch.target;
    if (envelopeTarget.bot !== target.botName || envelopeTarget.chatId !== target.chatId) {
      throw new Error('RulesPack dispatch target does not match API bot/chat');
    }
    const mismatched = declarations && (
      (declarations.projectId !== undefined && declarations.projectId !== envelopeTarget.projectId) ||
      (declarations.agentName !== undefined && declarations.agentName !== envelopeTarget.agent) ||
      (declarations.workerId !== undefined && declarations.workerId !== envelopeTarget.worker) ||
      (declarations.taskId !== undefined && declarations.taskId !== envelopeTarget.taskId) ||
      !sameDeclaration(declarations.roles, envelopeTarget.roles) ||
      !sameDeclaration(declarations.tools, envelopeTarget.tools) ||
      !sameDeclaration(declarations.dataClasses, envelopeTarget.dataClasses) ||
      !sameDeclaration(declarations.outputTypes, envelopeTarget.outputTypes)
    );
    if (mismatched) throw new Error('RulesPack API identity declaration does not match authenticated envelope target');
    return {
      kind: 'scoped',
      source: 'agent-bus',
      botName: envelopeTarget.bot,
      chatId: envelopeTarget.chatId,
      roles: envelopeTarget.roles,
      ...(envelopeTarget.userId ? { userId: envelopeTarget.userId } : {}),
      ...(envelopeTarget.agent ? { agentName: envelopeTarget.agent } : {}),
      ...(envelopeTarget.worker ? { workerId: envelopeTarget.worker } : {}),
      ...(envelopeTarget.projectId ? { projectId: envelopeTarget.projectId } : {}),
      ...(envelopeTarget.taskId ? { taskId: envelopeTarget.taskId } : {}),
      tools: envelopeTarget.tools,
      dataClasses: envelopeTarget.dataClasses,
      outputTypes: envelopeTarget.outputTypes,
    };
  }
  if (auth.localAdministrator) {
    return {
      kind: 'scoped',
      source: 'local-admin',
      botName: target.botName,
      chatId: target.chatId,
      roles: exactValues(['api-admin', ...(declarations?.roles ?? [])]),
      userId: 'api-local-admin',
      ...(declarations?.agentName ? { agentName: declarations.agentName } : {}),
      ...(declarations?.workerId ? { workerId: declarations.workerId } : {}),
      ...(declarations?.projectId ? { projectId: declarations.projectId } : {}),
      ...(declarations?.taskId ? { taskId: declarations.taskId } : {}),
      ...(declarations?.tools ? { tools: exactValues(declarations.tools) } : {}),
      dataClasses: exactValues(['api', ...(declarations?.dataClasses ?? [])]),
      outputTypes: exactValues(declarations?.outputTypes ?? ['text']),
    };
  }
  if (declarations && Object.values(declarations).some((value) => value !== undefined)) {
    throw new Error('RulesPack API identity declarations require an authenticated exact dispatch');
  }
  return {
    kind: 'generic',
    source: 'core-bearer',
    ...(auth.coreBearerBotName ? { botName: auth.coreBearerBotName } : {}),
  };
}

function sameDeclaration(declared: readonly string[] | undefined, authenticated: readonly string[]): boolean {
  if (declared === undefined) return true;
  if (!declared.every((value) => typeof value === 'string')) return false;
  return [...new Set(declared)].sort().join('\0') === [...new Set(authenticated)].sort().join('\0');
}

function exactValues(values: readonly string[]): string[] {
  if (!values.every((value) => typeof value === 'string' && value.trim().length > 0)) {
    throw new Error('RulesPack API identity declarations must contain non-empty strings');
  }
  return [...new Set(values.map((value) => value.trim()))].sort();
}
