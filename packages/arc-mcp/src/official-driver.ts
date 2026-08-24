import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArcError } from './errors.js';
import type { OfficialBudgetDocument } from './bounded-execution.js';
import type { ArcExecutionHandle, ArcExecutionInput } from './contract.js';
import type { ArcRunner, ArcRunnerResult } from './runner.js';
import {
  externalReleasePaths,
  verifyExternalRuntimePairing,
  type CommandResult,
  type ExternalProbe,
  type RuntimePairingResult,
} from './releases/release-manager.js';
import { parseReleaseManifest, type ExternalReleaseManifest } from './releases/manifest.js';
import {
  ARC_MCP_PACKAGE,
  ARC_MCP_VERSION,
  EXTERNAL_RELEASE_SPECS,
  OFFICIAL_RESEARCHCLAW_SPEC,
  assertReleaseSpecEligible,
  releaseSpecByName,
  specProvenanceClass,
  specRole,
  type ExternalReleaseSpec,
} from './releases/spec.js';

/** Directory name of the official Python package inside the sealed source tree. */
export const OFFICIAL_ARC_PACKAGE_DIR = 'researchclaw';

/**
 * Console scripts a sealed release must still execute after it is sealed.
 *
 * `researchclaw` is the entry point ARC-009's direct CLI selector execs and the
 * one an operator runs by hand, so an install that sealed the virtualenv into
 * something that can no longer answer `--help` has produced an unusable
 * release and must fail rather than be recorded.
 */
export const OFFICIAL_ARC_CONSOLE_SCRIPTS: readonly string[] = ['researchclaw'];

export function officialBridgePath(): string {
  return fileURLToPath(new URL('../python/bridge.py', import.meta.url));
}

export function officialCompatibilityPath(): string {
  return fileURLToPath(new URL('../python/official_compat.py', import.meta.url));
}

export interface ResolvedOfficialRelease {
  releaseRoot: string;
  releaseId: string;
  python: string;
  sourceDir: string;
  manifest: ExternalReleaseManifest;
  manifestPath: string;
  pairing: RuntimePairingResult;
  /**
   * The bound this release was resolved under, carried so the supervisor
   * validates the same requirement the driver was asked for instead of being
   * separately configured with one that could drift.
   */
  bounded?: BoundedExecutionRequirement;
}

/**
 * Declares that a run may spend real money, and states the bound it must obey.
 *
 * Absent, the driver keeps its existing behaviour, which is what every
 * non-billable acceptance path relies on. Present with `require: true`, the
 * driver refuses to start unless the pinned release proved it enforces a hard
 * ceiling *and* the caller named the policy that ceiling comes from — an
 * enforcing release with no stated policy is not a bounded run, and a stated
 * policy against a release that cannot enforce it is not one either.
 */
export interface BoundedExecutionRequirement {
  require: boolean;
  /** Identifier of the budget policy the official config will carry. */
  policyId?: string;
}

export interface ResolveOfficialReleaseOptions {
  releaseRoot: string;
  spec?: ExternalReleaseSpec;
  execute?: (command: string, args: string[]) => CommandResult;
  probe?: (python: string, bridgePath: string) => Promise<ExternalProbe>;
  bounded?: BoundedExecutionRequirement;
}

/**
 * Fail-closed launch gate. Nothing may be executed as "official
 * AutoResearchClaw" unless the sealed release on disk still proves the exact
 * pinned origin, revision, tree, dependency freeze, `acpx` version, and
 * downstream compatibility.
 */
export async function resolveOfficialRelease(
  options: ResolveOfficialReleaseOptions,
): Promise<ResolvedOfficialRelease> {
  const spec = options.spec ?? OFFICIAL_RESEARCHCLAW_SPEC;
  assertReleaseSpecEligible(spec, 'launched');
  const execute = options.execute ?? defaultExecute;
  const probe = options.probe ?? probeOfficialResearchClaw;
  const paths = externalReleasePaths(options.releaseRoot, spec);
  if (!existsSync(paths.release)) {
    throw new ArcError('runner_unconfigured', 'Pinned official AutoResearchClaw release is not installed', {
      details: { release: paths.release },
    });
  }
  if (!existsSync(paths.python)) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw release virtualenv is missing');
  }

  const bridgePath = officialBridgePath();
  const compatibilityPath = officialCompatibilityPath();
  const structural = await probe(paths.python, bridgePath);
  const pairing = verifyExternalRuntimePairing(
    {
      python: paths.python,
      bridgePath,
      compatibilityPath,
      probe: structural,
      driverPackage: ARC_MCP_PACKAGE,
      driverVersion: ARC_MCP_VERSION,
      spec,
      packageDirName: OFFICIAL_ARC_PACKAGE_DIR,
    },
    execute,
  );
  if (!pairing.manifest_path || !pairing.driver_pairing) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw release is not sealed with a manifest');
  }
  assertBoundedExecution(pairing, options.bounded);
  return {
    releaseRoot: paths.root,
    releaseId: path.basename(paths.release),
    python: paths.python,
    sourceDir: pairing.source_dir,
    manifest: parseReleaseManifest(pairing.manifest_path),
    manifestPath: pairing.manifest_path,
    pairing,
    ...(options.bounded ? { bounded: options.bounded } : {}),
  };
}

/**
 * Reads the budget-relevant sections of an official config using the pinned
 * release's own interpreter and YAML loader.
 *
 * Deliberately not a second YAML implementation in TypeScript: the point of
 * the check is that the ceiling validated here is the ceiling the official
 * process will parse out of the same bytes, and two parsers that disagree
 * would silently defeat that.
 */
export function loadOfficialBudgetDocument(
  release: Pick<ResolvedOfficialRelease, 'python'>,
  configPath: string,
): OfficialBudgetDocument {
  const result = spawnSync(release.python, [officialBridgePath()], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    input: `${JSON.stringify({ action: 'budget_policy', config_path: configPath })}\n`,
  });
  let value: OfficialBudgetDocument & { success?: boolean; error?: string };
  try {
    value = JSON.parse(result.stdout) as OfficialBudgetDocument & { success?: boolean; error?: string };
  } catch (cause) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw budget policy probe returned invalid JSON', {
      cause,
    });
  }
  if (result.status !== 0 || value.success !== true) {
    throw new ArcError(
      'runner_unconfigured',
      `Could not read the official budget policy: ${value.error ?? `exit ${result.status ?? 'unknown'}`}`,
    );
  }
  return value;
}

/**
 * Refuses a money-spending run the pinned release cannot bound.
 *
 * Deliberately not inferred from anything: the caller must ask for a bounded
 * run, and the release must have proved it enforces one. Neither a configured
 * `max_budget_usd` nor a passing shim check is accepted as evidence.
 */
export function assertBoundedExecution(
  pairing: RuntimePairingResult,
  bounded: BoundedExecutionRequirement | undefined,
): void {
  if (!bounded?.require) return;
  const evidence = pairing.budget_guard;
  if (!evidence?.available) {
    throw new ArcError(
      'runner_unconfigured',
      'Bounded execution was requested but the pinned official release has no hard budget guard; ' +
        'seal a release whose source enforces one before running a billable acceptance',
      { details: { budget_guard: evidence ?? null } },
    );
  }
  if (!evidence.enforced) {
    throw new ArcError(
      'runner_unconfigured',
      'Bounded execution was requested but the pinned official release did not prove its budget guard fails closed',
      { details: { budget_guard: evidence } },
    );
  }
  if (!bounded.policyId?.trim()) {
    throw new ArcError(
      'runner_unconfigured',
      'Bounded execution was requested without naming a budget policy; a ceiling nobody stated is not a bound',
    );
  }
  // The guard lives in the release's own source and is imported out of the
  // release's own virtualenv. A run that may spend money must therefore
  // execute trees nothing could have edited between the seal and the launch,
  // or the proof that the ceiling is enforced is a proof about different code.
  if (!pairing.immutability) {
    throw new ArcError(
      'runner_unconfigured',
      'Bounded execution was requested against a release whose source and virtualenv are not both sealed ' +
        'read-only; a guard that lives in a writable tree bounds nothing',
      { details: { immutability: null } },
    );
  }
}

export interface BoundedRuntimeSelection {
  spec: ExternalReleaseSpec;
  bounded: BoundedExecutionRequirement;
  /** False for a locally patched candidate; see the release's own manifest. */
  official: boolean;
}

/**
 * Chooses the release one disposable bounded run executes.
 *
 * Selection is by explicit name and nothing else. There is no default, no
 * fallback to the `current` production selector, and — deliberately — no
 * environment variable: a patched candidate that could be selected by exporting
 * a variable would eventually be selected by accident, which is the failure
 * this whole class of release exists to avoid.
 *
 * Every selection here is a bounded one, patched candidate or not. Returning
 * an unbounded requirement because the caller left the policy blank would turn
 * a request to bound a run into a run with no ceiling, which is the one
 * outcome this function exists to make impossible; a blank policy is therefore
 * refused rather than downgraded. Running local patches with no ceiling would
 * additionally combine unreviewed code with unbounded spend.
 */
export function selectBoundedRuntime(options: {
  specName: string;
  policyId: string;
}): BoundedRuntimeSelection {
  const spec = releaseSpecByName(options.specName.trim());
  if (!spec) {
    throw new ArcError(
      'runner_unconfigured',
      `Unknown ARC runtime selection ${JSON.stringify(options.specName)}; name one of ` +
        `${Object.keys(EXTERNAL_RELEASE_SPECS).join(', ')}`,
    );
  }
  assertReleaseSpecEligible(spec, 'selected for bounded execution');
  if (specRole(spec) !== 'mcp-execution') {
    throw new ArcError(
      'runner_unconfigured',
      `ARC runtime selection ${JSON.stringify(options.specName)} is sealed for direct CLI use and may not be ` +
        'launched by the driver',
    );
  }
  const policyId = options.policyId?.trim();
  if (!policyId) {
    throw new ArcError(
      'runner_unconfigured',
      `ARC runtime selection ${JSON.stringify(options.specName)} was requested as a bounded run without naming a ` +
        `budget policy${spec.patch ? `; a ${specProvenanceClass(spec)} release has no other way to be launched` : ''}`,
    );
  }
  return {
    spec,
    bounded: { require: true, policyId },
    official: !spec.patch,
  };
}

/**
 * Durable process control over one official run. Kept as an interface so the
 * exact-revision guard and lifecycle wiring stay testable without launching the
 * external application.
 */
export interface OfficialProcessSupervisor {
  start(input: ArcExecutionInput, release: ResolvedOfficialRelease): Promise<ArcExecutionHandle>;
  probe(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
  pause(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
  resume(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
  cancel(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
  collect(handle: ArcExecutionHandle): Promise<ArcRunnerResult>;
}

export interface OfficialArcDriverOptions {
  releaseRoot: string;
  supervisor: OfficialProcessSupervisor;
  spec?: ExternalReleaseSpec;
  resolve?: (options: ResolveOfficialReleaseOptions) => Promise<ResolvedOfficialRelease>;
  /** Set for a run that may spend money. Omitted, behaviour is unchanged. */
  bounded?: BoundedExecutionRequirement;
}

/**
 * The ARC runner bound to the official external CLI. Every start re-verifies
 * the release, so a revision drift, a dirty checkout, a broken dependency
 * freeze, or an `acpx` upgrade stops the run before any model call happens.
 */
export class OfficialArcDriver implements ArcRunner {
  private readonly resolveRelease: (options: ResolveOfficialReleaseOptions) => Promise<ResolvedOfficialRelease>;
  private resolved?: ResolvedOfficialRelease;

  constructor(private readonly options: OfficialArcDriverOptions) {
    this.resolveRelease = options.resolve ?? resolveOfficialRelease;
  }

  /** Last verified release, for provenance. Undefined until a start succeeded. */
  get release(): ResolvedOfficialRelease | undefined {
    return this.resolved;
  }

  async start(input: ArcExecutionInput): Promise<ArcExecutionHandle> {
    const release = await this.verifiedRelease();
    return this.options.supervisor.start(input, release);
  }

  recover(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    return this.options.supervisor.probe(handle);
  }

  pause(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    return this.options.supervisor.pause(handle);
  }

  resume(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    return this.options.supervisor.resume(handle);
  }

  cancel(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    return this.options.supervisor.cancel(handle);
  }

  collect(handle: ArcExecutionHandle): Promise<ArcRunnerResult> {
    return this.options.supervisor.collect(handle);
  }

  private async verifiedRelease(): Promise<ResolvedOfficialRelease> {
    try {
      const release = await this.resolveRelease({
        releaseRoot: this.options.releaseRoot,
        ...(this.options.spec ? { spec: this.options.spec } : {}),
        ...(this.options.bounded ? { bounded: this.options.bounded } : {}),
      });
      this.resolved = release;
      return release;
    } catch (error) {
      this.resolved = undefined;
      if (error instanceof ArcError) throw error;
      throw new ArcError(
        'runner_unconfigured',
        `Official AutoResearchClaw release verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function defaultExecute(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Exported so the stdin action contract stays under test. */
export async function probeOfficialResearchClaw(python: string, bridgePath: string): Promise<ExternalProbe> {
  // The official bridge reads one JSON action from stdin so no argument ever
  // carries request data into the process table.
  const result = spawnSync(python, [bridgePath], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    input: `${JSON.stringify({ action: 'probe' })}\n`,
  });
  let value: ExternalProbe & { error?: string };
  try {
    value = JSON.parse(result.stdout) as ExternalProbe & { error?: string };
  } catch (error) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw probe returned invalid JSON', { cause: error });
  }
  if (result.status !== 0 || value.success !== true) {
    throw new ArcError(
      'runner_unconfigured',
      `Official AutoResearchClaw structural probe failed: ${value.error ?? `exit ${result.status ?? 'unknown'}`}`,
    );
  }
  return value;
}
