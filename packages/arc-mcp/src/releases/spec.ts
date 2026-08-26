/**
 * Immutable official AutoResearchClaw pins.
 *
 * Official AutoResearchClaw stays an independently installed application
 * outside this repository. ARC only records the exact revision it is paired
 * with and refuses to launch anything else. Nothing here knows about MetaClaw,
 * about a research-stack gateway, or about any other product.
 */

export const ARC_MCP_PACKAGE = '@xvirobotics/arc-mcp' as const;
export const ARC_MCP_VERSION = '0.3.0' as const;

export const OFFICIAL_ARC_PRODUCT = 'AutoResearchClaw' as const;
export type OfficialArcProduct = typeof OFFICIAL_ARC_PRODUCT;

/**
 * What a sealed release is allowed to be used for.
 *
 * `mcp-execution` releases are the ones ARC MCP launches, so they must satisfy
 * the downstream compatibility shims in `python/official_compat.py`.
 * `direct-cli` releases exist only so a human can run the exact published tag
 * from a shell; they are never launched by the driver and therefore are not
 * required to accept shims that were audited against a different commit.
 *
 * The claim is recorded in the sealed manifest, so a `direct-cli` release can
 * never be silently promoted into the MCP execution path.
 */
export type ExternalReleaseRole = 'mcp-execution' | 'direct-cli';
export const DEFAULT_EXTERNAL_RELEASE_ROLE: ExternalReleaseRole = 'mcp-execution';

/**
 * Whether a sealed release is upstream code or upstream code plus local patches.
 *
 * `official` is the absence of a claim, not a claim: every manifest sealed
 * before patched candidates existed carries no provenance block and is an
 * official release, so reading this never requires rewriting one. A patched
 * candidate must state `official: false` explicitly, and nothing may state the
 * opposite — a release cannot self-certify as official.
 */
export type ExternalReleaseProvenanceClass = 'official' | 'downstream-patched-candidate';
export const DOWNSTREAM_PATCHED_CANDIDATE = 'downstream-patched-candidate' as const;

/** Machine-checkable behavior claims that a sealed ARC release may carry. */
export const ARC_RELEASE_ASSURANCE_IDS = ['MCLAW-014'] as const;
export type ExternalReleaseAssuranceId = (typeof ARC_RELEASE_ASSURANCE_IDS)[number];

/** One commit applied on top of the upstream base, pinned by commit and tree. */
export interface DownstreamPatchCommit {
  commit: string;
  tree: string;
  subject: string;
}

/**
 * Provenance of a downstream-patched candidate.
 *
 * The patch commits exist in no upstream repository, so a remote URL proves
 * nothing about them. Identity is instead the upstream base they descend from,
 * the exact ordered commit/tree series applied on top, and the resulting tree —
 * all of which are re-derivable from the sealed checkout itself.
 */
export interface DownstreamPatchProvenance {
  /** Always false. A patched candidate is never an official release. */
  official: false;
  class: typeof DOWNSTREAM_PATCHED_CANDIDATE;
  upstream: {
    repository: string;
    tag: string;
    tagCommit: string;
    baseRevision: string;
    baseSourceTree: string;
  };
  patchCommits: readonly DownstreamPatchCommit[];
  /** Digest over the ordered `commit:tree` series; see `patchSeriesDigest`. */
  seriesSha256: string;
  reason: string;
}

/**
 * Append-only link from a release to the one it replaces.
 *
 * A sealed release is evidence, so a correction is a new release id rather than
 * an edit to the record an earlier driver signed. Without a link, the reason
 * two releases of the same revision exist lives only in a commit message, and
 * an operator reading the release root sees two directories and no way to tell
 * which one this driver pins. The link is written into the new manifest and
 * checked against the pin; the superseded release is never touched.
 */
export interface ExternalReleaseSupersession {
  /** Release id this one replaces. It stays installed and verifiable. */
  releaseId: string;
  reason: string;
}

/**
 * Marks a pin as retired in favour of a named replacement.
 *
 * Retired is stronger than merely old: the driver refuses to launch it and a
 * bounded run refuses to select it, so a superseded candidate cannot be the
 * thing an acceptance accidentally runs. It stays installed, nameable and
 * verifiable, because rollback evidence that cannot be verified is not
 * evidence.
 */
export interface ExternalReleaseRetirement {
  /** Name of the replacement in {@link EXTERNAL_RELEASE_SPECS}. */
  specName: string;
  releaseId: string;
  reason: string;
}

/** Exact driver bytes an append-only manifest was sealed against. */
export interface ExternalReleaseDriverHashes {
  bridgeSha256: string;
  compatibilitySha256: string;
}

/** Identity of one pinned official checkout. */
export interface ExternalReleaseIdentity {
  product: OfficialArcProduct;
  repository: string;
  revision: string;
  tag: string;
  version: string;
  /** Optional append-only pairing suffix for the same official revision. */
  releaseIdSuffix?: string;
  /**
   * Present only for a downstream-patched candidate. Its presence is what makes
   * a spec unofficial; there is no boolean to set the other way.
   */
  patch?: DownstreamPatchProvenance;
  /** Release this pin replaces, recorded in the sealed manifest. */
  supersedes?: ExternalReleaseSupersession;
}

export interface ExternalReleaseSpec extends ExternalReleaseIdentity {
  /** Structural invariant proven by the offline probe. */
  stageCount: number;
  acpxVersion: string;
  /**
   * Pinned tree hash. Optional for official releases, whose published tag
   * already anchors identity; required in practice for a patched candidate,
   * which has no tag of its own.
   */
  sourceTree?: string;
  /**
   * Refuses a sealed release that does not record a recursive source *and*
   * virtualenv seal.
   *
   * Not set on the specs that predate virtualenv sealing: their releases are
   * append-only evidence whose permissions may not be rewritten, so requiring
   * a claim they cannot acquire would only make them unverifiable. Every spec
   * pinned since is required to carry it, so stripping the manifest's
   * immutability block cannot be used to skip the check.
   */
  requiresSealedTrees?: boolean;
  /**
   * Exact bridge and compatibility bytes recorded in this release's manifest.
   *
   * A retired pairing cannot be compared to today's driver files: those files
   * are precisely why it was replaced. Pinning the historical hashes keeps the
   * old manifest verifiable without pretending it is still launchable. Active
   * MCP execution pins must match both these hashes and the files on disk.
   */
  driverHashes?: ExternalReleaseDriverHashes;
  /**
   * Reviewed behavior claims copied into the append-only release manifest.
   *
   * The manifest record is tied to the observed commit, source tree, and patch
   * series. A downstream consumer can therefore verify exact code evidence
   * instead of accepting free-form profile prose.
   */
  assurances?: readonly ExternalReleaseAssuranceId[];
  /**
   * Set when a later pin replaced this one. Verification still works, so the
   * release remains usable rollback evidence; launching and bounded selection
   * do not.
   */
  supersededBy?: ExternalReleaseRetirement;
}

/**
 * Refuses a pin that has been retired in favour of a named replacement.
 *
 * Deliberately not applied to verification: a superseded release must stay
 * verifiable or it stops being the rollback asset it was kept for. It is
 * applied everywhere a release would actually be executed or installed.
 */
export function assertReleaseSpecEligible(spec: ExternalReleaseSpec, action: string): void {
  const retirement = spec.supersededBy;
  if (!retirement) return;
  throw new Error(
    `This release pin was superseded by ${retirement.releaseId} and may not be ${action}: ${retirement.reason}. ` +
      `Use '${retirement.specName}' instead; the superseded release stays installed and verifiable as rollback ` +
      'evidence.',
  );
}

const LEGACY_ARC_MCP_DRIVER_HASHES: ExternalReleaseDriverHashes = {
  bridgeSha256: '1323b330e3ab51cea5c55b3ff9f4eb7e955262edc78b0fd4decef30f3510a426',
  compatibilitySha256: 'a51a372573d6313262b976fb1020d1940a2fef501f135f0d331838bc2dbe371a',
};

const HARD_BUDGET_ARC_MCP_DRIVER_HASHES: ExternalReleaseDriverHashes = {
  bridgeSha256: 'f8e6e3a4162f889b457f5f068291536951afd6f5b05aba15a65da9c27d8898d2',
  compatibilitySha256: '35837ecef1b98d217b0fdccdab0a9ce7f7a971afff5b81f459d51d05349d1719',
};

const IMMUTABLE_PAIRING_REASON =
  'The first arc-mcp pairing predates the bounded-execution bridge and recursive virtualenv sealing. ' +
  'The v2 pairing keeps the audited upstream tree but seals both executable trees against the current driver bytes.';

const IMMUTABLE_CANDIDATE_REASON =
  'The first locally patched candidate sealed only its source tree, leaving the virtualenv writable. ' +
  'The v2 candidate preserves that release as evidence and seals both executable trees for bounded acceptance.';

/** Whether a spec describes upstream code or upstream code plus local patches. */
export function specProvenanceClass(spec: Pick<ExternalReleaseIdentity, 'patch'>): ExternalReleaseProvenanceClass {
  return spec.patch ? DOWNSTREAM_PATCHED_CANDIDATE : 'official';
}

/**
 * ARC-009 default for direct shell use: the exact published `v0.5.0` tag.
 *
 * `researchclaw` invoked from a selector must be a release the upstream project
 * actually published, not a later untagged commit that happens to be installed.
 */
export const OFFICIAL_RESEARCHCLAW_TAG_SPEC: ExternalReleaseSpec = {
  product: OFFICIAL_ARC_PRODUCT,
  repository: 'https://github.com/aiming-lab/AutoResearchClaw',
  revision: '12d3fd809fa9658e91a0328c3280a0e462c78386',
  tag: 'v0.5.0',
  version: '0.5.0',
  stageCount: 23,
  acpxVersion: '0.13.0',
  // The already-installed exact-tag release predates the current bridge. It is
  // a direct CLI rollback asset, so its historical hashes remain its identity.
  driverHashes: LEGACY_ARC_MCP_DRIVER_HASHES,
};

/**
 * The commit the MCP compatibility shims were audited against.
 *
 * `python/official_compat.py` rewrites four precisely audited official function
 * bodies. Those shapes were verified at `e2e23c9`, which is `v0.5.0-45`, so ARC
 * MCP execution stays pinned here until the shims are re-audited against a
 * newer tag. It is deliberately a separate release id from the tag spec: both
 * can be sealed side by side and neither is presented as the other.
 */
export const OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC: ExternalReleaseSpec = {
  ...OFFICIAL_RESEARCHCLAW_TAG_SPEC,
  revision: 'e2e23c93b4943fd21cc531deb09850d8fda55357',
  // The historical release id at this revision is paired to the retired
  // adapter and must not be rewritten. Seal the arc-mcp pairing side by side.
  releaseIdSuffix: 'arc-mcp-0.3.0',
  driverHashes: LEGACY_ARC_MCP_DRIVER_HASHES,
  supersededBy: {
    specName: 'mcp-execution',
    releaseId: '0.5.0-e2e23c93b494-arc-mcp-0.3.0-v2',
    reason: IMMUTABLE_PAIRING_REASON,
  },
};

/** Current audited MCP pairing, append-only beside the historical pairing. */
export const OFFICIAL_RESEARCHCLAW_COMPAT_SPEC: ExternalReleaseSpec = {
  ...OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC,
  releaseIdSuffix: 'arc-mcp-0.3.0-v2',
  driverHashes: HARD_BUDGET_ARC_MCP_DRIVER_HASHES,
  requiresSealedTrees: true,
  supersedes: {
    releaseId: '0.5.0-e2e23c93b494-arc-mcp-0.3.0',
    reason: IMMUTABLE_PAIRING_REASON,
  },
  supersededBy: undefined,
};

/** The spec ARC MCP executes. Direct CLI selection uses the tag spec instead. */
export const OFFICIAL_RESEARCHCLAW_SPEC = OFFICIAL_RESEARCHCLAW_COMPAT_SPEC;

/**
 * The ARC-011 hard budget guard, as a downstream-patched candidate.
 *
 * ARC-006 cannot honestly claim a mechanically enforced ceiling while the
 * revision that spends the money predates the guard. The guard is upstreamable
 * and proposed upstream on its own branch, but until upstream accepts and tags
 * it there is no official release that enforces anything — so the only truthful
 * way to run a bounded acceptance is against a release that says, in its own
 * sealed manifest, that it is not official.
 *
 * `repository` records the upstream lineage. It is deliberately *not* the fetch
 * source: the three patch commits exist only in a local staging repository, so
 * the operator names that source at install time and the sealed manifest
 * records what was actually observed.
 */
export const ARC_HARD_BUDGET_CANDIDATE_V1_SPEC: ExternalReleaseSpec = {
  product: OFFICIAL_ARC_PRODUCT,
  repository: 'https://github.com/aiming-lab/AutoResearchClaw',
  revision: '8fa6d66d1b8f76b11b7f79b766b250d72bce9228',
  tag: 'v0.5.0',
  version: '0.5.0',
  stageCount: 23,
  acpxVersion: '0.13.0',
  sourceTree: 'c30b47983e7cd20ab7b965f321022f7d902d3d2f',
  releaseIdSuffix: 'hard-budget-guard',
  driverHashes: HARD_BUDGET_ARC_MCP_DRIVER_HASHES,
  patch: {
    official: false,
    class: DOWNSTREAM_PATCHED_CANDIDATE,
    upstream: {
      repository: 'https://github.com/aiming-lab/AutoResearchClaw',
      tag: 'v0.5.0',
      tagCommit: '12d3fd809fa9658e91a0328c3280a0e462c78386',
      // The audited MCP-execution commit, so the compatibility shims this
      // driver rewrites keep the exact function shapes they were audited on.
      baseRevision: 'e2e23c93b4943fd21cc531deb09850d8fda55357',
      baseSourceTree: 'df6b145fc5abf7005cf157386492bc26d010ba8c',
    },
    patchCommits: [
      {
        commit: '22236ff1522d1ddbdfc31abbdc4981b4dab6466e',
        tree: 'e915267836fc33d6e03d4aec4d928624b06aa0bc',
        subject: 'feat(budget): add a pre-dispatch hard cost, call and token guard',
      },
      {
        commit: '55b144e32a6398bb547a91c810dba9f88c544c2c',
        tree: '80e3eb05a2f3cbdde0d8950c972b48ff0522b88f',
        subject: 'feat(budget): bound every LLM dispatch, fallback and preflight',
      },
      {
        commit: '8fa6d66d1b8f76b11b7f79b766b250d72bce9228',
        tree: 'c30b47983e7cd20ab7b965f321022f7d902d3d2f',
        subject: 'fix(budget): close the gaps where the ceiling was claimed but not enforced',
      },
    ],
    seriesSha256: 'cca1113f655cab1e48329a4c74efbecaec517df3ce411069dce50a5dfa035298',
    reason:
      'ARC-011 hard budget guard, proposed upstream on feature/hard-budget-guard-20260817 and ' +
      'not yet accepted or tagged. Sealed only so a bounded ARC-006 acceptance can be run ' +
      'against a revision that provably refuses unbounded billable dispatch.',
  },
  supersededBy: {
    specName: 'hard-budget-candidate',
    releaseId: 'unofficial-0.5.0-8fa6d66d1b8f-hard-budget-guard-v2',
    reason: IMMUTABLE_CANDIDATE_REASON,
  },
};

/** Bounded-acceptance candidate with both executable trees recursively sealed. */
export const ARC_HARD_BUDGET_CANDIDATE_SPEC: ExternalReleaseSpec = {
  ...ARC_HARD_BUDGET_CANDIDATE_V1_SPEC,
  releaseIdSuffix: 'hard-budget-guard-v2',
  requiresSealedTrees: true,
  supersedes: {
    releaseId: 'unofficial-0.5.0-8fa6d66d1b8f-hard-budget-guard',
    reason: IMMUTABLE_CANDIDATE_REASON,
  },
  supersededBy: undefined,
};

/**
 * ARC-011 plus the independently reviewed MCLAW-014 bridge contract.
 *
 * This remains an explicit official=false candidate. It does not replace the
 * ordinary hard-budget candidate, because ARC runs that do not use MetaClaw
 * have no reason to inherit a cross-product acceptance claim.
 */
export const ARC_MCLAW014_CANDIDATE_SPEC: ExternalReleaseSpec = {
  ...ARC_HARD_BUDGET_CANDIDATE_SPEC,
  revision: 'bd01d84bbe30084fad6fc9b1f39d6a881ae9b92c',
  sourceTree: '7bf4606974ab50b3c71686f28288e2ca4afc592c',
  releaseIdSuffix: 'hard-budget-mclaw014',
  patch: {
    ...ARC_HARD_BUDGET_CANDIDATE_SPEC.patch!,
    patchCommits: [
      ...ARC_HARD_BUDGET_CANDIDATE_SPEC.patch!.patchCommits,
      {
        commit: 'bd01d84bbe30084fad6fc9b1f39d6a881ae9b92c',
        tree: '7bf4606974ab50b3c71686f28288e2ca4afc592c',
        subject: 'fix(metaclaw): harden ARC bridge sessions (MCLAW-014)',
      },
    ],
    seriesSha256: '6ffebffc277184962a9206f4ddb89cb9c7510a6a0662734cf7a7795d6a86db6b',
    reason:
      'ARC-011 hard budget enforcement plus the reviewed MCLAW-014 authenticated side-turn isolation contract. ' +
      'The branch is not an upstream tag and remains an explicitly labelled downstream-patched candidate.',
  },
  assurances: ['MCLAW-014'],
  supersedes: undefined,
  supersededBy: undefined,
};

/** Every spec an operator may name, keyed by the release-CLI argument. */
export const EXTERNAL_RELEASE_SPECS = {
  'direct-cli': OFFICIAL_RESEARCHCLAW_TAG_SPEC,
  'mcp-execution': OFFICIAL_RESEARCHCLAW_COMPAT_SPEC,
  'hard-budget-candidate': ARC_HARD_BUDGET_CANDIDATE_SPEC,
  'mclaw014-candidate': ARC_MCLAW014_CANDIDATE_SPEC,
  'mcp-execution-v1': OFFICIAL_RESEARCHCLAW_COMPAT_V1_SPEC,
  'hard-budget-candidate-v1': ARC_HARD_BUDGET_CANDIDATE_V1_SPEC,
} as const satisfies Record<string, ExternalReleaseSpec>;

export type ExternalReleaseSpecName = keyof typeof EXTERNAL_RELEASE_SPECS;

/**
 * Own-property lookup only. A plain index would resolve `constructor`,
 * `toString` and every other `Object.prototype` key to a truthy non-spec,
 * which then reaches release identity as an object with no revision instead
 * of being rejected as the unknown name it is.
 */
export function releaseSpecByName(name: string): ExternalReleaseSpec | undefined {
  if (!Object.hasOwn(EXTERNAL_RELEASE_SPECS, name)) return undefined;
  return EXTERNAL_RELEASE_SPECS[name as ExternalReleaseSpecName];
}

/**
 * Role each pinned spec is sealed and verified under.
 *
 * The candidate is an MCP-execution release: the driver is the only thing that
 * may launch it. That is not a promotion — being launchable and being the
 * production `current` release are separate gates, and a patched candidate
 * fails the second one by construction.
 */
export function specRole(spec: Pick<ExternalReleaseIdentity, 'revision' | 'patch'>): ExternalReleaseRole {
  if (spec.patch) return 'mcp-execution';
  return spec.revision === OFFICIAL_RESEARCHCLAW_COMPAT_SPEC.revision ? 'mcp-execution' : 'direct-cli';
}

export function defaultReleaseRoot(homeDir: string): string {
  return `${homeDir}/.local/opt/research-stack/autoresearchclaw`;
}
