import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  MetaBotRulesPackRuntime,
  resolveRulesPackBotConfig,
  resolveRulesPackDbPath,
  type RulesPackBotOverride,
  type RulesPackConfig,
  type RulesPackDefaultsConfig,
  type ResolvedRulesPackBotConfig,
} from '@metabot/rulespack-adapter';
import { WorkerRunnerError } from './types.js';
import type {
  WorkerRecord,
  WorkerRulesPackControlStatus,
  WorkerRulesPackMode,
  WorkerRulesPackProvider,
} from './types.js';

export function createWorkerRulesPackProvider(env: NodeJS.ProcessEnv): WorkerRulesPackProvider | undefined {
  const configPath = env.METABOT_RULESPACK_CONFIG?.trim();
  const botsConfigPath = env.BOTS_CONFIG?.trim();
  if (configPath && botsConfigPath) {
    throw new Error('METABOT_RULESPACK_CONFIG and BOTS_CONFIG are mutually exclusive for Worker RulesPack');
  }
  if (configPath) return standaloneProvider(readBoundedJson<RulesPackConfig>(configPath, 'METABOT_RULESPACK_CONFIG'));
  if (!botsConfigPath) return undefined;
  const config = readBoundedJson<BotsRulesPackConfig>(botsConfigPath, 'BOTS_CONFIG');
  const entries = botEntries(config);
  if (!config.rulesPackDefaults && ![...entries.values()].some((entry) => entry.rulesPack !== undefined)) {
    return undefined;
  }
  const runtimes = new Map<string, MetaBotRulesPackRuntime>();
  const resolve = (botName: string, surface: 'bridge' | 'worker' = 'worker') => {
    const entry = entries.get(botName);
    const engine = botEngine(entry, botName);
    return resolveRulesPackBotConfig({
      botName,
      engine,
      surface,
      defaults: config.rulesPackDefaults,
      ...(entry?.rulesPack !== undefined ? { override: entry.rulesPack } : {}),
      ...(entry?.rulesPackOptOutReason !== undefined ? { optOutReason: entry.rulesPackOptOutReason } : {}),
    });
  };
  validateDatabaseClaims(configuredDatabaseClaims(entries, resolve));
  const runtimeFor = (botName: string): { runtime: MetaBotRulesPackRuntime; configuredMode: WorkerRulesPackMode } | undefined => {
    const resolved = resolve(botName);
    if (!resolved.rulesPack) return undefined;
    const currentClaims = configuredDatabaseClaims(entries, resolve);
    if (!entries.has(botName)) currentClaims.push(...databaseClaimsForBot(botName, resolve));
    validateDatabaseClaims(currentClaims);
    let runtime = runtimes.get(botName);
    if (!runtime) {
      runtime = new MetaBotRulesPackRuntime(resolved.rulesPack, stderrLogger);
      runtimes.set(botName, runtime);
    }
    return { runtime, configuredMode: resolved.rulesPack.mode ?? 'off' };
  };
  return {
    async prepare(worker: WorkerRecord, childGrant) {
      const resolved = runtimeFor(worker.botName);
      return resolved ? prepare(resolved.runtime, worker, childGrant) : undefined;
    },
    controlStatus(botName: string) {
      const resolved = runtimeFor(botName);
      if (!resolved) {
        const state = resolve(botName).policy.state;
        return controlStatus(
          botName,
          state === 'opted-out' || state === 'unsupported' ? state : 'unconfigured',
          false,
          'off',
          0,
        );
      }
      return runtimeControlStatus(botName, resolved.runtime, resolved.configuredMode);
    },
    setControlMode(
      botName: string,
      mode: WorkerRulesPackMode | null,
      expectedVersion: number,
      operationId: string,
    ) {
      const resolved = runtimeFor(botName);
      if (!resolved) {
        const state = resolve(botName).policy.state;
        throw new WorkerRunnerError(
          state === 'unsupported'
            ? `Worker RulesPack supports Codex only; bot ${botName} is ${botEngine(entries.get(botName), botName)}`
            : `Worker RulesPack is not configured for bot: ${botName}`,
          'CONFLICT',
        );
      }
      try {
        resolved.runtime.compareAndSetMode(mode, expectedVersion, operationId);
      } catch (error) {
        throw new WorkerRunnerError(
          error instanceof Error ? error.message : String(error),
          'CONFLICT',
          undefined,
          { cause: error },
        );
      }
      return runtimeControlStatus(botName, resolved.runtime, resolved.configuredMode);
    },
    close: () => {
      for (const runtime of runtimes.values()) runtime.close();
      runtimes.clear();
    },
  };
}

function standaloneProvider(config: RulesPackConfig): WorkerRulesPackProvider {
  const runtime = new MetaBotRulesPackRuntime(config, stderrLogger);
  return {
    prepare: async (worker, childGrant) => prepare(runtime, worker, childGrant),
    controlStatus: (botName) => controlStatus(
      botName,
      'standalone-shared',
      false,
      runtime.status().mode,
      runtime.status().operatorModeVersion,
      config.mode ?? 'off',
      runtime.status().operatorModeOverride,
      runtime.status().operatorModeOperationId,
    ),
    setControlMode: (botName) => {
      throw new WorkerRunnerError(
        `Bot-scoped Worker RulesPack control is unavailable for ${botName} with METABOT_RULESPACK_CONFIG`,
        'CONFLICT',
      );
    },
    close: () => runtime.close(),
  };
}

function runtimeControlStatus(
  botName: string,
  runtime: MetaBotRulesPackRuntime,
  configuredMode: WorkerRulesPackMode,
): WorkerRulesPackControlStatus {
  const status = runtime.status();
  if (!Number.isSafeInteger(status.operatorModeVersion) || status.operatorModeVersion < 0) {
    throw new WorkerRunnerError('Worker RulesPack adapter returned an invalid operator mode version', 'CONFLICT');
  }
  if (status.operatorModeVersion > 0 && !status.operatorModeOperationId) {
    throw new WorkerRunnerError('Worker RulesPack adapter omitted the persisted operator operation ID', 'CONFLICT');
  }
  return controlStatus(
    botName,
    'configured',
    true,
    status.mode,
    status.operatorModeVersion,
    configuredMode,
    status.operatorModeOverride,
    status.operatorModeOperationId,
  );
}

function controlStatus(
  botName: string,
  state: WorkerRulesPackControlStatus['state'],
  botScoped: boolean,
  mode: WorkerRulesPackMode,
  operatorModeVersion: number,
  configuredMode?: WorkerRulesPackMode,
  operatorModeOverride?: WorkerRulesPackControlStatus['operatorModeOverride'],
  operatorModeOperationId?: string,
): WorkerRulesPackControlStatus {
  return {
    botName,
    state,
    botScoped,
    mode,
    operatorModeVersion,
    ...(configuredMode ? { configuredMode } : {}),
    ...(operatorModeOverride ? { operatorModeOverride } : {}),
    ...(operatorModeOperationId ? { operatorModeOperationId } : {}),
    appliesTo: 'subsequent-codex-policy-preparations',
    inFlight: 'unchanged',
  };
}

async function prepare(
  runtime: MetaBotRulesPackRuntime,
  worker: WorkerRecord,
  childGrant?: import('@metabot/rulespack').RulesPackChildGrantV1,
) {
  const legacyUnknown = worker.principalRole === 'unknown' || worker.executionKind === 'unknown';
  const facts = {
    botName: worker.botName,
    chatId: worker.chatId,
    roles: legacyUnknown ? ['unknown'] : [worker.principalRole, worker.executionKind],
    cwd: worker.workdir,
    ...(legacyUnknown ? {} : { workerId: worker.id, taskId: worker.id }),
    ...(childGrant?.parent.target.agent ? { agentName: childGrant.parent.target.agent } : {}),
    ...(childGrant?.parent.target.userId ? { userId: childGrant.parent.target.userId } : {}),
    ...(childGrant?.constraints.projectId ? { projectId: childGrant.constraints.projectId } : {}),
    dataClasses: [legacyUnknown ? 'legacy-unknown' : worker.executionKind === 'arc' ? 'arc' : 'worker'],
    outputTypes: [worker.outputContract?.format ?? 'text'],
  };
  const prepared = childGrant
    ? await runtime.prepareDelegatedTurn(facts, childGrant)
    : await runtime.prepareTurn(facts);
  return {
    injectionText: prepared.injectionText,
    packDigest: prepared.packDigest,
    markInjected: prepared.markInjected,
    markRejected: prepared.markRejected,
  };
}

interface BotRulesPackEntry {
  name?: string;
  engine?: 'codex' | 'claude' | 'kimi';
  rulesPack?: RulesPackBotOverride;
  rulesPackOptOutReason?: string;
}

interface BotsRulesPackConfig {
  rulesPackDefaults?: RulesPackDefaultsConfig;
  feishuBots?: BotRulesPackEntry[];
  telegramBots?: BotRulesPackEntry[];
  webBots?: BotRulesPackEntry[];
  wechatBots?: BotRulesPackEntry[];
  slackBots?: BotRulesPackEntry[];
}

function botEntries(config: BotsRulesPackConfig): Map<string, BotRulesPackEntry> {
  const result = new Map<string, BotRulesPackEntry>();
  const normalizedNames = new Map<string, string>();
  for (const group of [config.feishuBots, config.telegramBots, config.webBots, config.wechatBots, config.slackBots]) {
    for (const entry of group ?? []) {
      if (typeof entry.name !== 'string' || !entry.name) continue;
      const normalizedName = entry.name.normalize('NFKC').toLocaleLowerCase('en-US');
      const existing = normalizedNames.get(normalizedName);
      if (existing) throw new Error(`BOTS_CONFIG contains aliased bot names: ${existing}, ${entry.name}`);
      normalizedNames.set(normalizedName, entry.name);
      result.set(entry.name, entry);
    }
  }
  return result;
}

function botEngine(entry: BotRulesPackEntry | undefined, botName: string): 'codex' | 'claude' | 'kimi' {
  const engine = entry?.engine ?? 'codex';
  if (engine !== 'codex' && engine !== 'claude' && engine !== 'kimi') {
    throw new Error(`BOTS_CONFIG bot ${botName} has an unsupported engine`);
  }
  return engine;
}

interface DatabaseIdentity {
  pathKey: string;
  inodeKey?: string;
}

interface DatabaseClaim {
  botName: string;
  surface: 'bridge' | 'worker';
  identity: DatabaseIdentity;
}

type ResolveBotConfig = (botName: string, surface?: 'bridge' | 'worker') => ResolvedRulesPackBotConfig;

function configuredDatabaseClaims(
  entries: ReadonlyMap<string, BotRulesPackEntry>,
  resolve: ResolveBotConfig,
): DatabaseClaim[] {
  const claims: DatabaseClaim[] = [];
  for (const botName of entries.keys()) {
    claims.push(...databaseClaimsForBot(botName, resolve));
  }
  return claims;
}

function databaseClaimsForBot(
  botName: string,
  resolve: ResolveBotConfig,
): DatabaseClaim[] {
  const worker = resolve(botName, 'worker').rulesPack;
  if (!worker) return [];
  const bridge = resolve(botName, 'bridge').rulesPack;
  if (!bridge) {
    throw new WorkerRunnerError(`Worker RulesPack database for bot ${botName} has no Bridge peer`, 'CONFLICT');
  }
  return [
    { botName, surface: 'bridge', identity: databaseIdentity(bridge) },
    { botName, surface: 'worker', identity: databaseIdentity(worker) },
  ];
}

function validateDatabaseClaims(claims: readonly DatabaseClaim[]): void {
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    const left = claims[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const right = claims[rightIndex];
      if (left.surface !== 'worker' && right.surface !== 'worker') continue;
      if (aliasesDatabase(left.identity, right.identity)) {
        throw new WorkerRunnerError(
          `RulesPack ${left.surface} database for bot ${left.botName} aliases ${right.surface} database for bot ${right.botName}`,
          'CONFLICT',
        );
      }
    }
  }
}

function databaseIdentity(config: RulesPackConfig): DatabaseIdentity {
  const configuredPath = resolveRulesPackDbPath(config.dbPath);
  if (configuredPath === ':memory:') {
    throw new WorkerRunnerError('Bot-scoped Worker RulesPack requires a durable database', 'CONFLICT');
  }
  const absolute = path.resolve(configuredPath);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new WorkerRunnerError('Worker RulesPack database must not be a symlink', 'CONFLICT');
    }
    const canonical = realpathSync(absolute);
    const target = statSync(canonical);
    return {
      pathKey: databasePathKey(canonical),
      inodeKey: `${String(target.dev)}:${String(target.ino)}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    pathKey: databasePathKey(canonicalProspectivePath(absolute)),
  };
}

function canonicalProspectivePath(filePath: string): string {
  const tail: string[] = [path.basename(filePath)];
  let parent = path.dirname(filePath);
  while (true) {
    try {
      return path.join(realpathSync(parent), ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const next = path.dirname(parent);
    if (next === parent) return filePath;
    tail.push(path.basename(parent));
    parent = next;
  }
}

function databasePathKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function aliasesDatabase(left: DatabaseIdentity, right: DatabaseIdentity): boolean {
  return left.pathKey === right.pathKey || (
    left.inodeKey !== undefined && right.inodeKey !== undefined && left.inodeKey === right.inodeKey
  );
}

function readBoundedJson<T>(configPath: string, label: string): T {
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  return JSON.parse(readFileSync(realpathSync(configPath), 'utf8')) as T;
}

const stderrLogger = {
  debug: (_bindings: unknown, _message?: string) => undefined,
  info: (_bindings: unknown, _message?: string) => undefined,
  warn: (bindings: unknown, message?: string) => {
    process.stderr.write(`worker-rulespack warning: ${message ?? ''} ${safe(bindings)}\n`);
  },
  error: (bindings: unknown, message?: string) => {
    process.stderr.write(`worker-rulespack error: ${message ?? ''} ${safe(bindings)}\n`);
  },
};

function safe(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'string'
      ? item.replace(/(authorization|token|secret|password)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
      : item,
  ).slice(0, 2_000);
}
