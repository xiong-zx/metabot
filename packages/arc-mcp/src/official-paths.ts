import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ArcError } from './errors.js';

/**
 * Containment primitives shared by the in-process supervisor client and the
 * detached supervisor entry point.
 *
 * They are deliberately independent of {@link ArcArtifactStore}: the detached
 * process runs without the coordinator, the run store, or any MCP session, so
 * it must be able to prove containment on its own.
 */

const MAX_STATE_FILE_BYTES = 1024 * 1024;

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function safeProjectRoot(projectRoot: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(projectRoot);
  } catch (cause) {
    throw new ArcError('project_root_invalid', 'Official AutoResearchClaw project root does not exist', { cause });
  }
  if (!statSync(canonical).isDirectory()) {
    throw new ArcError('project_root_invalid', 'Official AutoResearchClaw project root must be a directory');
  }
  return canonical;
}

/**
 * Resolves a path that must stay inside the project root, rejecting every
 * symlinked component so a swapped directory cannot redirect official writes.
 */
export function safeContainedPath(
  projectRoot: string,
  candidate: string,
  options: { mustExist?: boolean; file?: boolean } = {},
): string {
  const root = safeProjectRoot(projectRoot);
  const resolved = path.resolve(root, candidate);
  if (!isInside(root, resolved)) {
    throw new ArcError('path_outside_project', 'Official AutoResearchClaw path escapes the project root');
  }
  let cursor = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new ArcError('symlink_not_allowed', 'Official AutoResearchClaw path contains a symbolic link', {
        details: { path: cursor },
      });
    }
    if (!isInside(root, realpathSync.native(cursor))) {
      throw new ArcError('path_outside_project', 'Official AutoResearchClaw path resolves outside the project root');
    }
  }
  if (options.mustExist && !existsSync(resolved)) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw path does not exist', {
      details: { path: resolved },
    });
  }
  if (options.file && (!existsSync(resolved) || !statSync(resolved).isFile())) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw path must be a regular file', {
      details: { path: resolved },
    });
  }
  return resolved;
}

export function ensureSafeDirectory(projectRoot: string, directory: string): string {
  const root = safeProjectRoot(projectRoot);
  const resolved = path.resolve(directory);
  if (!isInside(root, resolved)) {
    throw new ArcError('path_outside_project', 'Official AutoResearchClaw run directory escapes the project root');
  }
  let cursor = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ArcError('symlink_not_allowed', 'Official AutoResearchClaw run directory is not a safe directory', {
        details: { path: cursor },
      });
    }
  }
  return resolved;
}

/** Durable state must never be half-written, so every writer renames into place. */
export function atomicWriteJson(target: string, value: unknown, mode = 0o600): void {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    removeIfPresent(temporary);
    throw error;
  }
}

export function readJsonFile(target: string): unknown {
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ArcError('symlink_not_allowed', 'Official AutoResearchClaw state file must be a regular file', {
      details: { path: target },
    });
  }
  if (info.size > MAX_STATE_FILE_BYTES) {
    throw new ArcError('artifact_invalid', 'Official AutoResearchClaw state file exceeds the size limit');
  }
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as unknown;
  } catch (cause) {
    throw new ArcError('artifact_invalid', 'Official AutoResearchClaw state file is not valid JSON', { cause });
  }
}

/**
 * Removes a path that may already be gone. Only ENOENT is tolerated: any other
 * failure means cleanup did not happen and the caller must see it.
 */
export function removeIfPresent(target: string): void {
  try {
    unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
