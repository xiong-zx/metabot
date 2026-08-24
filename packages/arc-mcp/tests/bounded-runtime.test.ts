import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tripwires, installed before anything under test is imported.
 *
 * Every refusal in this file is supposed to happen *before* the official
 * process exists. A test that merely asserts "start() rejected" cannot tell a
 * pre-spawn refusal apart from a run that was launched, spent money, and then
 * failed — so the whole of `node:child_process` throws here, and the counters
 * are asserted to be zero alongside each refusal.
 */
const { subprocessAttempts, networkAttempts } = vi.hoisted(() => ({
  subprocessAttempts: [] as string[],
  networkAttempts: [] as string[],
}));

vi.mock('node:child_process', () => {
  const tripwire =
    (name: string) =>
    (...args: unknown[]): never => {
      subprocessAttempts.push(`${name} ${String(args[0])}`);
      throw new Error(`tripwire: a bounded-run refusal path reached ${name}`);
    };
  const api = {
    spawn: tripwire('spawn'),
    spawnSync: tripwire('spawnSync'),
    exec: tripwire('exec'),
    execSync: tripwire('execSync'),
    execFile: tripwire('execFile'),
    execFileSync: tripwire('execFileSync'),
    fork: tripwire('fork'),
  };
  return { ...api, default: api };
});

import { ARC_INPUT_CONTRACT_VERSION, type ArcExecutionInput } from '../src/contract.js';
import { ArcError } from '../src/errors.js';
import {
  OfficialArcDriver,
  selectBoundedRuntime,
  type BoundedExecutionRequirement,
  type ResolveOfficialReleaseOptions,
  type ResolvedOfficialRelease,
} from '../src/official-driver.js';
import { OfficialArcProcessSupervisor } from '../src/official-supervisor.js';
import type { OfficialBudgetDocument } from '../src/bounded-execution.js';
import type { ExternalReleaseManifest } from '../src/releases/manifest.js';
import {
  ARC_HARD_BUDGET_CANDIDATE_SPEC,
  OFFICIAL_RESEARCHCLAW_COMPAT_SPEC,
  OFFICIAL_RESEARCHCLAW_TAG_SPEC,
} from '../src/releases/spec.js';
import { parseBoundedRuntimeArguments, resolveConfiguredRunner } from '../src/runtime.js';
import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';

const POLICY = 'arc-006-bounded-acceptance';
const REVISION = ARC_HARD_BUDGET_CANDIDATE_SPEC.revision;

let root: string;
let projectRoot: string;
let configPath: string;
let realFetch: typeof globalThis.fetch;

const CONFIG_BODY = 'budget:\n  enforcement: required\n';

function boundedDocument(overrides: Record<string, unknown> = {}): OfficialBudgetDocument {
  return {
    config_sha256: createHash('sha256').update(CONFIG_BODY).digest('hex'),
    budget: {
      enforcement: 'required',
      policy_id: POLICY,
      provider: 'anthropic',
      max_calls: 40,
      max_prompt_tokens_per_call: 32_000,
      max_completion_tokens_per_call: 4_000,
      max_prompt_tokens_total: 600_000,
      max_completion_tokens_total: 80_000,
      max_usd_total: 5,
      allow_preflight: true,
      models: [{ model: 'claude-haiku-4-5', max_completion_tokens: 4_000 }],
    },
    llm: { provider: 'anthropic', primary_model: 'claude-haiku-4-5', fallback_models: [] },
    experiment: {
      opencode_enabled: false,
      repair_enabled: true,
      repair_uses_opencode: false,
      cli_agent_provider: 'llm',
      gemini_image_enabled: false,
    },
    ...overrides,
  };
}

function release(bounded?: BoundedExecutionRequirement): ResolvedOfficialRelease {
  const manifest = {
    schema_version: 'metabot.autoresearchclaw.release.v1',
    release_id: 'unofficial-0.5.0-8fa6d66d1b8f-hard-budget-guard-v2',
    product: 'AutoResearchClaw',
    state: 'candidate',
    commit: REVISION,
    version: '0.5.0',
    stage_count: 23,
  } as unknown as ExternalReleaseManifest;
  return {
    releaseRoot: root,
    releaseId: 'unofficial-0.5.0-8fa6d66d1b8f-hard-budget-guard-v2',
    python: path.join(root, 'python'),
    sourceDir: path.join(root, 'source'),
    manifest,
    manifestPath: path.join(root, 'manifest.json'),
    pairing: { revision: REVISION } as ResolvedOfficialRelease['pairing'],
    ...(bounded ? { bounded } : {}),
  };
}

function supervisor(options: {
  document?: OfficialBudgetDocument | (() => OfficialBudgetDocument);
  generatedConfig?: boolean;
} = {}): OfficialArcProcessSupervisor {
  const load = options.document;
  return new OfficialArcProcessSupervisor({
    // Would be a loud failure if anything reached it; the tripwire fires first.
    supervisorCommand: { command: '/nonexistent/never-spawned', args: [] },
    detachedRunnerPath: '/nonexistent/detached-runner.mjs',
    ...(options.generatedConfig ? {} : { defaultConfigPath: configPath }),
    ...(load ? { loadBudgetDocument: () => (typeof load === 'function' ? load() : load) } : {}),
    pollIntervalMs: 25,
    registrationTimeoutMs: 100,
  });
}

function input(runId: string): ArcExecutionInput {
  return {
    contract_version: ARC_INPUT_CONTRACT_VERSION,
    project_id: 'bounded-project',
    run_id: runId,
    objective: 'Prove the ceiling before anything can spend.',
    project_root: projectRoot,
    artifact_path: path.posix.join('.metabot-arc', 'runs', runId, 'output.json'),
    requested_at: new Date().toISOString(),
  };
}

/** Asserts a refusal happened with no process started and no request sent. */
function expectNoSideEffects(): void {
  expect(subprocessAttempts, 'a refusal path started a subprocess').toEqual([]);
  expect(networkAttempts, 'a refusal path reached the network').toEqual([]);
}

beforeEach(() => {
  subprocessAttempts.length = 0;
  networkAttempts.length = 0;
  root = temporaryDirectory('arc-bounded-runtime-');
  projectRoot = projectDirectory(root);
  configPath = path.join(root, 'official-config.yaml');
  writeFileSync(configPath, CONFIG_BODY, 'utf8');
  realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: unknown[]) => {
    networkAttempts.push(`fetch ${String(args[0])}`);
    throw new Error('tripwire: a bounded-run refusal path reached the network');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  removeDirectory(root);
});

describe('bounded config validation happens before the process exists', () => {
  it('refuses a bounded run whose config does not name the authorized policy', async () => {
    const document = boundedDocument();
    (document.budget as Record<string, unknown>).policy_id = 'some-other-policy';
    await expect(
      supervisor({ document }).start(input('run-wrong-policy'), release({ require: true, policyId: POLICY })),
    ).rejects.toThrow(/but the run was authorized for/i);
    expectNoSideEffects();
  });

  it('refuses a bounded run whose config never turned enforcement on', async () => {
    const document = boundedDocument();
    (document.budget as Record<string, unknown>).enforcement = 'off';
    await expect(
      supervisor({ document }).start(input('run-off'), release({ require: true, policyId: POLICY })),
    ).rejects.toThrow(/only "required"/i);
    expectNoSideEffects();
  });

  it('refuses a bounded run above the authorized USD ceiling', async () => {
    const document = boundedDocument();
    (document.budget as Record<string, unknown>).max_usd_total = 50;
    await expect(
      supervisor({ document }).start(input('run-expensive'), release({ require: true, policyId: POLICY })),
    ).rejects.toThrow(/above the authorized ceiling of USD 5/i);
    expectNoSideEffects();
  });

  it('refuses a bounded run that leaves an unbudgetable stage enabled', async () => {
    const document = boundedDocument();
    (document.experiment as Record<string, unknown>).opencode_enabled = true;
    await expect(
      supervisor({ document }).start(input('run-opencode'), release({ require: true, policyId: POLICY })),
    ).rejects.toThrow(/experiment\.opencode\.enabled is true/i);
    expectNoSideEffects();
  });

  it('refuses a bounded run declared without a policy at all', async () => {
    await expect(
      supervisor({ document: boundedDocument() }).start(input('run-nopolicy'), release({ require: true })),
    ).rejects.toThrow(/a ceiling nobody stated is not a bound/i);
    expectNoSideEffects();
  });

  /**
   * The validated document and the spawned config must be the same bytes.
   * Otherwise a file swapped between the two is a ceiling that was proven
   * about a document the runner never sees.
   */
  it('refuses when the validated policy came from different config bytes', async () => {
    const document = boundedDocument({ config_sha256: 'a'.repeat(64) });
    await expect(
      supervisor({ document }).start(input('run-swapped'), release({ require: true, policyId: POLICY })),
    ).rejects.toThrow(/different config bytes than the ones handed to the official runner/i);
    expectNoSideEffects();
  });

  it('refuses to bound a run through the generated ACP config', async () => {
    await expect(
      supervisor({ document: boundedDocument(), generatedConfig: true }).start(
        input('run-generated'),
        release({ require: true, policyId: POLICY }),
      ),
    ).rejects.toThrow(/cannot use the generated ACP config/i);
    expectNoSideEffects();
  });

  it('propagates a probe that could not read the policy at all', async () => {
    const boom = () => {
      throw new ArcError('runner_unconfigured', 'Could not read the official budget policy: exit 1');
    };
    await expect(
      supervisor({ document: boom }).start(input('run-probe-failed'), release({ require: true, policyId: POLICY })),
    ).rejects.toThrow(/could not read the official budget policy/i);
    expectNoSideEffects();
  });

  it('never consults the budget probe for a run nobody declared bounded', async () => {
    let consulted = false;
    const supervisorUnbounded = new OfficialArcProcessSupervisor({
      supervisorCommand: { command: '/nonexistent/never-spawned', args: [] },
      detachedRunnerPath: '/nonexistent/detached-runner.mjs',
      defaultConfigPath: configPath,
      loadBudgetDocument: () => {
        consulted = true;
        return boundedDocument();
      },
      pollIntervalMs: 25,
      registrationTimeoutMs: 100,
    });
    // Reaches the spawn tripwire, which is exactly the point: an unbounded run
    // is unchanged and proceeds all the way to launching the supervisor.
    await expect(supervisorUnbounded.start(input('run-unbounded'), release())).rejects.toThrow(/tripwire/i);
    expect(consulted).toBe(false);
    expect(subprocessAttempts.some((entry) => entry.startsWith('spawn '))).toBe(true);
  });
});

describe('disposable bounded selection', () => {
  it('selects a named mcp-execution release for a named policy', () => {
    const selection = selectBoundedRuntime({ specName: 'hard-budget-candidate', policyId: POLICY });
    expect(selection.spec).toBe(ARC_HARD_BUDGET_CANDIDATE_SPEC);
    expect(selection.official).toBe(false);
    expect(selection.bounded).toEqual({ require: true, policyId: POLICY });

    const official = selectBoundedRuntime({ specName: 'mcp-execution', policyId: POLICY });
    expect(official.spec).toBe(OFFICIAL_RESEARCHCLAW_COMPAT_SPEC);
    expect(official.official).toBe(true);
    expect(official.bounded).toEqual({ require: true, policyId: POLICY });
  });

  it('has no default and no environment variable to select by accident', () => {
    expect(() => selectBoundedRuntime({ specName: '', policyId: POLICY })).toThrow(/unknown arc runtime selection/i);
    expect(() => selectBoundedRuntime({ specName: 'candidate', policyId: POLICY })).toThrow(
      /unknown arc runtime selection/i,
    );
    for (const inherited of ['constructor', 'toString', '__proto__']) {
      expect(() => selectBoundedRuntime({ specName: inherited, policyId: POLICY }), inherited).toThrow(
        /unknown arc runtime selection/i,
      );
    }
  });

  /**
   * A blank policy must not quietly become an unbounded run. Downgrading here
   * would turn a request to bound a run into the one thing this whole path
   * exists to prevent.
   */
  it('refuses a blank policy instead of downgrading to an unbounded run', () => {
    for (const specName of ['mcp-execution', 'hard-budget-candidate']) {
      expect(() => selectBoundedRuntime({ specName, policyId: '   ' }), specName).toThrow(
        /without naming a budget policy/i,
      );
    }
  });

  it('refuses to launch the release sealed for the direct human CLI', () => {
    expect(() => selectBoundedRuntime({ specName: 'direct-cli', policyId: POLICY })).toThrow(
      /sealed for direct CLI use and may not be launched by the driver/i,
    );
    expect(OFFICIAL_RESEARCHCLAW_TAG_SPEC.patch).toBeUndefined();
  });

  it('refuses both superseded v1 pins even when they are named explicitly', () => {
    for (const specName of ['mcp-execution-v1', 'hard-budget-candidate-v1']) {
      expect(() => selectBoundedRuntime({ specName, policyId: POLICY }), specName).toThrow(/superseded/i);
    }
  });

  it('carries the selected spec and its ceiling into release resolution', async () => {
    const seen: ResolveOfficialReleaseOptions[] = [];
    const selection = selectBoundedRuntime({ specName: 'hard-budget-candidate', policyId: POLICY });
    const driver = new OfficialArcDriver({
      releaseRoot: root,
      supervisor: { start: () => Promise.reject(new Error('unreachable')) } as never,
      spec: selection.spec,
      bounded: selection.bounded,
      resolve: async (options) => {
        seen.push(options);
        throw new ArcError('runner_unconfigured', 'stop here');
      },
    });
    await expect(driver.start(input('run-forward'))).rejects.toThrow(/stop here/i);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.spec).toBe(ARC_HARD_BUDGET_CANDIDATE_SPEC);
    expect(seen[0]!.bounded).toEqual({ require: true, policyId: POLICY });
    expectNoSideEffects();
  });
});

describe('bounded selection is explicit on the command line', () => {
  it('is absent unless an operator asked for it', () => {
    expect(parseBoundedRuntimeArguments([])).toBeUndefined();
    expect(parseBoundedRuntimeArguments(['--verbose', 'x'])).toBeUndefined();
  });

  it('reads a release and a policy together', () => {
    expect(
      parseBoundedRuntimeArguments(['--bounded-release', 'hard-budget-candidate', '--budget-policy', POLICY]),
    ).toEqual({ specName: 'hard-budget-candidate', policyId: POLICY });
  });

  it('refuses half a bound', () => {
    expect(() => parseBoundedRuntimeArguments(['--bounded-release', 'hard-budget-candidate'])).toThrow(
      /needs both --bounded-release/i,
    );
    expect(() => parseBoundedRuntimeArguments(['--budget-policy', POLICY])).toThrow(/needs both --bounded-release/i);
    expect(() => parseBoundedRuntimeArguments(['--bounded-release', '--budget-policy', POLICY])).toThrow(
      /--bounded-release requires a value/i,
    );
    expect(() => parseBoundedRuntimeArguments(['--bounded-release', 'mcp-execution', '--budget-policy'])).toThrow(
      /--budget-policy requires a value/i,
    );
  });
});

describe('runtime refuses a bound it cannot honour', () => {
  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    METABOT_ARC_RELEASE_ROOT: '/opt/research-stack/autoresearchclaw',
    ...overrides,
  });

  it('refuses an unknown release at startup, before any run arrives', async () => {
    await expect(resolveConfiguredRunner(env(), { specName: 'nope', policyId: POLICY })).rejects.toThrow(
      /unknown arc runtime selection/i,
    );
    await expect(
      resolveConfiguredRunner(env(), { specName: 'hard-budget-candidate', policyId: '' }),
    ).rejects.toThrow(/without naming a budget policy/i);
    expectNoSideEffects();
  });

  it('refuses to satisfy a bounded request with a fixture runner module', async () => {
    await expect(
      resolveConfiguredRunner(
        { METABOT_ARC_RUNNER_MODULE: '/tmp/fixture-runner.mjs' },
        { specName: 'hard-budget-candidate', policyId: POLICY },
      ),
    ).rejects.toThrow(/METABOT_ARC_RUNNER_MODULE cannot be bounded/i);
  });

  it('leaves the ordinary unbounded daemon exactly as it was', async () => {
    const runner = await resolveConfiguredRunner(env());
    expect(runner).toBeInstanceOf(OfficialArcDriver);
    expect((runner as OfficialArcDriver).release).toBeUndefined();
    expectNoSideEffects();
  });

  it('builds a driver for an explicit bounded selection', async () => {
    const runner = await resolveConfiguredRunner(env(), {
      specName: 'hard-budget-candidate',
      policyId: POLICY,
    });
    expect(runner).toBeInstanceOf(OfficialArcDriver);
    expectNoSideEffects();
  });
});
