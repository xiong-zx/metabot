import os from 'node:os';
import path from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { readPrivateKeyFile } from './local-auth.js';
import { createWorkerRunnerMcpServer } from './mcp-server.js';
import { HttpCompletionNotifier, NoopCompletionNotifier } from './notifier.js';
import { NodeCliProcessRunner } from './process-runner.js';
import { WorkerService, normalizeTrustedPrincipal } from './service.js';
import { WorkerStore } from './store.js';
import type { TrustedPrincipal } from './types.js';
import { createWorkerRulesPackProvider } from './rulespack.js';
import type { RulesPackChildGrantV1 } from '@metabot/rulespack';

export interface WorkerRunnerServiceRuntime {
  principal?: TrustedPrincipal;
  store: WorkerStore;
  service: WorkerService;
}

export interface WorkerRunnerRuntime extends WorkerRunnerServiceRuntime {
  principal: TrustedPrincipal;
  server: Server;
}

export interface CreateWorkerRunnerRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  principal?: TrustedPrincipal;
}

export interface CreateWorkerRunnerServiceRuntimeOptions extends CreateWorkerRunnerRuntimeOptions {
  dynamicPrincipals?: boolean;
  rulesPackGrantVerifier?: (grant: RulesPackChildGrantV1, capability: string) => RulesPackChildGrantV1;
}

export function createWorkerRunnerServiceRuntime(
  options: CreateWorkerRunnerServiceRuntimeOptions = {},
): WorkerRunnerServiceRuntime {
  const env = options.env ?? process.env;
  const dynamicPrincipals = options.dynamicPrincipals === true;
  if (env.METABOT_WORKER_CALLBACK_URL?.trim() && !dynamicPrincipals) {
    throw new Error('Worker terminal callbacks require authenticated daemon mode');
  }
  const configuredPrincipal = options.principal ?? principalFromEnv(env);
  const principal = configuredPrincipal ? normalizeTrustedPrincipal(configuredPrincipal) : undefined;
  if (!dynamicPrincipals && !principal) normalizeTrustedPrincipal(undefined);
  const dataDir = path.resolve(env.METABOT_WORKER_DATA_DIR || path.join(os.homedir(), '.metabot', 'worker-runner'));
  const store = new WorkerStore(path.join(dataDir, 'workers.sqlite'));
  try {
    const runner = new NodeCliProcessRunner({
      executables: {
        ...(env.METABOT_WORKER_CODEX_EXECUTABLE ? { codex: env.METABOT_WORKER_CODEX_EXECUTABLE } : {}),
        ...(env.METABOT_WORKER_CLAUDE_EXECUTABLE ? { claude: env.METABOT_WORKER_CLAUDE_EXECUTABLE } : {}),
        ...(env.METABOT_WORKER_KIMI_EXECUTABLE ? { kimi: env.METABOT_WORKER_KIMI_EXECUTABLE } : {}),
      },
      maxOutputBytes: integerEnv(env, 'METABOT_WORKER_MAX_OUTPUT_BYTES', 1_048_576),
      killGraceMs: integerEnv(env, 'METABOT_WORKER_KILL_GRACE_MS', 2_000),
      claudeMaxBudgetUsd: integerEnv(env, 'METABOT_WORKER_CLAUDE_MAX_BUDGET_USD', 3),
      sourceEnv: env,
      safeEnvAllowlist: csvEnv(env.METABOT_WORKER_ENV_ALLOWLIST),
    });
    const notifier = env.METABOT_WORKER_CALLBACK_URL
      ? new HttpCompletionNotifier({
          url: env.METABOT_WORKER_CALLBACK_URL,
          signingKey: readPrivateKeyFile(
            requiredEnv(env, 'METABOT_WORKER_CALLBACK_PRIVATE_KEY_FILE'),
            'Worker callback private key',
          ),
          timeoutMs: integerEnv(env, 'METABOT_WORKER_CALLBACK_TIMEOUT_MS', 30_000),
        })
      : new NoopCompletionNotifier();
    const service = new WorkerService(
      store,
      runner,
      notifier,
      principal,
      {
        maxConcurrentPerScope: integerEnv(env, 'METABOT_WORKER_MAX_PER_SCOPE', 4),
        defaultTimeoutMs: integerEnv(env, 'METABOT_WORKER_DEFAULT_TIMEOUT_MS', 60 * 60 * 1_000),
        defaultIdleTimeoutMs: integerEnv(env, 'METABOT_WORKER_DEFAULT_IDLE_TIMEOUT_MS', 10 * 60 * 1_000),
        maxTimeoutMs: integerEnv(env, 'METABOT_WORKER_MAX_TIMEOUT_MS', 7 * 24 * 60 * 60 * 1_000),
        maxIdleTimeoutMs: integerEnv(env, 'METABOT_WORKER_MAX_IDLE_TIMEOUT_MS', 24 * 60 * 60 * 1_000),
        defaultDedupeTtlMs: integerEnv(env, 'METABOT_WORKER_DEDUPE_TTL_MS', 24 * 60 * 60 * 1_000),
        maxDedupeTtlMs: integerEnv(env, 'METABOT_WORKER_MAX_DEDUPE_TTL_MS', 30 * 24 * 60 * 60 * 1_000),
        maxListLimit: integerEnv(env, 'METABOT_WORKER_MAX_LIST_LIMIT', 100),
        notificationRetryInitialMs: integerEnv(env, 'METABOT_WORKER_NOTIFY_RETRY_INITIAL_MS', 1_000),
        notificationRetryMaxMs: integerEnv(env, 'METABOT_WORKER_NOTIFY_RETRY_MAX_MS', 60_000),
      },
      {
        dynamicPrincipals,
        rulesPackProvider: createWorkerRulesPackProvider(env),
        rulesPackGrantVerifier: options.rulesPackGrantVerifier,
      },
    );
    return { ...(principal ? { principal } : {}), store, service };
  } catch (error) {
    store.close();
    throw error;
  }
}

export function createWorkerRunnerRuntime(options: CreateWorkerRunnerRuntimeOptions = {}): WorkerRunnerRuntime {
  const env = options.env ?? process.env;
  const core = createWorkerRunnerServiceRuntime(options);
  const principal = core.principal as TrustedPrincipal;
  return {
    ...core,
    principal,
    server: createWorkerRunnerMcpServer(core.service, principal, {
      maxStatusOutputChars: integerEnv(env, 'METABOT_WORKER_STATUS_OUTPUT_CHARS', 16_384),
    }),
  };
}

function principalFromEnv(env: NodeJS.ProcessEnv): TrustedPrincipal | undefined {
  const role = env.METABOT_WORKER_PRINCIPAL_ROLE;
  const botName = env.METABOT_WORKER_PRINCIPAL_BOT_NAME;
  const chatId = env.METABOT_WORKER_PRINCIPAL_CHAT_ID;
  if (!role && !botName && !chatId) return undefined;
  return { role: role as TrustedPrincipal['role'], botName: botName ?? '', chatId: chatId ?? '' };
}

export function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function requiredAnyEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`One of ${names.join(', ')} is required`);
}

function csvEnv(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
