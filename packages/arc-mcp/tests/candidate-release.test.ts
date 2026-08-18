import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseReleaseManifest,
  patchSeriesDigest,
  releaseIsOfficial,
  releaseProvenanceClass,
  sha256,
  type ExternalReleaseManifest,
  type ExternalReleaseProvenance,
} from '../src/releases/manifest.js';
import {
  externalReleaseId,
  externalReleasePaths,
  installExternalReleaseCandidate,
  selectCurrentRelease,
  UNOFFICIAL_RELEASE_ID_PREFIX,
  verifyExternalReleaseCandidate,
  verifyExternalRuntimePairing,
  type CommandResult,
} from '../src/releases/release-manager.js';
import { verifyPatchSeries } from '../src/releases/source.js';
import { resolveSelectorRelease } from '../src/releases/selector.js';
import {
  ARC_HARD_BUDGET_CANDIDATE_SPEC,
  ARC_HARD_BUDGET_CANDIDATE_V1_SPEC,
  ARC_MCP_PACKAGE,
  ARC_MCP_VERSION,
  EXTERNAL_RELEASE_SPECS,
  OFFICIAL_RESEARCHCLAW_COMPAT_SPEC,
  OFFICIAL_RESEARCHCLAW_TAG_SPEC,
  releaseSpecByName,
  assertReleaseSpecEligible,
  specProvenanceClass,
  specRole,
  type DownstreamPatchProvenance,
} from '../src/releases/spec.js';
import { removeDirectory, temporaryDirectory } from './helpers.js';

const PRODUCTION_CANDIDATE = ARC_HARD_BUDGET_CANDIDATE_SPEC;
const PRODUCTION_OFFICIAL = OFFICIAL_RESEARCHCLAW_COMPAT_SPEC;
// Generic provenance/runtime tests use mutable fixtures. Production v2 pins
// require real recursive seals and are covered by the focused immutability and
// replacement tests below.
const CANDIDATE = {
  ...PRODUCTION_CANDIDATE,
  releaseIdSuffix: 'hard-budget-test-fixture',
  requiresSealedTrees: false,
  supersedes: undefined,
  driverHashes: undefined,
};
const PATCH = CANDIDATE.patch as DownstreamPatchProvenance;
const OFFICIAL = {
  ...PRODUCTION_OFFICIAL,
  releaseIdSuffix: 'arc-mcp-test-fixture',
  requiresSealedTrees: false,
  supersedes: undefined,
  driverHashes: undefined,
};
const CANDIDATE_TREE = CANDIDATE.sourceTree as string;
const OFFICIAL_TREE = 'df6b145fc5abf7005cf157386492bc26d010ba8c';
const TAG_COMMIT = PATCH.upstream.tagCommit;
/** Where an operator's local staging clone of the patch commits lives. */
const PATCH_SOURCE = '/Users/operator/worktrees/autoresearchclaw-cost-guard';

let root: string;
let releaseRoot: string;
let bridgePath: string;
let compatibilityPath: string;
let acpxPath: string;

function ok(stdout = ''): CommandResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(stderr = 'no'): CommandResult {
  return { status: 1, stdout: '', stderr };
}

function provenanceBlock(overrides: Partial<ExternalReleaseProvenance> = {}): ExternalReleaseProvenance {
  return {
    official: false,
    class: 'downstream-patched-candidate',
    patch_source: PATCH_SOURCE,
    upstream: {
      repository: PATCH.upstream.repository,
      tag: PATCH.upstream.tag,
      tag_commit: PATCH.upstream.tagCommit,
      base_revision: PATCH.upstream.baseRevision,
      base_source_tree: PATCH.upstream.baseSourceTree,
    },
    patch_commits: PATCH.patchCommits.map((entry) => ({ ...entry })),
    series_sha256: PATCH.seriesSha256,
    reason: PATCH.reason,
    ...overrides,
  };
}

interface Layout {
  source: string;
  venv: string;
  python: string;
  packagePath: string;
  manifestPath: string;
}

function buildRelease(spec = CANDIDATE, overrides: Partial<ExternalReleaseManifest> = {}): Layout {
  const paths = externalReleasePaths(releaseRoot, spec);
  const packageDir = path.join(paths.source, 'researchclaw');
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(path.dirname(paths.python), { recursive: true });
  writeFileSync(path.join(packageDir, '__init__.py'), '', 'utf8');
  writeFileSync(paths.python, '', 'utf8');

  const freezeBody = 'alpha==1.0.0\nbeta==2.0.0\n';
  writeFileSync(paths.freeze, freezeBody, 'utf8');

  const patched = spec.patch !== undefined;
  const manifest: ExternalReleaseManifest = {
    schema_version: 'metabot.autoresearchclaw.release.v1',
    release_id: externalReleaseId(spec),
    product: 'AutoResearchClaw',
    state: 'candidate',
    role: 'mcp-execution',
    ...(patched ? { provenance: provenanceBlock() } : {}),
    origin: patched ? PATCH_SOURCE : spec.repository,
    base_tag: spec.tag,
    base_tag_commit: TAG_COMMIT,
    describe: patched ? 'v0.5.0-48-g8fa6d66' : 'v0.5.0-45-ge2e23c9',
    commit: spec.revision,
    source_tree: patched ? CANDIDATE_TREE : OFFICIAL_TREE,
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
    install: { created_at: '2026-08-17T06:42:02.378Z', bootstrap_python: 'python3.11', pip_command: [] },
    ...overrides,
  };
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    source: paths.source,
    venv: paths.venv,
    python: paths.python,
    packagePath: path.join(packageDir, '__init__.py'),
    manifestPath: paths.manifest,
  };
}

function pairingOptions(layout: Layout, spec = CANDIDATE) {
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
    driverPackage: ARC_MCP_PACKAGE,
    driverVersion: ARC_MCP_VERSION,
    spec,
    packageDirName: 'researchclaw',
  };
}

/**
 * A checkout that faithfully carries the pinned candidate: the upstream base
 * is an ancestor with the tree it had upstream, and exactly the declared
 * commits sit on top with the declared trees and subjects.
 */
function candidateGit(overrides: Record<string, CommandResult> = {}, spec = CANDIDATE) {
  const patch = spec.patch;
  const base = patch?.upstream.baseRevision ?? '';
  const defaults: Record<string, CommandResult> = {
    'remote get-url origin': ok(patch ? PATCH_SOURCE : spec.repository),
    'rev-parse HEAD': ok(spec.revision),
    'status --porcelain --untracked-files=all': ok(''),
    'rev-parse HEAD^{tree}': ok(patch ? CANDIDATE_TREE : OFFICIAL_TREE),
  };
  if (patch) {
    defaults[`merge-base --is-ancestor ${base} ${spec.revision}`] = ok();
    defaults[`rev-parse ${base}^{tree}`] = ok(patch.upstream.baseSourceTree);
    defaults[`rev-list --reverse ${base}..${spec.revision}`] = ok(
      patch.patchCommits.map((entry) => entry.commit).join('\n'),
    );
    for (const entry of patch.patchCommits) {
      defaults[`rev-parse ${entry.commit}^{tree}`] = ok(entry.tree);
      defaults[`log -1 --format=%s ${entry.commit}`] = ok(entry.subject);
    }
  }
  const table = { ...defaults, ...overrides };
  return (command: string, args: string[]): CommandResult => {
    const key = args.filter((value) => !value.startsWith('/') && value !== '-C').join(' ');
    if (key in table) return table[key]!;
    if (command === acpxPath) return ok(spec.acpxVersion);
    if (command !== 'git') return ok(JSON.stringify({ success: true }));
    if (key === 'symbolic-ref -q HEAD') return fail();
    return ok('');
  };
}

beforeEach(() => {
  root = realpathSync.native(temporaryDirectory('arc-candidate-'));
  releaseRoot = path.join(root, 'autoresearchclaw');
  bridgePath = path.join(root, 'bridge.py');
  compatibilityPath = path.join(root, 'official_compat.py');
  acpxPath = path.join(root, 'acpx');
  writeFileSync(bridgePath, 'bridge', 'utf8');
  writeFileSync(compatibilityPath, 'compat', 'utf8');
  writeFileSync(acpxPath, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
});

afterEach(() => removeDirectory(root));

describe('candidate identity', () => {
  it('names itself unofficial everywhere it is merely named', () => {
    const id = externalReleaseId(PRODUCTION_CANDIDATE);
    expect(id.startsWith(UNOFFICIAL_RELEASE_ID_PREFIX)).toBe(true);
    expect(id).toBe('unofficial-0.5.0-8fa6d66d1b8f-hard-budget-guard-v2');
    expect(PRODUCTION_CANDIDATE.supersedes?.releaseId).toBe(
      'unofficial-0.5.0-8fa6d66d1b8f-hard-budget-guard',
    );
    // No official release acquires the prefix, and no id collides.
    expect(externalReleaseId(PRODUCTION_OFFICIAL)).toBe('0.5.0-e2e23c93b494-arc-mcp-0.3.0-v2');
    expect(externalReleaseId(OFFICIAL_RESEARCHCLAW_TAG_SPEC)).toBe('0.5.0-12d3fd809fa9');
    expect(new Set([externalReleaseId(CANDIDATE), externalReleaseId(OFFICIAL)]).size).toBe(2);
  });

  it('classifies the candidate as patched and the official specs as official', () => {
    expect(specProvenanceClass(CANDIDATE)).toBe('downstream-patched-candidate');
    expect(specProvenanceClass(OFFICIAL)).toBe('official');
    expect(specProvenanceClass(OFFICIAL_RESEARCHCLAW_TAG_SPEC)).toBe('official');
    // Launchable by the driver is not the same claim as production-current.
    expect(specRole(CANDIDATE)).toBe('mcp-execution');
    expect(specRole(OFFICIAL_RESEARCHCLAW_TAG_SPEC)).toBe('direct-cli');
  });

  it('pins a digest that actually covers its own declared patch series', () => {
    expect(patchSeriesDigest(PATCH.patchCommits)).toBe(PATCH.seriesSha256);
    expect(PATCH.patchCommits).toHaveLength(3);
    for (const entry of PATCH.patchCommits) {
      expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.subject.trim()).not.toBe('');
    }
    // The last patch commit is the revision the release actually executes.
    expect(PATCH.patchCommits.at(-1)!.commit).toBe(CANDIDATE.revision);
    expect(PATCH.patchCommits.at(-1)!.tree).toBe(CANDIDATE_TREE);
  });

  it('resolves selectable specs by own name only', () => {
    expect(releaseSpecByName('hard-budget-candidate')).toBe(PRODUCTION_CANDIDATE);
    expect(releaseSpecByName('mcp-execution')).toBe(PRODUCTION_OFFICIAL);
    expect(releaseSpecByName('direct-cli')).toBe(OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    expect(releaseSpecByName('nope')).toBeUndefined();
    // Inherited keys are not releases; resolving them would hand release
    // identity an object with no revision instead of rejecting the name.
    for (const inherited of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(releaseSpecByName(inherited), inherited).toBeUndefined();
    }
    expect(Object.keys(EXTERNAL_RELEASE_SPECS)).toEqual([
      'direct-cli',
      'mcp-execution',
      'hard-budget-candidate',
      'mcp-execution-v1',
      'hard-budget-candidate-v1',
    ]);
  });
});

describe('patch series re-derivation', () => {
  const run = (overrides: Record<string, CommandResult> = {}, patch = PATCH) =>
    verifyPatchSeries('/sealed/source', patch, CANDIDATE.revision, candidateGit(overrides));

  it('accepts a checkout that carries exactly the pinned series', () => {
    expect(() => run()).not.toThrow();
  });

  it('refuses a spec whose digest does not cover its own series', () => {
    expect(() => run({}, { ...PATCH, seriesSha256: 'f'.repeat(64) })).toThrow(/does not cover its own/i);
  });

  it('refuses a checkout the upstream base does not lead to', () => {
    expect(() => run({ [`merge-base --is-ancestor ${PATCH.upstream.baseRevision} ${CANDIDATE.revision}`]: fail() })).toThrow(
      /ancestry failed/i,
    );
  });

  it('refuses an upstream base that is not the tree upstream published', () => {
    expect(() => run({ [`rev-parse ${PATCH.upstream.baseRevision}^{tree}`]: ok('0'.repeat(40)) })).toThrow(
      /upstream base tree mismatch/i,
    );
  });

  it('refuses a fourth commit slipped into the series', () => {
    const applied = [...PATCH.patchCommits.map((entry) => entry.commit), 'a'.repeat(40)];
    expect(() =>
      run({ [`rev-list --reverse ${PATCH.upstream.baseRevision}..${CANDIDATE.revision}`]: ok(applied.join('\n')) }),
    ).toThrow(/applies a different commit series/i);
  });

  it('refuses a dropped or reordered commit', () => {
    const commits = PATCH.patchCommits.map((entry) => entry.commit);
    const key = `rev-list --reverse ${PATCH.upstream.baseRevision}..${CANDIDATE.revision}`;
    expect(() => run({ [key]: ok(commits.slice(1).join('\n')) })).toThrow(/applies a different commit series/i);
    expect(() => run({ [key]: ok([commits[1], commits[0], commits[2]].join('\n')) })).toThrow(
      /applies a different commit series/i,
    );
    expect(() => run({ [key]: ok('') })).toThrow(/got none/i);
  });

  it('refuses a commit that produced a different tree', () => {
    expect(() => run({ [`rev-parse ${PATCH.patchCommits[1]!.commit}^{tree}`]: ok('b'.repeat(40)) })).toThrow(
      /has tree .*expected/i,
    );
  });

  /**
   * Recorded subjects are the only part of the series a human reads, in the
   * manifest and in an install report. An unverified subject is not identity:
   * it would let the spec describe a commit that is not the one present.
   */
  it('refuses a commit whose recorded subject is not the subject it has', () => {
    expect(() =>
      run({ [`log -1 --format=%s ${PATCH.patchCommits[0]!.commit}`]: ok('feat: something else entirely') }),
    ).toThrow(/has subject .*expected/i);
  });
});

describe('sealed provenance block', () => {
  const write = (provenance: unknown): string => {
    const file = path.join(root, 'manifest.json');
    const base = JSON.parse(readFileSync(buildRelease().manifestPath, 'utf8')) as Record<string, unknown>;
    if (provenance === undefined) delete base.provenance;
    else base.provenance = provenance;
    writeFileSync(file, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
    return file;
  };

  it('treats a manifest with no provenance block as official, unchanged', () => {
    const manifest = parseReleaseManifest(write(undefined));
    expect(manifest.provenance).toBeUndefined();
    expect(releaseIsOfficial(manifest)).toBe(true);
    expect(releaseProvenanceClass(manifest)).toBe('official');
  });

  it('accepts a block that disclaims officialdom and carries checkable evidence', () => {
    const manifest = parseReleaseManifest(write(provenanceBlock()));
    expect(releaseIsOfficial(manifest)).toBe(false);
    expect(releaseProvenanceClass(manifest)).toBe('downstream-patched-candidate');
    expect(manifest.provenance!.patch_source).toBe(PATCH_SOURCE);
  });

  it('refuses any block that is not purely a disclaimer', () => {
    const cases: Array<[string, unknown]> = [
      ['a release certifying itself official', provenanceBlock({ official: true as never })],
      ['a null block', null],
      ['an array block', []],
      ['an unknown class', provenanceBlock({ class: 'vendor-blessed' as never })],
      ['no patch source', provenanceBlock({ patch_source: '   ' })],
      ['a malformed digest', provenanceBlock({ series_sha256: 'nope' })],
      ['no upstream base', provenanceBlock({ upstream: undefined as never })],
      ['no patch commits', provenanceBlock({ patch_commits: [] })],
      [
        'an abbreviated commit',
        provenanceBlock({ patch_commits: [{ commit: '8fa6d66', tree: 'c'.repeat(40), subject: 's' }] }),
      ],
    ];
    for (const [reason, provenance] of cases) {
      expect(() => parseReleaseManifest(write(provenance)), reason).toThrow(/invalid provenance block/i);
    }
  });

  it('refuses a block whose digest does not cover the commits it lists', () => {
    const tampered = provenanceBlock();
    tampered.patch_commits = tampered.patch_commits.slice(0, 2);
    expect(() => parseReleaseManifest(write(tampered))).toThrow(/does not cover the listed commits/i);
  });

  it('refuses an upstream base missing any field that makes the claim checkable', () => {
    for (const key of ['repository', 'tag', 'tag_commit', 'base_revision', 'base_source_tree'] as const) {
      const block = provenanceBlock();
      (block.upstream as Record<string, unknown>)[key] = '';
      expect(() => parseReleaseManifest(write(block)), key).toThrow(/no upstream/i);
    }
  });
});

describe('candidate runtime pairing', () => {
  it('launches as a verified release that reports it is not official', () => {
    const layout = buildRelease();
    const result = verifyExternalRuntimePairing(pairingOptions(layout), candidateGit());
    expect(result.official).toBe(false);
    expect(result.provenance_class).toBe('downstream-patched-candidate');
    expect(result.driver_pairing).toBe('current');
    expect(result.origin).toBe(PATCH_SOURCE);
    expect(result.revision).toBe(CANDIDATE.revision);
    expect(result.source_tree).toBe(CANDIDATE_TREE);
  });

  it('leaves the official release reporting exactly what it always did', () => {
    const layout = buildRelease(OFFICIAL);
    const result = verifyExternalRuntimePairing(pairingOptions(layout, OFFICIAL), candidateGit({}, OFFICIAL), );
    expect(result.official).toBe(true);
    expect(result.provenance_class).toBe('official');
    expect(result.origin).toBe(OFFICIAL.repository);
  });

  it('re-derives the patch series on the launch path, not only at seal time', () => {
    const layout = buildRelease();
    expect(() =>
      verifyExternalRuntimePairing(
        pairingOptions(layout),
        candidateGit({ [`rev-parse ${PATCH.patchCommits[2]!.commit}^{tree}`]: ok('d'.repeat(40)) }),
      ),
    ).toThrow(/has tree .*expected/i);
  });

  it('refuses a pinned tree the checkout does not have', () => {
    const layout = buildRelease();
    expect(() =>
      verifyExternalRuntimePairing(pairingOptions(layout), candidateGit({ 'rev-parse HEAD^{tree}': ok('e'.repeat(40)) })),
    ).toThrow(/tree mismatch/i);
  });

  it('refuses when the sealed manifest and the pinned spec disagree about being official', () => {
    // A patched tree sealed without a disclaimer must not launch under the
    // patched pin, and an official pin must not resolve to a disclaiming seal.
    const patchedSealedOfficial = buildRelease(CANDIDATE, { provenance: undefined });
    expect(() => verifyExternalRuntimePairing(pairingOptions(patchedSealedOfficial), candidateGit())).toThrow(
      /is a official release but the pinned spec is downstream-patched-candidate/i,
    );

    removeDirectory(releaseRoot);
    const officialSealedPatched = buildRelease(OFFICIAL, { provenance: provenanceBlock() });
    expect(() =>
      verifyExternalRuntimePairing(pairingOptions(officialSealedPatched, OFFICIAL), candidateGit({}, OFFICIAL)),
    ).toThrow(/downstream-patched-candidate release but the pinned spec is official/i);
  });

  it('refuses a seal that records a different patch series than the pin', () => {
    const layout = buildRelease(CANDIDATE, {
      provenance: provenanceBlock({
        upstream: {
          repository: PATCH.upstream.repository,
          tag: PATCH.upstream.tag,
          tag_commit: PATCH.upstream.tagCommit,
          base_revision: '9'.repeat(40),
          base_source_tree: PATCH.upstream.baseSourceTree,
        },
      }),
    });
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout), candidateGit())).toThrow(
      /records a different patch series/i,
    );
  });
});

describe('candidate promotion is refused', () => {
  it('cannot become the current production release', () => {
    buildRelease();
    expect(() => selectCurrentRelease(releaseRoot, externalReleaseId(CANDIDATE), null)).toThrow(
      /cannot become the current production release/i,
    );
  });

  it('leaves the official release promotable exactly as before', () => {
    buildRelease(OFFICIAL);
    expect(() => selectCurrentRelease(releaseRoot, externalReleaseId(OFFICIAL), null)).not.toThrow();
  });

  it('cannot back the direct researchclaw CLI selector', () => {
    const layout = buildRelease();
    mkdirSync(path.join(layout.venv, 'bin'), { recursive: true });
    writeFileSync(path.join(layout.venv, 'bin', 'researchclaw'), '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
    expect(() => resolveSelectorRelease(releaseRoot, CANDIDATE)).toThrow(
      /cannot back the direct researchclaw CLI selector/i,
    );
  });

  it('leaves the exact official tag release backing that selector', () => {
    const layout = buildRelease(OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    mkdirSync(path.join(layout.venv, 'bin'), { recursive: true });
    writeFileSync(path.join(layout.venv, 'bin', 'researchclaw'), '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
    const resolved = resolveSelectorRelease(releaseRoot, OFFICIAL_RESEARCHCLAW_TAG_SPEC);
    expect(resolved.releaseId).toBe('0.5.0-12d3fd809fa9');
  });
});

describe('deliberate local patch source', () => {
  const dependencies = {
    execute: () => ok(''),
    now: () => new Date('2026-08-17T00:00:00.000Z'),
    randomId: () => 'fixed',
  };
  const options = (spec: typeof CANDIDATE, patchSource?: string) => ({
    root: releaseRoot,
    bootstrapPython: 'python3.11',
    bridgePath,
    compatibilityPath,
    acpAgent: 'codex',
    spec,
    packageDirName: 'researchclaw',
    ...(patchSource ? { patchSource } : {}),
  });

  it('refuses to seal local patches nobody named a source for', async () => {
    await expect(installExternalReleaseCandidate(options(CANDIDATE), dependencies)).rejects.toThrow(
      /must name the repository its patch commits are fetched from/i,
    );
  });

  it('refuses a patch source for a release that has no patches', async () => {
    await expect(installExternalReleaseCandidate(options(OFFICIAL, PATCH_SOURCE), dependencies)).rejects.toThrow(
      /declares no patch series/i,
    );
  });

  it('refuses before it creates anything on disk', async () => {
    const paths = externalReleasePaths(releaseRoot, CANDIDATE);
    await expect(installExternalReleaseCandidate(options(CANDIDATE), dependencies)).rejects.toThrow();
    expect(() => readFileSync(paths.release)).toThrow();
  });
});

describe('append-only v2 replacement', () => {
  it('links both directions and makes the source-only v1 pin rollback-only', () => {
    expect(ARC_HARD_BUDGET_CANDIDATE_SPEC.requiresSealedTrees).toBe(true);
    expect(ARC_HARD_BUDGET_CANDIDATE_SPEC.supersedes).toEqual({
      releaseId: externalReleaseId(ARC_HARD_BUDGET_CANDIDATE_V1_SPEC),
      reason: ARC_HARD_BUDGET_CANDIDATE_V1_SPEC.supersededBy!.reason,
    });
    expect(ARC_HARD_BUDGET_CANDIDATE_V1_SPEC.supersededBy).toMatchObject({
      specName: 'hard-budget-candidate',
      releaseId: externalReleaseId(ARC_HARD_BUDGET_CANDIDATE_SPEC),
    });
    expect(() => assertReleaseSpecEligible(ARC_HARD_BUDGET_CANDIDATE_V1_SPEC, 'launched')).toThrow(
      /superseded.*may not be launched/i,
    );
    expect(() => assertReleaseSpecEligible(ARC_HARD_BUDGET_CANDIDATE_SPEC, 'launched')).not.toThrow();
  });

  it('parses a machine-readable supersession and refuses malformed or self links', () => {
    const layout = buildRelease();
    const base = JSON.parse(readFileSync(layout.manifestPath, 'utf8')) as Record<string, unknown>;
    const write = (supersedes: unknown): void => {
      base.supersedes = supersedes;
      writeFileSync(layout.manifestPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
    };
    write({ release_id: 'older-release', reason: 'sealed both executable trees' });
    expect(parseReleaseManifest(layout.manifestPath).supersedes).toEqual({
      release_id: 'older-release',
      reason: 'sealed both executable trees',
    });
    for (const invalid of [
      null,
      { release_id: '', reason: 'why' },
      { release_id: base.release_id, reason: 'self' },
      { release_id: 'older-release', reason: '   ' },
    ]) {
      write(invalid);
      expect(() => parseReleaseManifest(layout.manifestPath)).toThrow(/invalid supersession block/i);
    }
  });

  it('keeps a retired pin verifiable against its historical hashes without making it launchable', async () => {
    const retired = {
      ...ARC_HARD_BUDGET_CANDIDATE_V1_SPEC,
      releaseIdSuffix: 'retired-test-fixture',
      driverHashes: { bridgeSha256: sha256('bridge'), compatibilitySha256: sha256('compat') },
    };
    const layout = buildRelease(retired);
    const execute = (command: string, args: string[]): CommandResult => {
      if (command === layout.python && args[0] === '-c') return ok('3.11.15');
      if (command === layout.python && args.join(' ') === '-m pip freeze --all') {
        return ok('alpha==1.0.0\nbeta==2.0.0\n');
      }
      return candidateGit(
        {
          'describe --tags --always HEAD': ok('v0.5.0-48-g8fa6d66'),
          'describe --tags --abbrev=0 HEAD': ok(retired.tag),
          [`rev-parse refs/tags/${retired.tag}^{commit}`]: ok(TAG_COMMIT),
        },
        retired,
      )(command, args);
    };
    const verified = await verifyExternalReleaseCandidate(
      {
        root: releaseRoot,
        bootstrapPython: 'python3.11',
        bridgePath,
        compatibilityPath,
        acpAgent: 'codex',
        spec: retired,
        packageDirName: 'researchclaw',
        role: 'mcp-execution',
      },
      {
        execute,
        findCommand: (name) => (name === 'acpx' ? acpxPath : name === 'codex' ? '/usr/local/bin/codex' : undefined),
        probe: async () => pairingOptions(layout, retired).probe,
        now: () => new Date('2026-08-17T00:00:00.000Z'),
        randomId: () => 'unused',
      },
    );
    expect(verified.release_id).toBe(externalReleaseId(retired));
    expect(() => verifyExternalRuntimePairing(pairingOptions(layout, retired), execute)).toThrow(/superseded/i);
  });
});
