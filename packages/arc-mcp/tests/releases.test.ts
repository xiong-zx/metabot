import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyDriverPairing,
  parseReleaseManifest,
  releaseRole,
  sha256,
  sha256File,
  type ExternalReleaseManifest,
} from '../src/releases/manifest.js';
import {
  assertManifestAppendOnly,
  externalReleaseId,
  externalReleasePaths,
  listSealedReleaseIds,
  readCurrentReleaseId,
  selectCurrentRelease,
  verifyExternalRuntimePairing,
  BUDGET_GUARD_ABSENT,
  type CommandResult,
} from '../src/releases/release-manager.js';
import {
  assertBoundedExecution,
  officialBridgePath,
  officialCompatibilityPath,
  resolveOfficialRelease,
} from '../src/official-driver.js';
import { applyCliSelector, planCliSelector, readSelectorTarget } from '../src/releases/selector.js';
import {
  ARC_MCP_PACKAGE,
  ARC_MCP_VERSION,
  OFFICIAL_RESEARCHCLAW_COMPAT_SPEC,
  OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC,
  OFFICIAL_RESEARCHCLAW_TAG_SPEC,
  assertReleaseSpecEligible,
  specRole,
} from '../src/releases/spec.js';
import { removeDirectory, temporaryDirectory } from './helpers.js';

const PRODUCTION_SPEC = OFFICIAL_RESEARCHCLAW_COMPAT_SPEC;
// Most tests below exercise generic release guards with deliberately mutable
// fixtures. Keep that identity distinct from both append-only production pins;
// dedicated tests exercise the recursively sealed v2 pin itself.
const SPEC = {
  ...PRODUCTION_SPEC,
  releaseIdSuffix: 'arc-mcp-test-fixture',
  requiresSealedTrees: false,
  supersedes: undefined,
  driverHashes: undefined,
};
const DIRECT_TEST_SPEC = { ...OFFICIAL_RESEARCHCLAW_TAG_SPEC, driverHashes: undefined };
const TREE = 'df6b145fc5abf7005cf157386492bc26d010ba8c';
const TAG_COMMIT = '12d3fd809fa9658e91a0328c3280a0e462c78386';

let root: string;
let releaseRoot: string;
let bridgePath: string;
let compatibilityPath: string;
let acpxPath: string;

function ok(stdout = ''): CommandResult {
  return { status: 0, stdout, stderr: '' };
}

interface Layout {
  releaseDir: string;
  source: string;
  venv: string;
  python: string;
  packagePath: string;
  freeze: string;
  manifestPath: string;
}

function buildRelease(overrides: Partial<ExternalReleaseManifest> = {}, spec = SPEC): Layout {
  const paths = externalReleasePaths(releaseRoot, spec);
  const packageDir = path.join(paths.source, 'researchclaw');
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(path.dirname(paths.python), { recursive: true });
  writeFileSync(path.join(packageDir, '__init__.py'), '', 'utf8');
  writeFileSync(paths.python, '', 'utf8');

  const freezeBody = 'alpha==1.0.0\nbeta==2.0.0\n';
  writeFileSync(paths.freeze, freezeBody, 'utf8');

  const manifest: ExternalReleaseManifest = {
    schema_version: 'metabot.autoresearchclaw.release.v1',
    release_id: externalReleaseId(spec),
    product: 'AutoResearchClaw',
    state: 'candidate',
    origin: spec.repository,
    base_tag: spec.tag,
    base_tag_commit: TAG_COMMIT,
    describe: spec.revision === TAG_COMMIT ? spec.tag : 'v0.5.0-45-ge2e23c9',
    commit: spec.revision,
    source_tree: TREE,
    version: spec.version,
    stage_count: spec.stageCount,
    source_dir: paths.source,
    venv_dir: paths.venv,
    python: { executable: paths.python, version: '3.11.15' },
    dependencies: { freeze_file: 'requirements.freeze.txt', sha256: sha256(freezeBody), entries: 2 },
    tools: {
      acpx: { executable: acpxPath, version: spec.acpxVersion },
      acp_agent: { name: 'codex', executable: '/usr/local/bin/codex' },
    },
    adapter: {
      package: ARC_MCP_PACKAGE,
      version: ARC_MCP_VERSION,
      official_revision: spec.revision,
      bridge_sha256: sha256('bridge'),
      compatibility_sha256: sha256('compat'),
    },
    install: { created_at: '2026-08-15T06:42:02.378Z', bootstrap_python: 'python3.11', pip_command: [] },
    ...overrides,
  };
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    releaseDir: paths.release,
    source: paths.source,
    venv: paths.venv,
    python: paths.python,
    packagePath: path.join(packageDir, '__init__.py'),
    freeze: paths.freeze,
    manifestPath: paths.manifest,
  };
}

function pairingOptions(layout: Layout, spec = SPEC) {
  return {
    python: layout.python,
    bridgePath,
    compatibilityPath,
    probe: {
      success: true,
      version: spec.version,
      stage_count: spec.stageCount,
      package_path: layout.packagePath,
    },
    spec,
    packageDirName: 'researchclaw',
  };
}

function gitExecutor(overrides: Record<string, CommandResult> = {}, spec = SPEC) {
  return (command: string, args: string[]): CommandResult => {
    const key = args.filter((value) => !value.startsWith('/') && value !== '-C').join(' ');
    if (overrides[key]) return overrides[key];
    if (command === acpxPath) return ok(spec.acpxVersion);
    if (command !== 'git') return ok(JSON.stringify({ success: true }));
    if (key === 'remote get-url origin') return ok(spec.repository);
    if (key === 'rev-parse HEAD') return ok(spec.revision);
    if (key === 'symbolic-ref -q HEAD') return { status: 1, stdout: '', stderr: '' };
    if (key === 'status --porcelain --untracked-files=all') return ok('');
    if (key === 'rev-parse HEAD^{tree}') return ok(TREE);
    return ok('');
  };
}

beforeEach(() => {
  // Canonical so the guard's realpath comparisons match on macOS, where the
  // temp directory is reached through the /var -> /private/var symlink.
  root = realpathSync.native(temporaryDirectory('arc-release-'));
  releaseRoot = path.join(root, 'autoresearchclaw');
  bridgePath = path.join(root, 'bridge.py');
  compatibilityPath = path.join(root, 'official_compat.py');
  acpxPath = path.join(root, 'acpx');
  writeFileSync(bridgePath, 'bridge', 'utf8');
  writeFileSync(compatibilityPath, 'compat', 'utf8');
  writeFileSync(acpxPath, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
});

afterEach(() => removeDirectory(root));

describe('release identity', () => {
  it('derives the sealed release id from version and short revision', () => {
    expect(externalReleaseId(PRODUCTION_SPEC)).toBe('0.5.0-e2e23c93b494-arc-mcp-0.3.0-v2');
    expect(PRODUCTION_SPEC.supersedes?.releaseId).toBe('0.5.0-e2e23c93b494-arc-mcp-0.3.0');
  });

  it('gives the exact tag release its own id so both can be sealed side by side', () => {
    expect(externalReleaseId(OFFICIAL_RESEARCHCLAW_TAG_SPEC)).toBe('0.5.0-12d3fd809fa9');
    expect(externalReleaseId(OFFICIAL_RESEARCHCLAW_TAG_SPEC)).not.toBe(externalReleaseId(SPEC));
  });

  it('refuses a revision that is not a full SHA-1', () => {
    expect(() => externalReleaseId({ ...SPEC, revision: 'e2e23c9' })).toThrow(/40-character SHA-1/i);
  });
});

describe('append-only official pairing replacement', () => {
  it('pins current audited hashes and an exact bidirectional v2 replacement', () => {
    expect(PRODUCTION_SPEC.requiresSealedTrees).toBe(true);
    expect(PRODUCTION_SPEC.driverHashes).toEqual({
      bridgeSha256: sha256File(officialBridgePath()),
      compatibilitySha256: sha256File(officialCompatibilityPath()),
    });
    expect(PRODUCTION_SPEC.supersedes).toEqual({
      releaseId: externalReleaseId(OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC),
      reason: OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC.supersededBy!.reason,
    });
    expect(OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC.supersededBy).toMatchObject({
      specName: 'mcp-execution',
      releaseId: externalReleaseId(PRODUCTION_SPEC),
    });
  });

  it('keeps the old official manifest nameable but refuses launch and current selection', async () => {
    expect(() => assertReleaseSpecEligible(OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC, 'launched')).toThrow(
      /superseded.*may not be launched/i,
    );
    await expect(
      resolveOfficialRelease({ releaseRoot, spec: OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC }),
    ).rejects.toThrow(/superseded/i);

    buildRelease({}, OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC);
    expect(() =>
      selectCurrentRelease(releaseRoot, externalReleaseId(OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC), null),
    ).toThrow(/superseded.*selected as current/i);
    expect(readCurrentReleaseId(releaseRoot)).toBeNull();
  });
});

describe('driver pairing reconciliation', () => {
  const manifestWith = (pkg: string, version: string) =>
    ({ adapter: { package: pkg, version } }) as ExternalReleaseManifest;

  it('recognizes this package as the current pairing', () => {
    expect(classifyDriverPairing(manifestWith(ARC_MCP_PACKAGE, ARC_MCP_VERSION))).toBe('current');
  });

  it('accepts the retired arc-researchclaw-adapter pairing as a rollback asset', () => {
    expect(classifyDriverPairing(manifestWith('@xvirobotics/arc-researchclaw-adapter', '0.1.0'))).toBe('superseded');
  });

  it('accepts the rejected research-stack pairing as a rollback asset', () => {
    expect(classifyDriverPairing(manifestWith('@xvirobotics/research-stack-mcp', '0.1.0'))).toBe('superseded');
  });

  it('rejects an unrecognized driver pairing', () => {
    expect(() => classifyDriverPairing(manifestWith('@someone/other-adapter', '9.9.9'))).toThrow(
      /not paired to a recognized driver/i,
    );
  });
});

describe('runtime pairing guard', () => {
  it('accepts a sealed release that matches the pinned revision', () => {
    const layout = buildRelease();
    const result = verifyExternalRuntimePairing(pairingOptions(layout), gitExecutor());
    expect(result.revision).toBe(SPEC.revision);
    expect(result.driver_pairing).toBe('current');
    expect(result.manifest_path).toBe(layout.manifestPath);
    expect(result.acpx).toEqual({ executable: acpxPath, version: SPEC.acpxVersion });
  });

  it('accepts a superseded-adapter release without demanding this driver bridge hash', () => {
    const layout = buildRelease({
      adapter: {
        package: '@xvirobotics/arc-researchclaw-adapter',
        version: '0.1.0',
        official_revision: SPEC.revision,
        bridge_sha256: sha256('a-different-bridge'),
        compatibility_sha256: sha256('a-different-compat'),
      },
    });
    expect(verifyExternalRuntimePairing(pairingOptions(layout), gitExecutor()).driver_pairing).toBe('superseded');
  });

  it('fails closed when the mutable global acpx drifted from the pin', () => {
    const layout = buildRelease();
    const execute = gitExecutor({ '--version': ok('0.14.0') });
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), execute)).toThrow(/acpx version drifted/i);
  });

  it('fails closed when the pinned acpx executable disappeared', () => {
    const layout = buildRelease({
      tools: {
        acpx: { executable: path.join(root, 'missing-acpx'), version: SPEC.acpxVersion },
        acp_agent: { name: 'codex', executable: '/usr/local/bin/codex' },
      },
    });
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), gitExecutor())).toThrow(
      /acpx executable is missing/i,
    );
  });

  it('fails closed on a revision mismatch', () => {
    const layout = buildRelease();
    const execute = gitExecutor({ 'rev-parse HEAD': ok('0'.repeat(40)) });
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), execute)).toThrow(/revision mismatch/i);
  });

  it('fails closed on an attached HEAD', () => {
    const layout = buildRelease();
    const execute = gitExecutor({ 'symbolic-ref -q HEAD': ok('refs/heads/main') });
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), execute)).toThrow(/must be detached/i);
  });

  it('fails closed on a dirty source tree', () => {
    const layout = buildRelease();
    const execute = gitExecutor({ 'status --porcelain --untracked-files=all': ok(' M researchclaw/__init__.py') });
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), execute)).toThrow(/is dirty/i);
  });

  it('fails closed on an unexpected origin', () => {
    const layout = buildRelease();
    const execute = gitExecutor({ 'remote get-url origin': ok('https://github.com/attacker/AutoResearchClaw') });
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), execute)).toThrow(/unexpected origin/i);
  });

  it('fails closed when the source tree hash drifts from the manifest', () => {
    const layout = buildRelease();
    const execute = gitExecutor({ 'rev-parse HEAD^{tree}': ok('a'.repeat(40)) });
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), execute)).toThrow(
      /not paired to this pinned revision/i,
    );
  });

  it('fails closed when the dependency freeze no longer matches the manifest', () => {
    const layout = buildRelease();
    writeFileSync(layout.freeze, 'alpha==9.9.9\n', 'utf8');
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), gitExecutor())).toThrow(
      /not paired to this pinned revision/i,
    );
  });

  it('fails closed when the downstream compatibility probe reports failure', () => {
    const layout = buildRelease();
    const execute = (command: string, args: string[]): CommandResult =>
      command === 'git' ? gitExecutor()(command, args) : ok(JSON.stringify({ success: false }));
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), execute)).toThrow(/compatibility check failed/i);
  });

  it('fails closed on a structural probe that does not match the pin', () => {
    const layout = buildRelease();
    const options = { ...pairingOptions(layout), probe: { ...pairingOptions(layout).probe, stage_count: 22 } };
    expect(() => verifyExternalRuntimePairing(options, gitExecutor())).toThrow(/does not match the paired release/i);
  });

  it('rejects a probe whose package path is not the expected package', () => {
    const layout = buildRelease();
    const strayDir = path.join(layout.source, 'not-researchclaw');
    mkdirSync(strayDir, { recursive: true });
    const stray = path.join(strayDir, '__init__.py');
    writeFileSync(stray, '', 'utf8');
    const options = { ...pairingOptions(layout), probe: { ...pairingOptions(layout).probe, package_path: stray } };
    expect(() => verifyExternalRuntimePairing(options, gitExecutor())).toThrow(/unexpected package path/i);
  });

  it('rejects a sealed release whose manifest is missing', () => {
    const layout = buildRelease();
    writeFileSync(layout.manifestPath, '', 'utf8');
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), gitExecutor())).toThrow();
  });
});

describe('append-only provenance', () => {
  it('refuses to rewrite a manifest an earlier driver sealed', () => {
    const layout = buildRelease({
      adapter: {
        package: '@xvirobotics/arc-researchclaw-adapter',
        version: '0.1.0',
        official_revision: SPEC.revision,
        bridge_sha256: sha256('bridge'),
        compatibility_sha256: sha256('compat'),
      },
    });
    expect(() => assertManifestAppendOnly(layout.manifestPath)).toThrow(/append-only/i);
    // The superseded record is still intact and still readable as evidence.
    expect(parseReleaseManifest(layout.manifestPath).adapter.package).toBe(
      '@xvirobotics/arc-researchclaw-adapter',
    );
  });

  it('allows a brand new release id beside the superseded one', () => {
    buildRelease();
    const tagPaths = externalReleasePaths(releaseRoot, OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    expect(() => assertManifestAppendOnly(tagPaths.manifest)).not.toThrow();
  });

  it('inventories every sealed release for rollback', () => {
    buildRelease();
    buildRelease({}, OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    expect(listSealedReleaseIds(releaseRoot)).toEqual([
      externalReleaseId(OFFICIAL_RESEARCHCLAW_TAG_SPEC),
      externalReleaseId(SPEC),
    ]);
  });
});

describe('current selector', () => {
  it('reports no activation when the selector is absent', () => {
    buildRelease();
    expect(readCurrentReleaseId(releaseRoot)).toBeNull();
  });

  it('reads a selector that points inside releases', () => {
    buildRelease();
    symlinkSync(path.join('releases', externalReleaseId(SPEC)), path.join(releaseRoot, 'current'));
    expect(readCurrentReleaseId(releaseRoot)).toBe(externalReleaseId(SPEC));
  });

  it('rejects a selector that escapes the releases directory', () => {
    buildRelease();
    symlinkSync(path.join('..', 'elsewhere'), path.join(releaseRoot, 'current'));
    expect(() => readCurrentReleaseId(releaseRoot)).toThrow(/escapes the releases directory/i);
  });

  it('rejects a selector that is a real directory instead of a symlink', () => {
    buildRelease();
    mkdirSync(path.join(releaseRoot, 'current'), { recursive: true });
    expect(() => readCurrentReleaseId(releaseRoot)).toThrow(/is not a symlink/i);
  });

  it('reports the replaced target so a switch can be rolled back exactly', () => {
    buildRelease();
    buildRelease({}, OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    const first = selectCurrentRelease(releaseRoot, externalReleaseId(SPEC), null);
    expect(first.previous).toBeNull();
    const second = selectCurrentRelease(
      releaseRoot,
      externalReleaseId(OFFICIAL_RESEARCHCLAW_TAG_SPEC),
      externalReleaseId(SPEC),
    );
    expect(second.previous).toBe(externalReleaseId(SPEC));
    expect(readCurrentReleaseId(releaseRoot)).toBe(externalReleaseId(OFFICIAL_RESEARCHCLAW_TAG_SPEC));
  });

  it('refuses to switch when the selector changed underneath the caller', () => {
    buildRelease();
    expect(() => selectCurrentRelease(releaseRoot, externalReleaseId(SPEC), 'something-else')).toThrow(
      /selector changed/i,
    );
  });
});

describe('direct CLI selector plan', () => {
  function withResearchclawBinary(layout: Layout): void {
    mkdirSync(path.join(layout.venv, 'bin'), { recursive: true });
    writeFileSync(path.join(layout.venv, 'bin', 'researchclaw'), '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
  }

  it('plans an exact-tag selector that execs the release without MetaBot', () => {
    const layout = buildRelease({}, OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    withResearchclawBinary(layout);
    const plan = planCliSelector({
      selectorPath: path.join(root, 'bin', 'researchclaw'),
      releaseRoot,
      spec: OFFICIAL_RESEARCHCLAW_TAG_SPEC,
    });
    expect(plan.release_id).toBe(externalReleaseId(OFFICIAL_RESEARCHCLAW_TAG_SPEC));
    expect(plan.exact_tag_release).toBe(true);
    expect(plan.current_target).toBeNull();
    expect(plan.script).toContain(`exec '${plan.executable}' "$@"`);
    // Independence: the executable part of the selector must reach the sealed
    // release directly. Comments may name MetaBot; instructions may not.
    const instructions = plan.script
      .split('\n')
      .filter((line) => line.trim() && !line.trimStart().startsWith('#'));
    expect(instructions).toEqual(['set -eu', `exec '${plan.executable}' "$@"`]);
    expect(instructions.join('\n')).not.toMatch(/node|metabot|capability|daemon/i);
  });

  it('marks a later untagged commit as not an exact tag release', () => {
    const layout = buildRelease();
    withResearchclawBinary(layout);
    const plan = planCliSelector({
      selectorPath: path.join(root, 'bin', 'researchclaw'),
      releaseRoot,
      spec: SPEC,
    });
    expect(plan.exact_tag_release).toBe(false);
    expect(plan.describe).toBe('v0.5.0-45-ge2e23c9');
  });

  it('refuses to plan a selector for a release that ships no researchclaw', () => {
    buildRelease({}, OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    expect(() =>
      planCliSelector({
        selectorPath: path.join(root, 'bin', 'researchclaw'),
        releaseRoot,
        spec: OFFICIAL_RESEARCHCLAW_TAG_SPEC,
      }),
    ).toThrow(/does not provide researchclaw/i);
  });

  it('reports an existing operator selector instead of ignoring it', () => {
    const selectorPath = path.join(root, 'bin', 'researchclaw');
    mkdirSync(path.dirname(selectorPath), { recursive: true });
    writeFileSync(selectorPath, "#!/bin/sh\nexec '/opt/other/researchclaw' \"$@\"\n", {
      encoding: 'utf8',
      mode: 0o755,
    });
    expect(readSelectorTarget(selectorPath)).toBe('/opt/other/researchclaw');
  });
});

describe('manifest parsing', () => {
  it('rejects an unsupported schema version', () => {
    const layout = buildRelease();
    writeFileSync(layout.manifestPath, JSON.stringify({ schema_version: 'something.else.v1' }), 'utf8');
    expect(() => parseReleaseManifest(layout.manifestPath)).toThrow(/Unsupported official release manifest schema/i);
  });

  it('rejects a symlinked manifest', () => {
    buildRelease();
    const decoy = path.join(root, 'decoy.json');
    writeFileSync(decoy, '{}', 'utf8');
    const link = path.join(root, 'linked-manifest.json');
    symlinkSync(decoy, link);
    expect(() => parseReleaseManifest(link)).toThrow(/Unsafe official release manifest/i);
  });

  it('still reads a manifest sealed by the retired adapter', () => {
    const layout = buildRelease();
    const sealed = JSON.parse(readFileSync(layout.manifestPath, 'utf8')) as ExternalReleaseManifest;
    sealed.adapter.package = '@xvirobotics/arc-researchclaw-adapter';
    sealed.adapter.version = '0.1.0';
    writeFileSync(layout.manifestPath, JSON.stringify(sealed, null, 2), 'utf8');
    expect(parseReleaseManifest(layout.manifestPath).release_id).toBe(externalReleaseId(SPEC));
  });
});

describe('release role separation', () => {
  function withResearchclawBinary(layout: Layout): void {
    mkdirSync(path.join(layout.venv, 'bin'), { recursive: true });
    writeFileSync(path.join(layout.venv, 'bin', 'researchclaw'), '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
  }

  it('treats a manifest sealed before roles existed as an MCP execution release', () => {
    const layout = buildRelease();
    const sealed = JSON.parse(readFileSync(layout.manifestPath, 'utf8')) as ExternalReleaseManifest;
    expect(sealed.role).toBeUndefined();
    expect(releaseRole(sealed)).toBe('mcp-execution');
  });

  it('rejects an unknown role rather than guessing', () => {
    const layout = buildRelease({ role: 'whatever' as never });
    expect(() => releaseRole(parseReleaseManifest(layout.manifestPath))).toThrow(/unknown role/i);
  });

  it('pins the exact published tag to direct CLI use and the audited commit to MCP execution', () => {
    expect(specRole(OFFICIAL_RESEARCHCLAW_TAG_SPEC)).toBe('direct-cli');
    expect(specRole(OFFICIAL_RESEARCHCLAW_COMPAT_SPEC)).toBe('mcp-execution');
  });

  it('refuses to launch a release sealed for direct CLI use only', () => {
    const layout = buildRelease({ role: 'direct-cli' }, DIRECT_TEST_SPEC);
    expect(() =>
      verifyExternalRuntimePairing(
        pairingOptions(layout, DIRECT_TEST_SPEC),
        gitExecutor({}, DIRECT_TEST_SPEC),
      ),
    ).toThrow(/direct CLI use only and must not be launched/i);
  });

  it('still launches the audited MCP execution release', () => {
    const layout = buildRelease({ role: 'mcp-execution' });
    expect(verifyExternalRuntimePairing(pairingOptions(layout), gitExecutor()).driver_pairing).toBe('current');
  });

  it('refuses to make a direct CLI release the current MCP selector', () => {
    buildRelease({ role: 'direct-cli' }, OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    expect(() =>
      selectCurrentRelease(releaseRoot, externalReleaseId(OFFICIAL_RESEARCHCLAW_TAG_SPEC), null),
    ).toThrow(/cannot become the current MCP release/i);
  });

  it('states the role and exact-tag status inside the selector script itself', () => {
    const layout = buildRelease({ role: 'direct-cli' }, OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    withResearchclawBinary(layout);
    const plan = planCliSelector({
      selectorPath: path.join(root, 'bin', 'researchclaw'),
      releaseRoot,
      spec: OFFICIAL_RESEARCHCLAW_TAG_SPEC,
    });
    expect(plan.release_role).toBe('direct-cli');
    expect(plan.exact_tag_release).toBe(true);
    expect(plan.script).toContain('role:       direct-cli');
    expect(plan.script).toContain('exact_tag:  yes');
  });

  it('never claims the compatibility commit is the exact published tag', () => {
    const layout = buildRelease({ role: 'mcp-execution' });
    withResearchclawBinary(layout);
    const plan = planCliSelector({ selectorPath: path.join(root, 'bin', 'researchclaw'), releaseRoot, spec: SPEC });
    expect(plan.exact_tag_release).toBe(false);
    expect(plan.script).toContain('exact_tag:  no');
    expect(plan.script).toContain('describe:   v0.5.0-45-ge2e23c9');
  });

  it('applies a selector only when the caller names the target it replaces', () => {
    const layout = buildRelease({ role: 'direct-cli' }, OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    withResearchclawBinary(layout);
    const selectorPath = path.join(root, 'bin', 'researchclaw');
    mkdirSync(path.dirname(selectorPath), { recursive: true });
    writeFileSync(selectorPath, "#!/bin/sh\nexec '/opt/other/researchclaw' \"$@\"\n", { encoding: 'utf8', mode: 0o755 });
    const plan = planCliSelector({ selectorPath, releaseRoot, spec: OFFICIAL_RESEARCHCLAW_TAG_SPEC });

    expect(() => applyCliSelector(plan, null)).toThrow(/selector changed/i);

    const applied = applyCliSelector(plan, '/opt/other/researchclaw');
    expect(applied.previous_script).toContain('/opt/other/researchclaw');
    expect(readSelectorTarget(selectorPath)).toBe(path.join(layout.venv, 'bin', 'researchclaw'));
    expect(statSync(selectorPath).mode & 0o111).not.toBe(0);

    // The captured previous bytes are the rollback, restored without this tool.
    writeFileSync(selectorPath, applied.previous_script!, { encoding: 'utf8', mode: 0o755 });
    expect(readSelectorTarget(selectorPath)).toBe('/opt/other/researchclaw');
  });
});

describe('bounded-execution evidence', () => {
  const ENFORCING = {
    available: true,
    enforced: true,
    checks: { call_ceiling_is_hard: true, cli_run_refuses_before_preflight: true },
    network_attempts: 0,
    price_table_version: 'researchclaw-budget-pricing-2026-08-17',
  };

  function withEvidence(evidence: unknown) {
    // The compatibility probe is the only execute() call whose arguments are
    // all absolute, so it is the one keyed by the empty string.
    return gitExecutor({ '': ok(JSON.stringify({ success: true, budget_guard: evidence })) });
  }

  it('records no guard when the release says nothing about one', () => {
    const layout = buildRelease();
    const result = verifyExternalRuntimePairing(pairingOptions(layout), gitExecutor());
    expect(result.budget_guard).toEqual({ available: false, enforced: false, reason: 'not_reported' });
  });

  it('records an enforcing release as enforcing', () => {
    const layout = buildRelease();
    const result = verifyExternalRuntimePairing(pairingOptions(layout), withEvidence(ENFORCING));
    expect(result.budget_guard.available).toBe(true);
    expect(result.budget_guard.enforced).toBe(true);
    expect(result.budget_guard.price_table_version).toBe(ENFORCING.price_table_version);
  });

  it('does not take a release at its word that it is enforcing', () => {
    const layout = buildRelease();
    const contradictions: Array<[string, unknown]> = [
      ['a check that reached the network', { ...ENFORCING, network_attempts: 1 }],
      ['a check that failed', { ...ENFORCING, checks: { ...ENFORCING.checks, call_ceiling_is_hard: false } }],
      ['no checks at all', { available: true, enforced: true, network_attempts: 0 }],
      ['an empty check set', { ...ENFORCING, checks: {} }],
      ['enforced without available', { ...ENFORCING, available: false }],
      ['a non-object payload', 'enforced'],
    ];
    for (const [reason, evidence] of contradictions) {
      const result = verifyExternalRuntimePairing(pairingOptions(layout), withEvidence(evidence));
      expect(result.budget_guard.enforced, reason).toBe(false);
    }
  });

  it('keeps a non-enforcing release usable for the non-billable path', () => {
    const layout = buildRelease();
    const result = verifyExternalRuntimePairing(
      pairingOptions(layout),
      withEvidence({ available: true, enforced: false, reason: 'probe_error: AttributeError: nope' }),
    );
    expect(result.driver_pairing).toBe('current');
    expect(result.budget_guard.reason).toContain('probe_error');
  });
});

describe('bounded-execution gate', () => {
  const enforcing = {
    available: true,
    enforced: true,
    checks: { call_ceiling_is_hard: true },
    network_attempts: 0,
  };
  const sealed = {
    mode: 'recursive-read-only',
    sealed: ['source', 'venv'],
    trees: {
      source: { files: 2, directories: 1, interpreter_links: 0 },
      venv: { files: 3, directories: 2, interpreter_links: 1 },
    },
  };
  const pairing = (budget_guard: unknown, immutability: unknown = sealed) =>
    ({ budget_guard, immutability }) as never;

  it('is inert unless the caller asks for a bounded run', () => {
    expect(() => assertBoundedExecution(pairing(BUDGET_GUARD_ABSENT), undefined)).not.toThrow();
    expect(() => assertBoundedExecution(pairing(BUDGET_GUARD_ABSENT), { require: false })).not.toThrow();
  });

  it('refuses a release with no guard at all', () => {
    expect(() => assertBoundedExecution(pairing(BUDGET_GUARD_ABSENT), { require: true, policyId: 'arc-006' })).toThrow(
      /no hard budget guard/i,
    );
  });

  it('refuses a release whose guard did not prove it fails closed', () => {
    expect(() =>
      assertBoundedExecution(pairing({ ...enforcing, enforced: false }), { require: true, policyId: 'arc-006' }),
    ).toThrow(/did not prove/i);
  });

  it('refuses a bounded run that names no policy', () => {
    expect(() => assertBoundedExecution(pairing(enforcing), { require: true })).toThrow(/naming a budget policy/i);
    expect(() => assertBoundedExecution(pairing(enforcing), { require: true, policyId: '   ' })).toThrow(
      /naming a budget policy/i,
    );
  });

  it('admits an enforcing release under a named policy', () => {
    expect(() => assertBoundedExecution(pairing(enforcing), { require: true, policyId: 'arc-006' })).not.toThrow();
  });

  it('refuses a release whose trees are not both sealed read-only', () => {
    expect(() =>
      assertBoundedExecution(pairing(enforcing, null), { require: true, policyId: 'arc-006' }),
    ).toThrow(/not both sealed read-only/i);
  });

  it('still leaves an unsealed release usable for the non-billable path', () => {
    expect(() => assertBoundedExecution(pairing(enforcing, null), undefined)).not.toThrow();
  });

  it('refuses at release resolution, before any process is started', async () => {
    // Sealed against this driver's real bridge and compatibility files so the
    // resolution reaches the bounded-run gate rather than stopping earlier.
    const layout = buildRelease({
      adapter: {
        package: ARC_MCP_PACKAGE,
        version: ARC_MCP_VERSION,
        official_revision: SPEC.revision,
        bridge_sha256: sha256(readFileSync(officialBridgePath())),
        compatibility_sha256: sha256(readFileSync(officialCompatibilityPath())),
      },
    });
    const resolve = (bounded?: { require: boolean; policyId?: string }) =>
      resolveOfficialRelease({
        releaseRoot,
        spec: SPEC,
        execute: gitExecutor(),
        probe: async () => pairingOptions(layout).probe,
        ...(bounded ? { bounded } : {}),
      });

    // The non-billable path against the same release is unaffected.
    await expect(resolve()).resolves.toMatchObject({ releaseId: externalReleaseId(SPEC) });
    await expect(resolve({ require: true, policyId: 'arc-006' })).rejects.toThrow(/no hard budget guard/i);
  });
});
