import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';

import {
  RELEASE_IMMUTABILITY_MODE,
  SEALED_TREE_NAMES,
  type ReleaseImmutabilityRecord,
  type SealedTreeName,
} from './immutability.js';
import {
  ARC_RELEASE_ASSURANCE_IDS,
  ARC_MCP_PACKAGE,
  ARC_MCP_VERSION,
  DEFAULT_EXTERNAL_RELEASE_ROLE,
  DOWNSTREAM_PATCHED_CANDIDATE,
  type DownstreamPatchProvenance,
  type ExternalReleaseProvenanceClass,
  type ExternalReleaseRole,
  type ExternalReleaseAssuranceId,
  type OfficialArcProduct,
} from './spec.js';

export const ARC_RELEASE_MANIFEST_VERSION = 'metabot.autoresearchclaw.release.v1' as const;
export const ARC_RELEASE_ASSURANCE_VERSION = 'metabot.autoresearchclaw.assurance.v1' as const;

export interface ExternalReleaseAssurance {
  schema_version: typeof ARC_RELEASE_ASSURANCE_VERSION;
  id: ExternalReleaseAssuranceId;
  commit: string;
  source_tree: string;
  patch_series_sha256: string;
}

/**
 * Sealed manifests are append-only evidence.
 *
 * Earlier official releases were sealed by drivers that no longer exist on this
 * line: the retired `arc-researchclaw-adapter`, and the rejected unified
 * research-stack package. Rewriting those manifests to name `arc-mcp` would
 * destroy the provenance that makes them usable as rollback evidence, so they
 * are accepted by exact identity and reported as `superseded` instead. Nothing
 * else is grandfathered, and a superseded pairing never claims that this
 * driver's own bridge revision sealed the release.
 */
export const SUPERSEDED_DRIVER_PAIRINGS: ReadonlyArray<{ package: string; version: string }> = [
  { package: '@xvirobotics/arc-researchclaw-adapter', version: '0.1.0' },
  { package: '@xvirobotics/research-stack-mcp', version: '0.1.0' },
];

/**
 * Sealed, machine-readable statement that a release is *not* official.
 *
 * Serialized in snake_case alongside the rest of the manifest, and deliberately
 * one-directional: `official` may only ever be `false`. There is no shape a
 * manifest can take that asserts the opposite, so no release can launder itself
 * into officialdom by adding a key.
 */
export interface ExternalReleaseProvenance {
  official: false;
  class: typeof DOWNSTREAM_PATCHED_CANDIDATE;
  /** Git remote the patched checkout was actually cloned from. */
  patch_source: string;
  upstream: {
    repository: string;
    tag: string;
    tag_commit: string;
    base_revision: string;
    base_source_tree: string;
  };
  patch_commits: Array<{ commit: string; tree: string; subject: string }>;
  series_sha256: string;
  reason: string;
}

/** Append-only link to the release whose evidence this release replaces. */
export interface ExternalReleaseSupersessionRecord {
  release_id: string;
  reason: string;
}

export interface ExternalReleaseManifest {
  schema_version: typeof ARC_RELEASE_MANIFEST_VERSION;
  release_id: string;
  product: OfficialArcProduct;
  state: 'candidate';
  /**
   * Additive since the first sealed manifests. Absent means `mcp-execution`,
   * which is what every manifest sealed before direct-CLI releases existed
   * was: reading a role therefore never requires editing an old manifest.
   */
  role?: ExternalReleaseRole;
  /**
   * Additive, and absent on every official release. Absence is what "official"
   * means here, so the manifests sealed before patched candidates existed keep
   * their meaning byte-for-byte and are never rewritten to acquire this key.
   */
  provenance?: ExternalReleaseProvenance;
  /**
   * Additive, and present only on a new release. The superseded manifest is
   * never edited to point forward; its pin carries the inverse retirement.
   */
  supersedes?: ExternalReleaseSupersessionRecord;
  /**
   * Additive, and absent on every release sealed before the virtualenv was
   * sealed alongside the source. Absence means "source-only, sealed by an
   * older release manager" and is reported as such rather than repaired: an
   * earlier release's permissions are part of the evidence it is. Presence is
   * a claim this driver checks before every launch.
   */
  immutability?: ReleaseImmutabilityRecord;
  /**
   * Optional reviewed behavior claims tied to this exact sealed candidate.
   * Older manifests remain valid without this additive field.
   */
  assurances?: ExternalReleaseAssurance[];
  origin: string;
  base_tag: string;
  base_tag_commit: string;
  describe: string;
  commit: string;
  source_tree: string;
  version: string;
  stage_count: number;
  source_dir: string;
  venv_dir: string;
  python: {
    executable: string;
    version: string;
  };
  dependencies: {
    freeze_file: string;
    sha256: string;
    entries: number;
  };
  tools: {
    acpx: { executable: string; version: string };
    acp_agent: { name: string; executable: string };
  };
  /**
   * Retains the historical `adapter` key so manifests sealed before the package
   * consolidation stay readable and verifiable without a rewrite.
   */
  adapter: {
    package: string;
    version: string;
    official_revision: string;
    bridge_sha256: string;
    compatibility_sha256: string;
  };
  install: {
    created_at: string;
    bootstrap_python: string;
    pip_command: string[];
  };
}

export type DriverPairing = 'current' | 'superseded';

/**
 * Whether this release is upstream code.
 *
 * A manifest with no provenance block was sealed from an unmodified official
 * checkout, which is exactly what every manifest sealed before this key existed
 * was. Only an explicit `official: false` block makes a release unofficial.
 */
export function releaseIsOfficial(manifest: ExternalReleaseManifest): boolean {
  return manifest.provenance === undefined;
}

export function releaseProvenanceClass(manifest: ExternalReleaseManifest): ExternalReleaseProvenanceClass {
  return manifest.provenance === undefined ? 'official' : manifest.provenance.class;
}

/** Serialize a spec's patch provenance for the sealed manifest. */
export function patchProvenanceRecord(
  patch: DownstreamPatchProvenance,
  patchSource: string,
): ExternalReleaseProvenance {
  return {
    official: false,
    class: patch.class,
    patch_source: patchSource,
    upstream: {
      repository: normalizeRepository(patch.upstream.repository),
      tag: patch.upstream.tag,
      tag_commit: patch.upstream.tagCommit,
      base_revision: patch.upstream.baseRevision,
      base_source_tree: patch.upstream.baseSourceTree,
    },
    patch_commits: patch.patchCommits.map((entry) => ({
      commit: entry.commit,
      tree: entry.tree,
      subject: entry.subject,
    })),
    series_sha256: patch.seriesSha256,
    reason: patch.reason,
  };
}

/**
 * Digest over the ordered `commit:tree` series.
 *
 * Pinned in the spec and recomputed here, so dropping, reordering, or amending
 * a patch commit changes the identity of the whole series rather than quietly
 * producing a different release under the same description.
 */
export function patchSeriesDigest(commits: ReadonlyArray<{ commit: string; tree: string }>): string {
  return sha256(commits.map((entry) => `${entry.commit}:${entry.tree}\n`).join(''));
}

/** Role of a sealed release, treating pre-role manifests as MCP execution releases. */
export function releaseRole(manifest: ExternalReleaseManifest): ExternalReleaseRole {
  const role = manifest.role ?? DEFAULT_EXTERNAL_RELEASE_ROLE;
  if (role !== 'mcp-execution' && role !== 'direct-cli') {
    throw new Error(`Official release manifest declares an unknown role: ${String(role)}`);
  }
  return role;
}

export function classifyDriverPairing(
  manifest: ExternalReleaseManifest,
  driverPackage: string = ARC_MCP_PACKAGE,
  driverVersion: string = ARC_MCP_VERSION,
): DriverPairing {
  if (manifest.adapter.package === driverPackage && manifest.adapter.version === driverVersion) return 'current';
  if (
    SUPERSEDED_DRIVER_PAIRINGS.some(
      (entry) => entry.package === manifest.adapter.package && entry.version === manifest.adapter.version,
    )
  ) {
    return 'superseded';
  }
  throw new Error(
    `Official release manifest is not paired to a recognized driver: ${manifest.adapter.package}@${manifest.adapter.version}`,
  );
}

export function parseReleaseManifest(file: string): ExternalReleaseManifest {
  if (!existsSync(file)) throw new Error(`Official release manifest is missing: ${file}`);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe official release manifest: ${file}`);
  const value = JSON.parse(readFileSync(file, 'utf8')) as ExternalReleaseManifest;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Official release manifest is invalid: ${file}`);
  }
  if (value.schema_version !== ARC_RELEASE_MANIFEST_VERSION) {
    throw new Error(`Unsupported official release manifest schema: ${String(value.schema_version)}`);
  }
  if (value.provenance !== undefined) assertProvenanceBlock(value.provenance, file);
  if (value.supersedes !== undefined) assertSupersessionBlock(value.supersedes, value.release_id, file);
  if (value.immutability !== undefined) assertImmutabilityBlock(value.immutability, file);
  if (value.assurances !== undefined) assertAssurancesBlock(value, file);
  return value;
}

function assertAssurancesBlock(manifest: ExternalReleaseManifest, file: string): void {
  const invalid = (reason: string): never => {
    throw new Error(`Official release manifest has invalid assurances (${reason}): ${file}`);
  };
  const assurances = manifest.assurances;
  const provenance = manifest.provenance;
  if (!Array.isArray(assurances) || assurances.length === 0) invalid('not a non-empty array');
  if (!provenance) invalid('an official release cannot carry downstream assurances');
  const entries = assurances as ExternalReleaseAssurance[];
  const patch = provenance as ExternalReleaseProvenance;
  const seen = new Set<string>();
  for (const assurance of entries) {
    if (!assurance || typeof assurance !== 'object' || Array.isArray(assurance)) invalid('malformed entry');
    if (assurance.schema_version !== ARC_RELEASE_ASSURANCE_VERSION) invalid('unknown assurance schema');
    if (!ARC_RELEASE_ASSURANCE_IDS.includes(assurance.id)) invalid(`unknown assurance ${String(assurance.id)}`);
    if (seen.has(assurance.id)) invalid(`duplicate assurance ${assurance.id}`);
    seen.add(assurance.id);
    if (
      assurance.commit !== manifest.commit ||
      assurance.source_tree !== manifest.source_tree ||
      assurance.patch_series_sha256 !== patch.series_sha256
    ) {
      invalid(`${assurance.id} is not tied to the sealed commit, tree, and patch series`);
    }
  }
}

function assertSupersessionBlock(
  value: unknown,
  releaseId: unknown,
  file: string,
): asserts value is ExternalReleaseSupersessionRecord {
  const invalid = (reason: string): never => {
    throw new Error(`Official release manifest has an invalid supersession block (${reason}): ${file}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('not an object');
  const block = value as Record<string, unknown>;
  if (typeof block.release_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(block.release_id)) {
    invalid('no safe release id');
  }
  if (block.release_id === releaseId) invalid('a release cannot supersede itself');
  if (typeof block.reason !== 'string' || !block.reason.trim()) invalid('no reason');
}

/** What a sealed release claims about its own permissions, or nothing at all. */
export function releaseImmutability(manifest: ExternalReleaseManifest): ReleaseImmutabilityRecord | null {
  return manifest.immutability ?? null;
}

/** True only when the manifest claims both trees were sealed recursively. */
export function releaseSealsBothTrees(manifest: ExternalReleaseManifest): boolean {
  const record = manifest.immutability;
  if (!record || record.mode !== RELEASE_IMMUTABILITY_MODE) return false;
  return SEALED_TREE_NAMES.every((tree) => record.sealed.includes(tree));
}

/**
 * An immutability block is a checkable claim, so a malformed one is refused
 * rather than read as a weaker claim. A block that named only `source` would
 * otherwise let a release assert immutability while leaving the virtualenv —
 * the half that actually executes — outside the check.
 */
function assertImmutabilityBlock(value: unknown, file: string): asserts value is ReleaseImmutabilityRecord {
  const invalid = (reason: string): never => {
    throw new Error(`Official release manifest has an invalid immutability block (${reason}): ${file}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('not an object');
  const block = value as Record<string, unknown>;
  if (block.mode !== RELEASE_IMMUTABILITY_MODE) invalid(`unknown mode ${String(block.mode)}`);
  if (!Array.isArray(block.sealed) || block.sealed.length === 0) invalid('no sealed trees');
  for (const tree of block.sealed as unknown[]) {
    if (!SEALED_TREE_NAMES.includes(tree as SealedTreeName)) invalid(`unknown sealed tree ${String(tree)}`);
  }
  for (const tree of SEALED_TREE_NAMES) {
    if (!(block.sealed as SealedTreeName[]).includes(tree)) invalid(`the ${tree} tree is not claimed as sealed`);
  }
  const trees = block.trees as Record<string, unknown> | undefined;
  if (!trees || typeof trees !== 'object' || Array.isArray(trees)) invalid('no per-tree census');
  for (const tree of SEALED_TREE_NAMES) {
    const census = trees![tree] as Record<string, unknown> | undefined;
    if (!census || typeof census !== 'object' || Array.isArray(census)) invalid(`no ${tree} census`);
    for (const key of ['files', 'directories', 'interpreter_links'] as const) {
      const count = census![key];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        invalid(`${tree}.${key} is not a count`);
      }
    }
  }
}

/**
 * A provenance block is only ever a disclaimer.
 *
 * It must say `official: false` in a class this driver knows, and must carry
 * the upstream base and patch series that make the claim checkable. Anything
 * else — including a block that asserts `official: true` — is refused, so the
 * only way to be treated as official remains not having a block at all.
 */
function assertProvenanceBlock(value: unknown, file: string): asserts value is ExternalReleaseProvenance {
  const invalid = (reason: string): never => {
    throw new Error(`Official release manifest has an invalid provenance block (${reason}): ${file}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('not an object');
  const block = value as Record<string, unknown>;
  if (block.official !== false) invalid('a release may not certify itself as official');
  if (block.class !== DOWNSTREAM_PATCHED_CANDIDATE) invalid(`unknown class ${String(block.class)}`);
  if (typeof block.patch_source !== 'string' || !block.patch_source.trim()) invalid('no patch source');
  if (typeof block.series_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(block.series_sha256)) {
    invalid('no patch series digest');
  }
  const upstream = block.upstream as Record<string, unknown> | undefined;
  if (!upstream || typeof upstream !== 'object') invalid('no upstream base');
  for (const key of ['repository', 'tag', 'tag_commit', 'base_revision', 'base_source_tree'] as const) {
    if (typeof upstream![key] !== 'string' || !(upstream![key] as string).trim()) invalid(`no upstream ${key}`);
  }
  if (!Array.isArray(block.patch_commits) || block.patch_commits.length === 0) invalid('no patch commits');
  for (const entry of block.patch_commits as unknown[]) {
    const commit = entry as Record<string, unknown> | null;
    if (!commit || typeof commit !== 'object') invalid('a malformed patch commit');
    if (!/^[0-9a-f]{40}$/.test(String(commit!.commit))) invalid('a patch commit that is not a full SHA-1');
    if (!/^[0-9a-f]{40}$/.test(String(commit!.tree))) invalid('a patch commit with no tree');
  }
  if (patchSeriesDigest(block.patch_commits as Array<{ commit: string; tree: string }>) !== block.series_sha256) {
    invalid('the patch series digest does not cover the listed commits');
  }
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(file: string): string {
  return sha256(readFileSync(file));
}

export function normalizeRepository(repository: string): string {
  return repository.trim().replace(/\.git$/, '');
}

export function safeReleaseIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid official release ${label}: ${value}`);
  }
  return value;
}
