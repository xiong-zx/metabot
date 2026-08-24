import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ArcArtifactStore } from './artifact-store.js';
import type { ArcRunRecord } from './contract.js';
import { ArcError } from './errors.js';
import {
  releaseIsOfficial,
  releaseProvenanceClass,
  type ExternalReleaseManifest,
} from './releases/manifest.js';
import { ARC_MCP_PACKAGE, ARC_MCP_VERSION, type ExternalReleaseProvenanceClass } from './releases/spec.js';

export const ARC_RESULT_MANIFEST_VERSION = 'metabot.autoresearchclaw.result-manifest.v1' as const;
/** Bumped whenever artifact discovery or hashing changes shape. */
export const ARC_ARTIFACT_PARSER_VERSION = '1.0.0' as const;

const MAX_HASHED_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_LISTED_ARTIFACTS = 200;

/**
 * `downstream_patched_candidate_cli` is its own path rather than a flag on the
 * official one. A reader that only knows the two original values sees an
 * unfamiliar path and cannot mistake a locally patched run for an official
 * one, which is the failure mode a boolean would have allowed.
 */
export type ArcExecutionPath = 'official_external_cli' | 'downstream_patched_candidate_cli' | 'unproven';

export interface ArcArtifactEntry {
  relative_path: string;
  bytes: number;
  sha256: string;
}

export interface ArcResultManifest {
  contract_version: typeof ARC_RESULT_MANIFEST_VERSION;
  run_id: string;
  project_id: string;
  lifecycle: {
    status: ArcRunRecord['status'];
    phase: string;
    output_status: ArcRunRecord['output_status'];
    recovery_generation: number;
    started_at: string | null;
    finished_at: string | null;
  };
  /**
   * `official_external_cli` is only claimed when a sealed external release
   * manifest proved the exact pinned revision actually drove this run, *and*
   * that manifest does not disclaim being official. A verified release is not
   * the same fact as an official one, so a patched candidate reports its own
   * path with `official_claimed: false` while still carrying full evidence.
   */
  execution: {
    path: ArcExecutionPath;
    official_claimed: boolean;
    fallback_used: boolean;
    fallback_reason: string | null;
  };
  /**
   * The sealed external release that drove this run, official or not. Named
   * `official` for backward compatibility with manifests already emitted; read
   * `official.official` and `execution.official_claimed` for the actual claim.
   */
  official: {
    origin: string;
    commit: string;
    source_tree: string;
    base_tag: string;
    version: string;
    release_id: string;
    release_manifest_path: string;
    driver_pairing: 'current' | 'superseded';
    /** False only when the release's own manifest disclaims officialdom. */
    official: boolean;
    provenance_class: ExternalReleaseProvenanceClass;
    /** Exact local-patch evidence, verbatim from the sealed manifest. */
    patch: {
      upstream_repository: string;
      upstream_tag: string;
      upstream_tag_commit: string;
      upstream_base_revision: string;
      upstream_base_source_tree: string;
      patch_commits: Array<{ commit: string; tree: string; subject: string }>;
      series_sha256: string;
      patch_source: string;
      reason: string;
    } | null;
  } | null;
  integration: {
    package: string;
    version: string;
    parser_version: typeof ARC_ARTIFACT_PARSER_VERSION;
    effective_config_digest: string;
  };
  artifacts: {
    root_relative_path: string;
    entries: ArcArtifactEntry[];
    truncated: boolean;
  };
  /**
   * Deliberately empty until a separately validated extractor exists. An empty
   * array means "not extracted", never "no findings".
   */
  semantic_extraction: {
    status: 'not_extracted';
    verified: false;
    findings: never[];
  };
}

export interface BuildArcResultManifestOptions {
  run: ArcRunRecord;
  artifacts: ArcArtifactStore;
  releaseManifest?: ExternalReleaseManifest;
  releaseManifestPath?: string;
  driverPairing?: 'current' | 'superseded';
  /** Redacted effective configuration actually used for this run. */
  effectiveConfig: unknown;
  /** Exact digest captured by the official supervisor before process launch. */
  effectiveConfigDigest?: string;
  fallbackReason?: string;
}

export function buildArcResultManifest(options: BuildArcResultManifestOptions): ArcResultManifest {
  const { run, artifacts, releaseManifest, releaseManifestPath, driverPairing } = options;
  const provenance = releaseManifest?.provenance;
  const release =
    releaseManifest && releaseManifestPath && driverPairing
      ? {
          origin: releaseManifest.origin,
          commit: releaseManifest.commit,
          source_tree: releaseManifest.source_tree,
          base_tag: releaseManifest.base_tag,
          version: releaseManifest.version,
          release_id: releaseManifest.release_id,
          release_manifest_path: releaseManifestPath,
          driver_pairing: driverPairing,
          official: releaseIsOfficial(releaseManifest),
          provenance_class: releaseProvenanceClass(releaseManifest),
          patch: provenance
            ? {
                upstream_repository: provenance.upstream.repository,
                upstream_tag: provenance.upstream.tag,
                upstream_tag_commit: provenance.upstream.tag_commit,
                upstream_base_revision: provenance.upstream.base_revision,
                upstream_base_source_tree: provenance.upstream.base_source_tree,
                patch_commits: provenance.patch_commits.map((entry) => ({ ...entry })),
                series_sha256: provenance.series_sha256,
                patch_source: provenance.patch_source,
                reason: provenance.reason,
              }
            : null,
        }
      : null;

  const rootRelative = path.posix.join('.metabot-arc', 'runs', run.run_id);
  const listing = listRunArtifacts(artifacts, run.project_root, rootRelative);

  return {
    contract_version: ARC_RESULT_MANIFEST_VERSION,
    run_id: run.run_id,
    project_id: run.project_id,
    lifecycle: {
      status: run.status,
      phase: run.phase,
      output_status: run.output_status,
      recovery_generation: run.recovery_generation,
      started_at: run.started_at,
      finished_at: run.finished_at,
    },
    execution: {
      path: executionPath(release),
      // Verified is not official. A sealed candidate proves exactly which code
      // ran; it never proves that code was upstream's.
      official_claimed: release?.official === true,
      fallback_used: options.fallbackReason !== undefined,
      fallback_reason: options.fallbackReason ?? null,
    },
    official: release,
    integration: {
      package: ARC_MCP_PACKAGE,
      version: ARC_MCP_VERSION,
      parser_version: ARC_ARTIFACT_PARSER_VERSION,
      effective_config_digest: options.effectiveConfigDigest ?? digest(options.effectiveConfig),
    },
    artifacts: {
      root_relative_path: rootRelative,
      entries: listing.entries,
      truncated: listing.truncated,
    },
    semantic_extraction: {
      status: 'not_extracted',
      verified: false,
      findings: [],
    },
  };
}

function executionPath(release: { official: boolean } | null): ArcExecutionPath {
  if (!release) return 'unproven';
  return release.official ? 'official_external_cli' : 'downstream_patched_candidate_cli';
}

function listRunArtifacts(
  artifacts: ArcArtifactStore,
  projectRoot: string,
  rootRelative: string,
): { entries: ArcArtifactEntry[]; truncated: boolean } {
  const root = artifacts.resolveLocalPath(projectRoot, rootRelative, { rejectSymlinks: true });
  if (!existsSync(root)) return { entries: [], truncated: false };
  if (!statSync(root).isDirectory()) {
    throw new ArcError('artifact_invalid', 'ARC run artifact root is not a directory');
  }

  const entries: ArcArtifactEntry[] = [];
  let truncated = false;
  const walk = (directory: string): void => {
    if (truncated) return;
    for (const name of readdirSync(directory).sort()) {
      if (entries.length >= MAX_LISTED_ARTIFACTS) {
        truncated = true;
        return;
      }
      const absolute = path.join(directory, name);
      const info = lstatSync(absolute);
      // Symlinked evidence cannot be trusted as official provenance; skip it.
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!info.isFile()) continue;
      entries.push({
        relative_path: path.posix.join(rootRelative, ...path.relative(root, absolute).split(path.sep)),
        bytes: info.size,
        sha256: info.size > MAX_HASHED_ARTIFACT_BYTES ? '' : sha256File(absolute),
      });
    }
  };
  walk(root);
  return { entries, truncated };
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
