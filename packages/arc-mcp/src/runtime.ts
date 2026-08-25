import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ArcArtifactStore } from './artifact-store.js';
import { ArcCoordinator } from './coordinator.js';
import { ArcError } from './errors.js';
import { OfficialArcDriver, selectBoundedRuntime } from './official-driver.js';
import { OfficialArcProcessSupervisor } from './official-supervisor.js';
import type { ArcRunner } from './runner.js';
import { ArcRunStore } from './run-store.js';
import { ArcProjectScope } from './scope-policy.js';

type RunnerModule = { createArcRunner?: () => ArcRunner | Promise<ArcRunner> };

export interface ArcRuntime {
  artifacts: ArcArtifactStore;
  coordinator: ArcCoordinator;
  runner: ArcRunner;
  scope: ArcProjectScope;
  store: ArcRunStore;
}

/**
 * One disposable bounded run's release and ceiling.
 *
 * Passed in by the caller, never read from `env`. The ordinary daemon has no
 * way to reach this: an environment variable that could select a patched
 * candidate, or silently mark a run bounded, would eventually do so by
 * accident in a shell that outlived its purpose.
 */
export interface BoundedRuntimeRequest {
  /** A name from `EXTERNAL_RELEASE_SPECS`; there is no default. */
  specName: string;
  /** Budget policy the official config must name; blank is refused. */
  policyId: string;
}

/**
 * Reads a disposable bounded selection off the command line.
 *
 * Both flags or neither: naming a release without a policy, or a policy
 * without a release, is a half-stated intention rather than a bound, and
 * guessing the other half is exactly how an unbounded run gets started by
 * something that looked like a bounded one.
 */
export function parseBoundedRuntimeArguments(argv: readonly string[]): BoundedRuntimeRequest | undefined {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ArcError('runner_unconfigured', `${flag} requires a value`);
    }
    return value;
  };
  const specName = read('--bounded-release');
  const policyId = read('--budget-policy');
  if (specName === undefined && policyId === undefined) return undefined;
  if (specName === undefined || policyId === undefined) {
    throw new ArcError(
      'runner_unconfigured',
      'A bounded run needs both --bounded-release <name> and --budget-policy <id>; neither has a default',
    );
  }
  return { specName, policyId };
}

export interface CreateArcRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  runner?: ArcRunner;
  /**
   * Omitted, the runtime behaves exactly as it always has. Present, the driver
   * refuses to start unless the release proves it enforces a hard ceiling and
   * the config proves the run was given this policy.
   */
  bounded?: BoundedRuntimeRequest;
}

export async function createArcRuntime(options: CreateArcRuntimeOptions = {}): Promise<ArcRuntime> {
  const env = options.env ?? process.env;
  const artifacts = new ArcArtifactStore();
  const scope = new ArcProjectScope(artifacts, {
    allowedProjectRoots: configuredProjectRoots(env),
    ...(env.ARC_MCP_PROJECT_ID?.trim() ? { fixedProjectId: env.ARC_MCP_PROJECT_ID.trim() } : {}),
  });
  const store = new ArcRunStore(requiredEnv(env, 'ARC_MCP_DATA_DIR'));
  try {
    const runner = options.runner ?? (await resolveConfiguredRunner(env, options.bounded));
    assertRunner(runner);
    const coordinator = new ArcCoordinator(store, artifacts, runner, { scope });
    return { artifacts, coordinator, runner, scope, store };
  } catch (error) {
    store.close();
    throw error;
  }
}

export function configuredProjectRoots(env: NodeJS.ProcessEnv): string[] {
  const raw = env.ARC_MCP_PROJECT_ROOTS?.trim();
  if (!raw) {
    throw new ArcError('scope_not_configured', 'ARC_MCP_PROJECT_ROOTS must be a JSON array of trusted project roots');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ArcError('scope_not_configured', 'ARC_MCP_PROJECT_ROOTS is not valid JSON', { cause: error });
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ArcError('scope_not_configured', 'ARC_MCP_PROJECT_ROOTS must contain only paths');
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
  for (const method of ['start', 'recover', 'pause', 'resume', 'cancel', 'collect'] as const) {
    if (!candidate || typeof candidate[method] !== 'function') {
      throw new ArcError('runner_unconfigured', `ARC runner adapter is missing ${method}()`);
    }
  }
}

/**
 * The official external CLI is the production runner. A module path stays
 * supported for fixtures and for an operator-pinned experiment, but it is never
 * a silent fallback: if the release root is configured and its release does not
 * verify, the daemon fails rather than quietly executing something else.
 */
export async function resolveConfiguredRunner(
  env: NodeJS.ProcessEnv,
  bounded?: BoundedRuntimeRequest,
): Promise<ArcRunner> {
  const releaseRoot = env.ARC_MCP_RELEASE_ROOT?.trim();
  const runnerModule = env.ARC_MCP_RUNNER_MODULE?.trim();
  if (releaseRoot && runnerModule) {
    throw new ArcError(
      'runner_unconfigured',
      'Set either ARC_MCP_RELEASE_ROOT or ARC_MCP_RUNNER_MODULE, not both',
    );
  }
  if (releaseRoot) {
    // Resolved before the driver exists, so an unknown release name or a
    // blank policy is a startup refusal rather than a daemon that accepts
    // runs and only discovers it cannot bound them once one arrives.
    const selection = bounded ? selectBoundedRuntime(bounded) : undefined;
    return new OfficialArcDriver({
      releaseRoot: path.resolve(releaseRoot),
      ...(selection ? { spec: selection.spec, bounded: selection.bounded } : {}),
      supervisor: new OfficialArcProcessSupervisor({
        ...(env.ARC_MCP_OFFICIAL_CONFIG_FILE?.trim()
          ? { defaultConfigPath: env.ARC_MCP_OFFICIAL_CONFIG_FILE.trim() }
          : {}),
        ...(env.ARC_MCP_OFFICIAL_HITL_MODE?.trim()
          ? { defaultHitlMode: env.ARC_MCP_OFFICIAL_HITL_MODE.trim() }
          : {}),
        ...(env.ARC_MCP_OFFICIAL_ACP_AGENT?.trim()
          ? { acpAgent: env.ARC_MCP_OFFICIAL_ACP_AGENT.trim() }
          : {}),
        ...(env.ARC_MCP_OFFICIAL_ACPX_COMMAND?.trim()
          ? { acpxCommand: env.ARC_MCP_OFFICIAL_ACPX_COMMAND.trim() }
          : {}),
        pollIntervalMs: integerEnv(env, 'ARC_MCP_OFFICIAL_POLL_MS', 1_000),
      }),
    });
  }
  if (runnerModule) {
    // A fixture runner proves nothing about a ceiling, so a bounded request
    // must not quietly become an unbounded fixture run.
    if (bounded) {
      throw new ArcError(
        'runner_unconfigured',
        'A bounded run must execute a sealed official release; ARC_MCP_RUNNER_MODULE cannot be bounded',
      );
    }
    return loadRunner(runnerModule);
  }
  throw new ArcError(
    'runner_unconfigured',
    'ARC_MCP_RELEASE_ROOT is required (or ARC_MCP_RUNNER_MODULE for a pinned fixture runner)',
  );
}

async function loadRunner(modulePath: string): Promise<ArcRunner> {
  const resolved = path.resolve(modulePath);
  const module = (await import(pathToFileURL(resolved).href)) as RunnerModule;
  if (typeof module.createArcRunner !== 'function') {
    throw new ArcError('runner_unconfigured', 'ARC runner module must export createArcRunner()');
  }
  return module.createArcRunner();
}
