import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TeamGovernanceActor, TeamGovernanceActorRole } from './governance-extension.js';

export const AGENT_TEAM_CAPABILITY_HEADER = 'x-metabot-team-capability';
export const AGENT_TEAM_BOT_HEADER = 'x-metabot-bot-name';
export const AGENT_TEAM_CHAT_HEADER = 'x-metabot-chat-id';
export const AGENT_TEAM_CAPABILITY_ENV = 'METABOT_TEAM_CAPABILITY';

interface CapabilityClaims {
  v: 1;
  role: TeamGovernanceActorRole;
  botName: string;
  chatId: string;
  teamName?: string;
  agentName?: string;
  exp: number;
}

export interface AgentTeamExecutionPrincipal extends TeamGovernanceActor {
  botName?: string;
  chatId?: string;
  teamName?: string;
  agentName?: string;
  source: 'execution-capability' | 'local-api-secret';
}

export class AgentTeamCapabilityError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AgentTeamCapabilityError';
  }
}

/**
 * Issues short-lived HMAC capabilities for engine subprocesses. The signing
 * key never leaves the bridge process; an engine receives only its signed,
 * scoped token.
 */
export class AgentTeamExecutionCapabilityService {
  private readonly secret: Buffer;

  constructor(secret?: Buffer | string) {
    this.secret = Buffer.isBuffer(secret)
      ? Buffer.from(secret)
      : secret
        ? Buffer.from(secret, 'utf8')
        : randomBytes(32);
  }

  issue(input: Omit<CapabilityClaims, 'v' | 'exp'> & { ttlMs?: number }, now = Date.now()): string {
    const ttlMs = input.ttlMs ?? 60 * 60 * 1000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new AgentTeamCapabilityError('Capability ttlMs must be a positive integer', 'INVALID_CAPABILITY_TTL');
    }
    const claims: CapabilityClaims = {
      v: 1,
      role: input.role,
      botName: requireClaim(input.botName, 'botName'),
      chatId: requireClaim(input.chatId, 'chatId'),
      ...(input.teamName ? { teamName: input.teamName } : {}),
      ...(input.agentName ? { agentName: input.agentName } : {}),
      exp: now + ttlMs,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token: string, expected: { botName: string; chatId: string }, now = Date.now()): AgentTeamExecutionPrincipal {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) {
      throw new AgentTeamCapabilityError('Invalid Agent Team execution capability', 'INVALID_EXECUTION_CAPABILITY');
    }
    const expectedSignature = this.sign(payload);
    const supplied = Buffer.from(signature);
    const wanted = Buffer.from(expectedSignature);
    if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
      throw new AgentTeamCapabilityError('Invalid Agent Team execution capability', 'INVALID_EXECUTION_CAPABILITY');
    }
    let claims: CapabilityClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CapabilityClaims;
    } catch {
      throw new AgentTeamCapabilityError('Invalid Agent Team execution capability', 'INVALID_EXECUTION_CAPABILITY');
    }
    if (
      claims.v !== 1 ||
      !isActorRole(claims.role) ||
      claims.botName !== expected.botName ||
      claims.chatId !== expected.chatId
    ) {
      throw new AgentTeamCapabilityError(
        'Execution capability does not match this engine session',
        'CAPABILITY_SCOPE_MISMATCH',
      );
    }
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= now) {
      throw new AgentTeamCapabilityError('Agent Team execution capability has expired', 'EXECUTION_CAPABILITY_EXPIRED');
    }
    return {
      role: claims.role,
      id: `${claims.botName}:${claims.chatId}`,
      botName: claims.botName,
      chatId: claims.chatId,
      ...(claims.teamName ? { teamName: claims.teamName } : {}),
      ...(claims.agentName ? { agentName: claims.agentName } : {}),
      source: 'execution-capability',
    };
  }

  resolve(input: {
    capability?: string;
    botName?: string;
    chatId?: string;
    localApiSecretAuthenticated: boolean;
    now?: number;
  }): AgentTeamExecutionPrincipal {
    const hasEngineMarker = !!input.botName || !!input.chatId;
    if (hasEngineMarker) {
      if (!input.botName || !input.chatId || !input.capability) {
        throw new AgentTeamCapabilityError(
          'Engine sessions require a valid Agent Team execution capability',
          'EXECUTION_CAPABILITY_REQUIRED',
        );
      }
      return this.verify(input.capability, { botName: input.botName, chatId: input.chatId }, input.now);
    }
    if (!input.localApiSecretAuthenticated) {
      throw new AgentTeamCapabilityError(
        'A local API secret or execution capability is required',
        'TRUSTED_PRINCIPAL_REQUIRED',
      );
    }
    return { role: 'admin', id: 'local-api', source: 'local-api-secret' };
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

function requireClaim(value: string, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new AgentTeamCapabilityError(`Missing capability ${name}`, 'INVALID_CAPABILITY_CLAIM');
  return normalized;
}

function isActorRole(value: unknown): value is TeamGovernanceActorRole {
  return (
    value === 'admin' ||
    value === 'user' ||
    value === 'pm' ||
    value === 'manager' ||
    value === 'agent' ||
    value === 'worker'
  );
}
