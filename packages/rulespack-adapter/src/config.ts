import { isDeepStrictEqual } from 'node:util';
import type {
  RulesPackConfig,
  RulesPackProjectBindingConfig,
  RulesPackProjectChatBindingConfig,
  RulesPackStructuredSourceConfig,
} from './types.js';

export type RulesPackDefaultsPolicy = 'optional' | 'required';

/** Shared multi-bot defaults. Required policy forbids per-bot opt-out and source replacement. */
export interface RulesPackDefaultsConfig {
  policy?: RulesPackDefaultsPolicy;
  config: RulesPackConfig;
}

export type RulesPackBotOverride = RulesPackConfig | false;

export interface RulesPackBotPolicy {
  state: 'inherited' | 'overridden' | 'opted-out' | 'unconfigured' | 'unsupported';
  required: boolean;
  optOutReason?: string;
}

export interface ResolvedRulesPackBotConfig {
  rulesPack?: RulesPackConfig;
  policy: RulesPackBotPolicy;
}

/**
 * Resolve one bot without interpreting prompt or Rule text. Shared defaults
 * apply only to engines with audited injection and receipt support. Kimi stays
 * unsupported until it has an equivalent transport contract.
 */
export function resolveRulesPackBotConfig(input: {
  botName: string;
  engine: 'claude' | 'kimi' | 'codex';
  surface?: 'bridge' | 'worker';
  defaults?: RulesPackDefaultsConfig;
  override?: RulesPackBotOverride;
  optOutReason?: string;
}): ResolvedRulesPackBotConfig {
  const required = input.defaults?.policy === 'required';
  if (input.defaults && (
    !input.defaults.config || typeof input.defaults.config !== 'object' || Array.isArray(input.defaults.config)
  )) {
    throw new Error('rulesPackDefaults.config must be an object');
  }
  if (
    input.override !== undefined &&
    input.override !== false &&
    (typeof input.override !== 'object' || Array.isArray(input.override))
  ) {
    throw new Error(`Bot "${input.botName}" rulesPack override must be an object or false`);
  }
  if (input.defaults?.policy && input.defaults.policy !== 'optional' && input.defaults.policy !== 'required') {
    throw new Error('rulesPackDefaults.policy must be optional or required');
  }

  if (input.engine === 'kimi') {
    if (input.override !== undefined && input.override !== false) {
      throw new Error(`RulesPack supports Codex and Claude only; bot "${input.botName}" uses ${input.engine}`);
    }
    return { policy: { state: 'unsupported', required: false } };
  }

  if (input.override === false) {
    if (required) {
      throw new Error(`Bot "${input.botName}" cannot opt out of required RulesPack defaults`);
    }
    const reason = input.optOutReason?.trim();
    if (!reason) {
      throw new Error(`Bot "${input.botName}" RulesPack opt-out requires rulesPackOptOutReason`);
    }
    return { policy: { state: 'opted-out', required: false, optOutReason: reason } };
  }

  const defaults = input.defaults?.config;
  if (!defaults && input.override === undefined) {
    return { policy: { state: 'unconfigured', required: false } };
  }
  const merged = mergeRulesPackConfig(defaults, input.override);
  if (required && defaults) assertRequiredDefaultsPreserved(defaults, merged, input.botName);
  if (required && modeRank(merged.mode) < modeRank(defaults?.mode)) {
    requiredOverride(input.botName, 'mode');
  }
  if (input.defaults && (!merged.dbPath?.includes('{bot}') || !merged.dbPath.includes('{surface}'))) {
    throw new Error('rulesPackDefaults.config.dbPath must contain both {surface} and {bot}');
  }
  assertStaticDispatchIdentities(merged.dispatch);
  return {
    rulesPack: materializeBotTemplates(merged, input.botName, input.surface ?? 'bridge'),
    policy: {
      state: input.override === undefined ? 'inherited' : 'overridden',
      required,
    },
  };
}

function modeRank(mode: RulesPackConfig['mode']): number {
  return mode === 'enforce' ? 2 : mode === 'shadow' ? 1 : 0;
}

function mergeRulesPackConfig(base: RulesPackConfig | undefined, override: RulesPackConfig | undefined): RulesPackConfig {
  if (!base) return { ...(override ?? {}) };
  if (!override) return { ...base };
  return {
    ...base,
    ...override,
    ...(base.budget || override.budget ? { budget: { ...base.budget, ...override.budget } } : {}),
    ...(base.metaMemory || override.metaMemory
      ? { metaMemory: { ...base.metaMemory, ...override.metaMemory } as NonNullable<RulesPackConfig['metaMemory']> }
      : {}),
    ...(base.dispatch || override.dispatch
      ? { dispatch: { ...base.dispatch, ...override.dispatch } }
      : {}),
  };
}

function materializeBotTemplates(
  config: RulesPackConfig,
  botName: string,
  surface: 'bridge' | 'worker',
): RulesPackConfig {
  const materialize = (value: string): string => value
    .replaceAll('{surface}', surface)
    .replaceAll('{bot}', botName);
  return {
    ...config,
    ...(config.dbPath
      ? { dbPath: config.dbPath
          .replaceAll('{surface}', surface)
          .replaceAll('{bot}', encodeURIComponent(botName)) }
      : {}),
    ...(config.dispatch
      ? {
          dispatch: {
            ...config.dispatch,
            ...(config.dispatch.audience ? { audience: materialize(config.dispatch.audience) } : {}),
          },
        }
      : {}),
  };
}

/**
 * Dispatch identities describe authenticated transports, not the bot whose
 * prompt happens to trigger a dispatch. One Bridge uses one Core credential
 * for all of its bots, so per-bot/per-surface identity expansion would create
 * envelopes that cannot match Core `/api/whoami` (or inbox `fromBot`).
 */
function assertStaticDispatchIdentities(dispatch: RulesPackConfig['dispatch']): void {
  const identities = [
    ...(dispatch?.issuer ? [{ field: 'issuer', value: dispatch.issuer }] : []),
    ...(dispatch?.allowedIssuers ?? []).map((value, index) => ({
      field: `allowedIssuers[${index}]`,
      value,
    })),
  ];
  for (const identity of identities) {
    if (typeof identity.value !== 'string' || !identity.value.trim()) {
      throw new Error(`RulesPack dispatch ${identity.field} must be a non-empty authenticated transport identity`);
    }
    if (identity.value.includes('{bot}') || identity.value.includes('{surface}')) {
      throw new Error(
        `RulesPack dispatch ${identity.field} must be a fixed authenticated transport identity; ` +
          'replace {bot}/{surface} with the botName returned by metabot agents whoami',
      );
    }
  }
}

function assertRequiredDefaultsPreserved(
  defaults: RulesPackConfig,
  effective: RulesPackConfig,
  botName: string,
): void {
  if (defaults.hostId !== undefined && effective.hostId !== defaults.hostId) {
    requiredOverride(botName, 'hostId');
  }
  if (defaults.configRules && !isDeepStrictEqual(defaults.configRules, effective.configRules)) {
    requiredOverride(botName, `configRules.${defaults.configRules.id}`);
  }
  assertSourcesPreserved(botName, 'ruleSets', defaults.ruleSets, effective.ruleSets);
  assertSourcesPreserved(botName, 'curatedRules', defaults.curatedRules, effective.curatedRules);
  assertProjectsPreserved(botName, defaults.projectBindings, effective.projectBindings);
  assertProjectChatsPreserved(botName, defaults.projectChatBindings, effective.projectChatBindings);
  if (defaults.metaMemory) {
    const memory = effective.metaMemory;
    if (!memory || !isDeepStrictEqual(defaults.metaMemory, memory)) requiredOverride(botName, 'metaMemory');
  }
  if (defaults.dispatch && !isDeepStrictEqual(defaults.dispatch, effective.dispatch)) {
    requiredOverride(botName, 'dispatch');
  }
  for (const protectedPath of defaults.protectedDbPaths ?? []) {
    if (!(effective.protectedDbPaths ?? []).includes(protectedPath)) {
      requiredOverride(botName, `protectedDbPaths:${protectedPath}`);
    }
  }
}

function assertSourcesPreserved(
  botName: string,
  field: string,
  defaults: readonly RulesPackStructuredSourceConfig[] | undefined,
  effective: readonly RulesPackStructuredSourceConfig[] | undefined,
): void {
  for (const source of defaults ?? []) {
    const retained = effective?.find((candidate) => candidate.id === source.id);
    if (!retained || !isDeepStrictEqual(source, retained)) requiredOverride(botName, `${field}.${source.id}`);
  }
}

function assertProjectsPreserved(
  botName: string,
  defaults: readonly RulesPackProjectBindingConfig[] | undefined,
  effective: readonly RulesPackProjectBindingConfig[] | undefined,
): void {
  const requiredProjectIds = new Set((defaults ?? []).map((project) => project.projectId));
  for (const projectId of requiredProjectIds) {
    const expected = (defaults ?? []).filter((project) => project.projectId === projectId).sort(compareProjectBindings);
    const retained = (effective ?? []).filter((project) => project.projectId === projectId).sort(compareProjectBindings);
    if (!isDeepStrictEqual(expected, retained)) requiredOverride(botName, `projectBindings.${projectId}`);
  }
}

function compareProjectBindings(left: RulesPackProjectBindingConfig, right: RulesPackProjectBindingConfig): number {
  return left.root.localeCompare(right.root);
}

function assertProjectChatsPreserved(
  botName: string,
  defaults: readonly RulesPackProjectChatBindingConfig[] | undefined,
  effective: readonly RulesPackProjectChatBindingConfig[] | undefined,
): void {
  const retained = new Set((effective ?? []).flatMap((project) =>
    project.chats.map((chat) => JSON.stringify([project.projectId, chat.bot, chat.chatId])),
  ));
  for (const project of defaults ?? []) {
    for (const chat of project.chats) {
      if (!retained.has(JSON.stringify([project.projectId, chat.bot, chat.chatId]))) {
        requiredOverride(botName, `projectChatBindings.${project.projectId}:${chat.bot}/${chat.chatId}`);
      }
    }
  }
}

function requiredOverride(botName: string, field: string): never {
  throw new Error(`Bot "${botName}" cannot replace required RulesPack default ${field}`);
}
