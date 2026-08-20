import type * as lark from '@larksuiteoapi/node-sdk';
import type { BotConfigBase } from '../config.js';
import { resolveEngineName, type EngineName } from '../engines/index.js';
import type { MessageBridge } from '../bridge/message-bridge.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import {
  buildRulesPackProjectChatAttestations,
  type RulesPackProjectChatAttestation,
} from '../extensions/rulespack-peer-project.js';

export interface RegisteredBot {
  name: string;
  platform: 'feishu' | 'telegram' | 'web' | 'wechat' | 'slack';
  config: BotConfigBase;
  bridge: MessageBridge;
  sender: IMessageSender;
  /** Feishu SDK client (only for feishu platform bots). */
  feishuClient?: lark.Client;
  /** Live external channel state, when the platform adapter exposes it. */
  connectionStatus?: () => ChannelConnectionStatus;
}

export type ChannelConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface ChannelConnectionStatus {
  state: ChannelConnectionState;
  lastConnectTime?: number;
  nextConnectTime?: number;
  reconnectAttempts: number;
}

export interface BotChannelStatus extends ChannelConnectionStatus {
  name: string;
  platform: RegisteredBot['platform'];
}

/** Public DTO returned by list() — no secrets or internal refs. */
export interface BotInfo {
  name: string;
  description?: string;
  specialties?: string[];
  icon?: string;
  platform: string;
  engine: EngineName;
  model?: string;
  workingDirectory: string;
  /** Authenticated configured tool identities used for exact RulesPack peer subjects. */
  rulesPackTools?: string[];
  /** Non-secret Codex-only RulesPack adoption/opt-out state. */
  rulesPackStatus?: {
    state: 'inherited' | 'overridden' | 'opted-out' | 'unconfigured' | 'unsupported';
    required: boolean;
    mode?: 'off' | 'shadow' | 'enforce';
    operatorModeVersion?: number;
    operatorModeOperationId?: string;
    /** Explicit trusted default-cwd binding; null attests that the cwd is unbound. */
    defaultProjectId?: string | null;
    /** Hashed exact (bot, chatId) bindings authenticated by peer/Core transport. */
    projectChatAttestations?: RulesPackProjectChatAttestation[];
    optOutReason?: string;
  };
  /** Live non-secret host identity used for authenticated RulesPack dispatch. */
  rulesPackIdentity?: {
    hostId: string;
    audience: string;
  };
  ttsVoice?: string;
  /** Set when the bot comes from a peer instance. */
  peerUrl?: string;
  /** Human-readable peer identifier. */
  peerName?: string;
}

/**
 * In-memory registry of all running bots.
 * Populated at startup; used by the HTTP API and task scheduler.
 *
 * Keys are `platform:name` to avoid collisions when a Feishu bot and
 * Telegram bot share the same name (e.g. both called "metabot").
 */
export class BotRegistry {
  private bots = new Map<string, RegisteredBot>();

  private key(name: string, platform?: string): string {
    if (platform) return `${platform}:${name}`;
    // Legacy lookup: try exact key first, then search by name
    return name;
  }

  register(bot: RegisteredBot): void {
    this.bots.set(`${bot.platform}:${bot.name}`, bot);
  }

  get(name: string): RegisteredBot | undefined {
    // Try platform-qualified keys first
    for (const prefix of ['feishu', 'telegram', 'web', 'wechat', 'slack']) {
      const bot = this.bots.get(`${prefix}:${name}`);
      if (bot) return bot;
    }
    return undefined;
  }

  /** Get a bot by name and platform. */
  getByPlatform(name: string, platform: string): RegisteredBot | undefined {
    return this.bots.get(`${platform}:${name}`);
  }

  /** Get all bots of a specific platform. */
  listByPlatform(platform: string): RegisteredBot[] {
    return Array.from(this.bots.values()).filter((b) => b.platform === platform);
  }

  deregister(name: string): boolean {
    // Try all platform-qualified keys
    for (const prefix of ['feishu', 'telegram', 'web', 'wechat', 'slack']) {
      if (this.bots.delete(`${prefix}:${name}`)) return true;
    }
    return false;
  }

  /** Return all registered bots with full internal info (bridge, sender, etc.) */
  listRegistered(): RegisteredBot[] {
    return Array.from(this.bots.values());
  }

  /** Authenticated diagnostics for external channel connections. */
  listChannelStatuses(): BotChannelStatus[] {
    return Array.from(this.bots.values()).flatMap((bot) => {
      if (!bot.connectionStatus) return [];
      try {
        return [{ name: bot.name, platform: bot.platform, ...bot.connectionStatus() }];
      } catch {
        return [{ name: bot.name, platform: bot.platform, state: 'failed', reconnectAttempts: 0 }];
      }
    });
  }

  list(): BotInfo[] {
    return Array.from(this.bots.values()).map((b) => {
      const rulesPackIdentity = rulesPackIdentityForBot(b);
      return {
        name: b.name,
        ...(b.config.description ? { description: b.config.description } : {}),
        ...(b.config.specialties?.length ? { specialties: b.config.specialties } : {}),
        ...(b.config.icon ? { icon: b.config.icon } : {}),
        platform: b.platform,
        engine: resolveEngineName(b.config),
        ...(defaultModelForEngine(b.config) ? { model: defaultModelForEngine(b.config) } : {}),
        workingDirectory: b.config.claude.defaultWorkingDirectory,
        ...(resolveEngineName(b.config) === 'codex'
          ? { rulesPackTools: [
              ...(b.config.workerTools === true ? ['metabot-worker'] : []),
            ] }
          : {}),
        rulesPackStatus: rulesPackStatusForBot(b),
        ...(rulesPackIdentity ? { rulesPackIdentity } : {}),
        ...(b.config.ttsVoice ? { ttsVoice: b.config.ttsVoice } : {}),
      };
    });
  }
}

function rulesPackIdentityForBot(bot: RegisteredBot): BotInfo['rulesPackIdentity'] {
  if (resolveEngineName(bot.config) !== 'codex') return undefined;
  try {
    const status = bot.bridge.getRulesPackOperator?.()?.status();
    return status && typeof status.hostId === 'string' && status.hostId &&
      typeof status.audience === 'string' && status.audience
      ? { hostId: status.hostId, audience: status.audience }
      : undefined;
  } catch {
    return undefined;
  }
}

function rulesPackStatusForBot(bot: RegisteredBot): NonNullable<BotInfo['rulesPackStatus']> {
  const engine = resolveEngineName(bot.config);
  const policy = bot.config.rulesPackPolicy ?? {
    state: engine === 'codex'
      ? (bot.config.rulesPack ? 'overridden' as const : 'unconfigured' as const)
      : 'unsupported' as const,
    required: false,
  };
  let mode = bot.config.rulesPack?.mode;
  let operatorModeVersion: number | undefined;
  let operatorModeOperationId: string | undefined;
  let defaultProjectId: string | null | undefined;
  const projectChatAttestations = engine === 'codex' &&
    (policy.state === 'inherited' || policy.state === 'overridden')
    ? buildRulesPackProjectChatAttestations(bot.config.rulesPack?.projectChatBindings, bot.name)
    : undefined;
  try {
    const operator = bot.bridge.getRulesPackOperator?.();
    const status = operator?.status();
    mode = status?.mode ?? mode;
    operatorModeVersion = status?.operatorModeVersion;
    operatorModeOperationId = status?.operatorModeOperationId;
    if (operator && (policy.state === 'inherited' || policy.state === 'overridden')) {
      defaultProjectId = operator.projectIdForCwd(bot.config.claude.defaultWorkingDirectory) ?? null;
    }
  } catch {
    // Keep config-derived status when live diagnostics are temporarily unavailable.
  }
  return {
    ...policy,
    ...(mode ? { mode } : {}),
    ...(operatorModeVersion !== undefined ? { operatorModeVersion } : {}),
    ...(operatorModeOperationId ? { operatorModeOperationId } : {}),
    ...(defaultProjectId !== undefined ? { defaultProjectId } : {}),
    ...(projectChatAttestations ? { projectChatAttestations } : {}),
  };
}

function defaultModelForEngine(config: BotConfigBase): string | undefined {
  switch (resolveEngineName(config)) {
    case 'claude':
      return config.claude.model;
    case 'kimi':
      return config.kimi?.model;
    case 'codex':
      return config.codex?.model || config.codex?.displayModel;
  }
}
