import os from 'node:os';
import path from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createWorkerRunnerMcpServer } from './mcp-server.js';
import { HttpCompletionNotifier, NoopCompletionNotifier } from './notifier.js';
import { NodeCliProcessRunner } from './process-runner.js';
import { WorkerService, normalizeTrustedPrincipal } from './service.js';
import { WorkerStore } from './store.js';
import type { TrustedPrincipal } from './types.js';

export interface WorkerRunnerRuntime {
  principal: TrustedPrincipal;
  store: WorkerStore;
  service: WorkerService;
  server: Server;
}

export interface CreateWorkerRunnerRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  principal?: TrustedPrincipal;
}

export function createWorkerRunnerRuntime(options: CreateWorkerRunnerRuntimeOptions = {}): WorkerRunnerRuntime {
  const env = options.env ?? process.env;
  const principal = normalizeTrustedPrincipal(options.principal ?? principalFromEnv(env));
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
      sourceEnv: env,
      safeEnvAllowlist: csvEnv(env.METABOT_WORKER_ENV_ALLOWLIST),
    });
    const notifier = env.METABOT_WORKER_CALLBACK_URL
      ? new HttpCompletionNotifier({
          url: env.METABOT_WORKER_CALLBACK_URL,
          bearerToken: env.METABOT_WORKER_CALLBACK_TOKEN,
          timeoutMs: integerEnv(env, 'METABOT_WORKER_CALLBACK_TIMEOUT_MS', 30_000),
        })
      : new NoopCompletionNotifier();
    const service = new WorkerService(store, runner, notifier, principal, {
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
    });
    return {
      principal,
      store,
      service,
      server: createWorkerRunnerMcpServer(service, principal, {
        maxStatusOutputChars: integerEnv(env, 'METABOT_WORKER_STATUS_OUTPUT_CHARS', 16_384),
      }),
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

function principalFromEnv(env: NodeJS.ProcessEnv): TrustedPrincipal | undefined {
  const role = env.METABOT_WORKER_PRINCIPAL_ROLE;
  const botName = env.METABOT_WORKER_PRINCIPAL_BOT_NAME;
  const chatId = env.METABOT_WORKER_PRINCIPAL_CHAT_ID;
  if (!role && !botName && !chatId) return undefined;
  return { role: role as TrustedPrincipal['role'], botName: botName ?? '', chatId: chatId ?? '' };
}

function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function csvEnv(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
