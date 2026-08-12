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

import { ArcError } from '@xvirobotics/arc-mcp';

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function safeProjectRoot(projectRoot: string): string {
  const canonical = realpathSync.native(projectRoot);
  if (!statSync(canonical).isDirectory()) throw new ArcError('project_root_invalid', 'Project root must be a directory');
  return canonical;
}

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
  const relative = path.relative(root, resolved);
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) break;
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) {
      throw new ArcError('symlink_not_allowed', 'Official AutoResearchClaw path contains a symbolic link', {
        details: { path: cursor },
      });
    }
    if (!isInside(root, realpathSync.native(cursor))) {
      throw new ArcError('path_outside_project', 'Official AutoResearchClaw path resolves outside the project root');
    }
  }
  if (options.mustExist && !existsSync(resolved)) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw config does not exist', {
      details: { path: resolved },
    });
  }
  if (options.file && (!existsSync(resolved) || !statSync(resolved).isFile())) {
    throw new ArcError('runner_unconfigured', 'Official AutoResearchClaw config must be a regular file', {
      details: { path: resolved },
    });
  }
  return resolved;
}

export function ensureSafeDirectory(projectRoot: string, directory: string): void {
  const root = safeProjectRoot(projectRoot);
  const resolved = path.resolve(directory);
  if (!isInside(root, resolved)) throw new ArcError('path_outside_project', 'ARC run directory escapes project root');
  const relative = path.relative(root, resolved);
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ArcError('symlink_not_allowed', 'ARC run directory is not a safe regular directory', {
        details: { path: cursor },
      });
    }
  }
}

export function atomicWriteJson(target: string, value: unknown, mode = 0o600): void {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function readJsonFile(target: string): unknown {
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe JSON state file: ${target}`);
  return JSON.parse(readFileSync(target, 'utf8')) as unknown;
}
