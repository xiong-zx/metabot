import { createHash } from 'node:crypto';
import { constants, lstatSync, readFileSync, type Dirent, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { MetaClawError } from './errors.js';
import {
  createLocalReadBudget,
  LocalReadBudget,
  LocalReadLimitError,
  type LocalReadBudgetOptions,
  type LocalReadTruncation,
} from './local-read.js';

/**
 * `official` is provenance, never a quality inference. A downstream-patched
 * candidate remains `official:false`, even when it is the safer build.
 * Integrity is re-read per call because drift after startup is the case that
 * matters.
 */

const MAX_RELEASE_MANIFEST_BYTES = 32 * 1024 * 1024;
const CANDIDATE_IDENTITY = Object.freeze({
  releaseId: '0.4.1+mcpsec.2-396ff44',
  version: '0.4.1',
  tag: 'v0.4.1',
  commit: '396ff44f375ca5273f20bcd33a7611a03e003d20',
  repository: 'https://github.com/aiming-lab/MetaClaw',
  tagCommit: 'aea4f3382d561ed0718a7419bba13616663d67a9',
  baseCommit: '922caf3a1cd093fb316e95183a8acc8aa47b3b21',
  baseTree: '936c50f8989755e76999da6a86422c12500ba5ab',
  patchCount: 24,
  seriesSha256: '11ca1d37a468c24b3f5505aa08300fa7564037adcdc38cfd6acab8e987c7882b',
  resultTree: 'c71609f3696e93661895a41f0d12e1c22d7e22a2',
  integrationVersion: '0.1.0',
});
const SUPERSESSION_REASON =
  'Replaced append-only by the non-editable, recursively sealed official=false security candidate; old evidence is not rewritten.';

const absolutePath = z.string().refine((value) => path.isAbsolute(value), {
  message: 'must be an absolute path',
});

const manifestMode = z.string().regex(/^0[45][0-7]{2}$/);
const manifestFileSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    mode: manifestMode.optional(),
  })
  .strict();
const manifestDirectorySchema = z.object({ path: z.string().min(1).max(1_024), mode: manifestMode }).strict();
const patchSchema = z
  .object({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    tree: z.string().regex(/^[0-9a-f]{40}$/),
    subject: z.string().min(1).max(500),
  })
  .strict();

export const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseId: z.string().min(1).max(200),
    product: z.literal('MetaClaw').optional(),
    version: z.string().min(1).max(120).optional(),
    official: z.boolean(),
    state: z.enum(['official_release', 'downstream_patched_candidate']),
    tag: z.string().min(1).max(120),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    root: absolutePath,
    files: z.array(manifestFileSchema).min(1).max(100_000),
    directories: z.array(manifestDirectorySchema).max(100_000).optional(),
    provenance: z
      .object({
        official: z.literal(false),
        class: z.literal('downstream_patched_candidate'),
        sourcePath: absolutePath,
        upstream: z
          .object({
            repository: z.string().url(),
            tag: z.string().min(1),
            tagCommit: z.string().regex(/^[0-9a-f]{40}$/),
            baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
            baseTree: z.string().regex(/^[0-9a-f]{40}$/),
          })
          .strict(),
        patches: z.array(patchSchema).min(1).max(1_000),
        seriesSha256: z.string().regex(/^[0-9a-f]{64}$/),
        resultTree: z.string().regex(/^[0-9a-f]{40}$/),
        installedSourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .optional(),
    build: z
      .object({
        format: z.literal('wheel'),
        wheelFile: z.string().min(1).max(1_024),
        wheelSha256: z.string().regex(/^[0-9a-f]{64}$/),
        editable: z.literal(false),
        sourceDateEpoch: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    dependencies: z
      .object({
        freezeFile: z.string().min(1).max(1_024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        entries: z.number().int().positive(),
        pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        source: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('pip_resolved') }).strict(),
          z
            .object({
              kind: z.literal('seeded_official_v0.4.1'),
              venvPath: absolutePath,
              excludedEditable: z.tuple([
                z.literal('metaclaw'),
                z.literal('aiming_metaclaw-0.4.1.dist-info'),
                z.literal('__editable__*'),
              ]),
            })
            .strict(),
        ]),
      })
      .strict()
      .optional(),
    immutability: z
      .object({
        mode: z.literal('recursive_read_only'),
        rootMode: z.literal('0555'),
        roots: z.tuple([z.literal('source'), z.literal('venv')]),
        consoleScript: z.string().min(1).max(1_024),
      })
      .strict()
      .optional(),
    integration: z
      .object({ package: z.literal('@xvirobotics/metaclaw-mcp'), version: z.string().min(1).max(120) })
      .strict()
      .optional(),
    supersedes: z
      .object({
        releaseId: z.literal('0.4.1-aea4f3382d56'),
        manifestPath: absolutePath,
        manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
        reason: z.string().min(1).max(2_000),
      })
      .strict()
      .optional(),
    limitations: z.array(z.string().min(1).max(2_000)).min(1).max(100).optional(),
    priorCandidate: z
      .object({
        releaseId: z.literal('0.4.1+mcpsec.1-396ff44'),
        manifestPath: absolutePath,
        manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
        reason: z.string().min(1).max(2_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.official === (value.state === 'official_release'), {
    message: 'official must agree with state',
  })
  .refine((value) => new Set(value.files.map((file) => file.path)).size === value.files.length, {
    message: 'release manifest paths must be unique',
  })
  .refine((value) => value.files.every((file) => isSafeManifestPath(file.path)), {
    message: 'release manifest paths must be normalized relative paths',
  })
  .refine(
    (value) => {
      const normalized = value.files.map((file) => normalizeManifestPath(file.path));
      return new Set(normalized).size === normalized.length;
    },
    {
      message: 'release manifest paths must be unique after normalization',
    },
  )
  .refine(
    (value) => {
      if (value.state !== 'downstream_patched_candidate' || !value.provenance || !value.integration) return true;
      const upstream = value.provenance.upstream;
      return (
        value.releaseId === CANDIDATE_IDENTITY.releaseId &&
        value.product === 'MetaClaw' &&
        value.version === CANDIDATE_IDENTITY.version &&
        value.tag === CANDIDATE_IDENTITY.tag &&
        value.commit === CANDIDATE_IDENTITY.commit &&
        upstream.repository === CANDIDATE_IDENTITY.repository &&
        upstream.tag === CANDIDATE_IDENTITY.tag &&
        upstream.tagCommit === CANDIDATE_IDENTITY.tagCommit &&
        upstream.baseCommit === CANDIDATE_IDENTITY.baseCommit &&
        upstream.baseTree === CANDIDATE_IDENTITY.baseTree &&
        value.provenance.patches.length === CANDIDATE_IDENTITY.patchCount &&
        value.provenance.seriesSha256 === CANDIDATE_IDENTITY.seriesSha256 &&
        value.provenance.resultTree === CANDIDATE_IDENTITY.resultTree &&
        value.integration.version === CANDIDATE_IDENTITY.integrationVersion &&
        value.supersedes?.reason === SUPERSESSION_REASON &&
        value.directories?.some((entry) => entry.path === 'source') === true &&
        value.directories?.some((entry) => entry.path === 'venv') === true &&
        value.files.some((entry) => entry.path.startsWith('source/')) &&
        value.files.some((entry) => entry.path.startsWith('venv/'))
      );
    },
    { message: 'downstream candidate identity does not match the reviewed MCLAW-011 security series' },
  )
  .refine((value) => (value.directories ?? []).every((entry) => isSafeManifestPath(entry.path)), {
    message: 'release manifest directory paths must be normalized relative paths',
  })
  .refine(
    (value) => new Set((value.directories ?? []).map((entry) => entry.path)).size === (value.directories ?? []).length,
    {
      message: 'release manifest directory paths must be unique',
    },
  )
  .refine(
    (value) => {
      if (value.state !== 'downstream_patched_candidate') return true;
      return Boolean(
        value.product === 'MetaClaw' &&
        value.version &&
        value.directories &&
        value.provenance &&
        value.build &&
        value.dependencies &&
        value.immutability &&
        value.integration &&
        value.supersedes &&
        value.limitations &&
        value.files.every((file) => file.mode),
      );
    },
    {
      message:
        'downstream candidate requires complete provenance, wheel, freeze, immutability, integration, supersession and limitations evidence',
    },
  )
  .refine(
    (value) => {
      if (!value.provenance) return true;
      const serialized = value.provenance.patches.map((entry) => `${entry.commit}:${entry.tree}\n`).join('');
      return createHash('sha256').update(serialized).digest('hex') === value.provenance.seriesSha256;
    },
    {
      message: 'downstream patch series digest must cover the ordered commits and trees',
    },
  );

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export type DriftReason =
  | 'missing'
  | 'not_regular_file'
  | 'symlink'
  | 'size_mismatch'
  | 'digest_mismatch'
  | 'mode_mismatch'
  | 'writable'
  | 'changed_during_read'
  | 'escapes_root'
  | 'unlisted';

export interface ReleaseDrift {
  readonly path: string;
  readonly reason: DriftReason;
}

export interface ReleaseIntegrity {
  readonly releaseId: string;
  readonly official: boolean;
  readonly state: ReleaseManifest['state'];
  readonly tag: string;
  readonly commit: string;
  readonly fileCount: number;
  readonly checkedFileCount: number;
  readonly observedEntryCount: number;
  readonly bytesRead: number;
  readonly complete: boolean;
  readonly truncation: LocalReadTruncation | null;
  readonly ok: boolean;
  readonly drift: readonly ReleaseDrift[];
}

export interface VerifyReleaseIntegrityOptions extends LocalReadBudgetOptions {
  readonly budget?: LocalReadBudget;
}

export function loadReleaseManifest(manifestPath: string): ReleaseManifest {
  if (!path.isAbsolute(manifestPath)) {
    throw new MetaClawError('Release manifest path must be absolute', 'profile_invalid', { manifestPath });
  }
  let info;
  try {
    info = lstatSync(manifestPath);
  } catch {
    throw new MetaClawError('Release manifest is missing or unreadable', 'profile_invalid', { manifestPath });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new MetaClawError('Release manifest is not a regular file', 'profile_invalid', { manifestPath });
  }
  if (info.size > MAX_RELEASE_MANIFEST_BYTES) {
    throw new MetaClawError('Release manifest exceeds its startup byte bound', 'profile_invalid', {
      maxBytes: MAX_RELEASE_MANIFEST_BYTES,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new MetaClawError('Release manifest is not valid JSON', 'profile_invalid', { manifestPath });
  }
  const result = releaseManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new MetaClawError('Release manifest does not match the pinned schema', 'profile_invalid', {
      manifestPath,
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  if (result.data.state === 'downstream_patched_candidate' && (info.mode & 0o222) !== 0) {
    throw new MetaClawError('Downstream candidate manifest must be read-only', 'profile_invalid', { manifestPath });
  }
  if (result.data.state === 'downstream_patched_candidate') verifyLinkedManifestEvidence(result.data);
  return result.data;
}

export function verifyLinkedManifestEvidence(manifest: ReleaseManifest): void {
  if (manifest.state !== 'downstream_patched_candidate' || !manifest.supersedes) return;
  verifyEvidenceDigest(
    manifest.supersedes.manifestPath,
    manifest.supersedes.manifestSha256,
    'superseded official v0.4.1 manifest',
  );
  if (manifest.priorCandidate) {
    verifyEvidenceDigest(
      manifest.priorCandidate.manifestPath,
      manifest.priorCandidate.manifestSha256,
      'prior downstream candidate manifest',
      true,
    );
  }
}

/**
 * Verify both halves of a sealed release: every listed byte must match, and
 * every on-disk leaf must be listed. The walk and hashing share one entry,
 * byte, and wall-clock budget; an incomplete scan is integrity failure, never
 * a partial success.
 */
export async function verifyReleaseIntegrity(
  manifest: ReleaseManifest,
  options: VerifyReleaseIntegrityOptions,
): Promise<ReleaseIntegrity> {
  const budget = options.budget ?? createLocalReadBudget(options);
  const startedEntries = budget.entries;
  const startedBytes = budget.bytes;
  const drift: ReleaseDrift[] = [];
  let checkedFileCount = 0;
  let truncation: LocalReadTruncation | null = null;
  let canonicalRoot: string;
  try {
    const declaredRoot = await budget.race(lstat(manifest.root));
    if (declaredRoot.isSymbolicLink()) {
      return result(manifest, checkedFileCount, budget, startedEntries, startedBytes, truncation, [
        { path: '.', reason: 'symlink' },
      ]);
    }
    if (!declaredRoot.isDirectory()) {
      return result(manifest, checkedFileCount, budget, startedEntries, startedBytes, truncation, [
        { path: '.', reason: 'not_regular_file' },
      ]);
    }
    canonicalRoot = await budget.race(realpath(manifest.root));
  } catch (error) {
    if (error instanceof LocalReadLimitError) truncation = error.toTruncation();
    return result(
      manifest,
      checkedFileCount,
      budget,
      startedEntries,
      startedBytes,
      truncation,
      manifest.files.map((file) => ({ path: file.path, reason: 'missing' as const })),
    );
  }

  try {
    const observed = await walkLeaves(canonicalRoot, budget);
    const listed = listedPathsAndParents([
      ...manifest.files.map((file) => file.path),
      ...(manifest.directories ?? []).map((directory) => directory.path),
    ]);
    for (const [relative, entry] of [...observed.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (entry.isSymbolicLink()) {
        if (!listed.has(relative)) drift.push({ path: relative, reason: 'symlink' });
      } else if (!entry.isFile() && !entry.isDirectory()) drift.push({ path: relative, reason: 'not_regular_file' });
      else if (!listed.has(relative)) drift.push({ path: relative, reason: 'unlisted' });
    }

    for (const file of manifest.files) {
      budget.checkpoint();
      const relative = normalizeManifestPath(file.path);
      const target = path.resolve(canonicalRoot, file.path);
      if (!isWithin(canonicalRoot, target)) {
        drift.push({ path: file.path, reason: 'escapes_root' });
        continue;
      }
      let before;
      try {
        before = await budget.race(lstat(target));
      } catch (error) {
        if (error instanceof LocalReadLimitError) throw error;
        drift.push({ path: file.path, reason: 'missing' });
        continue;
      }
      if (before.isSymbolicLink()) {
        drift.push({ path: file.path, reason: 'symlink' });
        continue;
      }
      if (!before.isFile()) {
        drift.push({ path: file.path, reason: 'not_regular_file' });
        continue;
      }
      if (!observed.has(relative)) {
        drift.push({ path: file.path, reason: 'missing' });
        continue;
      }
      if (before.size !== file.bytes) {
        drift.push({ path: file.path, reason: 'size_mismatch' });
        continue;
      }
      if (file.mode) {
        const actualMode = before.mode & 0o7777;
        if ((actualMode & 0o222) !== 0) drift.push({ path: file.path, reason: 'writable' });
        else if (actualMode.toString(8).padStart(4, '0') !== file.mode) {
          drift.push({ path: file.path, reason: 'mode_mismatch' });
        }
      }
      const digest = await digestFile(target, before, budget);
      checkedFileCount += 1;
      if (digest === null) drift.push({ path: file.path, reason: 'changed_during_read' });
      else if (digest !== file.sha256) drift.push({ path: file.path, reason: 'digest_mismatch' });
    }
    for (const directory of manifest.directories ?? []) {
      budget.checkpoint();
      const target = path.resolve(canonicalRoot, directory.path);
      let info;
      try {
        info = await budget.race(lstat(target));
      } catch (error) {
        if (error instanceof LocalReadLimitError) throw error;
        drift.push({ path: directory.path, reason: 'missing' });
        continue;
      }
      if (info.isSymbolicLink()) drift.push({ path: directory.path, reason: 'symlink' });
      else if (!info.isDirectory()) drift.push({ path: directory.path, reason: 'not_regular_file' });
      else if ((info.mode & 0o222) !== 0) drift.push({ path: directory.path, reason: 'writable' });
      else if ((info.mode & 0o7777).toString(8).padStart(4, '0') !== directory.mode) {
        drift.push({ path: directory.path, reason: 'mode_mismatch' });
      }
    }
    if (manifest.immutability) {
      const rootInfo = await budget.race(lstat(canonicalRoot));
      if ((rootInfo.mode & 0o222) !== 0) drift.push({ path: '.', reason: 'writable' });
      else if ((rootInfo.mode & 0o7777).toString(8).padStart(4, '0') !== manifest.immutability.rootMode) {
        drift.push({ path: '.', reason: 'mode_mismatch' });
      }
    }
  } catch (error) {
    if (error instanceof LocalReadLimitError) truncation = error.toTruncation();
    else throw error;
  }

  return result(manifest, checkedFileCount, budget, startedEntries, startedBytes, truncation, drift);
}

export function assertReleaseIntact(integrity: ReleaseIntegrity): void {
  if (integrity.ok) return;
  const driftLimit = 20;
  throw new MetaClawError(`Release ${integrity.releaseId} no longer matches its manifest`, 'integrity_drift', {
    releaseId: integrity.releaseId,
    complete: integrity.complete,
    truncation: integrity.truncation,
    drift: integrity.drift.slice(0, driftLimit),
    driftCount: integrity.drift.length,
    driftTruncated: integrity.drift.length > driftLimit,
  });
}

async function walkLeaves(root: string, budget: LocalReadBudget): Promise<Map<string, Dirent>> {
  const entries = new Map<string, Dirent>();
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.shift()!;
    const directoryPath = path.join(root, relativeDirectory);
    const handle = await budget.race(opendir(directoryPath));
    try {
      for (;;) {
        const entry = await budget.race(handle.read());
        if (entry === null) break;
        budget.consumeEntry();
        budget.consumeBytes(Buffer.byteLength(entry.name, 'utf8'));
        const relative = path.join(relativeDirectory, entry.name);
        entries.set(relative, entry);
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(relative);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return entries;
}

async function digestFile(target: string, before: Stats, budget: LocalReadBudget): Promise<string | null> {
  budget.consumeBytes(before.size);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await budget.race(open(target, constants.O_RDONLY | noFollow));
  try {
    const opened = await budget.race(handle.stat());
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, opened.size)));
    let position = 0;
    while (position < opened.size) {
      budget.checkpoint();
      const length = Math.min(buffer.length, opened.size - position);
      const read = await budget.race(handle.read(buffer, 0, length, position));
      if (read.bytesRead === 0) return null;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await budget.race(handle.stat());
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ino !== opened.ino) return null;
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function result(
  manifest: ReleaseManifest,
  checkedFileCount: number,
  budget: LocalReadBudget,
  startedEntries: number,
  startedBytes: number,
  truncation: LocalReadTruncation | null,
  drift: readonly ReleaseDrift[],
): ReleaseIntegrity {
  const complete = truncation === null;
  return {
    releaseId: manifest.releaseId,
    official: manifest.official,
    state: manifest.state,
    tag: manifest.tag,
    commit: manifest.commit,
    fileCount: manifest.files.length,
    checkedFileCount,
    observedEntryCount: budget.entries - startedEntries,
    bytesRead: budget.bytes - startedBytes,
    complete,
    truncation,
    ok: complete && drift.length === 0 && checkedFileCount === manifest.files.length,
    drift,
  };
}

function normalizeManifestPath(value: string): string {
  return path.normalize(value).split(path.sep).join('/');
}

function isSafeManifestPath(value: string): boolean {
  if (value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || path.win32.isAbsolute(value))
    return false;
  const normalized = value;
  if (normalized !== path.posix.normalize(normalized)) return false;
  return normalized.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function listedPathsAndParents(values: readonly string[]): Set<string> {
  const listed = new Set<string>();
  for (const value of values) {
    let current = normalizeManifestPath(value);
    listed.add(current);
    for (;;) {
      const parent = path.dirname(current);
      if (parent === '.' || parent === current) break;
      listed.add(parent);
      current = parent;
    }
  }
  return listed;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function verifyEvidenceDigest(target: string, expected: string, label: string, requireReadOnly = false): void {
  let before;
  try {
    before = lstatSync(target);
  } catch {
    throw new MetaClawError(`${label} is missing or unreadable`, 'integrity_drift', { target });
  }
  if (before.isSymbolicLink() || !before.isFile() || (requireReadOnly && (before.mode & 0o222) !== 0)) {
    throw new MetaClawError(`${label} is not protected evidence`, 'integrity_drift', { target });
  }
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
  const after = lstatSync(target);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    digest !== expected
  ) {
    throw new MetaClawError(`${label} changed or no longer matches its digest`, 'integrity_drift', { target });
  }
}

export { CANDIDATE_IDENTITY };
