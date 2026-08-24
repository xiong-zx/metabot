import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArcArtifactStore } from '../src/artifact-store.js';
import type { ArcRunRecord } from '../src/contract.js';
import { ArcError } from '../src/errors.js';
import {
  ARC_ARTIFACT_PARSER_VERSION,
  ARC_RESULT_MANIFEST_VERSION,
  buildArcResultManifest,
} from '../src/provenance.js';
import { OfficialArcDriver, probeOfficialResearchClaw } from '../src/official-driver.js';
import type { ExternalReleaseManifest } from '../src/releases/manifest.js';
import { ARC_HARD_BUDGET_CANDIDATE_SPEC, ARC_MCP_PACKAGE, ARC_MCP_VERSION } from '../src/releases/spec.js';
import { projectDirectory, removeDirectory, temporaryDirectory } from './helpers.js';

const RUN_ID = 'run-1';

let parent: string;
let projectRoot: string;
let artifacts: ArcArtifactStore;

function run(overrides: Partial<ArcRunRecord> = {}): ArcRunRecord {
  return {
    contract_version: 'autoresearchclaw.run.v1',
    run_id: RUN_ID,
    project_id: 'proj',
    project_root: projectRoot,
    objective: 'Bounded provenance fixture.',
    idempotency_key: 'prov-1',
    request_fingerprint: 'f'.repeat(64),
    originator: null,
    status: 'completed',
    phase: 'completed',
    progress: 1,
    artifact_path: `.metabot-arc/runs/${RUN_ID}/output.json`,
    output_status: 'completed',
    runner_handle: null,
    error: null,
    recovery_generation: 0,
    created_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:01:00.000Z',
    started_at: '2026-08-15T00:00:01.000Z',
    finished_at: '2026-08-15T00:01:00.000Z',
    version: 3,
    ...overrides,
  } as ArcRunRecord;
}

function writeArtifact(relative: string, body: string): void {
  const target = path.join(projectRoot, '.metabot-arc', 'runs', RUN_ID, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, 'utf8');
}

const releaseManifest = {
  origin: 'https://github.com/aiming-lab/AutoResearchClaw',
  commit: 'e2e23c93b4943fd21cc531deb09850d8fda55357',
  source_tree: 'df6b145fc5abf7005cf157386492bc26d010ba8c',
  base_tag: 'v0.5.0',
  version: '0.5.0',
  release_id: '0.5.0-e2e23c93b494',
} as ExternalReleaseManifest;

const PATCH = ARC_HARD_BUDGET_CANDIDATE_SPEC.patch!;
const CANDIDATE_REVISION = ARC_HARD_BUDGET_CANDIDATE_SPEC.revision;
const PATCH_SOURCE = '/Users/operator/worktrees/autoresearchclaw-cost-guard';

const candidateReleaseManifest = {
  origin: PATCH_SOURCE,
  commit: CANDIDATE_REVISION,
  source_tree: ARC_HARD_BUDGET_CANDIDATE_SPEC.sourceTree,
  base_tag: 'v0.5.0',
  version: '0.5.0',
  release_id: 'unofficial-0.5.0-8fa6d66d1b8f-hard-budget-guard-v2',
  provenance: {
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
  },
} as unknown as ExternalReleaseManifest;

beforeEach(() => {
  parent = temporaryDirectory('arc-provenance-');
  projectRoot = projectDirectory(parent);
  artifacts = new ArcArtifactStore();
});

afterEach(() => removeDirectory(parent));

describe('result manifest', () => {
  it('refuses to claim official execution when no release was verified', () => {
    const manifest = buildArcResultManifest({
      run: run(),
      artifacts,
      effectiveConfig: { a: 1 },
      fallbackReason: 'official external release was not verified for this daemon',
    });

    expect(manifest.contract_version).toBe(ARC_RESULT_MANIFEST_VERSION);
    expect(manifest.official).toBeNull();
    expect(manifest.execution).toEqual({
      path: 'unproven',
      official_claimed: false,
      fallback_used: true,
      fallback_reason: 'official external release was not verified for this daemon',
    });
  });

  it('claims official execution only with a verified sealed release', () => {
    const manifest = buildArcResultManifest({
      run: run(),
      artifacts,
      releaseManifest,
      releaseManifestPath: '/opt/release/manifest.json',
      driverPairing: 'superseded',
      effectiveConfig: {},
    });

    expect(manifest.execution.path).toBe('official_external_cli');
    expect(manifest.execution.official_claimed).toBe(true);
    expect(manifest.execution.fallback_used).toBe(false);
    expect(manifest.official).toMatchObject({
      commit: releaseManifest.commit,
      source_tree: releaseManifest.source_tree,
      release_manifest_path: '/opt/release/manifest.json',
      driver_pairing: 'superseded',
    });
  });

  /**
   * A verified release and an official one are different facts. A sealed
   * candidate proves exactly which code ran; it never proves that code was
   * upstream's, so it gets its own execution path and `official_claimed:
   * false` while still carrying full, checkable evidence.
   */
  it('reports a patched candidate as its own execution path, never as official', () => {
    const manifest = buildArcResultManifest({
      run: run(),
      artifacts,
      releaseManifest: candidateReleaseManifest,
      releaseManifestPath: '/opt/release/unofficial/manifest.json',
      driverPairing: 'current',
      effectiveConfig: {},
    });

    expect(manifest.execution.path).toBe('downstream_patched_candidate_cli');
    expect(manifest.execution.official_claimed).toBe(false);
    expect(manifest.execution.fallback_used).toBe(false);
    expect(manifest.official).toMatchObject({
      official: false,
      provenance_class: 'downstream-patched-candidate',
      release_id: 'unofficial-0.5.0-8fa6d66d1b8f-hard-budget-guard-v2',
      commit: CANDIDATE_REVISION,
      driver_pairing: 'current',
    });
    // Verbatim from the seal, so a reader can re-derive the series themselves.
    expect(manifest.official!.patch).toEqual({
      upstream_repository: PATCH.upstream.repository,
      upstream_tag: PATCH.upstream.tag,
      upstream_tag_commit: PATCH.upstream.tagCommit,
      upstream_base_revision: PATCH.upstream.baseRevision,
      upstream_base_source_tree: PATCH.upstream.baseSourceTree,
      patch_commits: PATCH.patchCommits.map((entry) => ({ ...entry })),
      series_sha256: PATCH.seriesSha256,
      patch_source: PATCH_SOURCE,
      reason: PATCH.reason,
    });
  });

  it('leaves an official release manifest reporting exactly what it always did', () => {
    // A manifest sealed before patched candidates existed carries no
    // provenance block, and that absence is what "official" means here.
    const manifest = buildArcResultManifest({
      run: run(),
      artifacts,
      releaseManifest,
      releaseManifestPath: '/opt/release/manifest.json',
      driverPairing: 'current',
      effectiveConfig: {},
    });
    expect(manifest.execution.path).toBe('official_external_cli');
    expect(manifest.execution.official_claimed).toBe(true);
    expect(manifest.official).toMatchObject({ official: true, provenance_class: 'official', patch: null });
  });

  it('records lifecycle state and the unified package identity', () => {
    const manifest = buildArcResultManifest({
      run: run({ status: 'partial', output_status: 'partial', recovery_generation: 2 }),
      artifacts,
      effectiveConfig: {},
    });
    expect(manifest.lifecycle).toMatchObject({ status: 'partial', output_status: 'partial', recovery_generation: 2 });
    expect(manifest.integration).toMatchObject({
      package: ARC_MCP_PACKAGE,
      version: ARC_MCP_VERSION,
      parser_version: ARC_ARTIFACT_PARSER_VERSION,
    });
  });

  it('hashes discovered artifacts and reports paths relative to the project root', () => {
    writeArtifact('output.json', '{"ok":true}');
    writeArtifact('checkpoints/stage-1.json', 'checkpoint');

    const manifest = buildArcResultManifest({ run: run(), artifacts, effectiveConfig: {} });
    const paths = manifest.artifacts.entries.map((entry) => entry.relative_path);
    expect(paths).toEqual([
      `.metabot-arc/runs/${RUN_ID}/checkpoints/stage-1.json`,
      `.metabot-arc/runs/${RUN_ID}/output.json`,
    ]);
    expect(manifest.artifacts.entries[1].sha256).toBe(
      createHash('sha256').update('{"ok":true}').digest('hex'),
    );
    expect(manifest.artifacts.truncated).toBe(false);
  });

  it('skips symlinked evidence rather than attributing it to the official run', () => {
    writeArtifact('output.json', '{"ok":true}');
    const outside = path.join(parent, 'outside.txt');
    writeFileSync(outside, 'not official', 'utf8');
    symlinkSync(outside, path.join(projectRoot, '.metabot-arc', 'runs', RUN_ID, 'linked.txt'));

    const manifest = buildArcResultManifest({ run: run(), artifacts, effectiveConfig: {} });
    expect(manifest.artifacts.entries.map((entry) => entry.relative_path)).toEqual([
      `.metabot-arc/runs/${RUN_ID}/output.json`,
    ]);
  });

  it('reports an empty artifact set when the run produced nothing', () => {
    const manifest = buildArcResultManifest({ run: run(), artifacts, effectiveConfig: {} });
    expect(manifest.artifacts.entries).toEqual([]);
  });

  it('marks semantic extraction as not performed rather than as an empty finding set', () => {
    const manifest = buildArcResultManifest({ run: run(), artifacts, effectiveConfig: {} });
    expect(manifest.semantic_extraction).toEqual({ status: 'not_extracted', verified: false, findings: [] });
  });

  it('produces a stable config digest that is order-independent but value-sensitive', () => {
    const a = buildArcResultManifest({ run: run(), artifacts, effectiveConfig: { b: 2, a: 1 } });
    const b = buildArcResultManifest({ run: run(), artifacts, effectiveConfig: { a: 1, b: 2 } });
    const c = buildArcResultManifest({ run: run(), artifacts, effectiveConfig: { a: 1, b: 3 } });
    expect(a.integration.effective_config_digest).toBe(b.integration.effective_config_digest);
    expect(c.integration.effective_config_digest).not.toBe(a.integration.effective_config_digest);
  });

  it('uses the supervisor-captured config digest without re-hashing it', () => {
    const captured = 'a'.repeat(64);
    const manifest = buildArcResultManifest({
      run: run(),
      artifacts,
      effectiveConfig: { redacted: true },
      effectiveConfigDigest: captured,
    });
    expect(manifest.integration.effective_config_digest).toBe(captured);
  });
});

describe('official driver guard', () => {
  const supervisor = {
    start: async () => ({ id: 'handle-1' }),
    probe: async () => ({ state: 'running' as const }),
    pause: async () => ({ state: 'paused' as const }),
    resume: async () => ({ state: 'running' as const }),
    cancel: async () => ({ state: 'cancelled' as const }),
    collect: async () => ({ state: 'finished' as const }),
  };

  const input = {
    contract_version: 'autoresearchclaw.input.v1',
    project_id: 'proj',
    run_id: RUN_ID,
    objective: 'Bounded fixture.',
    project_root: '/tmp/project',
    artifact_path: `.metabot-arc/runs/${RUN_ID}/output.json`,
    requested_at: '2026-08-15T00:00:00.000Z',
  } as const;

  it('refuses to start when the sealed release cannot be verified', async () => {
    const driver = new OfficialArcDriver({
      releaseRoot: '/nonexistent',
      supervisor,
      resolve: async () => {
        throw new Error('External runtime revision mismatch');
      },
    });
    await expect(driver.start(input)).rejects.toThrow(/revision mismatch/i);
    expect(driver.release).toBeUndefined();
  });

  it('preserves a typed ArcError from the release guard', async () => {
    const driver = new OfficialArcDriver({
      releaseRoot: '/nonexistent',
      supervisor,
      resolve: async () => {
        throw new ArcError('runner_unconfigured', 'Pinned official AutoResearchClaw release is not installed');
      },
    });
    await expect(driver.start(input)).rejects.toMatchObject({ code: 'runner_unconfigured' });
  });

  it('re-verifies the release on every start and exposes it for provenance', async () => {
    let calls = 0;
    const resolved = {
      releaseRoot: '/opt/release',
      releaseId: '0.5.0-e2e23c93b494',
      python: '/opt/release/venv/bin/python3',
      sourceDir: '/opt/release/source',
      manifest: releaseManifest,
      manifestPath: '/opt/release/manifest.json',
      pairing: { source_dir: '', revision: '', source_tree: '', manifest_path: '', driver_pairing: 'current' as const },
    };
    const driver = new OfficialArcDriver({
      releaseRoot: '/opt/release',
      supervisor,
      resolve: async () => {
        calls += 1;
        return resolved;
      },
    });

    await driver.start(input);
    await driver.start(input);
    expect(calls).toBe(2);
    expect(driver.release?.releaseId).toBe('0.5.0-e2e23c93b494');
  });

  it('clears the recorded release when a later verification fails', async () => {
    let healthy = true;
    const driver = new OfficialArcDriver({
      releaseRoot: '/opt/release',
      supervisor,
      resolve: async () => {
        if (!healthy) throw new Error('External runtime source is dirty');
        return {
          releaseRoot: '/opt/release',
          releaseId: '0.5.0-e2e23c93b494',
          python: '/p',
          sourceDir: '/s',
          manifest: releaseManifest,
          manifestPath: '/m',
          pairing: { source_dir: '', revision: '', source_tree: '', manifest_path: '', driver_pairing: 'current' as const },
        };
      },
    });

    await driver.start(input);
    expect(driver.release).toBeDefined();
    healthy = false;
    await expect(driver.start(input)).rejects.toThrow(/is dirty/i);
    expect(driver.release).toBeUndefined();
  });
});

describe('official structural probe contract', () => {
  const bridge = fileURLToPath(new URL('./fixtures/fake-bridge.mjs', import.meta.url));

  it('sends the probe action on stdin, not as a process argument', async () => {
    process.env.FAKE_PACKAGE_PATH = '/opt/release/source/researchclaw/__init__.py';
    const probe = await probeOfficialResearchClaw(process.execPath, bridge);
    expect(probe).toMatchObject({ success: true, version: '0.5.0', stage_count: 23 });
  });

  it('fails closed and surfaces the bridge error when the action is unrecognized', async () => {
    const wrongAction = fileURLToPath(new URL('./fixtures/fake-bridge-reject.mjs', import.meta.url));
    await expect(probeOfficialResearchClaw(process.execPath, wrongAction)).rejects.toThrow(
      /structural probe failed: unknown bridge action/i,
    );
  });

  it('fails closed when the bridge emits no parsable JSON', async () => {
    const silent = fileURLToPath(new URL('./fixtures/fake-bridge-silent.mjs', import.meta.url));
    await expect(probeOfficialResearchClaw(process.execPath, silent)).rejects.toThrow(/invalid JSON/i);
  });
});
