import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ArcArtifactStore } from './artifact-store.js';
import { ArcCoordinator } from './coordinator.js';
import { ArcError } from './errors.js';
import { readArcSecretFile } from './local-auth.js';
import { ArcTerminalNotifierService, HttpArcTerminalNotifier } from './notifier.js';
import type { ArcRunner } from './runner.js';
import { ArcRunStore } from './run-store.js';
import { ArcProjectScope } from './scope-policy.js';

type RunnerModule = { createArcRunner?: () => ArcRunner | Promise<ArcRunner> };

export interface ArcRuntime {
  artifacts: ArcArtifactStore;
  coordinator: ArcCoordinator;
  notifications?: ArcTerminalNotifierService;
  runner: ArcRunner;
  scope: ArcProjectScope;
  store: ArcRunStore;
}

export interface CreateArcRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  runner?: ArcRunner;
}

export async function createArcRuntime(options: CreateArcRuntimeOptions = {}): Promise<ArcRuntime> {
  const env = options.env ?? process.env;
  const artifacts = new ArcArtifactStore();
  const scope = new ArcProjectScope(artifacts, {
    allowedProjectRoots: configuredProjectRoots(env),
    ...(env.METABOT_ARC_PROJECT_ID?.trim() ? { fixedProjectId: env.METABOT_ARC_PROJECT_ID.trim() } : {}),
  });
  const store = new ArcRunStore(requiredEnv(env, 'METABOT_ARC_DATA_DIR'));
  try {
    const runner = options.runner ?? (await loadRunner(requiredEnv(env, 'METABOT_ARC_RUNNER_MODULE')));
    assertRunner(runner);
    const coordinator = new ArcCoordinator(store, artifacts, runner, { scope });
    const callbackUrl = env.METABOT_ARC_CALLBACK_URL?.trim();
    const notifications = callbackUrl
      ? new ArcTerminalNotifierService(
          store,
          new HttpArcTerminalNotifier({
            url: callbackUrl,
            signingKey: readArcSecretFile(
              requiredAnyEnv(env, ['METABOT_ARC_CALLBACK_KEY_FILE', 'METABOT_ARC_CALLBACK_SIGNING_KEY_FILE']),
              'ARC callback signing key',
            ),
            timeoutMs: integerEnv(env, 'METABOT_ARC_CALLBACK_TIMEOUT_MS', 30_000),
          }),
          {
            pollIntervalMs: integerEnv(env, 'METABOT_ARC_NOTIFY_POLL_MS', 250),
            retryInitialMs: integerEnv(env, 'METABOT_ARC_NOTIFY_RETRY_INITIAL_MS', 1_000),
            retryMaxMs: integerEnv(env, 'METABOT_ARC_NOTIFY_RETRY_MAX_MS', 60_000),
          },
        )
      : undefined;
    return { artifacts, coordinator, ...(notifications ? { notifications } : {}), runner, scope, store };
  } catch (error) {
    store.close();
    throw error;
  }
}

export function configuredProjectRoots(env: NodeJS.ProcessEnv): string[] {
  const raw = env.METABOT_ARC_PROJECT_ROOTS?.trim();
  if (!raw) {
    throw new ArcError('scope_not_configured', 'METABOT_ARC_PROJECT_ROOTS must be a JSON array of trusted project roots');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ArcError('scope_not_configured', 'METABOT_ARC_PROJECT_ROOTS is not valid JSON', { cause: error });
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ArcError('scope_not_configured', 'METABOT_ARC_PROJECT_ROOTS must contain only paths');
  }
  return value;
}

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ArcError('runner_unconfigured', `${name} is required`);
  return value;
}

export function requiredAnyEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new ArcError('runner_unconfigured', `One of ${names.join(', ')} is required`);
}

export function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ArcError('invalid_contract', `${name} must be positive`);
  return parsed;
}

function assertRunner(value: unknown): asserts value is ArcRunner {
  const candidate = value as Partial<ArcRunner> | null;
  for (const method of ['start', 'pause', 'resume', 'cancel', 'collect'] as const) {
    if (!candidate || typeof candidate[method] !== 'function') {
      throw new ArcError('runner_unconfigured', `ARC runner adapter is missing ${method}()`);
    }
  }
}

async function loadRunner(modulePath: string): Promise<ArcRunner> {
  const resolved = path.resolve(modulePath);
  const module = (await import(pathToFileURL(resolved).href)) as RunnerModule;
  if (typeof module.createArcRunner !== 'function') {
    throw new ArcError('runner_unconfigured', 'ARC runner module must export createArcRunner()');
  }
  return module.createArcRunner();
}
