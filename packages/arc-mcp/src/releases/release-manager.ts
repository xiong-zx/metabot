import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  assertReleaseTreesSealed,
  restoreTreeDirectoriesWritable,
  sealReleaseTrees,
  type ReleaseImmutabilityRecord,
} from './immutability.js';
import {
  ARC_RELEASE_MANIFEST_VERSION,
  classifyDriverPairing,
  normalizeRepository,
  parseReleaseManifest,
  patchProvenanceRecord,
  releaseImmutability,
  releaseIsOfficial,
  releaseProvenanceClass,
  releaseRole,
  releaseSealsBothTrees,
  safeReleaseIdentifier,
  sha256,
  sha256File,
  type DriverPairing,
  type ExternalReleaseManifest,
} from './manifest.js';
import {
  assertPlainDirectory,
  normalizeFreeze,
  requireOutput,
  requireSuccess,
  verifyDetachedSourceRevision,
  verifyPatchSeries,
  verifySourceDescription,
  type CommandResult,
} from './source.js';
import {
  ARC_MCP_PACKAGE,
  ARC_MCP_VERSION,
  EXTERNAL_RELEASE_SPECS,
  DEFAULT_EXTERNAL_RELEASE_ROLE,
  assertReleaseSpecEligible,
  specProvenanceClass,
  specRole,
  type ExternalReleaseIdentity,
  type ExternalReleaseProvenanceClass,
  type ExternalReleaseRole,
  type ExternalReleaseSpec,
} from './spec.js';

/** Structural probe of an installed official application. */
export interface ExternalProbe {
  success: boolean;
  version: string;
  stage_count: number;
  package_path: string;
}

export type { CommandResult } from './source.js';

export interface ReleaseManagerDependencies {
  execute(command: string, args: string[]): CommandResult;
  findCommand(command: string): string | undefined;
  probe(python: string, bridgePath: string): Promise<ExternalProbe>;
  now(): Date;
  randomId(): string;
}

export interface ReleaseManagerOptions {
  root: string;
  bootstrapPython: string;
  bridgePath: string;
  compatibilityPath: string;
  acpAgent: string;
  driverPackage?: string;
  driverVersion?: string;
  spec: ExternalReleaseSpec;
  /** Package directory name expected inside the official source tree. */
  packageDirName: string;
  /**
   * What the release may be used for. A `direct-cli` release is sealed and
   * verified without the downstream compatibility shims, because those shims
   * were audited against a different commit and the driver never launches it.
   * Defaults to `mcp-execution`, so every existing caller keeps the strict path.
   */
  role?: ExternalReleaseRole;
  /**
   * Repository the patched candidate's commits are fetched from. Required when
   * the spec declares a patch series and rejected when it does not: an official
   * release is always cloned from the origin it pins.
   */
  patchSource?: string;
  /**
   * Makes the newly created source *and* virtualenv trees recursively
   * read-only, and records the census in the manifest. Only ever applied to
   * trees this call created, never to a release that already existed.
   */
  sealReadOnly?: boolean;
  /**
   * Console scripts the sealed virtualenv must still be able to execute.
   *
   * Sealing is only correct if the release still runs afterwards, so each of
   * these is executed from the sealed tree before the manifest is written. An
   * install that produced an unusable release fails instead of being recorded.
   */
  consoleScripts?: readonly string[];
}

export interface RuntimePairingOptions {
  python: string;
  bridgePath: string;
  compatibilityPath: string;
  probe: ExternalProbe;
  driverPackage?: string;
  driverVersion?: string;
  spec: ExternalReleaseSpec;
  packageDirName: string;
}

/**
 * Evidence, produced by the release's own interpreter, that this exact
 * revision refuses unbounded billable dispatch. `enforced` is true only when
 * the release proved every refusal path without reaching the network.
 * Releases sealed before the upstream guard existed report
 * `available: false` — a fact the driver acts on, not an error.
 */
export interface BudgetGuardEvidence {
  available: boolean;
  enforced: boolean;
  reason?: string;
  checks?: Record<string, boolean>;
  network_attempts?: number;
  price_table_version?: string;
}

export const BUDGET_GUARD_ABSENT: BudgetGuardEvidence = Object.freeze({
  available: false,
  enforced: false,
  reason: 'not_reported',
});

export interface RuntimePairingResult {
  source_dir: string;
  origin: string;
  revision: string;
  source_tree: string;
  manifest_path: string | null;
  driver_pairing: DriverPairing | null;
  /**
   * True only when a sealed manifest exists and does not disclaim being
   * official. An unsealed tree reports `false` because nothing vouches for
   * it either way, not because something disclaimed it.
   */
  official: boolean;
  provenance_class: ExternalReleaseProvenanceClass;
  acpx: { executable: string; version: string } | null;
  budget_guard: BudgetGuardEvidence;
  /**
   * Verified immutability census, or `null` for a release sealed before the
   * virtualenv was sealed with the source. `null` is a fact about the release,
   * not a pass: a bounded run refuses it.
   */
  immutability: ReleaseImmutabilityRecord | null;
}

export interface ReleasePaths {
  root: string;
  releases: string;
  release: string;
  source: string;
  venv: string;
  python: string;
  freeze: string;
  manifest: string;
  installing: string;
}

interface VerifiedRelease {
  probe: ExternalProbe;
  origin: string;
  revision: string;
  sourceTree: string;
  describe: string;
  baseTag: string;
  baseTagCommit: string;
  pythonVersion: string;
  acpx: string;
  acpxVersion: string;
  acpAgent: string;
  dependencyFreeze: string;
}

/**
 * A patched candidate's id carries its own disclaimer.
 *
 * Release ids appear in directory listings, run state, provenance manifests and
 * operator commands, most of which never open the manifest. Prefixing the id
 * means a patched candidate cannot be mistaken for an official `0.5.0-…`
 * release anywhere it is merely named.
 */
export const UNOFFICIAL_RELEASE_ID_PREFIX = 'unofficial-' as const;

export function externalReleaseId(spec: ExternalReleaseIdentity): string {
  const version = safeReleaseIdentifier(spec.version, 'release version');
  if (!/^[0-9a-f]{40}$/.test(spec.revision)) {
    throw new Error('Official release revision must be a 40-character SHA-1');
  }
  const suffix = spec.releaseIdSuffix
    ? `-${safeReleaseIdentifier(spec.releaseIdSuffix, 'release suffix')}`
    : '';
  const prefix = spec.patch ? UNOFFICIAL_RELEASE_ID_PREFIX : '';
  return `${prefix}${version}-${spec.revision.slice(0, 12)}${suffix}`;
}

export function externalReleasePaths(root: string, spec: ExternalReleaseIdentity): ReleasePaths {
  const resolvedRoot = path.resolve(root);
  const id = externalReleaseId(spec);
  const releases = path.join(resolvedRoot, 'releases');
  const release = path.join(releases, id);
  return {
    root: resolvedRoot,
    releases,
    release,
    source: path.join(release, 'source'),
    venv: path.join(release, 'venv'),
    python: path.join(release, 'venv', 'bin', 'python3'),
    freeze: path.join(release, 'requirements.freeze.txt'),
    manifest: path.join(release, 'manifest.json'),
    installing: path.join(release, '.installing'),
  };
}

/** Every sealed release id under a root, oldest-sorted, for rollback inventory. */
export function listSealedReleaseIds(root: string): string[] {
  const releases = path.join(path.resolve(root), 'releases');
  if (!existsSync(releases)) return [];
  assertPlainDirectory(releases, 'releases directory');
  return readdirSync(releases)
    .filter((name) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return false;
      const candidate = path.join(releases, name);
      return lstatSync(candidate).isDirectory() && existsSync(path.join(candidate, 'manifest.json'));
    })
    .sort();
}

/**
 * Where the sealed checkout is cloned from.
 *
 * An official release is cloned from the origin it pins, so there is nothing to
 * choose. A patched candidate cannot be: the operator must name the staging
 * repository holding the patch commits, and stating it is the act that makes
 * the seal deliberate rather than incidental.
 */
function resolveCloneSource(options: ReleaseManagerOptions): string {
  const patchSource = options.patchSource?.trim();
  if (!options.spec.patch) {
    if (patchSource) {
      throw new Error('A patch source was given for a release that declares no patch series');
    }
    return options.spec.repository;
  }
  if (!patchSource) {
    throw new Error(
      'A downstream-patched candidate must name the repository its patch commits are fetched from',
    );
  }
  return patchSource;
}

/**
 * Append-only guard. A sealed manifest is provenance, not configuration: a
 * package rename or a correction must produce a new release id rather than
 * rewrite the record an earlier driver signed.
 */
export function assertManifestAppendOnly(manifestPath: string): void {
  if (existsSync(manifestPath)) {
    throw new Error(`Sealed official release manifests are append-only; refusing to rewrite ${manifestPath}`);
  }
}

export async function installExternalReleaseCandidate(
  options: ReleaseManagerOptions,
  dependencies: ReleaseManagerDependencies,
): Promise<ExternalReleaseManifest> {
  assertReleaseSpecEligible(options.spec, 'installed');
  if (options.sealReadOnly === false) {
    throw new Error('New external releases must seal both source and virtualenv recursively read-only');
  }
  const paths = externalReleasePaths(options.root, options.spec);
  const cloneSource = resolveCloneSource(options);
  ensureReleaseRoot(paths);
  if (existsSync(paths.release)) {
    if (!existsSync(paths.manifest)) {
      throw new Error(`Incomplete official release already exists; refusing in-place repair: ${paths.release}`);
    }
    return verifyExternalReleaseCandidate(options, dependencies);
  }

  mkdirSync(paths.release, { mode: 0o700 });
  writeFileSync(paths.installing, `${dependencies.now().toISOString()}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    requireSuccess(
      dependencies.execute('git', ['clone', '--filter=blob:none', '--no-checkout', cloneSource, paths.source]),
      'git clone',
    );
    requireSuccess(
      dependencies.execute('git', [
        '-C',
        paths.source,
        'fetch',
        '--depth=256',
        'origin',
        options.spec.revision,
        `refs/tags/${options.spec.tag}:refs/tags/${options.spec.tag}`,
      ]),
      'git fetch',
    );
    if (options.spec.patch) {
      // The patch series is verified against the upstream base, so that base
      // and its ancestry must be present rather than shallow-truncated away.
      requireSuccess(
        dependencies.execute('git', [
          '-C',
          paths.source,
          'fetch',
          '--depth=256',
          'origin',
          options.spec.patch.upstream.baseRevision,
        ]),
        'git fetch patched candidate upstream base',
      );
    }
    requireSuccess(
      dependencies.execute('git', ['-C', paths.source, 'checkout', '--detach', options.spec.revision]),
      'git checkout',
    );

    assertPython(options.bootstrapPython, dependencies);
    requireSuccess(dependencies.execute(options.bootstrapPython, ['-m', 'venv', paths.venv]), 'python virtualenv creation');
    if (!existsSync(paths.python)) throw new Error(`Official release virtualenv did not create ${paths.python}`);
    const pipCommand = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-e', `${paths.source}[all]`];
    requireSuccess(dependencies.execute(paths.python, pipCommand), 'official dependency installation');

    const verified = await verifyReleaseLayout(options, dependencies, paths);
    // Sealed before the manifest is written, because the manifest records the
    // census that sealing produced. A seal that fails, or a sealed release
    // that can no longer execute, therefore never acquires a manifest at all.
    const immutability = sealReleaseTrees(paths);
    await assertSealedReleaseIsOperable(options, dependencies, paths);
    atomicWrite(paths.freeze, verified.dependencyFreeze, 0o600, dependencies.randomId());
    const manifest = manifestFromVerified(options, paths, verified, pipCommand, dependencies.now(), immutability);
    assertManifestAppendOnly(paths.manifest);
    atomicWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600, dependencies.randomId());
    unlinkSync(paths.installing);
    return manifest;
  } catch (error) {
    // A sealed tree cannot be removed without directory write permission, so a
    // failure after sealing would otherwise leave an unusable, undeletable
    // half-install behind. Only ever the release this call just created.
    restoreTreeDirectoriesWritable(paths.release);
    rmSync(paths.release, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Proves a sealed release still runs.
 *
 * Read-only is only the right answer if the release is still the thing it was:
 * the structural probe and the downstream compatibility probe are re-run
 * through the sealed virtualenv's own interpreter against the sealed source,
 * and every declared console script must still exist as an executable regular
 * file and answer `--help`. A virtualenv that cannot write its bytecode cache
 * is expected; one that cannot execute is a failed install.
 */
async function assertSealedReleaseIsOperable(
  options: ReleaseManagerOptions,
  dependencies: ReleaseManagerDependencies,
  paths: ReleasePaths,
): Promise<void> {
  const probe = await dependencies.probe(paths.python, options.bridgePath);
  if (probe.success !== true || probe.version !== options.spec.version) {
    throw new Error(`Sealed official release no longer answers its structural probe: ${JSON.stringify(probe)}`);
  }
  for (const name of options.consoleScripts ?? []) {
    const script = path.join(paths.venv, 'bin', safeReleaseIdentifier(name, 'console script name'));
    if (!existsSync(script) || !lstatSync(script).isFile()) {
      throw new Error(`Sealed official release does not provide the console script ${name}: ${script}`);
    }
    if ((lstatSync(script).mode & 0o111) === 0) {
      throw new Error(`Sealing removed the executable bit from the console script ${name}: ${script}`);
    }
    requireSuccess(dependencies.execute(script, ['--help']), `sealed console script ${name}`);
  }
}

export async function verifyExternalReleaseCandidate(
  options: ReleaseManagerOptions,
  dependencies: ReleaseManagerDependencies,
): Promise<ExternalReleaseManifest> {
  const paths = externalReleasePaths(options.root, options.spec);
  assertPlainDirectory(paths.root, 'release root');
  assertPlainDirectory(paths.releases, 'releases directory');
  assertPlainDirectory(paths.release, 'release');
  assertPlainDirectory(paths.source, 'source');
  assertPlainDirectory(paths.venv, 'virtualenv');
  if (existsSync(paths.installing)) throw new Error(`Official release is incomplete: ${paths.release}`);
  const manifest = parseReleaseManifest(paths.manifest);
  assertManifestPairing(manifest, options, paths);
  verifyReleaseImmutability(manifest, options.spec, paths);
  const verified = await verifyReleaseLayout(options, dependencies, paths);
  const freezeHash = sha256(verified.dependencyFreeze);
  if (manifest.dependencies.sha256 !== freezeHash || readFileSync(paths.freeze, 'utf8') !== verified.dependencyFreeze) {
    throw new Error('Official release dependency freeze does not match the sealed manifest');
  }
  if (
    manifest.source_tree !== verified.sourceTree ||
    manifest.describe !== verified.describe ||
    manifest.base_tag !== verified.baseTag ||
    manifest.base_tag_commit !== verified.baseTagCommit ||
    manifest.python.version !== verified.pythonVersion ||
    manifest.tools.acpx.executable !== verified.acpx ||
    manifest.tools.acpx.version !== verified.acpxVersion ||
    manifest.tools.acp_agent.executable !== verified.acpAgent
  ) {
    throw new Error('Official release contents or toolchain differ from the sealed manifest');
  }
  if (
    shouldMatchCurrentDriver(
      options.spec,
      manifest,
      options.driverPackage ?? ARC_MCP_PACKAGE,
      options.driverVersion ?? ARC_MCP_VERSION,
    ) &&
    !manifestMatchesDriverFiles(manifest, options.bridgePath, options.compatibilityPath)
  ) {
    throw new Error('Official release does not match this driver bridge revision');
  }
  return manifest;
}

/**
 * Fail-closed guard executed before any official launch. Origin, revision,
 * detachment, cleanliness, tree hash, dependency digest, external `acpx`
 * version, downstream compatibility, and the sealed manifest must all agree
 * with the pinned spec.
 */
export function verifyExternalRuntimePairing(
  options: RuntimePairingOptions,
  execute: ReleaseManagerDependencies['execute'],
): RuntimePairingResult {
  assertReleaseSpecEligible(options.spec, 'launched');
  if (
    options.probe.success !== true ||
    options.probe.version !== options.spec.version ||
    options.probe.stage_count !== options.spec.stageCount
  ) {
    throw new Error(`Official runtime probe does not match the paired release: ${JSON.stringify(options.probe)}`);
  }
  const packagePath = realpathSync.native(options.probe.package_path);
  if (path.basename(packagePath) !== '__init__.py' || path.basename(path.dirname(packagePath)) !== options.packageDirName) {
    throw new Error(`Official runtime probe returned an unexpected package path: ${packagePath}`);
  }
  const source = path.dirname(path.dirname(packagePath));
  assertPlainDirectory(source, 'source');
  const { origin, revision, sourceTree } = verifyDetachedSourceRevision(source, options.spec, execute, {
    subject: 'runtime source',
    revisionMismatch: (expected, actual) => `Official runtime revision mismatch: expected ${expected}, got ${actual}`,
  });
  // Re-derived on the launch path, not only at seal time: the pinned tree and
  // the patch series are what a patched candidate's identity actually is.
  if (options.spec.patch) verifyPatchSeries(source, options.spec.patch, revision, execute);
  const compatibility = JSON.parse(
    requireOutput(execute(path.resolve(options.python), [options.compatibilityPath]), 'downstream compatibility probe'),
  ) as { success?: boolean; budget_guard?: BudgetGuardEvidence };
  if (compatibility.success !== true) {
    throw new Error(`Official downstream compatibility check failed: ${JSON.stringify(compatibility)}`);
  }
  // Reported, never assumed. A release that says nothing about the guard is
  // recorded as not having one, which is what the driver's bounded-run gate
  // refuses on.
  const budgetGuard = normalizeBudgetGuard(compatibility.budget_guard);

  const release = path.dirname(source);
  const venv = path.dirname(path.dirname(path.resolve(options.python)));
  const manifestPath = path.join(release, 'manifest.json');
  if (!existsSync(manifestPath)) {
    if (path.basename(path.dirname(release)) === 'releases') {
      throw new Error(`Sealed official runtime release is missing its manifest: ${manifestPath}`);
    }
    return {
      source_dir: source,
      origin,
      revision,
      source_tree: sourceTree,
      manifest_path: null,
      driver_pairing: null,
      // Nothing sealed this tree, so nothing vouches for it either way; the
      // driver refuses an unsealed release before this reaches a claim.
      official: false,
      provenance_class: specProvenanceClass(options.spec),
      acpx: null,
      budget_guard: budgetGuard,
      immutability: null,
    };
  }

  const manifest = parseReleaseManifest(manifestPath);
  assertProvenanceMatchesSpec(manifest, options.spec);
  assertSupersessionMatchesSpec(manifest, options.spec);
  assertPinnedDriverHashes(manifest, options.spec);
  // Sealed as "a human may run this exact tag" is not the same claim as "the
  // driver may launch this", so the launch gate refuses it outright rather than
  // re-deriving compatibility at run time.
  if (releaseRole(manifest) !== 'mcp-execution') {
    throw new Error(
      `Official release ${manifest.release_id} is sealed for direct CLI use only and must not be launched by ARC MCP`,
    );
  }
  const driverPairing = classifyDriverPairing(
    manifest,
    options.driverPackage ?? ARC_MCP_PACKAGE,
    options.driverVersion ?? ARC_MCP_VERSION,
  );
  const freezePath = path.join(release, 'requirements.freeze.txt');
  if (
    manifest.schema_version !== ARC_RELEASE_MANIFEST_VERSION ||
    manifest.release_id !== externalReleaseId(options.spec) ||
    manifest.product !== options.spec.product ||
    manifest.state !== 'candidate' ||
    manifest.origin !== normalizeRepository(options.spec.patch ? origin : options.spec.repository) ||
    manifest.base_tag !== options.spec.tag ||
    manifest.commit !== options.spec.revision ||
    manifest.source_tree !== sourceTree ||
    manifest.version !== options.spec.version ||
    manifest.stage_count !== options.spec.stageCount ||
    realpathSync.native(manifest.source_dir) !== source ||
    // Lexical, not canonical: `venv/bin/python3` is a symlink to the base
    // interpreter, so resolving both sides would compare two paths that agree
    // about Homebrew rather than about which virtualenv is being launched.
    realpathSync.native(manifest.venv_dir) !== venv ||
    path.resolve(manifest.python.executable) !== path.resolve(options.python) ||
    manifest.dependencies.freeze_file !== path.basename(freezePath) ||
    manifest.dependencies.sha256 !== sha256File(freezePath) ||
    manifest.adapter.official_revision !== options.spec.revision
  ) {
    throw new Error('Sealed official runtime release is not paired to this pinned revision');
  }
  if (
    shouldMatchCurrentDriver(
      options.spec,
      manifest,
      options.driverPackage ?? ARC_MCP_PACKAGE,
      options.driverVersion ?? ARC_MCP_VERSION,
    ) &&
    !manifestMatchesDriverFiles(manifest, options.bridgePath, options.compatibilityPath)
  ) {
    throw new Error('Sealed official runtime release does not match this driver bridge revision');
  }
  const acpx = verifyAcpxToolchain(manifest, options.spec, execute);
  // Re-walked on every launch, not only at seal time: a permission is exactly
  // the kind of thing that gets restored by hand to fix something and then
  // left that way, and neither the source tree hash nor the dependency digest
  // would notice.
  const immutability = verifyReleaseImmutability(manifest, options.spec, { release, source, venv });
  return {
    source_dir: source,
    origin,
    revision,
    source_tree: sourceTree,
    manifest_path: manifestPath,
    driver_pairing: driverPairing,
    official: releaseIsOfficial(manifest),
    provenance_class: releaseProvenanceClass(manifest),
    acpx,
    budget_guard: budgetGuard,
    immutability,
  };
}

/**
 * Checks the sealed immutability claim, or records its absence.
 *
 * A release sealed before the virtualenv was sealed with the source carries no
 * claim. That is reported as `null` rather than repaired or refused: those
 * releases are append-only evidence, and rewriting their permissions would
 * destroy the rollback material they exist to be. A spec may still require a
 * fully sealed release, and a bounded run always does.
 */
export function verifyReleaseImmutability(
  manifest: ExternalReleaseManifest,
  spec: Pick<ExternalReleaseSpec, 'requiresSealedTrees'>,
  paths: { release: string; source: string; venv: string },
): ReleaseImmutabilityRecord | null {
  const recorded = releaseImmutability(manifest);
  if (!recorded) {
    if (spec.requiresSealedTrees) {
      throw new Error(
        `Sealed release ${manifest.release_id} records no recursive immutability, but the pinned spec requires a ` +
          'release whose source and virtualenv were both sealed',
      );
    }
    return null;
  }
  if (!releaseSealsBothTrees(manifest)) {
    throw new Error(`Sealed release ${manifest.release_id} claims immutability without sealing both trees`);
  }
  return assertReleaseTreesSealed(paths, recorded);
}

/**
 * Reduce whatever the probe reported to a definite claim. Anything malformed,
 * missing, or self-contradictory (`enforced` without `available`, or a check
 * that reached the network) collapses to "no guard".
 */
function normalizeBudgetGuard(value: unknown): BudgetGuardEvidence {
  if (!value || typeof value !== 'object') return BUDGET_GUARD_ABSENT;
  const raw = value as Record<string, unknown>;
  const available = raw.available === true;
  const attempts = typeof raw.network_attempts === 'number' ? raw.network_attempts : 0;
  const checks =
    raw.checks && typeof raw.checks === 'object'
      ? (Object.fromEntries(
          Object.entries(raw.checks as Record<string, unknown>).map(([key, entry]) => [key, entry === true]),
        ) as Record<string, boolean>)
      : undefined;
  const enforced =
    available &&
    raw.enforced === true &&
    attempts === 0 &&
    checks !== undefined &&
    Object.keys(checks).length > 0 &&
    Object.values(checks).every(Boolean);
  return {
    available,
    enforced,
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    ...(checks ? { checks } : {}),
    network_attempts: attempts,
    ...(typeof raw.price_table_version === 'string'
      ? { price_table_version: raw.price_table_version }
      : {}),
  };
}

/**
 * `acpx` is a mutable global install outside every sealed release, so it is the
 * one pinned dependency that can drift between two otherwise identical runs.
 * It is therefore re-verified on the launch path, not only at seal time.
 */
export function verifyAcpxToolchain(
  manifest: ExternalReleaseManifest,
  spec: Pick<ExternalReleaseSpec, 'acpxVersion'>,
  execute: ReleaseManagerDependencies['execute'],
): { executable: string; version: string } {
  const executable = manifest.tools.acpx.executable;
  if (!existsSync(executable)) {
    throw new Error(`Pinned acpx executable is missing: ${executable}`);
  }
  const version = requireOutput(execute(executable, ['--version']), 'acpx version');
  if (version !== spec.acpxVersion || version !== manifest.tools.acpx.version) {
    throw new Error(
      `acpx version drifted: expected ${spec.acpxVersion}, sealed ${manifest.tools.acpx.version}, found ${version}`,
    );
  }
  return { executable, version };
}

export function readCurrentReleaseId(root: string): string | null {
  const resolvedRoot = path.resolve(root);
  const current = path.join(resolvedRoot, 'current');
  if (!existsSync(current) && !isSymbolicLink(current)) return null;
  const info = lstatSync(current);
  if (!info.isSymbolicLink()) throw new Error(`Official current selector is not a symlink: ${current}`);
  const target = readlinkSync(current);
  const absolute = path.resolve(resolvedRoot, target);
  const releases = path.join(resolvedRoot, 'releases');
  if (path.dirname(absolute) !== releases) {
    throw new Error(`Official current selector escapes the releases directory: ${target}`);
  }
  return safeReleaseIdentifier(path.basename(absolute), 'current release id');
}

/**
 * Activation. Never called by the daemon or by any MCP tool; it exists for the
 * separately approved ARC-008 switch and requires the caller to state the
 * selector value it believes is current, so a concurrent change is a conflict
 * rather than a silent overwrite. The previous target is returned so a rollback
 * can restore it exactly.
 */
export function selectCurrentRelease(
  root: string,
  releaseId: string,
  expectedCurrent: string | null,
): { selector: string; previous: string | null } {
  const resolvedRoot = path.resolve(root);
  const id = safeReleaseIdentifier(releaseId, 'release id');
  const releases = path.join(resolvedRoot, 'releases');
  const release = path.join(releases, id);
  const manifestPath = path.join(release, 'manifest.json');
  assertPlainDirectory(resolvedRoot, 'release root');
  assertPlainDirectory(releases, 'releases directory');
  assertPlainDirectory(release, 'release');
  const manifest = parseReleaseManifest(manifestPath);
  const registeredSpec = registeredSpecByReleaseId(id);
  if (registeredSpec) assertReleaseSpecEligible(registeredSpec, 'selected as current');
  if (manifest.release_id !== id || manifest.state !== 'candidate') {
    throw new Error(`Official release is not an eligible sealed candidate: ${id}`);
  }
  if (releaseRole(manifest) !== 'mcp-execution') {
    throw new Error(`Official release ${id} is sealed for direct CLI use only and cannot become the current MCP release`);
  }
  // `current` is the production selector: whatever it names is what an
  // ordinary, unbounded, unsupervised run executes. A release carrying local
  // patches may be launched by an explicitly configured disposable daemon, but
  // it must never become the thing everything else silently falls back to.
  if (!releaseIsOfficial(manifest)) {
    throw new Error(
      `Release ${id} is a ${releaseProvenanceClass(manifest)} release and cannot become the current production ` +
        'release; point a disposable daemon at it explicitly instead',
    );
  }
  const actual = readCurrentReleaseId(resolvedRoot);
  if (actual !== expectedCurrent) {
    throw new Error(`Official current selector changed: expected ${expectedCurrent ?? 'none'}, got ${actual ?? 'none'}`);
  }
  const current = path.join(resolvedRoot, 'current');
  if (actual === id) return { selector: current, previous: actual };
  const temporary = path.join(resolvedRoot, `.current-${process.pid}-${randomUUID()}`);
  try {
    symlinkSync(path.join('releases', id), temporary);
    renameSync(temporary, current);
  } finally {
    if (existsSync(temporary) || isSymbolicLink(temporary)) unlinkSync(temporary);
  }
  return { selector: current, previous: actual };
}

async function verifyReleaseLayout(
  options: ReleaseManagerOptions,
  dependencies: ReleaseManagerDependencies,
  paths: ReleasePaths,
): Promise<VerifiedRelease> {
  assertPlainDirectory(paths.source, 'source');
  assertPlainDirectory(paths.venv, 'virtualenv');
  const { origin, revision, sourceTree } = verifyDetachedSourceRevision(
    paths.source,
    options.spec,
    dependencies.execute,
    {
      subject: 'source',
      revisionMismatch: (_expected, actual) => `Official source revision mismatch: ${actual}`,
    },
  );
  if (options.spec.patch) verifyPatchSeries(paths.source, options.spec.patch, revision, dependencies.execute);
  const { describe, baseTag, baseTagCommit } = verifySourceDescription(
    paths.source,
    options.spec,
    revision,
    dependencies.execute,
  );
  const pythonVersion = requireOutput(
    dependencies.execute(paths.python, [
      '-c',
      'import platform,sys; print(platform.python_version()); raise SystemExit(0 if sys.version_info >= (3,11) else 1)',
    ]),
    'release Python version',
  );
  const probe = await dependencies.probe(paths.python, options.bridgePath);
  if (
    probe.success !== true ||
    probe.version !== options.spec.version ||
    probe.stage_count !== options.spec.stageCount ||
    !path.resolve(probe.package_path).startsWith(`${paths.source}${path.sep}`)
  ) {
    throw new Error(`Official compatibility probe failed: ${JSON.stringify(probe)}`);
  }
  // A direct-CLI release exists so a human can run the exact published tag; the
  // driver never launches it, so requiring shims audited against a different
  // commit would only force us to mislabel the tag as the audited commit.
  if ((options.role ?? DEFAULT_EXTERNAL_RELEASE_ROLE) === 'mcp-execution') {
    const compatibility = JSON.parse(
      requireOutput(dependencies.execute(paths.python, [options.compatibilityPath]), 'downstream compatibility probe'),
    ) as { success?: boolean };
    if (compatibility.success !== true) {
      throw new Error(`Official downstream compatibility check failed: ${JSON.stringify(compatibility)}`);
    }
  }
  const acpx = dependencies.findCommand('acpx');
  if (!acpx) throw new Error('acpx is missing; install the pinned version separately before creating a candidate');
  const acpxVersion = requireOutput(dependencies.execute(acpx, ['--version']), 'acpx version');
  if (acpxVersion !== options.spec.acpxVersion) {
    throw new Error(`acpx version mismatch: expected ${options.spec.acpxVersion}, got ${acpxVersion}`);
  }
  const acpAgent = dependencies.findCommand(options.acpAgent);
  if (!acpAgent) throw new Error(`Configured ACP agent is missing from PATH: ${options.acpAgent}`);
  const dependencyFreeze = normalizeFreeze(
    requireOutput(dependencies.execute(paths.python, ['-m', 'pip', 'freeze', '--all']), 'dependency freeze'),
  );
  return {
    probe,
    origin,
    revision,
    sourceTree,
    describe,
    baseTag,
    baseTagCommit,
    pythonVersion,
    acpx: realpathIfPossible(acpx),
    acpxVersion,
    acpAgent: realpathIfPossible(acpAgent),
    dependencyFreeze,
  };
}

function manifestFromVerified(
  options: ReleaseManagerOptions,
  paths: ReleasePaths,
  verified: VerifiedRelease,
  pipCommand: string[],
  createdAt: Date,
  immutability: ReleaseImmutabilityRecord | undefined,
): ExternalReleaseManifest {
  return {
    schema_version: ARC_RELEASE_MANIFEST_VERSION,
    release_id: externalReleaseId(options.spec),
    product: options.spec.product,
    state: 'candidate',
    role: options.role ?? DEFAULT_EXTERNAL_RELEASE_ROLE,
    // Only a patched candidate gets a provenance block, and it can only ever
    // disclaim. Official releases keep the exact shape they have always had.
    ...(options.spec.patch
      ? { provenance: patchProvenanceRecord(options.spec.patch, normalizeRepository(verified.origin)) }
      : {}),
    ...(options.spec.supersedes
      ? {
          supersedes: {
            release_id: options.spec.supersedes.releaseId,
            reason: options.spec.supersedes.reason,
          },
        }
      : {}),
    // Present only when this call actually sealed the trees, so the manifest
    // never claims an immutability it did not perform.
    ...(immutability ? { immutability } : {}),
    // The observed remote, which for a patched candidate is the local staging
    // repository rather than the upstream URL its provenance block records.
    origin: normalizeRepository(options.spec.patch ? verified.origin : options.spec.repository),
    base_tag: verified.baseTag,
    base_tag_commit: verified.baseTagCommit,
    describe: verified.describe,
    commit: verified.revision,
    source_tree: verified.sourceTree,
    version: verified.probe.version,
    stage_count: verified.probe.stage_count,
    source_dir: paths.source,
    venv_dir: paths.venv,
    python: { executable: paths.python, version: verified.pythonVersion },
    dependencies: {
      freeze_file: path.basename(paths.freeze),
      sha256: sha256(verified.dependencyFreeze),
      entries: verified.dependencyFreeze.trim() ? verified.dependencyFreeze.trim().split('\n').length : 0,
    },
    tools: {
      acpx: { executable: verified.acpx, version: verified.acpxVersion },
      acp_agent: { name: options.acpAgent, executable: verified.acpAgent },
    },
    adapter: {
      package: options.driverPackage ?? ARC_MCP_PACKAGE,
      version: options.driverVersion ?? ARC_MCP_VERSION,
      official_revision: options.spec.revision,
      bridge_sha256: sha256File(options.bridgePath),
      compatibility_sha256: sha256File(options.compatibilityPath),
    },
    install: {
      created_at: createdAt.toISOString(),
      bootstrap_python: options.bootstrapPython,
      pip_command: [paths.python, ...pipCommand],
    },
  };
}

function assertManifestPairing(
  manifest: ExternalReleaseManifest,
  options: ReleaseManagerOptions,
  paths: ReleasePaths,
): void {
  classifyDriverPairing(manifest, options.driverPackage ?? ARC_MCP_PACKAGE, options.driverVersion ?? ARC_MCP_VERSION);
  assertProvenanceMatchesSpec(manifest, options.spec);
  assertSupersessionMatchesSpec(manifest, options.spec);
  if (releaseRole(manifest) !== (options.role ?? DEFAULT_EXTERNAL_RELEASE_ROLE)) {
    throw new Error(
      `Official release ${manifest.release_id} is sealed as a ${releaseRole(manifest)} release, not ${
        options.role ?? DEFAULT_EXTERNAL_RELEASE_ROLE
      }`,
    );
  }
  if (
    manifest.schema_version !== ARC_RELEASE_MANIFEST_VERSION ||
    manifest.release_id !== externalReleaseId(options.spec) ||
    manifest.product !== options.spec.product ||
    manifest.state !== 'candidate' ||
    // A patched candidate's origin is a local staging path the spec cannot
    // pin; its provenance block is checked against the spec instead.
    (!options.spec.patch && normalizeRepository(manifest.origin) !== normalizeRepository(options.spec.repository)) ||
    manifest.base_tag !== options.spec.tag ||
    manifest.commit !== options.spec.revision ||
    manifest.version !== options.spec.version ||
    manifest.stage_count !== options.spec.stageCount ||
    manifest.source_dir !== paths.source ||
    manifest.venv_dir !== paths.venv ||
    manifest.python.executable !== paths.python ||
    manifest.dependencies.freeze_file !== path.basename(paths.freeze) ||
    manifest.adapter.official_revision !== options.spec.revision
  ) {
    throw new Error('Official release manifest is not paired to this driver and pinned revision');
  }
  assertPinnedDriverHashes(manifest, options.spec);
}

function assertSupersessionMatchesSpec(manifest: ExternalReleaseManifest, spec: ExternalReleaseSpec): void {
  const pinned = spec.supersedes;
  const sealed = manifest.supersedes;
  if (!pinned && !sealed) return;
  if (!pinned || !sealed || sealed.release_id !== pinned.releaseId || sealed.reason !== pinned.reason) {
    throw new Error(`Sealed release ${manifest.release_id} does not record the pinned supersession`);
  }
}

function assertPinnedDriverHashes(manifest: ExternalReleaseManifest, spec: ExternalReleaseSpec): void {
  const pinned = spec.driverHashes;
  if (!pinned) return;
  if (
    manifest.adapter.bridge_sha256 !== pinned.bridgeSha256 ||
    manifest.adapter.compatibility_sha256 !== pinned.compatibilitySha256
  ) {
    throw new Error(`Sealed release ${manifest.release_id} does not match its pinned driver hashes`);
  }
}

function shouldMatchCurrentDriver(
  spec: ExternalReleaseSpec,
  manifest: ExternalReleaseManifest,
  driverPackage: string,
  driverVersion: string,
): boolean {
  if (spec.supersededBy || specRole(spec) === 'direct-cli') return false;
  return classifyDriverPairing(manifest, driverPackage, driverVersion) === 'current';
}

function manifestMatchesDriverFiles(
  manifest: ExternalReleaseManifest,
  bridgePath: string,
  compatibilityPath: string,
): boolean {
  return (
    manifest.adapter.bridge_sha256 === sha256File(bridgePath) &&
    manifest.adapter.compatibility_sha256 === sha256File(compatibilityPath)
  );
}

function registeredSpecByReleaseId(releaseId: string): ExternalReleaseSpec | undefined {
  const matches = Object.values(EXTERNAL_RELEASE_SPECS).filter((spec) => externalReleaseId(spec) === releaseId);
  if (matches.length > 1) throw new Error(`External release id is registered more than once: ${releaseId}`);
  return matches[0];
}

/**
 * The manifest's own claim about being official must agree with the spec being
 * verified. Both directions are refused: an official spec may not resolve to a
 * release that disclaims officialdom, and a patched spec may not resolve to a
 * release that silently claims it — otherwise the two identities could drift
 * and a patched tree could be launched under an official pin.
 */
function assertProvenanceMatchesSpec(manifest: ExternalReleaseManifest, spec: ExternalReleaseSpec): void {
  const sealed = releaseProvenanceClass(manifest);
  const pinned = specProvenanceClass(spec);
  if (sealed !== pinned) {
    throw new Error(
      `Sealed release ${manifest.release_id} is a ${sealed} release but the pinned spec is ${pinned}`,
    );
  }
  const patch = spec.patch;
  if (!patch || !manifest.provenance) return;
  const sealedUpstream = manifest.provenance.upstream;
  if (
    manifest.provenance.series_sha256 !== patch.seriesSha256 ||
    sealedUpstream.base_revision !== patch.upstream.baseRevision ||
    sealedUpstream.base_source_tree !== patch.upstream.baseSourceTree ||
    sealedUpstream.tag_commit !== patch.upstream.tagCommit ||
    normalizeRepository(sealedUpstream.repository) !== normalizeRepository(patch.upstream.repository)
  ) {
    throw new Error(
      `Sealed release ${manifest.release_id} records a different patch series than the pinned candidate spec`,
    );
  }
}

function ensureReleaseRoot(paths: ReleasePaths): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  assertPlainDirectory(paths.root, 'release root');
  mkdirSync(paths.releases, { recursive: true, mode: 0o700 });
  assertPlainDirectory(paths.releases, 'releases directory');
}

function assertPython(binary: string, dependencies: ReleaseManagerDependencies): void {
  const version = requireOutput(
    dependencies.execute(binary, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']),
    'bootstrap Python version',
  );
  const [major, minor] = version.split('.').map(Number);
  if ((major ?? 0) < 3 || ((major ?? 0) === 3 && (minor ?? 0) < 11)) {
    throw new Error(`Python 3.11 or newer is required, got ${version}`);
  }
}

export function atomicWrite(file: string, content: string, mode: number, id: string): void {
  const temporary = `${file}.tmp-${process.pid}-${safeReleaseIdentifier(id, 'temporary id')}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, content, 'utf8');
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function realpathIfPossible(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

function isSymbolicLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
