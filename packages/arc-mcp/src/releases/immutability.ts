import { chmodSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Recursive immutability of a sealed release.
 *
 * A sealed release's identity is its source tree hash and its dependency
 * freeze. Sealing only the source left the half that actually executes — the
 * virtualenv, which is where every third-party package, every console script
 * and the editable install of the source itself lives — writable by the same
 * user that runs the daemon. An accidental `pip install` into that virtualenv
 * would change what the release executes while every recorded identity in the
 * manifest still matched, so the drift would verify clean.
 *
 * Both trees are therefore sealed together and re-checked before every launch.
 * Read and execute bits are preserved exactly, so a sealed console script is
 * still an executable console script; only write permission is removed.
 */

/** Every permission bit a sealed node may keep. Write is what is dropped. */
const READ_AND_EXECUTE = 0o555;
const ANY_WRITE = 0o222;

export const RELEASE_IMMUTABILITY_MODE = 'recursive-read-only' as const;

export type SealedTreeName = 'source' | 'venv';

/** Order is the order the trees are sealed and reported in. */
export const SEALED_TREE_NAMES: readonly SealedTreeName[] = ['source', 'venv'];

/**
 * Structural census of one sealed tree.
 *
 * Recorded at seal time and recomputed at verification. A sealed tree cannot
 * gain or lose a node without a writable directory somewhere, so a count that
 * moved is evidence the seal was broken and restored rather than never broken.
 */
export interface SealedTreeRecord {
  files: number;
  directories: number;
  /** Allowed virtualenv structural links. Field name retained for manifest compatibility. */
  interpreter_links: number;
}

export interface ReleaseImmutabilityRecord {
  mode: typeof RELEASE_IMMUTABILITY_MODE;
  sealed: SealedTreeName[];
  trees: Record<SealedTreeName, SealedTreeRecord>;
}

export interface SealedTreePaths {
  release: string;
  source: string;
  venv: string;
}

/**
 * Where a symlink is tolerated, and nowhere else.
 *
 * `interpreterDir` is a virtualenv's `bin`, where `python`, `python3` and
 * `python3.11` structurally reach the base interpreter. CPython on Linux may
 * also create the exact root-level `lib64 -> lib` compatibility link. A source
 * tree receives none of these virtualenv paths, so every symlink in it is
 * refused.
 */
interface LinkPolicy {
  releaseDir: string;
  /** Lexical, so it can be compared against the directory being walked. */
  interpreterDir?: string;
  /** Canonical, so it can be compared against a resolved symlink target. */
  interpreterRealDir?: string;
  /** Lexical virtualenv root, for the exact root-level lib64 compatibility link. */
  venvDir?: string;
  /** Canonical virtualenv lib directory that lib64 must resolve to. */
  venvLibRealDir?: string;
}

const VENV_INTERPRETER_NAME = /^python(\d+(\.\d+)?)?$/;

/**
 * Seals both trees and returns what was sealed, for the manifest.
 *
 * Only ever called on trees this process just created. It never touches a
 * release that already existed: an earlier release's permissions are part of
 * the evidence it is, and repairing one in place would rewrite that evidence.
 */
export function sealReleaseTrees(paths: SealedTreePaths): ReleaseImmutabilityRecord {
  const policy = linkPolicy(paths);
  return {
    mode: RELEASE_IMMUTABILITY_MODE,
    sealed: [...SEALED_TREE_NAMES],
    trees: {
      source: sealTree(paths.source, 'source', { releaseDir: policy.releaseDir }),
      venv: sealTree(paths.venv, 'virtualenv', policy),
    },
  };
}

/**
 * Fail-closed immutability check.
 *
 * Refuses a writable file, a writable directory, a symlink that is not an
 * allowed virtualenv structural link, any node that is neither a regular file
 * nor a directory, and — when the sealed record is supplied — a census that
 * no longer matches the one the manifest recorded.
 */
export function assertReleaseTreesSealed(
  paths: SealedTreePaths,
  expected?: ReleaseImmutabilityRecord,
): ReleaseImmutabilityRecord {
  const policy = linkPolicy(paths);
  const observed: ReleaseImmutabilityRecord = {
    mode: RELEASE_IMMUTABILITY_MODE,
    sealed: [...SEALED_TREE_NAMES],
    trees: {
      source: assertTreeSealed(paths.source, 'source', { releaseDir: policy.releaseDir }),
      venv: assertTreeSealed(paths.venv, 'virtualenv', policy),
    },
  };
  if (!expected) return observed;
  if (expected.mode !== RELEASE_IMMUTABILITY_MODE) {
    throw new Error(`Sealed release records an unknown immutability mode: ${String(expected.mode)}`);
  }
  for (const tree of SEALED_TREE_NAMES) {
    if (!expected.sealed.includes(tree)) {
      throw new Error(`Sealed release does not claim to have sealed its ${tree} tree`);
    }
    const want = expected.trees[tree];
    const got = observed.trees[tree];
    if (
      want.files !== got.files ||
      want.directories !== got.directories ||
      want.interpreter_links !== got.interpreter_links
    ) {
      throw new Error(
        `Sealed release ${tree} tree drifted from the sealed census: recorded ${describe(want)}, found ${describe(got)}`,
      );
    }
  }
  return observed;
}

/**
 * Restores directory write permission so a *failed* install can be removed.
 *
 * Unlinking a child needs write and execute permission on its directory, not
 * on the child, so only directories are touched: the files keep the modes they
 * were given, which matters because a local clone hardlinks its git objects
 * into the staging repository that supplied them.
 *
 * Only ever applied to a release directory this process created and is about
 * to delete. Nothing calls it on a sealed release that completed.
 */
export function restoreTreeDirectoriesWritable(root: string): void {
  let info;
  try {
    info = lstatSync(root);
  } catch {
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  chmodSync(root, info.mode | 0o700);
  for (const entry of readdirSync(root)) {
    restoreTreeDirectoriesWritable(path.join(root, entry));
  }
}

function sealTree(root: string, label: string, policy: LinkPolicy): SealedTreeRecord {
  assertSealableRoot(root, label);
  const record: SealedTreeRecord = { files: 0, directories: 0, interpreter_links: 0 };
  const pending = [root];
  const directories: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    directories.push(directory);
    for (const entry of readdirSync(directory)) {
      const candidate = path.join(directory, entry);
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) {
        assertAllowedVirtualenvLink(candidate, label, policy);
        record.interpreter_links += 1;
        continue;
      }
      if (info.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!info.isFile()) throw unsafeNode(candidate, label);
      chmodSync(candidate, info.mode & READ_AND_EXECUTE);
      record.files += 1;
    }
  }
  // Directory write permission controls creation, deletion and replacement of
  // children, so sealing files alone is insufficient. Seal bottom-up after the
  // traversal so every nested directory, including .git and site-packages,
  // becomes non-writable too.
  for (const directory of directories.reverse()) {
    chmodSync(directory, statSync(directory).mode & READ_AND_EXECUTE);
  }
  record.directories = directories.length;
  return record;
}

function assertTreeSealed(root: string, label: string, policy: LinkPolicy): SealedTreeRecord {
  assertSealableRoot(root, label);
  const record: SealedTreeRecord = { files: 0, directories: 0, interpreter_links: 0 };
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    record.directories += 1;
    assertNotWritable(directory, lstatSync(directory).mode, label);
    for (const entry of readdirSync(directory)) {
      const candidate = path.join(directory, entry);
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) {
        assertAllowedVirtualenvLink(candidate, label, policy);
        record.interpreter_links += 1;
        continue;
      }
      if (info.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!info.isFile()) throw unsafeNode(candidate, label);
      assertNotWritable(candidate, info.mode, label);
      record.files += 1;
    }
  }
  return record;
}

function assertSealableRoot(root: string, label: string): void {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Official release ${label} tree is not a plain directory: ${root}`);
  }
}

function assertNotWritable(node: string, mode: number, label: string): void {
  if ((mode & ANY_WRITE) !== 0) {
    throw new Error(
      `Official release ${label} tree is not immutable: ${node} is writable (mode ${(mode & 0o777).toString(8)})`,
    );
  }
}

/**
 * The one symlink shape a sealed release may contain.
 *
 * A virtualenv reaches its base interpreter through `bin/python*`, so refusing
 * every symlink would mean refusing every virtualenv. The allowance is made as
 * narrow as the fact requires: only inside the virtualenv's own `bin`, only
 * under an interpreter name, never through `..`, never dangling, and never
 * pointing back into the sealed release anywhere except that same `bin` — so a
 * link cannot be used to reach the source tree or a release directory under a
 * name that looks like an interpreter.
 */
function assertAllowedVirtualenvLink(link: string, label: string, policy: LinkPolicy): void {
  const refuse = (reason: string): never => {
    throw new Error(`Official release ${label} tree contains an unsafe symlink (${reason}): ${link}`);
  };
  const target = readlinkSync(link);
  if (policy.venvDir && path.dirname(link) === policy.venvDir && path.basename(link) === 'lib64') {
    if (target !== 'lib') refuse('the virtualenv lib64 link must point exactly to lib');
    let resolved: string;
    try {
      resolved = realpathSync.native(link);
    } catch {
      return refuse('the virtualenv lib64 target does not resolve');
    }
    if (!policy.venvLibRealDir || resolved !== policy.venvLibRealDir || !statSync(resolved).isDirectory()) {
      refuse('the virtualenv lib64 target is not its own lib directory');
    }
    return;
  }
  if (!policy.interpreterDir || path.dirname(link) !== policy.interpreterDir) {
    refuse('only a virtualenv interpreter link may be a symlink');
  }
  if (!VENV_INTERPRETER_NAME.test(path.basename(link))) refuse('not an interpreter name');
  if (target.split('/').includes('..')) refuse('the target traverses upwards');
  let resolved: string;
  try {
    resolved = realpathSync.native(link);
  } catch {
    return refuse('the target does not resolve');
  }
  if (!statSync(resolved).isFile()) refuse('the target is not a regular file');
  const insideInterpreterDir = path.dirname(resolved) === policy.interpreterRealDir;
  const insideRelease = resolved === policy.releaseDir || resolved.startsWith(`${policy.releaseDir}${path.sep}`);
  if (!insideInterpreterDir && insideRelease) refuse('the target reaches into the sealed release');
}

function linkPolicy(paths: SealedTreePaths): Required<LinkPolicy> {
  const interpreterDir = path.join(paths.venv, 'bin');
  return {
    releaseDir: realpathIfPossible(paths.release),
    interpreterDir,
    interpreterRealDir: realpathIfPossible(interpreterDir),
    venvDir: paths.venv,
    venvLibRealDir: realpathIfPossible(path.join(paths.venv, 'lib')),
  };
}

function unsafeNode(node: string, label: string): Error {
  return new Error(`Official release ${label} tree contains a node that is neither a file nor a directory: ${node}`);
}

function describe(record: SealedTreeRecord): string {
  return `${record.files} files, ${record.directories} directories, ${record.interpreter_links} interpreter links`;
}

function realpathIfPossible(directory: string): string {
  try {
    return realpathSync.native(directory);
  } catch {
    return path.resolve(directory);
  }
}
