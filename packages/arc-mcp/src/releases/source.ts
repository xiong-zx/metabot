import { existsSync, lstatSync } from 'node:fs';

import { normalizeRepository, patchSeriesDigest, safeReleaseIdentifier } from './manifest.js';
import type { DownstreamPatchProvenance, ExternalReleaseIdentity, ExternalReleaseSpec } from './spec.js';

/** Result of one external command executed on behalf of the release machinery. */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type ExecuteCommand = (command: string, args: string[]) => CommandResult;

/**
 * Message shapes differ between the install-time layout check and the
 * launch-time runtime guard, so both call sites keep their own wording while
 * sharing one implementation of the checks themselves.
 */
export interface SourceVerificationLabels {
  subject: string;
  revisionMismatch(expected: string, actual: string): string;
}

export interface VerifiedSourceRevision {
  /** Observed git remote, recorded even when it is not the pinned identity. */
  origin: string;
  revision: string;
  sourceTree: string;
}

export interface VerifiedSourceDescription {
  describe: string;
  baseTag: string;
  baseTagCommit: string;
}

/**
 * Origin, exact revision, detachment, and cleanliness of the official checkout.
 * Every release ARC seals or launches must satisfy this.
 *
 * A downstream-patched candidate is the one exception to the origin pin: its
 * commits exist in no upstream repository, so it is necessarily fetched from a
 * local staging clone whose URL is a machine-local path. Pinning that path
 * would prove nothing and would make the release un-verifiable on any other
 * host, so the URL is recorded and the identity is carried instead by the
 * pinned tree and the patch series, which `verifyPatchSeries` re-derives from
 * the checkout itself.
 */
export function verifyDetachedSourceRevision(
  source: string,
  spec: Pick<ExternalReleaseIdentity, 'repository' | 'revision' | 'patch'> & Pick<ExternalReleaseSpec, 'sourceTree'>,
  execute: ExecuteCommand,
  labels: SourceVerificationLabels,
): VerifiedSourceRevision {
  const origin = requireOutput(execute('git', ['-C', source, 'remote', 'get-url', 'origin']), 'git origin');
  if (!spec.patch && normalizeRepository(origin) !== normalizeRepository(spec.repository)) {
    throw new Error(`Official ${labels.subject} has an unexpected origin: ${origin}`);
  }
  const revision = requireOutput(execute('git', ['-C', source, 'rev-parse', 'HEAD']), 'git revision');
  if (revision !== spec.revision) throw new Error(labels.revisionMismatch(spec.revision, revision));
  const symbolic = execute('git', ['-C', source, 'symbolic-ref', '-q', 'HEAD']);
  if (symbolic.status === 0) throw new Error(`Official ${labels.subject} must be detached`);
  const dirty = requireOutput(
    execute('git', ['-C', source, 'status', '--porcelain', '--untracked-files=all']),
    'git status',
  );
  if (dirty) throw new Error(`Official ${labels.subject} is dirty`);
  const sourceTree = requireOutput(execute('git', ['-C', source, 'rev-parse', 'HEAD^{tree}']), 'git source tree');
  if (spec.sourceTree && sourceTree !== spec.sourceTree) {
    throw new Error(`Official ${labels.subject} tree mismatch: expected ${spec.sourceTree}, got ${sourceTree}`);
  }
  return { origin, revision, sourceTree };
}

/**
 * Re-derives a patched candidate's identity from the checkout.
 *
 * The pinned revision alone does not say what was patched onto what. This does:
 * the upstream base must be an ancestor with the tree it had upstream, the
 * commits between base and HEAD must be exactly the declared series in order —
 * so a fourth commit cannot be slipped in, and one cannot be dropped — each
 * with the tree the spec recorded, and the digest must cover that series.
 */
export function verifyPatchSeries(
  source: string,
  patch: DownstreamPatchProvenance,
  revision: string,
  execute: ExecuteCommand,
): void {
  const declared = patch.patchCommits;
  if (patchSeriesDigest(declared) !== patch.seriesSha256) {
    throw new Error('Patched candidate spec digest does not cover its own declared patch series');
  }
  const base = patch.upstream.baseRevision;
  requireSuccess(
    execute('git', ['-C', source, 'merge-base', '--is-ancestor', base, revision]),
    `patched candidate upstream base ${base} ancestry`,
  );
  const baseTree = requireOutput(execute('git', ['-C', source, 'rev-parse', `${base}^{tree}`]), 'git base tree');
  if (baseTree !== patch.upstream.baseSourceTree) {
    throw new Error(
      `Patched candidate upstream base tree mismatch: expected ${patch.upstream.baseSourceTree}, got ${baseTree}`,
    );
  }
  const applied = requireOutput(
    execute('git', ['-C', source, 'rev-list', '--reverse', `${base}..${revision}`]),
    'git patch series',
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const expected = declared.map((entry) => entry.commit);
  if (applied.length !== expected.length || applied.some((commit, index) => commit !== expected[index])) {
    throw new Error(
      `Patched candidate applies a different commit series: expected ${expected.join(', ')}, got ${
        applied.join(', ') || 'none'
      }`,
    );
  }
  for (const entry of declared) {
    const tree = requireOutput(
      execute('git', ['-C', source, 'rev-parse', `${entry.commit}^{tree}`]),
      `git patch commit tree ${entry.commit}`,
    );
    if (tree !== entry.tree) {
      throw new Error(`Patched candidate commit ${entry.commit} has tree ${tree}, expected ${entry.tree}`);
    }
    // The subject is the only part of the series a human actually reads, in
    // the manifest and in an operator's install report. Verified here so it
    // describes the commit that is present rather than whatever the spec was
    // written to say about it; an unverified subject is not identity.
    const subject = requireOutput(
      execute('git', ['-C', source, 'log', '-1', '--format=%s', entry.commit]),
      `git patch commit subject ${entry.commit}`,
    );
    if (subject !== entry.subject.trim()) {
      throw new Error(
        `Patched candidate commit ${entry.commit} has subject ${JSON.stringify(subject)}, expected ${JSON.stringify(
          entry.subject,
        )}`,
      );
    }
  }
}

/** Tag provenance: the pinned tag must exist and be an ancestor of the pinned revision. */
export function verifySourceDescription(
  source: string,
  spec: Pick<ExternalReleaseIdentity, 'tag'>,
  revision: string,
  execute: ExecuteCommand,
): VerifiedSourceDescription {
  const describe = requireOutput(
    execute('git', ['-C', source, 'describe', '--tags', '--always', 'HEAD']),
    'git describe',
  );
  const configuredTag = safeReleaseIdentifier(spec.tag, 'release tag');
  const baseTag = requireOutput(
    execute('git', ['-C', source, 'describe', '--tags', '--abbrev=0', 'HEAD']),
    'git base tag',
  );
  if (baseTag !== configuredTag) {
    throw new Error(`Official base tag mismatch: expected ${configuredTag}, got ${baseTag}`);
  }
  const baseTagCommit = requireOutput(
    execute('git', ['-C', source, 'rev-parse', `refs/tags/${configuredTag}^{commit}`]),
    'git base tag commit',
  );
  requireSuccess(
    execute('git', ['-C', source, 'merge-base', '--is-ancestor', baseTagCommit, revision]),
    'git base tag ancestry',
  );
  return { describe, baseTag, baseTagCommit };
}

export function assertPlainDirectory(directory: string, label: string): void {
  if (!existsSync(directory)) throw new Error(`Official ${label} is missing: ${directory}`);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe official ${label}: ${directory}`);
}

export function requireSuccess(result: CommandResult, label: string): void {
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status ?? 'unknown'}`}`);
  }
}

export function requireOutput(result: CommandResult, label: string): string {
  requireSuccess(result, label);
  return result.stdout.trim();
}

/** Deterministic, sorted dependency freeze so the sealed digest is reproducible. */
export function normalizeFreeze(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return lines.length ? `${lines.join('\n')}\n` : '';
}
